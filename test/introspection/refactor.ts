// Codemod primitives for structural refactors, built on the same TypeScript
// program bootstrap as the rest of the toolkit. Two operations:
//
//   1. `moveModules` — move file(s)/a directory and rewrite BOTH the moved
//      files' own relative imports AND every consumer's import specifier.
//   2. `moveDeclaration` — move a single top-level declaration (interface /
//      type / function / const / class / enum) to another file, redirect every
//      consumer's import of it, and best-effort fix up the destination's own
//      imports + the source file's back-import.
//
// Everything resolves modules through the checker (like `build-graph.ts`), so a
// relative `../lib/foo.ts`, a dynamic `import("./foo.ts")`, and an `export …
// from` are all understood. Edits are computed against the original text and
// applied by offset, then the moved/changed files are written to disk. Run
// `bun check` afterwards to typecheck + format the result.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as ts from "typescript";
import { createAnalysisProgram, REPO_ROOT, toPosix } from "./program.ts";

// ── paths & specifiers ──────────────────────────────────────────────────────

function abs(p: string): string {
	return path.resolve(REPO_ROOT, p);
}

function relOf(file: string): string {
	return toPosix(path.relative(REPO_ROOT, path.resolve(file)));
}

/**
 * The module specifier to write when `fromFile` imports `toFile`: a POSIX
 * relative path, `./`-prefixed, preserving the `.ts` extension (this repo uses
 * `allowImportingTsExtensions`).
 */
export function relativeSpecifier(fromFile: string, toFile: string): string {
	let rel = toPosix(path.relative(path.dirname(fromFile), toFile));
	if (!rel.startsWith(".")) rel = `./${rel}`;
	return rel;
}

// ── text edits ──────────────────────────────────────────────────────────────

interface TextEdit {
	start: number;
	end: number;
	newText: string;
}

/** Apply non-overlapping edits to a string, right-to-left so offsets stay valid. */
function applyEdits(text: string, edits: TextEdit[]): string {
	const sorted = [...edits].sort((a, b) => b.start - a.start);
	let out = text;
	for (const e of sorted) out = out.slice(0, e.start) + e.newText + out.slice(e.end);
	return out;
}

// ── AST helpers ─────────────────────────────────────────────────────────────

