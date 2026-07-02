import { beforeAll, describe, expect, test } from "bun:test";
import {
	buildImportGraph,
	dependents,
	findCycles,
	findLayerViolations,
	functionsReferencingType,
	functionsReturningShape,
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
 * `lib` and `store`/`repo`/`proxy` are peers (no edges between them), so their
 * relative order within the list is arbitrary.
 *
 * The command tier is `commands/` (leaf handlers) sitting on top of its private
 * substrate `commands/kit/` (the `CommandResult` contract + cross-command
 * orchestration). Two pure sub-namespaces live *below* the orchestration inside
 * the kit: argument parsing (`commands/kit/parse`) and the renderers
 * (`commands/kit/format`, i.e. `(data struct) → string`). Layer membership is by
 * longest-prefix match, so these nested prefixes are first-class layers:
 *
 *   - No data-core layer may import the kit, so any `data → commands/kit` runtime
 *     edge is a violation ("presentation/orchestration is owned by the command
 *     tier"; see `local-docs/plans/lib-formatting-data-separation.md`).
 *   - `format`/`parse` sit below the orchestration, so a renderer or the parser
 *     reaching *up* into the orchestration (e.g. importing `command-errors` /
 *     `CommandResult`) is a violation — this keeps them pure.
 */
const LAYERS = [
	"lib",
	"store",
	"repo",
	"proxy",
	"server",
	"commands/kit/parse",
	"commands/kit/format",
	"commands/kit",
	"commands",
] as const;

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

// ──────────────────────────────────────────────────────────────────────────
// The CLI command contract is owned by `commands/kit/`, never `lib/`.
//
// `lib` gathers structured data; the command tier renders it and decides the
// exit code. These guards are the end-state of the formatting/data-separation
// work (see `local-docs/plans/lib-formatting-data-separation.md`): they fail if
// the `CommandResult` contract — named *or* by its `{ stdout, stderr, exitCode }`
// shape — ever leaks back into the data core.
// ──────────────────────────────────────────────────────────────────────────
describe("lib is free of the CLI command contract", () => {
	test("no lib function has CommandResult in its signature", async () => {
		const refs = await functionsReferencingType({ include: "src/lib" }, ["CommandResult"]);
		expect(refs.map((r) => r.id)).toEqual([]);
	});

	test("no lib function returns an inline { stdout, stderr, exitCode } shape", async () => {
		const refs = await functionsReturningShape({ include: "src/lib" }, [
			"stdout",
			"stderr",
			"exitCode",
		]);
		expect(refs.map((r) => r.id)).toEqual([]);
	});

	test("no lib file imports the command-errors module", async () => {
		const graph = await buildImportGraph({ include: "src", root: "src" });
		const commandErrors = [...graph.nodes.values()].find(
			(n) => n.relPath === "commands/kit/command-errors.ts",
		);
		expect(commandErrors).toBeDefined();
		const libImporters = dependents(graph, commandErrors!.file)
			.map((f) => graph.nodes.get(f)?.relPath ?? f)
			.filter((rel) => rel.startsWith("lib/"));
		expect(libImporters).toEqual([]);
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
