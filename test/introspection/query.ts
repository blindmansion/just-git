// Query helpers over a built `ImportGraph`. These are intentionally small,
// composable primitives so targeted scripts/tests can be written in a few
// lines: traversal, reverse lookup, cycle detection, external-dependency
// rollups, directory-level layering matrices, and layering-rule checks.

import type { EdgeTarget, ImportEdge, ImportGraph, ModuleNode } from "./types.ts";

/**
 * Whether an edge represents a *runtime* dependency — i.e. it survives type
 * erasure and therefore matters for layering, bundling, and circular-import
 * behaviour. Type-only statements and value-form imports whose every binding is
 * actually a type (which TypeScript elides) are NOT runtime edges. Side-effect
 * imports and non-type re-exports are.
 */
export function isRuntimeEdge(edge: ImportEdge): boolean {
	if (edge.isTypeOnly) return false;
	if (edge.bindings.length === 0) return true; // side-effect import or `export * from`
	return edge.bindings.some((b) => !b.isTypeOnly && b.kind !== "type");
}

/** Look up a node by absolute or root-relative path. */
export function getNode(graph: ImportGraph, file: string): ModuleNode | undefined {
	if (graph.nodes.has(file)) return graph.nodes.get(file);
	for (const node of graph.nodes.values()) {
		if (node.relPath === file) return node;
	}
	return undefined;
}

/** Convenience: an absolute file's root-relative path, falling back to the input. */
export function relPathOf(graph: ImportGraph, file: string): string {
	return graph.nodes.get(file)?.relPath ?? file;
}

/** The parent directory of a root-relative path (`"."` for top-level files). */
export function parentDir(relPath: string): string {
	const i = relPath.lastIndexOf("/");
	return i < 0 ? "." : relPath.slice(0, i);
}

/** All internal (include-root) nodes. */
export function internalNodes(graph: ImportGraph): ModuleNode[] {
	return [...graph.nodes.values()].filter((n) => n.category === "internal");
}

/** Filter all edges by an arbitrary predicate. */
export function edgesWhere(
	graph: ImportGraph,
	predicate: (edge: ImportEdge) => boolean,
): ImportEdge[] {
	return graph.edges.filter(predicate);
}

/** Edges whose entire statement is type-only (`import type` / `export type`). */
export function typeOnlyEdges(graph: ImportGraph): ImportEdge[] {
	return graph.edges.filter((e) => e.isTypeOnly);
}

/**
 * Edges that import at least one runtime *value* but are not declared
 * type-only — i.e. genuine runtime dependencies (the ones that matter for
 * layering / bundling).
 */
export function valueEdges(graph: ImportGraph): ImportEdge[] {
	return graph.edges.filter(
		(e) =>
			!e.isTypeOnly &&
			e.bindings.some((b) => !b.isTypeOnly && (b.kind === "value" || b.kind === "value-and-type")),
	);
}

/** Resolved internal files that `file` depends on (deduped). */
export function dependencies(
	graph: ImportGraph,
	file: string,
	opts: { targets?: EdgeTarget[] } = {},
): string[] {
	const node = getNode(graph, file);
	if (!node) return [];
	const targets = new Set(opts.targets ?? ["internal"]);
	const out = new Set<string>();
	for (const edge of node.imports) {
		if (edge.toFile && targets.has(edge.target)) out.add(edge.toFile);
	}
	return [...out].sort();
}

/** Build a reverse index: target file -> set of files importing it. */
export function buildReverseIndex(graph: ImportGraph): Map<string, Set<string>> {
	const reverse = new Map<string, Set<string>>();
	for (const edge of graph.edges) {
		if (!edge.toFile) continue;
		let set = reverse.get(edge.toFile);
		if (!set) {
			set = new Set();
			reverse.set(edge.toFile, set);
		}
		set.add(edge.fromFile);
	}
	return reverse;
}

/** Internal files that depend on `file`. */
export function dependents(graph: ImportGraph, file: string): string[] {
	const node = getNode(graph, file);
	if (!node) return [];
	const reverse = buildReverseIndex(graph);
	return [...(reverse.get(node.file) ?? [])].sort();
}

/**
 * Strongly-connected components of the internal-edge subgraph that represent
 * cycles: every returned group either has >1 file or is a single file that
 * imports itself. Uses iterative Tarjan to stay safe on large graphs.
 */