function hasExportModifier(node: ts.Node): boolean {
	if (!ts.canHaveModifiers(node)) return false;
	return (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

/** The name a top-level statement declares, if it declares exactly one. */
function declaredNames(stmt: ts.Statement): string[] {
	if (
		ts.isFunctionDeclaration(stmt) ||
		ts.isClassDeclaration(stmt) ||
		ts.isInterfaceDeclaration(stmt) ||
		ts.isTypeAliasDeclaration(stmt) ||
		ts.isEnumDeclaration(stmt) ||
		ts.isModuleDeclaration(stmt)
	) {
		return stmt.name && ts.isIdentifier(stmt.name) ? [stmt.name.text] : [];
	}
	if (ts.isVariableStatement(stmt)) {
		return stmt.declarationList.declarations
			.map((d) => (ts.isIdentifier(d.name) ? d.name.text : undefined))
			.filter((n): n is string => n !== undefined);
	}
	return [];
}

/** Resolve a module-specifier expression to an absolute file path via the checker. */
function resolveSpecifier(checker: ts.TypeChecker, spec: ts.Expression): string | undefined {
	const sym = checker.getSymbolAtLocation(spec);
	const decl = sym?.declarations?.find((d) => ts.isSourceFile(d));
	return decl ? path.resolve(decl.getSourceFile().fileName) : undefined;
}

interface SpecifierOccurrence {
	node: ts.StringLiteralLike;
	text: string;
	resolved?: string;
}

/** Every module-specifier string literal in a file: static import/export + dynamic import. */
function collectSpecifiers(sf: ts.SourceFile, checker: ts.TypeChecker): SpecifierOccurrence[] {
	const out: SpecifierOccurrence[] = [];
	const add = (node: ts.Expression | ts.Node | undefined) => {
		if (!node || !ts.isStringLiteralLike(node)) return;
		out.push({ node, text: node.text, resolved: resolveSpecifier(checker, node) });
	};
	const visit = (node: ts.Node) => {
		if (ts.isImportDeclaration(node)) add(node.moduleSpecifier);
		else if (ts.isExportDeclaration(node) && node.moduleSpecifier) add(node.moduleSpecifier);
		else if (
			ts.isCallExpression(node) &&
			node.expression.kind === ts.SyntaxKind.ImportKeyword &&
			node.arguments[0]
		) {
			add(node.arguments[0]);
		} else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
			add(node.argument.literal);
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);
	return out;
}

/**
 * Start offset of the doc comment immediately above a statement (contiguous —
 * no blank line between comment and declaration), or the statement start if
 * there is none. Avoids sweeping up a section-banner comment separated by a
 * blank line.
 */
function leadingDocStart(text: string, stmt: ts.Statement, sf: ts.SourceFile): number {
	const declStart = stmt.getStart(sf);
	const ranges = ts.getLeadingCommentRanges(text, stmt.getFullStart()) ?? [];
	let cut = declStart;
	for (let i = ranges.length - 1; i >= 0; i--) {
		const r = ranges[i] as ts.CommentRange;
		const gap = text.slice(r.end, cut);
		if ((gap.match(/\n/g)?.length ?? 0) > 1) break; // blank line ⇒ not attached
		cut = r.pos;
	}
	return cut;
}

// ── shared: a per-file collection of named-import edits ──────────────────────

interface NamedItem {
	importedName: string;
	localName: string;
	typeOnly: boolean;
}

/**
 * Accumulates import edits for a single file: dropping a named binding from one
 * module and/or ensuring a named binding is imported from another, merging into
 * an existing compatible import statement when possible.
 */
class ImportEditor {
	readonly edits: TextEdit[] = [];
	private readonly text: string;
	private readonly imports: ts.ImportDeclaration[];
	private insertAnchor: number;

	constructor(
		private readonly sf: ts.SourceFile,
		private readonly checker: ts.TypeChecker,
	) {
		this.text = sf.getFullText();
		this.imports = sf.statements.filter((s): s is ts.ImportDeclaration =>
			ts.isImportDeclaration(s),
		);
		const last = this.imports.at(-1);
		this.insertAnchor = last ? last.getEnd() : this.topOfFile();
	}

	private topOfFile(): number {
		const first = this.sf.statements[0];
		return first ? leadingDocStart(this.text, first, this.sf) : 0;
	}

	private moduleOf(decl: ts.ImportDeclaration): string | undefined {
		return resolveSpecifier(this.checker, decl.moduleSpecifier);
	}

	/** Named-imports declarations that resolve to `target` (abs path). */
	private namedDeclsFor(target: string): ts.ImportDeclaration[] {
		return this.imports.filter((d) => {
			if (this.moduleOf(d) !== target) return false;
			const nb = d.importClause?.namedBindings;
			return nb !== undefined && ts.isNamedImports(nb);
		});
	}

	private alreadyImports(target: string, importedName: string): boolean {
		return this.namedDeclsFor(target).some((d) => {
			const nb = d.importClause?.namedBindings;
			if (!nb || !ts.isNamedImports(nb)) return false;
			return nb.elements.some((el) => (el.propertyName?.text ?? el.name.text) === importedName);
		});
	}

	/** Remove one named binding from the import(s) that pull it from `target`. */
	removeNamed(target: string, importedName: string): void {
		for (const decl of this.namedDeclsFor(target)) {
			const nb = decl.importClause?.namedBindings;
			if (!nb || !ts.isNamedImports(nb)) continue;
			const els = nb.elements;
			const idx = els.findIndex((el) => (el.propertyName?.text ?? el.name.text) === importedName);
			if (idx < 0) continue;
			const hasOtherClause = decl.importClause?.name !== undefined;
			if (els.length === 1 && !hasOtherClause) {
				// Whole statement goes away (consume the trailing newline too).
				let end = decl.getEnd();
				if (this.text[end] === "\n") end++;
				this.edits.push({ start: leadingDocStart(this.text, decl, this.sf), end, newText: "" });
			} else {
				const el = els[idx] as ts.ImportSpecifier;
				if (idx < els.length - 1) {
					const next = els[idx + 1] as ts.ImportSpecifier;
					this.edits.push({
						start: el.getStart(this.sf),
						end: next.getStart(this.sf),
						newText: "",
					});
				} else {
					const prev = els[idx - 1] as ts.ImportSpecifier;
					this.edits.push({ start: prev.getEnd(), end: el.getEnd(), newText: "" });
				}
			}
			return;
		}
	}

	/** Ensure `item` is imported from `spec` (resolving to `target`), merging if possible. */
	ensureNamed(spec: string, target: string | undefined, item: NamedItem): void {
		if (target && this.alreadyImports(target, item.importedName)) return;
		const binding = formatBinding(item, false);
		if (target) {
			const mergeInto = this.namedDeclsFor(target).find((d) => {
				// Don't merge a value binding into an `import type { … }` statement.
				return !(d.importClause?.isTypeOnly && !item.typeOnly);
			});
			if (mergeInto) {
				const nb = mergeInto.importClause?.namedBindings as ts.NamedImports;
				const typeOnlyStmt = mergeInto.importClause?.isTypeOnly ?? false;
				const text = formatBinding(item, typeOnlyStmt);
				const lastEl = nb.elements.at(-1);
				const at = lastEl ? lastEl.getEnd() : nb.getStart(this.sf) + 1;
				this.edits.push({ start: at, end: at, newText: `, ${text}` });
				return;
			}
		}
		const stmt = `import ${item.typeOnly ? "type " : ""}{ ${binding} } from ${JSON.stringify(spec)};`;
		this.edits.push({ start: this.insertAnchor, end: this.insertAnchor, newText: `\n${stmt}` });
	}
}

/** Render a named specifier: `X`, `X as Y`, `type X`, prefixing `type ` only when the statement isn't already type-only. */
function formatBinding(item: NamedItem, statementIsTypeOnly: boolean): string {
	const base =
		item.importedName === item.localName
			? item.importedName
			: `${item.importedName} as ${item.localName}`;
	return item.typeOnly && !statementIsTypeOnly ? `type ${base}` : base;
}

// ── result type ─────────────────────────────────────────────────────────────

export interface RefactorResult {
	movedFiles: { from: string; to: string }[];
	changedFiles: string[];
	notes: string[];
	dryRun: boolean;
}

export interface RefactorOptions {
	/** Directories whose files are analyzed as potential consumers. Default `["src", "test"]`. */
	scope?: string | string[];
	/** Compute and report edits without touching disk. */
	dryRun?: boolean;
}

/** A pending file write, accumulated during planning and flushed at the end. */
interface PendingWrite {
	file: string;
	content: string;
	isNew: boolean;
}

async function statOrNull(p: string): Promise<import("node:fs").Stats | null> {
	try {
		return await fs.stat(p);
	} catch {
		return null;
	}
}

async function walkTsFiles(dir: string): Promise<string[]> {
	const out: string[] = [];
	for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...(await walkTsFiles(full)));
		else if (/\.tsx?$/.test(entry.name)) out.push(full);
	}
	return out;
}

