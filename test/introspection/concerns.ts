// Formatting-vs-data concern classifier.
//
// A pragmatic, checker-backed heuristic for the question "how tangled are
// presentation (string formatting) and data (retrieval/computation) concerns?".
// For every named function it records two independent axes:
//
//   • formats     — produces human-readable string output (returns a string /
//                   string[], and/or its body is built from template literals,
//                   `.join`, padding, embedded newlines), or its name is drawn
//                   from the formatting vocabulary (`format*`, `render*`, …).
//   • handlesData — reaches for data at runtime: it is `async` / contains
//                   `await` (in this codebase object/ref/fs reads are async), so
//                   it couples *retrieval* with whatever else it does.
//
// The cross-product gives the concern kind. `mixed` (does data AND formats) is
// the anti-pattern of interest; `formatting` functions living in files that are
// otherwise `data`/`logic` are the "formatter sprinkled in a data module" case.
//
// Signals are AST-derived (one checker call per function for the return type),
// so this runs comfortably over all of `src`. It is a heuristic lead-finder,
// not a verdict — calibrate thresholds via the options.

import * as path from "node:path";
import * as ts from "typescript";
import { type AnalysisProgram, createAnalysisProgram } from "./program.ts";
import type { ProgramOptions } from "./types.ts";

export type ConcernKind = "formatting" | "data" | "mixed" | "logic";

/** Names that strongly imply a function's job is to render output. */
const FORMATTING_NAME =
	/^(format|render|print|serialize|stringify|display|describe|pretty|colou?r|expand|summari[sz]e)/i;
// Suffixes kept deliberately narrow: `Line`/`Text`/`Header`/`Label` also occur
// in parse/split/util functions, so only unambiguous presentation nouns qualify.
const FORMATTING_SUFFIX = /(ToString|Message|Summary|Repr)$/;

function nameLooksFormatting(name: string): boolean {
	const base = name.includes(".") ? (name.split(".").pop() as string) : name;
	return FORMATTING_NAME.test(base) || FORMATTING_SUFFIX.test(base);
}

/** Per-function concern record. */
export interface FunctionConcern {
	/** Stable id: `${relPath}#${qualifiedName}` (with `@line` on collision). */
	id: string;
	name: string;
	relPath: string;
	line: number;
	exported: boolean;
	/** Return type is `string` / `string[]` (Promise-unwrapped). */
	returnsString: boolean;
	/** Name is drawn from the formatting vocabulary. */
	nameSignal: boolean;
	/** Count of template-literal expressions in the body. */
	templates: number;
	/** Count of `.join(...)` calls. */
	joins: number;
	/** Count of `.padStart` / `.padEnd` / `.repeat` calls. */
	pads: number;
	/** Count of string/template literals containing a newline. */
	newlines: number;
	/** Count of `await` expressions (data-retrieval proxy). */
	awaits: number;
	/** Declared `async` (or returns a `Promise`). */
	isAsync: boolean;
	/** Derived: produces formatted string output. */
	formats: boolean;
	/** Derived: performs runtime data retrieval (async/await). */
	handlesData: boolean;
	/** Cross-product classification. */
	kind: ConcernKind;
}

/** Tunables for {@link classifyConcerns}'s heuristics. */
export interface ConcernOptions {
	/**
	 * Minimum *presentation* body signals (template literals + padding +
	 * multi-line literals; `.join` is treated as weak evidence) for a function to
	 * count as `formats` on body evidence alone, absent a formatting name. Default
	 * 1. Error-message strings (inside `throw` / `new *Error(...)`) never count.
	 */
	minPresentationSignals?: number;
}

/** Whether a node constructs an Error (its string args are diagnostics, not output). */
function isErrorConstruction(node: ts.Node): boolean {
	if (!ts.isNewExpression(node) && !ts.isCallExpression(node)) return false;
	const expr = node.expression;
	const name = ts.isIdentifier(expr)
		? expr.text
		: ts.isPropertyAccessExpression(expr)
			? expr.name.text
			: "";
	return name.endsWith('Error');
}

