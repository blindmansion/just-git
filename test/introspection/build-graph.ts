// Builds an `ImportGraph` from one or more directories using the TypeScript
// compiler API. We create a real `ts.Program` so the type checker can resolve
// modules and classify each imported binding as value / type / namespace —
// information that text/regex scanning cannot recover.

import * as path from "node:path";
import * as ts from "typescript";
import { BUILTIN_BARE, classifySymbol, createAnalysisProgram, toPosix } from "./program.ts";
import type {
	BuildGraphOptions,
	EdgeTarget,
	ExportInfo,
	ImportBinding,
	ImportClauseKind,
	ImportEdge,
	ImportGraph,
	ModuleNode,
} from "./types.ts";

/** Resolve the file a module specifier points at, via the checker's module symbol. */
function resolveModuleFile(checker: ts.TypeChecker, specifier: ts.Expression): string | undefined {
	const sym = checker.getSymbolAtLocation(specifier);
	const decl = sym?.declarations?.find((d) => ts.isSourceFile(d));
	return decl ? path.resolve(decl.getSourceFile().fileName) : undefined;
}

function categorize(
	specifierText: string,
	toFile: string | undefined,
	includeRoots: string[],
): EdgeTarget {
	if (!toFile) {
		if (specifierText.startsWith("node:")) return "builtin";
		if (BUILTIN_BARE.has(specifierText)) return "builtin";
		return "unresolved";
	}
	if (toPosix(toFile).includes("/node_modules/")) return "package";
	const norm = toPosix(toFile);
	if (includeRoots.some((r) => norm.startsWith(`${toPosix(r)}/`) || norm === toPosix(r))) {
		return "internal";
	}
	return "external-project";
}

interface BindingContext {
	checker: ts.TypeChecker;
	includeTypeStrings: boolean;
}

function makeBinding(
	ctx: BindingContext,
	importedName: string,
	nameNode: ts.Node,
	localName: string,
	isTypeOnly: boolean,
): ImportBinding {
	const symbol = ctx.checker.getSymbolAtLocation(nameNode);
	const kind = symbol ? classifySymbol(ctx.checker, symbol) : "unknown";
	const binding: ImportBinding = { importedName, localName, isTypeOnly, kind };
	if (ctx.includeTypeStrings && symbol && (kind === "value" || kind === "value-and-type")) {
		try {
			let s = symbol;
			if (s.flags & ts.SymbolFlags.Alias) s = ctx.checker.getAliasedSymbol(s);
			const decl = s.valueDeclaration ?? s.declarations?.[0] ?? nameNode;
			const type = ctx.checker.getTypeOfSymbolAtLocation(s, decl);
			binding.typeString = ctx.checker.typeToString(type);
		} catch {
			// type materialisation failed — leave typeString undefined
		}
	}
	return binding;
}