// ── tool 1: move files / directories ────────────────────────────────────────

/**
 * Move one or more files/directories, rewriting every relative import specifier
 * that is affected — both the moved files' own imports and all consumers.
 *
 * @example
 * await moveModules([{ from: "src/lib/foo.ts", to: "src/lib/util/foo.ts" }]);
 * await moveModules([{ from: "src/lib/diff-algorithm.ts", to: "src/lib/diff/diff-algorithm.ts" }]);
 */
export async function moveModules(
	specs: { from: string; to: string }[],
	opts: RefactorOptions = {},
): Promise<RefactorResult> {
	const scope = opts.scope ?? ["src", "test"];
	const { checker, sourceFiles } = await createAnalysisProgram({ include: scope });
	const result: RefactorResult = {
		movedFiles: [],
		changedFiles: [],
		notes: [],
		dryRun: !!opts.dryRun,
	};

	// Build the absolute old→new map, expanding directories.
	const renameMap = new Map<string, string>();
	for (const spec of specs) {
		const from = abs(spec.from);
		const to = abs(spec.to);
		const st = await statOrNull(from);
		if (st?.isDirectory()) {
			for (const f of await walkTsFiles(from)) {
				renameMap.set(f, path.join(to, path.relative(from, f)));
			}
		} else {
			const toStat = await statOrNull(to);
			const dest = toStat?.isDirectory() ? path.join(to, path.basename(from)) : to;
			renameMap.set(from, dest);
		}
	}
	if (renameMap.size === 0) {
		result.notes.push("no files matched the move specs");
		return result;
	}
	const newLoc = (f: string) => renameMap.get(f) ?? f;

	// Compute specifier rewrites across the whole scope.
	const editsByFile = new Map<string, TextEdit[]>();
	for (const sf of sourceFiles) {
		const importer = path.resolve(sf.fileName);
		const text = sf.getFullText();
		for (const occ of collectSpecifiers(sf, checker)) {
			if (!occ.resolved || !occ.text.startsWith(".")) continue;
			if (!renameMap.has(importer) && !renameMap.has(occ.resolved)) continue;
			const newSpec = relativeSpecifier(newLoc(importer), newLoc(occ.resolved));
			if (newSpec === occ.text) continue;
			const start = occ.node.getStart(sf);
			const quote = text[start] ?? '"';
			const list = editsByFile.get(importer) ?? [];
			list.push({ start, end: occ.node.getEnd(), newText: `${quote}${newSpec}${quote}` });
			editsByFile.set(importer, list);
		}
	}

	// Apply: write moved files to their new home, rewrite consumers in place.
	const touched = new Set<string>([...editsByFile.keys(), ...renameMap.keys()]);
	for (const file of touched) {
		const edits = editsByFile.get(file) ?? [];
		const original = await fs.readFile(file, "utf8");
		const updated = edits.length ? applyEdits(original, edits) : original;
		const dest = newLoc(file);
		if (dest !== file) {
			result.movedFiles.push({ from: relOf(file), to: relOf(dest) });
			if (!opts.dryRun) {
				await fs.mkdir(path.dirname(dest), { recursive: true });
				await fs.writeFile(dest, updated);
				await fs.rm(file);
			}
		} else if (edits.length) {
			result.changedFiles.push(relOf(file));
			if (!opts.dryRun) await fs.writeFile(file, updated);
		}
	}
	result.movedFiles.sort((a, b) => a.from.localeCompare(b.from));
	result.changedFiles.sort();
	return result;
}