interface FnInfo {
	kind: "function" | "method" | "arrow" | "function-expression";
	name: string;
	nameNode: ts.Node;
	fn: ts.FunctionLikeDeclaration;
}

function fnInfo(node: ts.Node): FnInfo | undefined {
	if (ts.isFunctionDeclaration(node) && node.name) {
		return { kind: "function", name: node.name.text, nameNode: node.name, fn: node };
	}
	if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
		const cls = node.parent;
		const clsName =
			(ts.isClassDeclaration(cls) || ts.isClassExpression(cls)) && cls.name
				? `${cls.name.text}.`
				: "";
		return { kind: "method", name: `${clsName}${node.name.text}`, nameNode: node.name, fn: node };
	}
	if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
		const parent = node.parent;
		const kind = ts.isArrowFunction(node) ? "arrow" : "function-expression";
		if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
			return { kind, name: parent.name.text, nameNode: parent.name, fn: node };
		}
		if (ts.isPropertyDeclaration(parent) && ts.isIdentifier(parent.name)) {
			const cls = parent.parent;
			const clsName =
				(ts.isClassDeclaration(cls) || ts.isClassExpression(cls)) && cls.name
					? `${cls.name.text}.`
					: "";
			return { kind, name: `${clsName}${parent.name.text}`, nameNode: parent.name, fn: node };
		}
		if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) {
			return { kind, name: parent.name.text, nameNode: parent.name, fn: node };
		}
	}
	return undefined;
}

function isExported(node: ts.Node): boolean {
	let cur: ts.Node | undefined = node;
	while (cur) {
		if (ts.canHaveModifiers(cur)) {
			const mods = ts.getModifiers(cur);
			if (mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) return true;
		}
		if (cur.parent && ts.isSourceFile(cur.parent)) break;
		cur = cur.parent;
	}
	return false;
}

function stringLike(checker: ts.TypeChecker, type: ts.Type): boolean {
	// Unwrap Promise<T>.
	const sym = type.getSymbol();
	if (sym?.name === "Promise") {
		const args = checker.getTypeArguments(type as ts.TypeReference);
		if (args.length > 0) return stringLike(checker, args[0] as ts.Type);
	}
	if (type.isUnion()) return type.types.every((t) => stringLike(checker, t));
	if (type.flags & ts.TypeFlags.StringLike) return true;
	if (checker.isArrayType(type)) {
		const el = checker.getTypeArguments(type as ts.TypeReference)[0];
		return !!el && stringLike(checker, el);
	}
	return false;
}

function returnsStringLike(checker: ts.TypeChecker, fn: ts.FunctionLikeDeclaration): boolean {
	const sig = checker.getSignatureFromDeclaration(fn);
	if (!sig) return false;
	return stringLike(checker, checker.getReturnTypeOfSignature(sig));
}

function isAsyncFn(fn: ts.FunctionLikeDeclaration): boolean {
	return !!ts.getModifiers(fn)?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
}

/**
 * Classify every named function under `include` by its formatting/data
 * concerns. Nested anonymous callbacks contribute their signals to the nearest
 * enclosing named function; nested *named* functions get their own record (so
 * signals are not double-counted).
 */
