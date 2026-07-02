import { describe, expect, test } from "bun:test";
import { relativeSpecifier, renameSymbol } from "./index.ts";

// These exercise the codemod primitives without touching disk (dryRun), scoped
// to the toolkit itself so they stay deterministic.
describe("refactor primitives", () => {
	test("relativeSpecifier builds ./-prefixed POSIX specifiers with extension", () => {
		const spec = relativeSpecifier(
			`${process.cwd()}/test/introspection/a.ts`,
			`${process.cwd()}/test/introspection/sub/b.ts`,
		);
		expect(spec).toBe("./sub/b.ts");
	});

	test("renameSymbol (dryRun) rewrites the declaration and every reference", async () => {
		// `TypeNode` is declared in type-graph.ts and referenced there + re-exported
		// (as a type) from index.ts, so a rename touches more than one file.
		const result = await renameSymbol(
			"TypeNode",
			"test/introspection/type-graph.ts",
			"TypeNodeRenamed",
			{ scope: ["test/introspection"], dryRun: true },
		);

		expect(result.dryRun).toBe(true);
		expect(result.changedFiles).toContain("test/introspection/type-graph.ts");
		// The barrel re-exports the type, so it is rewritten too.
		expect(result.changedFiles).toContain("test/introspection/index.ts");
		// Reported a rename with a location count in its summary note.
		expect(result.notes[0]).toMatch(/renamed TypeNode → TypeNodeRenamed: \d+ location/);
	});

	test("renameSymbol throws for an unknown declaration", async () => {
		await expect(
			renameSymbol("NoSuchType", "test/introspection/type-graph.ts", "X", {
				scope: ["test/introspection"],
				dryRun: true,
			}),
		).rejects.toThrow(/no top-level declaration/);
	});
});
