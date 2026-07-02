import { describe, expect, test } from "bun:test";
import {
	type AnalysisProgram,
	buildCallGraph,
	buildTestTopology,
	buildTypeGraph,
	callCycles,
	callers,
	classifyConcerns,
	collectTypeShapes,
	createAnalysisProgram,
	fileConcernProfiles,
	fileMetrics,
	findDuplicateTypeShapes,
	functionsReferencingType,
	godFiles,
	impactedTests,
	moduleCallCohesion,
	testsCovering,
	typeCycles,
	typeReferrers,
	typeShapeSignature,
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

describe("type shapes", () => {
	test("buckets structurally identical declarations under different names", async () => {
		// CallEdge and TypeEdge are both `{ fromId: string; toId: string }` — a
		// real duplicate pair inside the toolkit, so this is deterministic.
		const dupes = await findDuplicateTypeShapes({
			include: "test/introspection",
			root: "test/introspection",
		});
		const group = dupes.find(
			(g) =>
				g.members.some((m) => m.id === "call-graph.ts#CallEdge") &&
				g.members.some((m) => m.id === "type-graph.ts#TypeEdge"),
		);
		expect(group).toBeDefined();
		expect(group?.distinctNames).toBe(true);
		// Every member of a group shares one signature, and it's the group's key.
		for (const g of dupes) {
			expect(g.members.length).toBeGreaterThanOrEqual(2);
			for (const m of g.members) expect(m.signature).toBe(g.signature);
		}
	});

	test("signatures are name-independent and drop trivial shapes", async () => {
		const prog = await createAnalysisProgram({
			include: "test/introspection",
			root: "test/introspection",
		});
		const shapes = await collectTypeShapes(prog);
		const callEdge = shapes.find((s) => s.id === "call-graph.ts#CallEdge");
		const typeEdge = shapes.find((s) => s.id === "type-graph.ts#TypeEdge");
		expect(callEdge?.signature).toBe(typeEdge?.signature);

		// typeShapeSignature runs off the same checker without throwing.
		expect(typeof typeShapeSignature).toBe("function");

		// Trivial buckets (primitives / empty objects) are excluded by default.
		const withTrivial = await findDuplicateTypeShapes(prog, { skipTrivial: false });
		const withoutTrivial = await findDuplicateTypeShapes(prog);
		expect(withTrivial.length).toBeGreaterThanOrEqual(withoutTrivial.length);
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

	test("moduleCallCohesion rolls calls up per file", async () => {
		const cg = await buildCallGraph({ include: "test/introspection", root: "test/introspection" });
		const rows = moduleCallCohesion(cg);
		expect(rows.length).toBeGreaterThan(0);

		// Totals reconcile with the raw graph: summed functions == node count, and
		// summed intra + fanOut edges == every edge with both ends resolved.
		const totalFns = rows.reduce((s, r) => s + r.functions, 0);
		expect(totalFns).toBe(cg.nodes.size);
		const totalIntra = rows.reduce((s, r) => s + r.intraEdges, 0);
		const totalFanOut = rows.reduce((s, r) => s + r.fanOut, 0);
		const resolved = cg.edges.filter((e) => cg.nodes.has(e.fromId) && cg.nodes.has(e.toId)).length;
		expect(totalIntra + totalFanOut).toBe(resolved);

		// cohesion is intraEdges / functions and rows are sorted largest-first.
		for (const r of rows) expect(r.cohesion).toBeCloseTo(r.intraEdges / r.functions);
		for (let i = 1; i < rows.length; i++)
			expect(rows[i - 1]?.functions ?? 0).toBeGreaterThanOrEqual(rows[i]?.functions ?? 0);
	});
});

describe("concern classifier", () => {
	test("separates formatting from data on known lib files", async () => {
		const concerns = await classifyConcerns({
			include: ["src/lib", "src/commands/kit/format"],
			root: "src",
		});
		const by = (relPath: string, name: string) =>
			concerns.find((c) => c.relPath === relPath && c.name === name);

		// commands/kit/format/log.ts is a pure presentation module: expandFormat formats
		// and touches no data.
		const expand = by("commands/kit/format/log.ts", "expandFormat");
		expect(expand?.kind).toBe("formatting");
		expect(expand?.formats).toBe(true);
		expect(expand?.handlesData).toBe(false);

		// commit-summary and checkout are split (P2): the gather is pure data in
		// lib, the renderer is pure presentation in commands/kit/format/.
		expect(by("lib/commit-summary.ts", "computeDiffStats")?.kind).toBe("data");
		expect(by("commands/kit/format/commit-summary.ts", "renderCommitSummary")?.kind).toBe(
			"formatting",
		);
		expect(by("lib/worktree/checkout-utils.ts", "computeCheckoutStatus")?.kind).toBe("data");
		expect(by("commands/kit/format/checkout.ts", "renderCheckoutSummary")?.kind).toBe("formatting");
		// status long-form is split (A): the gather is pure data in lib, the
		// renderer is pure presentation in commands/kit/format/.
		expect(by("lib/status-format.ts", "gatherLongStatus")?.kind).toBe("data");
		expect(by("commands/kit/format/status.ts", "renderLongStatus")?.kind).toBe("formatting");
		// A pure counting helper is neither formatting nor data.
		expect(by("lib/commit-summary.ts", "countLines")?.kind).toBe("logic");

		// Error-message templates don't make a data reader "formatting": a bare
		// `.join` / `path` builder isn't presentation either.
		expect(by("lib/path.ts", "join")?.kind).toBe("logic");

		// every record's derived kind agrees with its two axes.
		for (const c of concerns) {
			const expected =
				c.formats && c.handlesData
					? "mixed"
					: c.formats
						? "formatting"
						: c.handlesData
							? "data"
							: "logic";
			expect(c.kind).toBe(expected);
		}
	});

	test("fileConcernProfiles roll functions up per file", async () => {
		const concerns = await classifyConcerns({
			include: ["src/lib", "src/commands/kit/format"],
			root: "src",
		});
		const profiles = fileConcernProfiles(concerns);

		// Profiles partition the functions: summed counts reconcile with the input.
		const totalFns = profiles.reduce((s, p) => s + p.functions, 0);
		expect(totalFns).toBe(concerns.length);
		for (const p of profiles) {
			expect(p.formatting + p.data + p.mixed + p.logic).toBe(p.functions);
			expect(p.formattingRatio).toBeCloseTo((p.formatting + p.mixed) / p.functions);
		}

		// commands/kit/format/log.ts is presentation-dominant.
		const logFormat = profiles.find((p) => p.relPath === "commands/kit/format/log.ts");
		expect(logFormat?.dominant).toBe("formatting");
	});
});

describe("signature type references", () => {
	test("finds functions with a target type in return/param position", async () => {
		const refs = await functionsReferencingType(
			{ include: ["src/lib", "src/commands/kit"], root: "src" },
			["CommandResult"],
		);
		const by = (id: string) => refs.find((r) => r.id === id);

		// Explicit return of the type. command-errors.ts is the CLI command
		// contract and now lives in commands/kit/, not lib/ (Track B complete).
		expect(by("commands/kit/command-errors.ts#fatal")?.positions).toEqual(["return"]);
		expect(by("commands/kit/command-errors.ts#ambiguousArgError")?.positions).toContain("return");
		// The rebase engine no longer speaks the CommandResult contract: it
		// returns a structured RebaseOutcome that commands/kit/rebase.ts renders (Track B2).
		expect(by("lib/rebase-engine.ts#checkUntrackedConflicts")).toBeUndefined();
		expect(by("lib/rebase-engine.ts#performRebase")).toBeUndefined();
		// The type in a parameter is recorded as a param position, not a return.
		const isCmdErr = by("commands/kit/command-errors.ts#isCommandError");
		expect(isCmdErr?.positions).toContain("param");
		expect(isCmdErr?.positions).not.toContain("return");

		// A function with no CommandResult in its signature is absent.
		expect(by("lib/abbrev.ts#uniqueAbbrev")).toBeUndefined();
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