export async function classifyConcerns(
	source: ProgramOptions | AnalysisProgram,
	opts: ConcernOptions = {},
): Promise<FunctionConcern[]> {
	const minPresentation = opts.minPresentationSignals ?? 1;
	const prog = "program" in source ? source : await createAnalysisProgram(source);
	const { checker, relOf } = prog;
	const out: FunctionConcern[] = [];
	const seen = new Set<string>();

	for (const sf of prog.sourceFiles) {
		const file = path.resolve(sf.fileName);
		const rel = relOf(file);

		const analyze = (info: FnInfo): void => {
			let templates = 0;
			let joins = 0;
			let pads = 0;
			let newlines = 0;
			let awaits = 0;

			const walk = (node: ts.Node, inError: boolean): void => {
				// Stop at nested named functions — they get their own record.
				if (node !== info.fn && fnInfo(node)) return;
				// Strings inside `throw` / `new *Error(...)` are diagnostics, not
				// presentation output, so they don't count as formatting signals.
				const err = inError || ts.isThrowStatement(node) || isErrorConstruction(node);
				if (!err) {
					if (ts.isTemplateExpression(node)) templates++;
					// A literal with an *embedded* newline plus other text is a multi-line
					// output fragment; a bare "\n" (as in split/join/comparisons) is not.
					if (ts.isStringLiteralLike(node) && node.text.includes("\n") && node.text.length > 1) {
						newlines++;
					}
					if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
						const m = node.expression.name.text;
						if (m === "join") joins++;
						else if (m === "padStart" || m === "padEnd" || m === "repeat") pads++;
					}
				}
				if (ts.isAwaitExpression(node)) awaits++;
				ts.forEachChild(node, (c) => walk(c, err));
			};
			if (info.fn.body) ts.forEachChild(info.fn.body, (c) => walk(c, false));

			const line = sf.getLineAndCharacterOfPosition(info.fn.getStart(sf)).line + 1;
			let id = `${rel}#${info.name}`;
			if (seen.has(id)) id = `${id}@${line}`;
			seen.add(id);

			// `.join` is weak (path.join, csv), so presentation excludes it; the
			// strong signals are templates, padding, and embedded-newline literals.
			const presentation = templates + pads + newlines;
			const bodyAny = presentation + joins;
			const returnsString = returnsStringLike(checker, info.fn);
			const nameSignal = nameLooksFormatting(info.name);
			// Two routes to "formatting": an explicit formatting *name* (strong
			// intent), or a function that actually *returns* a string assembled with
			// presentation ops. A lone template/join in a data/parse function that
			// returns a structured value does not qualify.
			const formats =
				(nameSignal && (returnsString || bodyAny > 0)) ||
				(returnsString && presentation >= minPresentation);
			const isAsync = isAsyncFn(info.fn);
			const handlesData = isAsync || awaits > 0;
			const kind: ConcernKind =
				formats && handlesData ? "mixed" : formats ? "formatting" : handlesData ? "data" : "logic";

			out.push({
				id,
				name: info.name,
				relPath: rel,
				line,
				exported: isExported(info.fn),
				returnsString,
				nameSignal,
				templates,
				joins,
				pads,
				newlines,
				awaits,
				isAsync,
				formats,
				handlesData,
				kind,
			});
		};

		const visit = (node: ts.Node): void => {
			const info = fnInfo(node);
			if (info) analyze(info);
			ts.forEachChild(node, visit);
		};
		visit(sf);
	}

	return out;
}

/** Per-file rollup of concern classification. */
export interface FileConcernProfile {
	relPath: string;
	functions: number;
	formatting: number;
	data: number;
	mixed: number;
	logic: number;
	/** `(formatting + mixed) / functions` — share of the file touching presentation. */
	formattingRatio: number;
	/** Dominant concern by count (ties broken data > logic > formatting > mixed). */
	dominant: ConcernKind;
}

/** Roll {@link classifyConcerns} up per file. */
export function fileConcernProfiles(concerns: FunctionConcern[]): FileConcernProfile[] {
	const byFile = new Map<string, FunctionConcern[]>();
	for (const c of concerns) {
		const list = byFile.get(c.relPath);
		if (list) list.push(c);
		else byFile.set(c.relPath, [c]);
	}
	const profiles: FileConcernProfile[] = [];
	for (const [relPath, list] of byFile) {
		const count = (k: ConcernKind) => list.filter((c) => c.kind === k).length;
		const formatting = count("formatting");
		const data = count("data");
		const mixed = count("mixed");
		const logic = count("logic");
		const order: ConcernKind[] = ["data", "logic", "formatting", "mixed"];
		const dominant = order.reduce((best, k) => (count(k) > count(best) ? k : best)) as ConcernKind;
		profiles.push({
			relPath,
			functions: list.length,
			formatting,
			data,
			mixed,
			logic,
			formattingRatio: list.length > 0 ? (formatting + mixed) / list.length : 0,
			dominant,
		});
	}
	return profiles.sort((a, b) => b.functions - a.functions);
}
