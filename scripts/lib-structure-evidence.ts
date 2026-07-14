// Evidence report for the internal structure of `src/lib`.
//
// Three complementary lenses, all scoped to lib-internal edges only (external
// command-layer consumers are deliberately out of scope:
//
//   1. Import graph  — files, edges, subdirectory coupling, hubs, depth, cycles.
//   2. Symbol graph  — per-module export co-usage clustering (split-seam finder).
//   3. Call graph    — intra-module cohesion, call cycles, dead-helper scan.
//
// Regenerate with `bun scripts/lib-structure-evidence.ts`.

import {
	buildCallGraph,
	buildImportGraph,
	callCycles,
	coUsageClusters,
	createAnalysisProgram,
	degrees,
	dependencyDepth,
	directoryMatrix,
	findCycles,
	formatMatrix,
	internalNodes,
	isRuntimeEdge,
	moduleCallCohesion,
	parentDir,
	relPathOf,
	uncalledFunctions,
} from "../test/introspection/index.ts";

const graph = await buildImportGraph({ include: "src/lib", root: "src/lib" });
const rel = (f: string) => relPathOf(graph, f);
const line = (s = "") => console.log(s);

// ── 1. Import graph ──────────────────────────────────────────────────────────
const nodes = internalNodes(graph);
const internalEdges = graph.edges.filter((e) => e.target === "internal");
const runtimeEdges = internalEdges.filter(isRuntimeEdge);

line("# lib internal structure — evidence\n");
line(
	`files: ${nodes.length} | internal edges: ${internalEdges.length} ` +
	`(runtime: ${runtimeEdges.length})\n`,
);

const byDir = new Map<string, number>();
for (const n of nodes) byDir.set(parentDir(n.relPath), (byDir.get(parentDir(n.relPath)) ?? 0) + 1);
line("## files per directory\n");
for (const [d, c] of [...byDir.entries()].sort((a, b) => b[1] - a[1]))
	line(`  ${d.padEnd(14)}${c}`);

line("\n## subdirectory matrix — runtime edges (row imports column)\n");
line(formatMatrix(directoryMatrix(graph, { edgeFilter: isRuntimeEdge })));

const deg = degrees(graph, { edgeFilter: isRuntimeEdge });
const depth = dependencyDepth(graph, { edgeFilter: isRuntimeEdge });
const byIn = [...deg.entries()].sort((a, b) => b[1].in - a[1].in).slice(0, 10);
const byOut = [...deg.entries()].sort((a, b) => b[1].out - a[1].out).slice(0, 10);
line("\n## hubs (runtime graph)\n");
line("top fan-in (most depended-on):");
for (const [f, d] of byIn)
	line(`  ${rel(f).padEnd(28)} in:${d.in} out:${d.out} depth:${depth.get(f)}`);
line("\ntop fan-out (most dependencies):");
for (const [f, d] of byOut)
	line(`  ${rel(f).padEnd(28)} out:${d.out} in:${d.in} depth:${depth.get(f)}`);

line("\n## runtime import cycles\n");
const cycles = findCycles(graph, { edgeFilter: isRuntimeEdge }).map((c) => c.map(rel).sort());
if (cycles.length === 0) line("  none");
for (const c of cycles) line(`  cycle: ${c.join("  <->  ")}`);

// ── 2. Symbol graph: export co-usage clustering ──────────────────────────────
// A module whose exports split into many disjoint clusters is fragmented — its
// consumers pull unrelated slices. Foundational data buckets (object-db, index,
// path, hex, tree-ops) over-fragment by nature; treat fragmentation as a split
// signal only when the call graph (below) confirms distinct concerns.
line("\n## export co-usage (runtime, exports \u2265 4)\n");
line(`${"module".padEnd(28)}exp  fanIn  clusters  singletons`);
for (const r of coUsageClusters(graph, { minExports: 4 }))
	line(
		`  ${r.module.padEnd(28)}${String(r.exports).padStart(2)}  ` +
		`${String(r.fanIn).padStart(5)}  ${String(r.clusters.length).padStart(8)}  ` +
		`${String(r.singletons).padStart(10)}`,
	);

// ── 3. Call graph: intra-module cohesion, cycles, dead helpers ───────────────
const prog = await createAnalysisProgram({ include: "src/lib", root: "src/lib" });
const cg = await buildCallGraph(prog);
const cohesion = moduleCallCohesion(cg);
const intra = cohesion.reduce((s, r) => s + r.intraEdges, 0);
line(`\n## call graph — ${cg.nodes.size} functions, ${cg.edges.length} edges (intra: ${intra})\n`);
line(`${"largest module".padEnd(28)}fns  intra  cohesion  fanOut`);
for (const r of cohesion.slice(0, 15))
	line(
		`  ${r.module.padEnd(28)}${String(r.functions).padStart(3)}  ` +
		`${String(r.intraEdges).padStart(5)}  ${r.cohesion.toFixed(2).padStart(8)}  ` +
		`${String(r.fanOut).padStart(6)}`,
	);

const nodeOf = (id: string) => cg.nodes.get(id);
const crossFileCycles = callCycles(cg).filter(
	(c) => new Set(c.map((id) => nodeOf(id)?.relPath)).size > 1,
);
line(`\ncross-file call cycles: ${crossFileCycles.length}`);
for (const c of crossFileCycles)
	line(`  ${[...new Set(c.map((id) => nodeOf(id)?.relPath))].join(" <-> ")}`);

// Non-exported, never-called functions. Many are local closures (callbacks the
// resolver attributes to the enclosing fn), so this is a lead list, not a verdict.
const dead = uncalledFunctions(cg).filter((d) => d.kind === "function");
line(`\nuncalled top-level functions (kind=function): ${dead.length}`);
for (const d of dead) line(`  ${d.relPath} :: ${d.name}`);
