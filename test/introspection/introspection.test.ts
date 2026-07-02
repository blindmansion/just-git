import { describe, expect, test } from "bun:test";
import {
	barrelFiles,
	buildImportGraph,
	degrees,
	dependencies,
	dependencyDepth,
	dependents,
	directoryMatrix,
	exportConsumers,
	externalPackages,
	findCycles,
	formatMatrix,
	getNode,
	groupMetrics,
	internalNodes,
	isRuntimeEdge,
	parentDir,
	relPathOf,
	symbolEdges,
	typeOnlyEdges,
	valueEdges,
} from "./index.ts";

// The toolkit is exercised against itself: graphing `test/introspection` is
// fast, deterministic, and doubles as a worked example of the API.
describe("import-graph introspection", () => {
	test("builds a graph of a directory with nodes and edges", async () => {
		const graph = await buildImportGraph({ include: "test/introspection" });

		const files = internalNodes(graph).map((n) => n.relPath);
		expect(files).toContain("build-graph.ts");
		expect(files).toContain("query.ts");
		expect(files).toContain("types.ts");

		// Every node is categorised as internal and has a POSIX-relative path.
		for (const node of internalNodes(graph)) {
			expect(node.category).toBe("internal");
			expect(node.relPath).not.toContain("\\");
		}
	});

	test("classifies type-only vs value imports via the checker", async () => {
		const graph = await buildImportGraph({ include: "test/introspection" });

		// `types.ts` is consumed purely as types, so `import` edges into it are
		// type-only (the `export * from "./types.ts"` barrel re-export is not).
		const typeImports = graph.edges.filter(
			(e) => e.statement === "import" && e.toFile?.endsWith("/types.ts"),
		);
		expect(typeImports.length).toBeGreaterThan(0);
		for (const edge of typeImports) {
			expect(edge.isTypeOnly).toBe(true);
			expect(edge.bindings.every((b) => b.kind === "type" || b.kind === "value-and-type")).toBe(
				true,
			);
		}

		// `typescript` is imported as a runtime value namespace.
		const tsEdge = graph.edges.find((e) => e.specifier === "typescript");
		expect(tsEdge).toBeDefined();
		expect(tsEdge?.target).toBe("package");
		expect(tsEdge?.clauseKinds).toContain("namespace");

		expect(typeOnlyEdges(graph).length).toBeGreaterThan(0);
		expect(valueEdges(graph).length).toBeGreaterThan(0);
	});

	test("captures type strings when requested", async () => {
		const graph = await buildImportGraph({
			include: "test/introspection",
			includeTypeStrings: true,
		});
		const valueBindings = graph.edges
			.flatMap((e) => e.bindings)
			.filter((b) => b.kind === "value" || b.kind === "value-and-type");
		expect(valueBindings.some((b) => typeof b.typeString === "string")).toBe(true);
	});

	test("dependency / dependent traversal", async () => {
		const graph = await buildImportGraph({ include: "test/introspection" });

		const indexNode = getNode(graph, "index.ts");
		expect(indexNode).toBeDefined();
		const deps = dependencies(graph, "index.ts");
		expect(deps.some((d) => d.endsWith("/build-graph.ts"))).toBe(true);

		const typesDependents = dependents(graph, "types.ts");
		expect(typesDependents.some((d) => d.endsWith("/build-graph.ts"))).toBe(true);
	});

	test("rolls up external package usage", async () => {
		const graph = await buildImportGraph({ include: "test/introspection" });
		const pkgs = externalPackages(graph);
		expect(pkgs.has("typescript")).toBe(true);
		expect(pkgs.has("bun")).toBe(true);
	});

	test("no import cycles within the toolkit", async () => {
		const graph = await buildImportGraph({ include: "test/introspection" });
		expect(findCycles(graph)).toEqual([]);
	});

	test("identifies barrel files", async () => {
		const graph = await buildImportGraph({ include: "test/introspection" });
		const barrels = barrelFiles(graph).map((n) => n.relPath);
		expect(barrels).toContain("index.ts");
	});

	test("directory matrix groups cross-directory edges", async () => {
		const graph = await buildImportGraph({ include: "src", root: "src" });
		const matrix = directoryMatrix(graph, { depth: 1 });
		// `src` has multiple top-level groups (commands, lib, repo, ...) that import each other.
		expect(matrix.size).toBeGreaterThan(0);
		// formatMatrix renders a square table including all groups seen.
		const rendered = formatMatrix(matrix);
		expect(rendered).toContain("commands");
		expect(rendered).toContain("lib");
	});

	test("degrees and dependencyDepth describe the hierarchy", async () => {
		const graph = await buildImportGraph({ include: "test/introspection" });
		const deg = degrees(graph, { edgeFilter: isRuntimeEdge });
		const depth = dependencyDepth(graph, { edgeFilter: isRuntimeEdge });

		// types.ts is a leaf (no outgoing runtime deps) yet depended upon.
		const typesNode = internalNodes(graph).find((n) => n.relPath === "types.ts");
		expect(typesNode).toBeDefined();
		const typesFile = typesNode?.file as string;
		expect(depth.get(typesFile)).toBe(0);
		expect(deg.get(typesFile)?.in ?? 0).toBeGreaterThan(0);

		// index.ts sits above its dependencies.
		const indexFile = internalNodes(graph).find((n) => n.relPath === "index.ts")?.file as string;
		expect(depth.get(indexFile) ?? 0).toBeGreaterThan(0);
	});

	test("groupMetrics measures cohesion vs coupling", async () => {
		const graph = await buildImportGraph({ include: "src/lib", root: "src/lib" });
		const m = groupMetrics(graph, [
			"transport/transport",
			"transport/remote",
			"transport/resolver",
			"transport/smart-http",
			"transport/smart-http-v2",
			"transport/object-walk",
			"transport/discovery-cache",
			"transport/refspec",
			"transport/pkt-line",
		]);
		expect(m.missing).toEqual([]);
		expect(m.size).toBe(9);
		expect(m.internalEdges).toBeGreaterThan(0);
		// transport is consumed through a small public surface.
		expect(m.publicSurface).toBeLessThan(m.size);
	});

	test("symbolEdges explode imports to the binding level", async () => {
		const graph = await buildImportGraph({ include: "test/introspection" });
		const edges = symbolEdges(graph);

		// Every symbol edge points at a resolved internal target and carries the
		// name of an actual export of that module.
		expect(edges.length).toBeGreaterThan(0);
		for (const e of edges) {
			expect(e.id).toBe(`${e.toRel}#${e.importedName}`);
			expect(e.importedName).not.toBe("*");
		}

		// `relPathOf` is exported from query.ts and imported by index.ts (a value).
		const relPathUses = edges.filter((e) => e.importedName === "relPathOf");
		expect(relPathUses.some((e) => e.fromRel === "index.ts" && e.runtime)).toBe(true);

		// `ImportGraph` is a pure type, so its bindings are non-runtime.
		const importGraphUses = edges.filter((e) => e.importedName === "ImportGraph");
		expect(importGraphUses.length).toBeGreaterThan(0);
		expect(importGraphUses.every((e) => !e.runtime)).toBe(true);
	});

	test("exportConsumers rolls symbol edges up per export", async () => {
		const graph = await buildImportGraph({ include: "test/introspection" });
		const consumers = exportConsumers(graph, { runtimeOnly: true });

		// The heavily-reused `relPathOf` helper is consumed by several files.
		const relPathConsumers = consumers.get("query.ts#relPathOf");
		expect(relPathConsumers).toBeDefined();
		expect(relPathConsumers?.has("index.ts")).toBe(true);

		// runtimeOnly drops pure-type exports entirely.
		expect(consumers.has("types.ts#ImportGraph")).toBe(false);
	});

	test("path helpers", async () => {
		const graph = await buildImportGraph({ include: "src/lib", root: "src/lib" });
		expect(parentDir("transport/remote.ts")).toBe("transport");
		expect(parentDir("types.ts")).toBe(".");
		const anyFile = internalNodes(graph)[0]?.file as string;
		expect(relPathOf(graph, anyFile)).toBe(graph.nodes.get(anyFile)?.relPath ?? "");
	});
});
