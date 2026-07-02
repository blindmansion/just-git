import { beforeAll, describe, expect, test } from "bun:test";
import {
	buildImportGraph,
	findCycles,
	findLayerViolations,
	type ImportGraph,
	isRuntimeEdge,
} from "./index.ts";

// ──────────────────────────────────────────────────────────────────────────
// Layering policy for `src/`.
//
// These are architectural invariants, enforced as part of the normal suite.
// They operate on RUNTIME edges only (see `isRuntimeEdge`): `import type` and
// other erased imports may freely point "up" the stack — only edges that
// survive to runtime constrain layering and can form real import cycles.
// ──────────────────────────────────────────────────────────────────────────

/**
 * Directory layers, ordered foundational → high-level. A module may import its
 * own layer or any *lower* one; importing a higher layer at runtime is a
 * violation. Entries are root-relative path prefixes.
 *
 * `lib`/`parse` and `store`/`repo`/`proxy` are peers (no edges between them),
 * so their relative order within the list is arbitrary.
 */
const LAYERS = ["lib", "parse", "store", "repo", "proxy", "server", "cli", "commands"] as const;

/**
 * Top-level `src/*.ts` modules are exempt: they are either pure *contracts*
 * (`fs.ts`, `hooks.ts` — interface/type definitions everything depends inward
 * on) or *composition roots* (`index.ts`, `git.ts`, `transport.ts`,
 * `tree-backed-fs.ts`) whose job is to wire the layers together for the public
 * entrypoints. They are excluded from `LAYERS`, so edges touching them are
 * ignored by `findLayerViolations`.
 */

/**
 * Known runtime import cycles, expressed as sorted root-relative file sets.
 * Now empty: `lib` has no runtime cycles. The guard test fails if a NEW cycle
 * appears (add it here with justification) or if a baselined entry is fixed
 * (delete it), so this list must always mirror reality exactly.
 *
 * History: the `refs ↔ reflog ↔ repo` and
 * `command-utils ↔ tree-ops ↔ unpack-trees ↔ worktree` cycles were dissolved by
 * moving the stray leaf helpers `ensureParentDir` and `comparePaths` into
 * `path.ts`, then extracting the error helpers (`err`/`fatal`/…) out of the
 * `command-utils` god-file into a dependency-free `command-errors.ts`.
 */
const KNOWN_RUNTIME_CYCLES: string[][] = [];

describe("src layering policy", () => {
	let graph: ImportGraph;

	beforeAll(async () => {
		graph = await buildImportGraph({ include: "src", root: "src" });
	});

	test("core is self-contained: no external or builtin imports", () => {
		const foreign = graph.edges.filter((e) => e.target !== "internal");
		const offenders = foreign.map((e) => `${e.specifier} (${e.target})`);
		expect(offenders).toEqual([]);
	});

	test("all module specifiers resolve", () => {
		expect(graph.diagnostics).toEqual([]);
	});

	test("runtime dependencies only point downward through the layers", () => {
		const violations = findLayerViolations(graph, [...LAYERS], { edgeFilter: isRuntimeEdge });
		const report = violations.map((v) => {
			const from = graph.nodes.get(v.edge.fromFile)?.relPath;
			const to = v.edge.toFile ? graph.nodes.get(v.edge.toFile)?.relPath : v.edge.specifier;
			return `${from}:${v.edge.line} -> ${to}  (${v.fromLayer} imports ${v.toLayer})`;
		});
		expect(report).toEqual([]);
	});

	test("no runtime import cycles beyond the documented baseline", () => {
		const cycles = runtimeCycles(graph);
		const baseline = new Set(KNOWN_RUNTIME_CYCLES.map(cycleKey));
		const unexpected = cycles.filter((c) => !baseline.has(cycleKey(c)));
		expect(unexpected).toEqual([]);

		// And the baseline itself stays accurate (no stale entries claiming a
		// cycle that no longer exists).
		const present = new Set(cycles.map(cycleKey));
		const stale = KNOWN_RUNTIME_CYCLES.filter((c) => !present.has(cycleKey(c)));
		expect(stale).toEqual([]);
	});
});

/** Runtime SCCs as sorted, root-relative file lists. */
function runtimeCycles(graph: ImportGraph): string[][] {
	return findCycles(graph, { edgeFilter: isRuntimeEdge })
		.map((scc) => scc.map((f) => graph.nodes.get(f)?.relPath ?? f).sort())
		.sort((a, b) => (a[0] ?? "").localeCompare(b[0] ?? ""));
}

function cycleKey(scc: string[]): string {
	return [...scc].sort().join("|");
}
