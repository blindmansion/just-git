// A type-level reference graph: nodes are named type declarations (interfaces,
// type aliases, enums, classes) in the internal files; edges mean "type A
// mentions type B in its definition" (heritage, property/param/return types,
// type arguments, etc.). This complements the import graph — it can pinpoint
// type-only tangles (e.g. the lib↔git.ts cycle) that the runtime graph can't.

import * as path from "node:path";
import * as ts from "typescript";
import { type AnalysisProgram, createAnalysisProgram } from "./program.ts";
import { stronglyConnectedComponents } from "./query.ts";
import type { ProgramOptions } from "./types.ts";

export type TypeDeclKind = "interface" | "type-alias" | "enum" | "class";

export interface TypeNode {
	/** Stable id: `${relPath}#${name}`. */
	id: string;
	name: string;
	file: string;
	relPath: string;
	kind: TypeDeclKind;
	exported: boolean;
}

export interface TypeEdge {
	fromId: string;
	toId: string;
}

export interface TypeGraph {
	root: string;
	nodes: Map<string, TypeNode>;
	edges: TypeEdge[];
}

function declKind(node: ts.Node): TypeDeclKind | undefined {
	if (ts.isInterfaceDeclaration(node)) return "interface";
	if (ts.isTypeAliasDeclaration(node)) return "type-alias";
	if (ts.isEnumDeclaration(node)) return "enum";
	if (ts.isClassDeclaration(node)) return "class";
	return undefined;
}

type NamedTypeDecl =
	| ts.InterfaceDeclaration
	| ts.TypeAliasDeclaration
	| ts.EnumDeclaration
	| ts.ClassDeclaration;

function isExported(node: ts.Node): boolean {
	const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
	return mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

/**
 * Build the type-reference graph for the configured directories.
 *
 * @example
 * const tg = await buildTypeGraph({ include: "src/lib" });
 * for (const cyc of typeCycles(tg)) console.log(cyc.join(" -> "));
 */
export async function buildTypeGraph(source: ProgramOptions | AnalysisProgram): Promise<TypeGraph> {
	const prog = "program" in source ? source : await createAnalysisProgram(source);
	const { checker, relOf, root } = prog;

	const nodes = new Map<string, TypeNode>();
	const symbolToId = new Map<ts.Symbol, string>();
	const declsById = new Map<string, NamedTypeDecl[]>();

	// Pass 1 — collect declarations.
	for (const sf of prog.sourceFiles) {
		const file = path.resolve(sf.fileName);
		const rel = relOf(file);
		for (const stmt of sf.statements) {
			const kind = declKind(stmt);
			if (!kind) continue;
			const decl = stmt as NamedTypeDecl;
			const name = decl.name?.text;
			if (!name) continue;
			const id = `${rel}#${name}`;
			if (!nodes.has(id)) {
				nodes.set(id, { id, name, file, relPath: rel, kind, exported: isExported(decl) });
				declsById.set(id, []);
			}
			declsById.get(id)?.push(decl);
			const sym = decl.name && checker.getSymbolAtLocation(decl.name);
			if (sym) symbolToId.set(sym, id);
		}
	}

	const resolveToId = (entity: ts.EntityName | ts.Expression): string | undefined => {
		let sym = checker.getSymbolAtLocation(entity);
		if (!sym && ts.isQualifiedName(entity)) sym = checker.getSymbolAtLocation(entity.right);
		if (!sym) return undefined;
		if (sym.flags & ts.SymbolFlags.Alias) {
			try {
				sym = checker.getAliasedSymbol(sym);
			} catch {
				// keep alias symbol
			}
		}
		return symbolToId.get(sym);
	};

	// Pass 2 — collect references inside each declaration.
	const edgeSet = new Set<string>();
	const edges: TypeEdge[] = [];
	for (const [id, decls] of declsById) {
		for (const decl of decls) {
			const visit = (node: ts.Node): void => {
				if (ts.isTypeReferenceNode(node)) {
					const toId = resolveToId(node.typeName);
					if (toId && toId !== id) {
						const key = `${id}\u0000${toId}`;
						if (!edgeSet.has(key)) {
							edgeSet.add(key);
							edges.push({ fromId: id, toId });
						}
					}
				} else if (ts.isExpressionWithTypeArguments(node)) {
					// heritage: `extends Foo` / `implements Bar`
					const toId = resolveToId(node.expression);
					if (toId && toId !== id) {
						const key = `${id}\u0000${toId}`;
						if (!edgeSet.has(key)) {
							edgeSet.add(key);
							edges.push({ fromId: id, toId });
						}
					}
				}
				ts.forEachChild(node, visit);
			};
			// Walk children (skip the declaration's own name node).
			ts.forEachChild(decl, visit);
		}
	}

	return { root, nodes, edges };
}

/** Types that `id` references. */
export function typeReferences(graph: TypeGraph, id: string): string[] {
	return graph.edges
		.filter((e) => e.fromId === id)
		.map((e) => e.toId)
		.sort();
}

/** Types that reference `id`. */
export function typeReferrers(graph: TypeGraph, id: string): string[] {
	return graph.edges
		.filter((e) => e.toId === id)
		.map((e) => e.fromId)
		.sort();
}

/** Strongly-connected type clusters (mutually-referential types / type cycles). */
export function typeCycles(graph: TypeGraph): string[][] {
	const succ = new Map<string, Set<string>>();
	for (const id of graph.nodes.keys()) succ.set(id, new Set());
	for (const e of graph.edges) succ.get(e.fromId)?.add(e.toId);
	return stronglyConnectedComponents(graph.nodes.keys(), (id) => succ.get(id) ?? []);
}
