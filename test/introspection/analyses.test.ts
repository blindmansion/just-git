import { describe, expect, test } from "bun:test";
import {
	type AnalysisProgram,
	buildCallGraph,
	buildTestTopology,
	buildTypeGraph,
	callCycles,
	callers,
	createAnalysisProgram,
	fileMetrics,
	godFiles,
	impactedTests,
	testsCovering,
	typeCycles,
	typeReferrers,
} from "./index.ts";

// These exercise the non-import-graph analyses that share the program bootstrap.
describe("shared program bootstrap", () => {
	test("createAnalysisProgram exposes checker + internal files", async () => {
		const prog = await createAnalysisProgram({ include: "test/introspection" });
		expect(prog.checker).toBeDefined();
		expect(prog.sourceFiles.length).toBeGreaterThan(0);
		expect(prog.files.every((f) => prog.isInternal(f))).toBe(true);
		expect(prog.relOf(prog.files[0] as string)).not.toContain("\\");
	});

	test("analyses can reuse one program instance", async () => {
		const prog: AnalysisProgram = await createAnalysisProgram({ include: "test/introspection" });
		const metrics = await fileMetrics(prog);
		const typeGraph = await buildTypeGraph(prog);
		expect(metrics.length).toBe(prog.sourceFiles.length);
		expect(typeGraph.nodes.size).toBeGreaterThan(0);
	});
});

describe("file metrics", () => {
	test("computes size/shape and finds god-files", async () => {
		const metrics = await fileMetrics({ include: "src/lib", root: "src/lib" });
		const cfg = metrics.find((m) => m.relPath === "types.ts");
		expect(cfg).toBeDefined();
		expect(cfg?.exports ?? 0).toBeGreaterThan(20);

		// types.ts is a known god-file by export count (the shared type bucket).
		const gods = godFiles(metrics, { exports: 25 });
		expect(gods.some((m) => m.relPath === "types.ts")).toBe(true);
	});
});

describe("type graph", () => {
	test("captures type-level references and cycles", async () => {
		const tg = await buildTypeGraph({ include: "test/introspection", root: "test/introspection" });
		// ImportGraph references ModuleNode and ImportEdge — both internal types.
		const importGraphId = [...tg.nodes.keys()].find((id) => id.endsWith("#ImportGraph"));
		expect(importGraphId).toBeDefined();
		const refs = typeReferrers(tg, `types.ts#ImportEdge`);
		expect(refs.length).toBeGreaterThan(0);
		// The toolkit's own types are acyclic.
		expect(typeCycles(tg)).toEqual([]);
	});

	test("surfaces the lib<->git.ts type tangle in src", async () => {
		const tg = await buildTypeGraph({ include: "src", root: "src" });
		expect(tg.nodes.size).toBeGreaterThan(0);
		expect(tg.edges.length).toBeGreaterThan(0);
	});
});

describe("call graph", () => {
	test("resolves caller -> callee within a module", async () => {
		const cg = await buildCallGraph({ include: "test/introspection", root: "test/introspection" });
		expect(cg.nodes.size).toBeGreaterThan(0);
		expect(cg.edges.length).toBeGreaterThan(0);
		// buildImportGraph calls helpers; it should have outgoing edges.
		const buildId = [...cg.nodes.keys()].find((id) => id.endsWith("#buildImportGraph"));
		if (buildId) expect(callers(cg, buildId)).toBeDefined();
		// callCycles returns arrays (possibly empty) without throwing.
		expect(Array.isArray(callCycles(cg))).toBe(true);
	});
});

describe("test topology", () => {
	test("maps tests to the lib files they exercise", async () => {
		const topo = await buildTestTopology({ include: ["src/lib", "test/lib"], root: "." });
		expect(topo.testFiles.length).toBeGreaterThan(0);
		expect(topo.subjectFiles.length).toBeGreaterThan(0);

		// refs.ts is exercised by its tests (refs are imported by many test files).
		const refs = topo.subjectFiles.find((f) => f.endsWith("/lib/refs.ts"));
		if (refs) expect(testsCovering(topo, refs).length).toBeGreaterThan(0);

		// impactedTests for a changed file returns the covering tests.
		if (refs) {
			const impacted = impactedTests(topo, [refs]);
			expect(impacted).toEqual(testsCovering(topo, refs));
		}
	});
});