// ── tool 2: move a declaration between files ─────────────────────────────────

/** Local import bindings of a file, keyed by the checker symbol they introduce. */
interface LocalImportInfo {
	kind: "named" | "default" | "namespace";
	importedName: string;
	localName: string;
	moduleText: string;
	resolved?: string;
	typeOnly: boolean;
}

function indexLocalImports(
	sf: ts.SourceFile,
	checker: ts.TypeChecker,
): Map<ts.Symbol, LocalImportInfo> {
	const map = new Map<ts.Symbol, LocalImportInfo>();
	for (const stmt of sf.statements) {
		if (!ts.isImportDeclaration(stmt) || !stmt.importClause) continue;
		const moduleText = ts.isStringLiteralLike(stmt.moduleSpecifier)
			? stmt.moduleSpecifier.text
			: "";
		const resolved = resolveSpecifier(checker, stmt.moduleSpecifier);
		const whole = stmt.importClause.isTypeOnly;
		const record = (
			nameNode: ts.Identifier,
			info: Omit<LocalImportInfo, "moduleText" | "resolved">,
		) => {
			const sym = checker.getSymbolAtLocation(nameNode);
			if (sym) map.set(sym, { ...info, moduleText, resolved });
		};
		if (stmt.importClause.name) {
			record(stmt.importClause.name, {
				kind: "default",
				importedName: "default",
				localName: stmt.importClause.name.text,
				typeOnly: whole,
			});
		}
		const nb = stmt.importClause.namedBindings;
		if (nb && ts.isNamespaceImport(nb)) {
			record(nb.name, {
				kind: "namespace",
				importedName: "*",
				localName: nb.name.text,
				typeOnly: whole,
			});
		} else if (nb && ts.isNamedImports(nb)) {
			for (const el of nb.elements) {
				record(el.name, {
					kind: "named",
					importedName: el.propertyName?.text ?? el.name.text,
					localName: el.name.text,
					typeOnly: whole || el.isTypeOnly,
				});
			}
		}
	}
	return map;
}

