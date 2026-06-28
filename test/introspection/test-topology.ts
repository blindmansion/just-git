// Maps the test suite onto the source tree using the import graph: which tests
// (transitively, at runtime) exercise each source file, which files no test
// reaches, and — given a set of changed files — which tests are impacted.
//
// "Covered" here means runtime-reachable from a test via imports, not
// statement coverage. It answers "what should I run / what's untested?" at file
// granularity, which is exactly the validation question agents hit most.

import * as path from "node:path";
import { buildImportGraph } from "./build-graph.ts";
import { isRuntimeEdge } from "./query.ts";
import type { BuildGraphOptions, ImportEdge, ImportGraph } from "./types.ts";

export interface TestTopologyOptions extends BuildGraphOptions {
	/**
	 * Marks a node (by root-relative path) as a test file. Default: anything
	 * ending in `.test.ts(x)`.
	 */
	isTest?: (relPath: string) => boolean;
	/**
	 * Which edges count as "exercises". Default `isRuntimeEdge` — a test that only
	 * imports a *type* from a file does not run it.
	 */
	edgeFilter?: (edge: ImportEdge) => boolean;
}

export interface TestTopology {
	/** The underlying import graph (spanning the configured include roots). */
	graph: ImportGraph;
	/** Absolute paths of test files. */
	testFiles: string[];
	/** Absolute paths of non-test internal files (the subjects under test). */
	subjectFiles: string[];
	/** Subject file -> set of test files that transitively reach it. */
	coveredBy: Map<string, Set<string>>;
	/** Subject files reached by no test. */
	uncovered: string[];
}

const defaultIsTest = (relPath: string) => /\.test\.tsx?$/.test(relPath);

/**
 * Build the test↔source topology. Defaults to graphing `src` + `test` from the
 * repo root.
 */
export async function buildTestTopology(
	options: Partial<TestTopologyOptions> = {},
): Promise<TestTopology> {
	const graph = await buildImportGraph({
		include: options.include ?? ["src", "test"],
		root: options.root ?? ".",
		tsconfigPath: options.tsconfigPath,
		includeDeclarations: options.includeDeclarations,
		ignore: options.ignore,
	});
	const isTest = options.isTest ?? defaultIsTest;
	const edgeFilter = options.edgeFilter ?? isRuntimeEdge;

	// Forward adjacency over internal edges that pass the filter.
	const adj = new Map<string, Set<string>>();
	for (const node of graph.nodes.values()) adj.set(node.file, new Set());
	for (const edge of graph.edges) {
		if (edge.target !== "internal" || !edge.toFile) continue;
		if (!edgeFilter(edge)) continue;
		adj.get(edge.fromFile)?.add(edge.toFile);
	}

	const testFiles: string[] = [];
	const subjectFiles: string[] = [];
	for (const node of graph.nodes.values()) {
		if (node.category !== "internal") continue;
		if (isTest(node.relPath)) testFiles.push(node.file);
		else subjectFiles.push(node.file);
	}
	testFiles.sort();
	subjectFiles.sort();

	const coveredBy = new Map<string, Set<string>>();
	for (const file of subjectFiles) coveredBy.set(file, new Set());

	for (const test of testFiles) {
		const seen = new Set<string>([test]);
		const queue = [test];
		while (queue.length > 0) {
			const cur = queue.pop() as string;
			for (const next of adj.get(cur) ?? []) {
				if (seen.has(next)) continue;
				seen.add(next);
				queue.push(next);
				coveredBy.get(next)?.add(test);
			}
		}
	}

	const uncovered = subjectFiles.filter((f) => (coveredBy.get(f)?.size ?? 0) === 0).sort();
	return { graph, testFiles, subjectFiles, coveredBy, uncovered };
}

/** Test files that transitively exercise `file` (absolute or root-relative). */
export function testsCovering(topo: TestTopology, file: string): string[] {
	const abs = topo.coveredBy.has(file)
		? file
		: [...topo.coveredBy.keys()].find((f) => topo.graph.nodes.get(f)?.relPath === file);
	if (!abs) return [];
	return [...(topo.coveredBy.get(abs) ?? [])].sort();
}

/**
 * Given changed subject files, the set of test files that should be re-run
 * (any test transitively reaching at least one changed file). Inputs may be
 * absolute or root-relative paths.
 */
export function impactedTests(topo: TestTopology, changed: string[]): string[] {
	const byRel = new Map<string, string>();
	for (const f of topo.coveredBy.keys()) {
		byRel.set(f, f);
		byRel.set(topo.graph.nodes.get(f)?.relPath ?? f, f);
	}
	const impacted = new Set<string>();
	for (const c of changed) {
		const abs = byRel.get(c) ?? byRel.get(path.resolve(c));
		if (!abs) continue;
		for (const t of topo.coveredBy.get(abs) ?? []) impacted.add(t);
	}
	return [...impacted].sort();
}
