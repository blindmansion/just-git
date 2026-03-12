import { describe, expect, test } from "bun:test";
import { diff3Merge, diff3MergeRegions, merge } from "../../src/lib/diff3";

// ── Helpers ─────────────────────────────────────────────────────────

/** Split a multi-line string into a line array (like splitLines but for test clarity). */
function lines(text: string): string[] {
	if (text === "") return [];
	const result = text.split("\n");
	if (result[result.length - 1] === "") result.pop();
	return result;
}

// ── diff3MergeRegions ───────────────────────────────────────────────

describe("diff3MergeRegions", () => {
	test("no changes — all three identical", () => {
		const o = ["a", "b", "c"];
		const regions = diff3MergeRegions(o, o, o);
		expect(regions).toEqual([
			{
				stable: true,
				buffer: "o",
				bufferStart: 0,
				bufferLength: 3,
				content: ["a", "b", "c"],
			},
		]);
	});

	test("only a changes", () => {
		const o = ["a", "b", "c"];
		const a = ["a", "X", "c"];
		const regions = diff3MergeRegions(a, o, o);
		// a changed line 2, b is same as o
		const stableRegions = regions.filter((r) => r.stable);
		const unstableRegions = regions.filter((r) => !r.stable);
		expect(unstableRegions).toHaveLength(0);
		// The changed line from a should appear as stable from buffer "a"
		const fromA = stableRegions.filter((r) => r.stable && r.buffer === "a");
		expect(fromA.length).toBeGreaterThan(0);
	});

	test("only b changes", () => {
		const o = ["a", "b", "c"];
		const b = ["a", "Y", "c"];
		const regions = diff3MergeRegions(o, o, b);
		const fromB = regions.filter((r) => r.stable && r.buffer === "b");
		expect(fromB.length).toBeGreaterThan(0);
	});

	test("a and b change different lines — no conflict", () => {
		const o = ["a", "b", "c", "d", "e"];
		const a = ["a", "X", "c", "d", "e"];
		const b = ["a", "b", "c", "Y", "e"];
		const regions = diff3MergeRegions(a, o, b);
		const unstable = regions.filter((r) => !r.stable);
		expect(unstable).toHaveLength(0);
	});

	test("a and b change same line differently — conflict", () => {
		const o = ["a", "b", "c"];
		const a = ["a", "X", "c"];
		const b = ["a", "Y", "c"];
		const regions = diff3MergeRegions(a, o, b);
		const unstable = regions.filter((r) => !r.stable);
		expect(unstable).toHaveLength(1);
		expect(unstable[0]?.stable).toBe(false);
		if (!unstable[0]?.stable) {
			expect(unstable[0]?.a).toEqual(["X"]);
			expect(unstable[0]?.o).toEqual(["b"]);
			expect(unstable[0]?.b).toEqual(["Y"]);
		}
	});
});

// ── diff3Merge ──────────────────────────────────────────────────────

describe("diff3Merge", () => {
	test("identical inputs — single ok block", () => {
		const o = ["a", "b", "c"];
		const blocks = diff3Merge(o, o, o);
		expect(blocks).toEqual([{ type: "ok", lines: ["a", "b", "c"] }]);
	});

	test("only a changes — clean merge", () => {
		const o = ["a", "b", "c"];
		const a = ["a", "X", "c"];
		const blocks = diff3Merge(a, o, o);
		expect(blocks).toEqual([{ type: "ok", lines: ["a", "X", "c"] }]);
	});

	test("only b changes — clean merge", () => {
		const o = ["a", "b", "c"];
		const b = ["a", "Y", "c"];
		const blocks = diff3Merge(o, o, b);
		expect(blocks).toEqual([{ type: "ok", lines: ["a", "Y", "c"] }]);
	});

	test("both sides change different lines — clean merge", () => {
		const o = ["a", "b", "c", "d", "e"];
		const a = ["a", "X", "c", "d", "e"];
		const b = ["a", "b", "c", "Y", "e"];
		const blocks = diff3Merge(a, o, b);
		// Should merge cleanly with both changes
		const allLines = blocks.flatMap((block) => (block.type === "ok" ? block.lines : []));
		expect(allLines).toEqual(["a", "X", "c", "Y", "e"]);
		expect(blocks.every((b) => b.type === "ok")).toBe(true);
	});

	test("both sides make same change — false conflict resolved", () => {
		const o = ["a", "b", "c"];
		const a = ["a", "X", "c"];
		const b = ["a", "X", "c"];
		const blocks = diff3Merge(a, o, b);
		expect(blocks).toEqual([{ type: "ok", lines: ["a", "X", "c"] }]);
	});

	test("false conflict kept when excludeFalseConflicts is false", () => {
		const o = ["a", "b", "c"];
		const a = ["a", "X", "c"];
		const b = ["a", "X", "c"];
		const blocks = diff3Merge(a, o, b, {
			excludeFalseConflicts: false,
		});
		const conflicts = blocks.filter((b) => b.type === "conflict");
		expect(conflicts).toHaveLength(1);
	});

	test("true conflict — different changes to same region", () => {
		const o = ["a", "b", "c"];
		const a = ["a", "X", "c"];
		const b = ["a", "Y", "c"];
		const blocks = diff3Merge(a, o, b);
		expect(blocks).toHaveLength(3);
		expect(blocks[0]).toEqual({ type: "ok", lines: ["a"] });
		expect(blocks[1]).toEqual({
			type: "conflict",
			a: ["X"],
			o: ["b"],
			b: ["Y"],
		});
		expect(blocks[2]).toEqual({ type: "ok", lines: ["c"] });
	});

	test("empty inputs", () => {
		const blocks = diff3Merge([], [], []);
		expect(blocks).toEqual([]);
	});

	test("a adds lines, b unchanged", () => {
		const o = ["a", "c"];
		const a = ["a", "b", "c"];
		const blocks = diff3Merge(a, o, o);
		const allLines = blocks.flatMap((block) => (block.type === "ok" ? block.lines : []));
		expect(allLines).toEqual(["a", "b", "c"]);
	});

	test("a deletes lines, b unchanged", () => {
		const o = ["a", "b", "c"];
		const a = ["a", "c"];
		const blocks = diff3Merge(a, o, o);
		const allLines = blocks.flatMap((block) => (block.type === "ok" ? block.lines : []));
		expect(allLines).toEqual(["a", "c"]);
	});
});