function isTypeOnlySymbol(checker: ts.TypeChecker, sym: ts.Symbol): boolean {
	let s = sym;
	if (s.flags & ts.SymbolFlags.Alias) {
		try {
			s = checker.getAliasedSymbol(s);
		} catch {}
	}
	return (s.flags & ts.SymbolFlags.Value) === 0 && (s.flags & ts.SymbolFlags.Type) !== 0;
}

/**
 * Move a single top-level declaration `name` from `fromRel` to `toRel`:
 * relocate the declaration (with its doc comment), redirect every consumer's
 * import, and best-effort fix up the destination's own imports plus the source
 * file's back-import. The consumer redirection is exhaustive; the two "own
 * imports" fixups (destination + source) are reported in `notes` for review.
 */
export async function moveDeclaration(
	name: string,
	fromRel: string,
	toRel: string,
	opts: RefactorOptions = {},
): Promise<RefactorResult> {
	const scope = opts.scope ?? ["src", "test"];
	const fromFile = abs(fromRel);
	const toFile = abs(toRel);
	const result: RefactorResult = {
		movedFiles: [],
		changedFiles: [],
		notes: [],
		dryRun: !!opts.dryRun,
	};

	const toExisted = (await statOrNull(toFile)) !== null;
	if (!toExisted && !opts.dryRun) {
		await fs.mkdir(path.dirname(toFile), { recursive: true });
		await fs.writeFile(toFile, "");
	}

	const { checker, sourceFiles } = await createAnalysisProgram({ include: scope });
	const fromSf = sourceFiles.find((sf) => path.resolve(sf.fileName) === fromFile);
	if (!fromSf) throw new Error(`source file not found in scope: ${fromRel}`);
	const fromText = fromSf.getFullText();
	const writes: PendingWrite[] = [];

	// 1. Locate the declaration statement(s).
	const matched = fromSf.statements.filter((s) => declaredNames(s).includes(name));
	if (matched.length === 0)
		throw new Error(`no top-level declaration named "${name}" in ${fromRel}`);
	for (const stmt of matched) {
		if (ts.isVariableStatement(stmt) && declaredNames(stmt).length > 1) {
			throw new Error(
				`"${name}" shares a variable statement with other declarations; split it first`,
			);
		}
	}
	const matchedSet = new Set(matched);

	// 2. Build the moved text and the removals from the source file.
	let movedBlock = "";
	const fromEdits: TextEdit[] = [];
	for (const stmt of matched) {
		const declStart = stmt.getStart(fromSf);
		const commentStart = leadingDocStart(fromText, stmt, fromSf);
		const comment = fromText.slice(commentStart, declStart);
		let body = fromText.slice(declStart, stmt.getEnd());
		if (!hasExportModifier(stmt)) body = `export ${body}`;
		movedBlock += `${comment}${body}\n\n`;
		let end = stmt.getEnd();
		if (fromText[end] === "\n") end++;
		fromEdits.push({ start: commentStart, end, newText: "" });
	}

	// 3. Figure out what the moved code references (for destination imports).
	const localImports = indexLocalImports(fromSf, checker);
	const topLevelBySymbol = new Map<ts.Symbol, string>();
	for (const stmt of fromSf.statements) {
		if (matchedSet.has(stmt)) continue;
		for (const n of declaredNames(stmt)) {
			const decl = findNameNode(stmt, n);
			const sym = decl && checker.getSymbolAtLocation(decl);
			if (sym) topLevelBySymbol.set(sym, n);
		}
	}

	const usedImports = new Map<string, LocalImportInfo>(); // localName -> info
	const backRefs = new Map<string, boolean>(); // name in fromFile -> typeOnly
	const movedNames = new Set(matched.flatMap(declaredNames));
	for (const stmt of matched) {
		const walk = (node: ts.Node) => {
			if (ts.isIdentifier(node)) {
				const sym = checker.getSymbolAtLocation(node);
				if (sym) {
					const imp = localImports.get(sym);
					if (imp) usedImports.set(imp.localName, imp);
					else {
						const tl = topLevelBySymbol.get(sym);
						if (tl && !movedNames.has(tl)) backRefs.set(tl, isTypeOnlySymbol(checker, sym));
					}
				}
			}
			ts.forEachChild(node, walk);
		};
		walk(stmt);
	}

	// 4. Rewrite the source file: remove the declaration; if it's still used
	//    there, import it back from the destination.
	const fromEditor = new ImportEditor(fromSf, checker);
	for (const e of fromEdits) fromEditor.edits.push(e);
	const stillUsedInSource = referencesNameOutside(fromSf, checker, name, matchedSet);
	if (stillUsedInSource) {
		fromEditor.ensureNamed(relativeSpecifier(fromFile, toFile), toFile, {
			importedName: name,
			localName: name,
			typeOnly: false,
		});
		result.notes.push(`${fromRel} still uses ${name}; added back-import from ${toRel}`);
	}
	recordWrite(result, writes, fromFile, applyEdits(fromText, fromEditor.edits));

	// 5. Build the destination file: prepend needed imports + the moved block.
	const destImports = buildDestinationImports(
		toFile,
		fromFile,
		[...usedImports.values()],
		backRefs,
		result,
	);
	const destOriginal = toExisted ? await fs.readFile(toFile, "utf8") : "";
	const destPrefix = [destImports, movedBlock].filter(Boolean).join("\n");
	const destContent = destOriginal ? `${destPrefix}\n${destOriginal}` : destPrefix;
	recordWrite(result, writes, toFile, destContent, /*isNew*/ !toExisted);
	if (backRefs.size > 0) {
		result.notes.push(
			`destination imports ${[...backRefs.keys()].join(", ")} back from ${fromRel} — ` +
				`review whether these should move too`,
		);
	}

	// 6. Redirect every consumer.
	let consumerCount = 0;
	for (const sf of sourceFiles) {
		const file = path.resolve(sf.fileName);
		if (file === fromFile || file === toFile) continue;
		const editor = new ImportEditor(sf, checker);
		const binding = findImportedBinding(sf, checker, fromFile, name);
		if (!binding) continue;
		editor.removeNamed(fromFile, name);
		editor.ensureNamed(relativeSpecifier(file, toFile), toFile, binding);
		if (editor.edits.length) {
			recordWrite(result, writes, file, applyEdits(sf.getFullText(), editor.edits));
			consumerCount++;
		}
	}
	result.notes.unshift(
		`moved ${name}: ${fromRel} → ${toRel}; redirected ${consumerCount} consumer(s)`,
	);
	result.changedFiles.sort();

	if (!opts.dryRun) await flushWrites(writes);
	return result;
}

