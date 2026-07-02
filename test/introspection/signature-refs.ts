// Signature-level type-reference finder.
//
// The type graph (type-graph.ts) records type→type references between *type
// declarations*. This complements it at the *value* level: for every named
// function it asks whether a target named type (e.g. `CommandResult`) appears
// anywhere in the function's signature — its return type or any parameter type,
// unwrapping `Promise<…>`, unions, and arrays.
//
// Because it resolves types through the checker, it catches *implicit*
// references too: a function whose body is `return fatal(...)` has inferred
// return type `CommandResult` even though the name never appears in its source.
// That makes it the right tool for "where does type X still leak into layer Y?"
// leak-hunting (e.g. driving `CommandResult` out of `lib`).

import * as path from "node:path";
import * as ts from "typescript";
import { type AnalysisProgram, createAnalysisProgram } from "./program.ts";
import type { ProgramOptions } from "./types.ts";

/** Where a target type appears within a function's signature. */
export type SignaturePosition = "return" | "param";

/** A named function whose signature references one of the target types. */
export interface SignatureRef {
	/** Stable id: `${relPath}#${qualifiedName}` (with `@line` on collision). */
	id: string;
	name: string;
	relPath: string;
	line: number;
	exported: boolean;
	/** Positions the target type appears in (deduped). */
	positions: SignaturePosition[];
	/** The matched target type name(s). */
	types: string[];
}

interface FnInfo {
	name: string;
	fn: ts.FunctionLikeDeclaration;
}

