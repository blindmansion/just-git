// Function-level call graph: nodes are named functions / methods / arrow-or
// function-expression bindings in the internal files; an edge caller→callee
// means the caller's body contains a call the checker resolves to the callee.
//
// This is the heaviest analysis (it leans on `getResolvedSignature`) and is a
// pragmatic approximation: calls inside anonymous callbacks are attributed to
// the nearest enclosing *named* function, and dynamic/indirect calls that the
// checker can't resolve are dropped. Good for sub-module layering, recursion
// clusters, and dead-internal-helper detection.

import * as path from "node:path";
import * as ts from "typescript";
import { type AnalysisProgram, createAnalysisProgram } from "./program.ts";
import { stronglyConnectedComponents } from "./query.ts";
import type { ProgramOptions } from "./types.ts";

export type FunctionKind = "function" | "method" | "arrow" | "function-expression";

export interface FunctionNode {
	/** Stable id: `${relPath}#${qualifiedName}` (with `@line` on collision). */
	id: string;
	/** Qualified name, e.g. `Foo.bar` for methods. */
	name: string;
	file: string;
	relPath: string;
	kind: FunctionKind;
	exported: boolean;
	line: number;
}

export interface CallEdge {
	fromId: string;
	toId: string;
}

export interface CallGraph {
	root: string;
	nodes: Map<string, FunctionNode>;
	edges: CallEdge[];
}

interface FnInfo {
	kind: FunctionKind;
	name: string;
	nameNode: ts.Node;
}

function fnInfo(node: ts.Node): FnInfo | undefined {
	if (ts.isFunctionDeclaration(node) && node.name) {
		return { kind: "function", name: node.name.text, nameNode: node.name };
	}
	if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
		const cls = node.parent;
		const clsName =
			(ts.isClassDeclaration(cls) || ts.isClassExpression(cls)) && cls.name
				? `${cls.name.text}.`
				: "";
		return { kind: "method", name: `${clsName}${node.name.text}`, nameNode: node.name };
	}
	if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
		const parent = node.parent;
		const kind: FunctionKind = ts.isArrowFunction(node) ? "arrow" : "function-expression";
		if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
			return { kind, name: parent.name.text, nameNode: parent.name };
		}
		if (ts.isPropertyDeclaration(parent) && ts.isIdentifier(parent.name)) {
			const cls = parent.parent;
			const clsName =
				(ts.isClassDeclaration(cls) || ts.isClassExpression(cls)) && cls.name
					? `${cls.name.text}.`
					: "";
			return { kind, name: `${clsName}${parent.name.text}`, nameNode: parent.name };
		}
		if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) {
			return { kind, name: parent.name.text, nameNode: parent.name };
		}
	}
	return undefined;
}

function isExported(node: ts.Node): boolean {
	// Walk to the nearest statement that can carry an `export` modifier.
	let cur: ts.Node | undefined = node;
	while (cur) {
		if (ts.canHaveModifiers(cur)) {
			const mods = ts.getModifiers(cur);
			if (mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) return true;
		}
		if (ts.isSourceFile(cur.parent ?? cur)) break;
		cur = cur.parent;
		if (cur && ts.isSourceFile(cur)) break;
	}
	return false;
}

/**
 * Build the call graph for the configured directories.
 *
 * @example
 * const cg = await buildCallGraph({ include: "src/lib" });
 * for (const cyc of callCycles(cg)) console.log(cyc.join(" -> "));
 */
export async function buildCallGraph(source: ProgramOptions | AnalysisProgram): Promise<CallGraph> {
	const prog = "program" in source ? source : await createAnalysisProgram(source);
	const { checker, relOf, root } = prog;

	const nodes = new Map<string, FunctionNode>();
	const declToId = new Map<ts.Node, string>();
	const symbolToId = new Map<ts.Symbol, string>();

	// Pass 1 — register function nodes.
	for (const sf of prog.sourceFiles) {
		const file = path.resolve(sf.fileName);
		const rel = relOf(file);
		const register = (node: ts.Node): void => {
			const info = fnInfo(node);
			if (info) {
				const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
				let id = `${rel}#${info.name}`;
				if (nodes.has(id) && declToId.get(node) === undefined) id = `${id}@${line}`;
				if (!nodes.has(id)) {
					nodes.set(id, {
						id,
						name: info.name,
						file,
						relPath: rel,
						kind: info.kind,
						exported: isExported(node),
						line,
					});
				}
				declToId.set(node, id);
				const sym = checker.getSymbolAtLocation(info.nameNode);
				if (sym && !symbolToId.has(sym)) symbolToId.set(sym, id);
			}
			ts.forEachChild(node, register);
		};
		register(sf);
	}

	const resolveCallee = (call: ts.CallExpression): string | undefined => {
		const sig = checker.getResolvedSignature(call);
		const decl = sig?.declaration;
		if (decl && declToId.has(decl)) return declToId.get(decl);
		let sym = checker.getSymbolAtLocation(call.expression);
		if (sym) {
			if (sym.flags & ts.SymbolFlags.Alias) {
				try {
					sym = checker.getAliasedSymbol(sym);
				} catch {
					// keep alias symbol
				}
			}
			return symbolToId.get(sym);
		}
		return undefined;
	};

	// Pass 2 — attribute calls to the nearest enclosing named function.
	const edgeSet = new Set<string>();
	const edges: CallEdge[] = [];
	for (const sf of prog.sourceFiles) {
		const stack: string[] = [];
		const visit = (node: ts.Node): void => {
			const id = declToId.get(node);
			if (id) stack.push(id);
			if (ts.isCallExpression(node)) {
				const caller = stack[stack.length - 1];
				if (caller) {
					const callee = resolveCallee(node);
					if (callee) {
						const key = `${caller}\u0000${callee}`;
						if (!edgeSet.has(key)) {
							edgeSet.add(key);
							edges.push({ fromId: caller, toId: callee });
						}
					}
				}
			}
			ts.forEachChild(node, visit);
			if (id) stack.pop();
		};
		visit(sf);
	}

	return { root, nodes, edges };
}

/** Functions that `id` calls. */
export function callees(graph: CallGraph, id: string): string[] {
	return graph.edges
		.filter((e) => e.fromId === id)
		.map((e) => e.toId)
		.sort();
}

/** Functions that call `id`. */
export function callers(graph: CallGraph, id: string): string[] {
	return graph.edges
		.filter((e) => e.toId === id)
		.map((e) => e.fromId)
		.sort();
}

/** Recursion clusters: mutually-recursive function groups (and self-recursion). */
export function callCycles(graph: CallGraph): string[][] {
	const succ = new Map<string, Set<string>>();
	for (const id of graph.nodes.keys()) succ.set(id, new Set());
	for (const e of graph.edges) succ.get(e.fromId)?.add(e.toId);
	return stronglyConnectedComponents(graph.nodes.keys(), (id) => succ.get(id) ?? []);
}

/**
 * Functions with no internal callers and not exported — candidate dead code.
 * (A function exported from the package may still be used by consumers/tests,
 * so only non-exported, never-called functions are flagged.)
 */
export function uncalledFunctions(graph: CallGraph): FunctionNode[] {
	const called = new Set(graph.edges.map((e) => e.toId));
	return [...graph.nodes.values()]
		.filter((n) => !n.exported && !called.has(n.id))
		.sort((a, b) => a.id.localeCompare(b.id));
}
