import {
	buildImportGraph,
	degrees,
	dependencyDepth,
	directoryMatrix,
	findCycles,
	formatMatrix,
	groupMatrix,
	groupMetrics,
	internalNodes,
	isRuntimeEdge,
	parentDir,
	relPathOf,
} from "../test/introspection/index.ts";

const graph = await buildImportGraph({ include: "src/lib", root: "src/lib" });
const rel = (f: string) => relPathOf(graph, f);
const line = (s: string) => console.log(s);

line("# lib internal structure — evidence\n");
line(
	`files: ${internalNodes(graph).length} | internal edges: ${graph.edges.filter((e) => e.target === "internal").length}\n`,
);

// ── 1. Subdirectory coupling ────────────────────────────────────────────────
line("## subdirectory matrix (row imports column)\n");
line("all edges:");
line(formatMatrix(groupMatrix(graph, (n) => parentDir(n.relPath))));
line("\nruntime edges only:");
line(formatMatrix(directoryMatrix(graph, { edgeFilter: isRuntimeEdge })));

// ── 2. Hierarchy: hubs and depth ────────────────────────────────────────────
const deg = degrees(graph, { edgeFilter: isRuntimeEdge });
const depth = dependencyDepth(graph, { edgeFilter: isRuntimeEdge });
const byIn = [...deg.entries()].sort((a, b) => b[1].in - a[1].in).slice(0, 8);
const byOut = [...deg.entries()].sort((a, b) => b[1].out - a[1].out).slice(0, 8);
line("\n## hubs (runtime graph)\n");
line("top fan-in (most depended-on):");
for (const [f, d] of byIn)
	line(`  ${rel(f).padEnd(24)} in:${d.in} out:${d.out} depth:${depth.get(f)}`);
line("\ntop fan-out (most dependencies):");
for (const [f, d] of byOut)
	line(`  ${rel(f).padEnd(24)} out:${d.out} in:${d.in} depth:${depth.get(f)}`);

// ── 3. Runtime cycles ───────────────────────────────────────────────────────
line("\n## runtime import cycles\n");
const cycles = findCycles(graph, { edgeFilter: isRuntimeEdge }).map((c) => c.map(rel).sort());
for (const c of cycles) line(`  cycle: ${c.join("  <->  ")}`);
if (cycles.length === 0) line("  none");

// ── 4. command-utils.ts grab-bag ────────────────────────────────────────────
const cu = internalNodes(graph).find((n) => n.relPath === "command-utils.ts");
if (cu) {
	line(`\n## command-utils.ts surface: ${cu.exports.length} exports\n`);
	line(`  ${cu.exports.map((e) => e.name).join(", ")}`);
}

// ── 5. Candidate directory cohesion / coupling ──────────────────────────────
// `attributes/`, `worktree/`, and `refs/` are now real directories (see the
// subdirectory matrix above); only still-flat candidates remain here.
// `tree-ops` stays at root as a repo-wide tree-data leaf (33 importers), not a
// worktree concern.
const candidates: Record<string, string[]> = {
	"diff/": [
		"diff-algorithm",
		"diff-driver",
		"diff3",
		"combined-diff",
		"patch-id",
		"rename-detection",
	],
};
line("\n## candidate directories (cohesion vs coupling)\n");
line("name".padEnd(14) + "sz  intra  fanOut  fanIn  surface  importers");
for (const [name, members] of Object.entries(candidates)) {
	const m = groupMetrics(graph, members);
	line(
		name.padEnd(14) +
			`${m.size}`.padStart(2) +
			`${m.internalEdges}`.padStart(7) +
			`${m.fanOut}`.padStart(8) +
			`${m.fanIn}`.padStart(7) +
			`  ${m.publicSurface}/${m.size}`.padStart(9) +
			`${m.externalImporters}`.padStart(11) +
			(m.missing.length ? `  MISSING: ${m.missing.join(", ")}` : ""),
	);
}