export function findCycles(
	graph: ImportGraph,
	opts: { edgeFilter?: (edge: ImportEdge) => boolean } = {},
): string[][] {
	const adj = new Map<string, string[]>();
	for (const node of graph.nodes.values()) {
		if (node.category !== "internal") continue;
		const targets = new Set<string>();
		for (const edge of node.imports) {
			if (edge.target === "internal" && edge.toFile && graph.nodes.has(edge.toFile)) {
				if (opts.edgeFilter && !opts.edgeFilter(edge)) continue;
				targets.add(edge.toFile);
			}
		}
		adj.set(node.file, [...targets]);
	}

	let index = 0;
	const indices = new Map<string, number>();
	const low = new Map<string, number>();
	const onStack = new Set<string>();
	const stack: string[] = [];
	const sccs: string[][] = [];

	type Frame = { node: string; childIdx: number };

	for (const start of adj.keys()) {
		if (indices.has(start)) continue;
		const frames: Frame[] = [{ node: start, childIdx: 0 }];
		while (frames.length > 0) {
			const frame = frames[frames.length - 1] as Frame;
			const v = frame.node;
			if (frame.childIdx === 0) {
				indices.set(v, index);
				low.set(v, index);
				index++;
				stack.push(v);
				onStack.add(v);
			}
			const children = adj.get(v) ?? [];
			if (frame.childIdx < children.length) {
				const w = children[frame.childIdx] as string;
				frame.childIdx++;
				if (!indices.has(w)) {
					frames.push({ node: w, childIdx: 0 });
				} else if (onStack.has(w)) {
					low.set(v, Math.min(low.get(v) as number, indices.get(w) as number));
				}
			} else {
				if (low.get(v) === indices.get(v)) {
					const component: string[] = [];
					let w: string;
					do {
						w = stack.pop() as string;
						onStack.delete(w);
						component.push(w);
					} while (w !== v);
					const selfLoop = (adj.get(v) ?? []).includes(v);
					if (component.length > 1 || selfLoop) sccs.push(component.sort());
				}
				frames.pop();
				const parent = frames[frames.length - 1];
				if (parent)
					low.set(parent.node, Math.min(low.get(parent.node) as number, low.get(v) as number));
			}
		}
	}

	return sccs;
}

/**
 * Generic Tarjan strongly-connected-components over any string-keyed directed
 * graph. Returns only components that represent cycles: size > 1, or a single
 * node with a self-edge. Reused by import/type/call cycle detection.
 */
export function stronglyConnectedComponents(
	nodes: Iterable<string>,
	successors: (node: string) => Iterable<string>,
): string[][] {
	let index = 0;
	const idx = new Map<string, number>();
	const low = new Map<string, number>();
	const onStack = new Set<string>();
	const stack: string[] = [];
	const sccs: string[][] = [];

	const strongConnect = (v: string): void => {
		idx.set(v, index);
		low.set(v, index);
		index++;
		stack.push(v);
		onStack.add(v);
		let selfLoop = false;
		for (const w of successors(v)) {
			if (w === v) selfLoop = true;
			if (!idx.has(w)) {
				strongConnect(w);
				low.set(v, Math.min(low.get(v) as number, low.get(w) as number));
			} else if (onStack.has(w)) {
				low.set(v, Math.min(low.get(v) as number, idx.get(w) as number));
			}
		}
		if (low.get(v) === idx.get(v)) {
			const component: string[] = [];
			let w: string;
			do {
				w = stack.pop() as string;
				onStack.delete(w);
				component.push(w);
			} while (w !== v);
			if (component.length > 1 || selfLoop) sccs.push(component.sort());
		}
	};

	for (const n of nodes) if (!idx.has(n)) strongConnect(n);
	return sccs;
}

/** Roll up external package usage: bare specifier -> count of importing edges. */
export function externalPackages(graph: ImportGraph): Map<string, number> {
	const counts = new Map<string, number>();
	for (const edge of graph.edges) {
		if (edge.target !== "package" && edge.target !== "builtin") continue;
		counts.set(edge.specifier, (counts.get(edge.specifier) ?? 0) + 1);
	}
	return new Map([...counts.entries()].sort((a, b) => b[1] - a[1]));
}

/** The directory group a relative path belongs to, taking the first `depth` segments. */
export function groupOf(relPath: string, depth = 1): string {
	const segments = relPath.split("/");
	if (segments.length <= depth) return segments.slice(0, -1).join("/") || ".";
	return segments.slice(0, depth).join("/");
}

/**
 * Directory-level adjacency matrix for layering analysis. Groups internal files
 * by their first `depth` path segments and counts internal edges between groups
 * (self-edges within a group are excluded by default).
 */
export function directoryMatrix(
	graph: ImportGraph,
	opts: { depth?: number; includeSelf?: boolean; edgeFilter?: (edge: ImportEdge) => boolean } = {},
): Map<string, Map<string, number>> {
	const depth = opts.depth ?? 1;
	return groupMatrix(graph, (n) => groupOf(n.relPath, depth), opts);
}