/** The `NamedItem` for how a consumer imports `name` from `fromFile` (preserving alias/type-only). */
function findImportedBinding(
	sf: ts.SourceFile,
	checker: ts.TypeChecker,
	fromFile: string,
	name: string,
): NamedItem | undefined {
	for (const stmt of sf.statements) {
		if (!ts.isImportDeclaration(stmt) || !stmt.importClause) continue;
		if (resolveSpecifier(checker, stmt.moduleSpecifier) !== fromFile) continue;
		const nb = stmt.importClause.namedBindings;
		if (!nb || !ts.isNamedImports(nb)) continue;
		for (const el of nb.elements) {
			if ((el.propertyName?.text ?? el.name.text) === name) {
				return {
					importedName: name,
					localName: el.name.text,
					typeOnly: stmt.importClause.isTypeOnly || el.isTypeOnly,
				};
			}
		}
	}
	return undefined;
}

/** Whether `name` is referenced anywhere in `sf` outside the moved statements. */
function referencesNameOutside(
	sf: ts.SourceFile,
	checker: ts.TypeChecker,
	name: string,
	excluded: Set<ts.Statement>,
): boolean {
	let used = false;
	const topLevel = sf.statements;
	for (const stmt of topLevel) {
		if (excluded.has(stmt) || ts.isImportDeclaration(stmt)) continue;
		const walk = (node: ts.Node) => {
			if (used) return;
			if (ts.isIdentifier(node) && node.text === name) {
				// Ignore property positions like `obj.name`.
				const p = node.parent;
				if (ts.isPropertyAccessExpression(p) && p.name === node) return;
				used = true;
				return;
			}
			ts.forEachChild(node, walk);
		};
		walk(stmt);
	}
	return used;
}

function findNameNode(stmt: ts.Statement, name: string): ts.Identifier | undefined {
	let found: ts.Identifier | undefined;
	const walk = (node: ts.Node) => {
		if (found) return;
		if (ts.isIdentifier(node) && node.text === name) {
			found = node;
			return;
		}
		ts.forEachChild(node, walk);
	};
	walk(stmt);
	return found;
}