/** Extract every import / export-from edge declared in a source file. */
function extractEdges(
	ctx: BindingContext,
	sourceFile: ts.SourceFile,
	includeRoots: string[],
): ImportEdge[] {
	const edges: ImportEdge[] = [];
	const fromFile = path.resolve(sourceFile.fileName);

	const pushEdge = (
		specifierNode: ts.Expression,
		statement: "import" | "export",
		isTypeOnly: boolean,
		clauseKinds: ImportClauseKind[],
		bindings: ImportBinding[],
	) => {
		if (!ts.isStringLiteralLike(specifierNode)) return;
		const specifier = specifierNode.text;
		const toFile = resolveModuleFile(ctx.checker, specifierNode);
		const { line } = sourceFile.getLineAndCharacterOfPosition(specifierNode.getStart(sourceFile));
		edges.push({
			fromFile,
			specifier,
			toFile,
			target: categorize(specifier, toFile, includeRoots),
			isTypeOnly,
			statement,
			clauseKinds,
			bindings,
			line: line + 1,
		});
	};

	for (const stmt of sourceFile.statements) {
		if (ts.isImportDeclaration(stmt)) {
			const clause = stmt.importClause;
			if (!clause) {
				pushEdge(stmt.moduleSpecifier, "import", false, ["side-effect"], []);
				continue;
			}
			const wholeTypeOnly = clause.isTypeOnly;
			const clauseKinds: ImportClauseKind[] = [];
			const bindings: ImportBinding[] = [];

			if (clause.name) {
				clauseKinds.push("default");
				bindings.push(makeBinding(ctx, "default", clause.name, clause.name.text, wholeTypeOnly));
			}
			const named = clause.namedBindings;
			if (named && ts.isNamespaceImport(named)) {
				clauseKinds.push("namespace");
				bindings.push(makeBinding(ctx, "*", named.name, named.name.text, wholeTypeOnly));
			} else if (named && ts.isNamedImports(named)) {
				clauseKinds.push("named");
				for (const el of named.elements) {
					const importedName = el.propertyName?.text ?? el.name.text;
					bindings.push(
						makeBinding(ctx, importedName, el.name, el.name.text, wholeTypeOnly || el.isTypeOnly),
					);
				}
			}
			pushEdge(stmt.moduleSpecifier, "import", wholeTypeOnly, clauseKinds, bindings);
			continue;
		}

		if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier) {
			const wholeTypeOnly = stmt.isTypeOnly;
			const clauseKinds: ImportClauseKind[] = [];
			const bindings: ImportBinding[] = [];
			const exported = stmt.exportClause;
			if (exported && ts.isNamespaceExport(exported)) {
				clauseKinds.push("namespace");
				bindings.push(makeBinding(ctx, "*", exported.name, exported.name.text, wholeTypeOnly));
			} else if (exported && ts.isNamedExports(exported)) {
				clauseKinds.push("named");
				for (const el of exported.elements) {
					const importedName = el.propertyName?.text ?? el.name.text;
					bindings.push(
						makeBinding(ctx, importedName, el.name, el.name.text, wholeTypeOnly || el.isTypeOnly),
					);
				}
			} else {
				// `export * from "..."`
				clauseKinds.push("namespace");
			}
			pushEdge(stmt.moduleSpecifier, "export", wholeTypeOnly, clauseKinds, bindings);
		}
	}

	return edges;
}

/** Compute the exported symbols of an internal module via the checker. */
function extractExports(checker: ts.TypeChecker, sourceFile: ts.SourceFile): ExportInfo[] {
	const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
	if (!moduleSymbol) return [];
	const out: ExportInfo[] = [];
	for (const exp of checker.getExportsOfModule(moduleSymbol)) {
		const isReExport = (exp.flags & ts.SymbolFlags.Alias) !== 0;
		out.push({ name: exp.getName(), kind: classifySymbol(checker, exp), isReExport });
	}
	out.sort((a, b) => a.name.localeCompare(b.name));
	return out;
}

/**
 * Build an import graph for the configured directories.
 *
 * @example
 * const graph = await buildImportGraph({ include: "src/lib" });
 * for (const edge of graph.edges) { ... }
 */
export async function buildImportGraph(options: BuildGraphOptions): Promise<ImportGraph> {
	const { checker, root, includeRoots, sourceFiles, relOf } = await createAnalysisProgram(options);
	const ctx: BindingContext = { checker, includeTypeStrings: options.includeTypeStrings ?? false };

	const nodes = new Map<string, ModuleNode>();
	const edges: ImportEdge[] = [];
	const diagnostics: string[] = [];

	const addInternalNode = (sourceFile: ts.SourceFile) => {
		const file = path.resolve(sourceFile.fileName);
		const fileEdges = extractEdges(ctx, sourceFile, includeRoots);
		for (const e of fileEdges) {
			edges.push(e);
			if (e.target === "unresolved") {
				diagnostics.push(`${relOf(file)}:${e.line} unresolved module "${e.specifier}"`);
			}
		}
		nodes.set(file, {
			file,
			relPath: relOf(file),
			category: "internal",
			imports: fileEdges,
			exports: extractExports(checker, sourceFile),
		});
	};

	for (const sourceFile of sourceFiles) addInternalNode(sourceFile);

	if (options.includeExternalNodes) {
		// Add lightweight nodes for resolved external targets referenced by edges.
		for (const edge of edges) {
			if (!edge.toFile || nodes.has(edge.toFile)) continue;
			if (edge.target !== "package" && edge.target !== "external-project") continue;
			nodes.set(edge.toFile, {
				file: edge.toFile,
				relPath: relOf(edge.toFile),
				category: edge.target,
				imports: [],
				exports: [],
			});
		}
	}

	return { root, includeRoots, nodes, edges, diagnostics };
}