/**
 * Generalised from→to count matrix over internal edges, bucketed by an
 * arbitrary `groupBy`. Return `undefined` from `groupBy` to drop a node.
 * The building block behind {@link directoryMatrix}; pass `parentDir`,
 * a layer lookup, or any custom classifier.
 */
export function groupMatrix(
	graph: ImportGraph,
	groupBy: (node: ModuleNode) => string | undefined,
	opts: { includeSelf?: boolean; edgeFilter?: (edge: ImportEdge) => boolean } = {},
): Map<string, Map<string, number>> {
	const matrix = new Map<string, Map<string, number>>();
	for (const edge of graph.edges) {
		if (edge.target !== "internal" || !edge.toFile) continue;
		if (opts.edgeFilter && !opts.edgeFilter(edge)) continue;
		const fromNode = graph.nodes.get(edge.fromFile);
		const toNode = graph.nodes.get(edge.toFile);
		if (!fromNode || !toNode) continue;
		const from = groupBy(fromNode);
		const to = groupBy(toNode);
		if (from === undefined || to === undefined) continue;
		if (from === to && !opts.includeSelf) continue;
		let row = matrix.get(from);
		if (!row) {
			row = new Map();
			matrix.set(from, row);
		}
		row.set(to, (row.get(to) ?? 0) + 1);
	}
	return matrix;
}

/** Unique-neighbour in/out degree for an internal node. */
export interface Degree {
	in: number;
	out: number;
}

/**
 * Fan-in / fan-out for every internal node, counting *distinct* neighbours
 * (multiple edges between the same pair count once). Pass `edgeFilter:
 * isRuntimeEdge` to measure the runtime graph specifically.
 */
export function degrees(
	graph: ImportGraph,
	opts: { edgeFilter?: (edge: ImportEdge) => boolean } = {},
): Map<string, Degree> {
	const outSets = new Map<string, Set<string>>();
	const inSets = new Map<string, Set<string>>();
	for (const node of graph.nodes.values()) {
		if (node.category !== "internal") continue;
		outSets.set(node.file, new Set());
		inSets.set(node.file, new Set());
	}
	for (const edge of graph.edges) {
		if (edge.target !== "internal" || !edge.toFile || edge.fromFile === edge.toFile) continue;
		if (opts.edgeFilter && !opts.edgeFilter(edge)) continue;
		if (!outSets.has(edge.fromFile) || !inSets.has(edge.toFile)) continue;
		outSets.get(edge.fromFile)?.add(edge.toFile);
		inSets.get(edge.toFile)?.add(edge.fromFile);
	}
	const result = new Map<string, Degree>();
	for (const file of outSets.keys()) {
		result.set(file, { in: inSets.get(file)?.size ?? 0, out: outSets.get(file)?.size ?? 0 });
	}
	return result;
}

/**
 * Dependency depth of every internal node: the length of the longest chain of
 * outgoing internal edges beneath it (leaves are `0`). Cycle-safe — back-edges
 * into the current DFS stack contribute `0` rather than looping. Use
 * `edgeFilter: isRuntimeEdge` to rank the runtime hierarchy.
 */
export function dependencyDepth(
	graph: ImportGraph,
	opts: { edgeFilter?: (edge: ImportEdge) => boolean } = {},
): Map<string, number> {
	const out = new Map<string, Set<string>>();
	for (const node of graph.nodes.values()) {
		if (node.category === "internal") out.set(node.file, new Set());
	}
	for (const edge of graph.edges) {
		if (edge.target !== "internal" || !edge.toFile || edge.fromFile === edge.toFile) continue;
		if (opts.edgeFilter && !opts.edgeFilter(edge)) continue;
		if (out.has(edge.fromFile) && out.has(edge.toFile)) out.get(edge.fromFile)?.add(edge.toFile);
	}
	const memo = new Map<string, number>();
	const stack = new Set<string>();
	const visit = (file: string): number => {
		const cached = memo.get(file);
		if (cached !== undefined) return cached;
		if (stack.has(file)) return 0;
		stack.add(file);
		let depth = 0;
		for (const next of out.get(file) ?? []) depth = Math.max(depth, 1 + visit(next));
		stack.delete(file);
		memo.set(file, depth);
		return depth;
	};
	for (const file of out.keys()) visit(file);
	return memo;
}

/** Cohesion / coupling profile for a candidate grouping of files. */
export interface GroupMetrics {
	/** Number of members resolved in the graph. */
	size: number;
	/** Edges between two members (cohesion). */
	internalEdges: number;
	/** Edges from a member to a non-member (outward coupling). */
	fanOut: number;
	/** Edges from a non-member into a member. */
	fanIn: number;
	/** Distinct member files imported from outside (the group's public surface). */
	publicSurface: number;
	/** Distinct outside files importing the group. */
	externalImporters: number;
	/** Member names that did not resolve to a node. */
	missing: string[];
}