/** Compose the destination file's needed import statements (best-effort). */
function buildDestinationImports(
	toFile: string,
	fromFile: string,
	used: LocalImportInfo[],
	backRefs: Map<string, boolean>,
	result: RefactorResult,
): string {
	const lines: string[] = [];
	// Group named imports by module specifier (recomputed relative to the dest).
	const named = new Map<string, NamedItem[]>();
	const push = (spec: string, item: NamedItem) => {
		const list = named.get(spec) ?? [];
		list.push(item);
		named.set(spec, list);
	};
	const specForModule = (info: { resolved?: string; moduleText: string }): string => {
		if (info.resolved && info.moduleText.startsWith(".")) {
			return relativeSpecifier(toFile, info.resolved);
		}
		return info.moduleText;
	};

	for (const info of used) {
		const spec = specForModule(info);
		if (info.kind === "named") {
			push(spec, {
				importedName: info.importedName,
				localName: info.localName,
				typeOnly: info.typeOnly,
			});
		} else if (info.kind === "namespace") {
			lines.push(
				`import ${info.typeOnly ? "type " : ""}* as ${info.localName} from ${JSON.stringify(spec)};`,
			);
		} else {
			lines.push(
				`import ${info.typeOnly ? "type " : ""}${info.localName} from ${JSON.stringify(spec)};`,
			);
		}
	}
	for (const [refName, typeOnly] of backRefs) {
		push(relativeSpecifier(toFile, fromFile), {
			importedName: refName,
			localName: refName,
			typeOnly,
		});
		result.notes.push(`  (${refName} must be exported from ${relOf(fromFile)})`);
	}
	for (const [spec, items] of named) {
		const allType = items.every((i) => i.typeOnly);
		const parts = items.map((i) => formatBinding(i, allType));
		lines.push(
			`import ${allType ? "type " : ""}{ ${parts.join(", ")} } from ${JSON.stringify(spec)};`,
		);
	}
	return lines.join("\n");
}

/** Record a planned write (and reflect it in the result) without touching disk yet. */
function recordWrite(
	result: RefactorResult,
	writes: PendingWrite[],
	file: string,
	content: string,
	isNew = false,
): void {
	if (isNew) result.movedFiles.push({ from: "(new)", to: relOf(file) });
	else result.changedFiles.push(relOf(file));
	writes.push({ file, content, isNew });
}

/** Flush all planned writes to disk, creating parent directories as needed. */
async function flushWrites(writes: PendingWrite[]): Promise<void> {
	for (const w of writes) {
		await fs.mkdir(path.dirname(w.file), { recursive: true });
		await fs.writeFile(w.file, w.content);
	}
}

// ── CLI ──────────────────────────────────────────────────────────────────────

async function main(argv: string[]): Promise<void> {
	const [cmd, ...rest] = argv;
	const dryRun = rest.includes("--dry-run");
	const args = rest.filter((a) => a !== "--dry-run");
	if (cmd === "move-file") {
		const [from, to] = args;
		if (!from || !to) throw new Error("usage: move-file <from> <to> [--dry-run]");
		printResult(await moveModules([{ from, to }], { dryRun }));
	} else if (cmd === "move-decl") {
		const [name, from, to] = args;
		if (!name || !from || !to) throw new Error("usage: move-decl <name> <from> <to> [--dry-run]");
		printResult(await moveDeclaration(name, from, to, { dryRun }));
	} else {
		console.error(
			"commands:\n  move-file <from> <to>\n  move-decl <name> <from> <to>\n  (append --dry-run)",
		);
		process.exit(1);
	}
}

function printResult(r: RefactorResult): void {
	if (r.dryRun) console.log("# DRY RUN (no files written)\n");
	if (r.movedFiles.length) {
		console.log("moved:");
		for (const m of r.movedFiles) console.log(`  ${m.from}  →  ${m.to}`);
	}
	if (r.changedFiles.length) {
		console.log("changed:");
		for (const f of r.changedFiles) console.log(`  ${f}`);
	}
	if (r.notes.length) {
		console.log("notes:");
		for (const n of r.notes) console.log(`  - ${n}`);
	}
}

if (import.meta.main) {
	await main(process.argv.slice(2));
}