// ── merge (2-way markers) ───────────────────────────────────────────

describe("merge", () => {
	test("clean merge — no conflict flag", () => {
		const o = ["a", "b", "c", "d", "e"];
		const a = ["a", "X", "c", "d", "e"];
		const b = ["a", "b", "c", "Y", "e"];
		const result = merge(a, o, b);
		expect(result.conflict).toBe(false);
		expect(result.result).toEqual(["a", "X", "c", "Y", "e"]);
	});

	test("conflict produces markers", () => {
		const o = ["a", "b", "c"];
		const a = ["a", "X", "c"];
		const b = ["a", "Y", "c"];
		const result = merge(a, o, b);
		expect(result.conflict).toBe(true);
		expect(result.result).toEqual(["a", "<<<<<<<", "X", "=======", "Y", ">>>>>>>", "c"]);
	});

	test("conflict with labels", () => {
		const o = ["a", "b", "c"];
		const a = ["a", "X", "c"];
		const b = ["a", "Y", "c"];
		const result = merge(a, o, b, { a: "ours", b: "theirs" });
		expect(result.conflict).toBe(true);
		expect(result.result).toContain("<<<<<<< ours");
		expect(result.result).toContain(">>>>>>> theirs");
	});

	test("multiple conflicts in one merge", () => {
		const o = ["a", "b", "c", "d", "e"];
		const a = ["X", "b", "c", "d", "Z"];
		const b = ["Y", "b", "c", "d", "W"];
		const result = merge(a, o, b);
		expect(result.conflict).toBe(true);
		// Gap between conflicts is ≤3 lines, so git (and we) merge them into one
		const markerCount = result.result.filter((l) => l.startsWith("<<<<<<<")).length;
		expect(markerCount).toBe(1);
	});
});

// ── Realistic multi-line scenarios ──────────────────────────────────

describe("realistic scenarios", () => {
	test("merge two feature branches editing different functions", () => {
		const base = lines(`function greet() {
  return "hello";
}

function farewell() {
  return "goodbye";
}
`);
		const branchA = lines(`function greet() {
  return "hello, world";
}

function farewell() {
  return "goodbye";
}
`);
		const branchB = lines(`function greet() {
  return "hello";
}

function farewell() {
  return "see you later";
}
`);

		const result = merge(branchA, base, branchB);
		expect(result.conflict).toBe(false);
		expect(result.result).toEqual(
			lines(`function greet() {
  return "hello, world";
}

function farewell() {
  return "see you later";
}
`),
		);
	});

	test("merge conflict on same function", () => {
		const base = lines(`function greet() {
  return "hello";
}
`);
		const branchA = lines(`function greet() {
  return "hello, world";
}
`);
		const branchB = lines(`function greet() {
  return "hi there";
}
`);

		const result = merge(branchA, base, branchB);
		expect(result.conflict).toBe(true);
		// The conflicting line should be wrapped in markers
		expect(result.result.some((l) => l.startsWith("<<<<<<<"))).toBe(true);
		expect(result.result.some((l) => l.startsWith(">>>>>>>"))).toBe(true);
	});

	test("one side adds, other side modifies — different regions", () => {
		const base = lines(`line1
line2
line3
`);
		const branchA = lines(`line1
line2
line2.5
line3
`);
		const branchB = lines(`LINE1
line2
line3
`);

		const result = merge(branchA, base, branchB);
		expect(result.conflict).toBe(false);
		expect(result.result).toEqual(
			lines(`LINE1
line2
line2.5
line3
`),
		);
	});
});