/**
 * Measure how module-like a set of files is: internal cohesion vs outward
 * coupling, plus the public surface (how many of its files are reached from
 * outside). The key tool for evaluating "should these become a directory?".
 * Members may be given as root-relative paths with or without the `.ts` suffix.
 */
export function groupMetrics(
	graph: ImportGraph,
	members: string[],
	opts: { edgeFilter?: (edge: ImportEdge) => boolean } = {},
): GroupMetrics {
	const byRel = new Map<string, string>();
	for (const node of graph.nodes.values()) {
		byRel.set(node.relPath, node.file);
		byRel.set(node.relPath.replace(/\.ts$/, ""), node.file);
	}
	const set = new Set<string>();
	const missing: string[] = [];
	for (const m of members) {
		const file = byRel.get(m);
		if (file) set.add(file);
		else missing.push(m);
	}
	let internalEdges = 0;
	let fanOut = 0;
	let fanIn = 0;
	const surface = new Set<string>();
	const importers = new Set<string>();
	for (const edge of graph.edges) {
		if (edge.target !== "internal" || !edge.toFile) continue;
		if (opts.edgeFilter && !opts.edgeFilter(edge)) continue;
		const fromIn = set.has(edge.fromFile);
		const toIn = set.has(edge.toFile);
		if (fromIn && toIn) internalEdges++;
		else if (fromIn) fanOut++;
		else if (toIn) {
			fanIn++;
			surface.add(edge.toFile);
			importers.add(edge.fromFile);
		}
	}
	return {
		size: set.size,
		internalEdges,
		fanOut,
		fanIn,
		publicSurface: surface.size,
		externalImporters: importers.size,
		missing,
	};
}

/** A single edge that breaks a layering rule. */
export interface LayerViolation {
	edge: ImportEdge;
	fromLayer: string;
	toLayer: string;
}

/**
 * Check directory-based layering. `layers` is ordered from most foundational
 * (index 0) to highest level. A module may import only from its own layer or a
 * lower one; importing a higher layer is a violation. Files matching no layer
 * prefix are ignored. Each layer entry is a root-relative path prefix.
 */
export function findLayerViolations(
	graph: ImportGraph,
	layers: string[],
	opts: { edgeFilter?: (edge: ImportEdge) => boolean } = {},
): LayerViolation[] {
	const layerOf = (relPath: string): number => {
		let best = -1;
		let bestLen = -1;
		for (let i = 0; i < layers.length; i++) {
			const prefix = layers[i] as string;
			if ((relPath === prefix || relPath.startsWith(`${prefix}/`)) && prefix.length > bestLen) {
				best = i;
				bestLen = prefix.length;
			}
		}
		return best;
	};

	const violations: LayerViolation[] = [];
	for (const edge of graph.edges) {
		if (edge.target !== "internal" || !edge.toFile) continue;
		if (opts.edgeFilter && !opts.edgeFilter(edge)) continue;
		const fromNode = graph.nodes.get(edge.fromFile);
		const toNode = graph.nodes.get(edge.toFile);
		if (!fromNode || !toNode) continue;
		const fromLayer = layerOf(fromNode.relPath);
		const toLayer = layerOf(toNode.relPath);
		if (fromLayer === -1 || toLayer === -1) continue;
		if (toLayer > fromLayer) {
			violations.push({
				edge,
				fromLayer: layers[fromLayer] as string,
				toLayer: layers[toLayer] as string,
			});
		}
	}
	return violations;
}

/**
 * Barrel/re-export files: internal modules whose only edges are `export … from`
 * statements (no real logic imports). Useful for spotting indirection layers.
 */
export function barrelFiles(graph: ImportGraph): ModuleNode[] {
	return internalNodes(graph).filter(
		(n) => n.imports.length > 0 && n.imports.every((e) => e.statement === "export"),
	);
}

/**
 * Value imports that the checker says are pure types — candidates to convert to
 * `import type` (or inline `type` modifiers) to drop a runtime dependency.
 */
export function typeImportCandidates(graph: ImportGraph): ImportEdge[] {
	return graph.edges.filter(
		(e) =>
			e.statement === "import" &&
			!e.isTypeOnly &&
			e.bindings.length > 0 &&
			e.bindings.every((b) => !b.isTypeOnly && b.kind === "type"),
	);
}

/** Serialise a graph to a JSON-friendly object (Maps become arrays/records). */
export function serializeGraph(graph: ImportGraph): unknown {
	return {
		root: graph.root,
		includeRoots: graph.includeRoots,
		nodes: [...graph.nodes.values()],
		edges: graph.edges,
		diagnostics: graph.diagnostics,
	};
}