function fnInfo(node: ts.Node): FnInfo | undefined {
	if (ts.isFunctionDeclaration(node) && node.name) return { name: node.name.text, fn: node };
	if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
		const cls = node.parent;
		const clsName =
			(ts.isClassDeclaration(cls) || ts.isClassExpression(cls)) && cls.name
				? `${cls.name.text}.`
				: "";
		return { name: `${clsName}${node.name.text}`, fn: node };
	}
	if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
		const parent = node.parent;
		if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
			return { name: parent.name.text, fn: node };
		}
		if (ts.isPropertyDeclaration(parent) && ts.isIdentifier(parent.name)) {
			const cls = parent.parent;
			const clsName =
				(ts.isClassDeclaration(cls) || ts.isClassExpression(cls)) && cls.name
					? `${cls.name.text}.`
					: "";
			return { name: `${clsName}${parent.name.text}`, fn: node };
		}
		if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) {
			return { name: parent.name.text, fn: node };
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

/** Collect every named type this type "mentions", unwrapping Promise/union/array. */
function typeNamesOf(
	checker: ts.TypeChecker,
	type: ts.Type,
	seen = new Set<ts.Type>(),
): Set<string> {
	const out = new Set<string>();
	const add = (names: Set<string>) => {
		for (const n of names) out.add(n);
	};
	if (seen.has(type)) return out;
	seen.add(type);

	const named = type.aliasSymbol?.name ?? type.getSymbol()?.name;
	if (named && named !== "__type" && named !== "Array" && named !== "Promise") out.add(named);

	if (type.aliasSymbol) {
		for (const arg of type.aliasTypeArguments ?? []) add(typeNamesOf(checker, arg, seen));
	}
	const sym = type.getSymbol();
	if (sym?.name === "Promise" || sym?.name === "Array" || checker.isArrayType(type)) {
		for (const arg of checker.getTypeArguments(type as ts.TypeReference)) {
			add(typeNamesOf(checker, arg, seen));
		}
	}
	if (type.isUnionOrIntersection()) {
		for (const t of type.types) add(typeNamesOf(checker, t, seen));
	}
	return out;
}

/** A named function whose return type contains an object arm of a given shape. */
export interface ShapeReturnRef {
	/** Stable id: `${relPath}#${qualifiedName}` (with `@line` on collision). */
	id: string;
	name: string;
	relPath: string;
	line: number;
	exported: boolean;
}

/** Every object arm of a type, unwrapping `Promise<…>` and top-level unions. */
function returnObjectArms(checker: ts.TypeChecker, type: ts.Type): ts.Type[] {
	const awaited = checker.getAwaitedType(type) ?? type;
	const arms = awaited.isUnion() ? awaited.types : [awaited];
	return arms.filter((t) => (t.flags & ts.TypeFlags.Object) !== 0);
}

/**
 * Find every named function under `include` whose *return type* has an object
 * arm carrying **all** of `requiredProps` — matching by structure, not by name,
 * so it catches the anonymous `{ stdout, stderr, exitCode }` CLI-result shapes
 * that {@link functionsReferencingType} misses (those never mention the
 * `CommandResult` type). Unwraps `Promise<…>` and top-level unions, so a
 * `Promise<Ok | { stdout; stderr; exitCode }>` return is flagged on its failure
 * arm.
 */
export async function functionsReturningShape(
	source: ProgramOptions | AnalysisProgram,
	requiredProps: string[],
): Promise<ShapeReturnRef[]> {
	const prog = "program" in source ? source : await createAnalysisProgram(source);
	const { checker, relOf } = prog;
	const out: ShapeReturnRef[] = [];
	const seenIds = new Set<string>();

	for (const sf of prog.sourceFiles) {
		const rel = relOf(path.resolve(sf.fileName));
		const visit = (node: ts.Node): void => {
			const info = fnInfo(node);
			if (info) {
				const sig = checker.getSignatureFromDeclaration(info.fn);
				if (sig) {
					const arms = returnObjectArms(checker, checker.getReturnTypeOfSignature(sig));
					const match = arms.some((arm) => {
						const props = new Set(checker.getPropertiesOfType(arm).map((p) => p.getName()));
						return requiredProps.every((p) => props.has(p));
					});
					if (match) {
						const line = sf.getLineAndCharacterOfPosition(info.fn.getStart(sf)).line + 1;
						let id = `${rel}#${info.name}`;
						if (seenIds.has(id)) id = `${id}@${line}`;
						seenIds.add(id);
						out.push({ id, name: info.name, relPath: rel, line, exported: isExported(info.fn) });
					}
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(sf);
	}

	return out;
}

/**
 * Find every named function under `include` whose signature (return type or any
 * parameter type) references one of `targetTypes`. Matching is by type *name*
 * resolved through the checker, so implicit inferred returns count too.
 */
export async function functionsReferencingType(
	source: ProgramOptions | AnalysisProgram,
	targetTypes: string[],
): Promise<SignatureRef[]> {
	const targets = new Set(targetTypes);
	const prog = "program" in source ? source : await createAnalysisProgram(source);
	const { checker, relOf } = prog;
	const out: SignatureRef[] = [];
	const seenIds = new Set<string>();

	for (const sf of prog.sourceFiles) {
		const rel = relOf(path.resolve(sf.fileName));

		const visit = (node: ts.Node): void => {
			const info = fnInfo(node);
			if (info) {
				const sig = checker.getSignatureFromDeclaration(info.fn);
				if (sig) {
					const positions = new Set<SignaturePosition>();
					const matched = new Set<string>();
					const hits = (names: Set<string>, pos: SignaturePosition) => {
						for (const n of names) {
							if (targets.has(n)) {
								positions.add(pos);
								matched.add(n);
							}
						}
					};
					hits(typeNamesOf(checker, checker.getReturnTypeOfSignature(sig)), "return");
					for (const p of sig.getParameters()) {
						const decl = p.valueDeclaration;
						if (!decl) continue;
						hits(typeNamesOf(checker, checker.getTypeOfSymbolAtLocation(p, decl)), "param");
					}
					if (matched.size > 0) {
						const line = sf.getLineAndCharacterOfPosition(info.fn.getStart(sf)).line + 1;
						let id = `${rel}#${info.name}`;
						if (seenIds.has(id)) id = `${id}@${line}`;
						seenIds.add(id);
						out.push({
							id,
							name: info.name,
							relPath: rel,
							line,
							exported: isExported(info.fn),
							positions: [...positions],
							types: [...matched],
						});
					}
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(sf);
	}

	return out;
}
