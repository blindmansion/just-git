import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync } from "fs";
import { join } from "path";
import {
	type BuiltShape,
	buildShape,
	jgApply,
	jgDiff,
	realApply,
	realDiff,
	resetTo,
	resultTree,
	type Shape,
} from "./apply-harness";
import { createSandbox, realGitIn, removeSandbox } from "./util";

/**
 * `git apply` integration/interop matrix. For every change shape we push the
 * `A→B` patch through each producer→consumer pairing and assert the resulting
 * tree OID equals `B^{tree}` (see apply-harness.ts for the oracle rationale):
 *
 *   real diff → just-git apply   interop, real → just
 *   jg diff   → just-git apply   round-trip / module integration (diff↔apply)
 *   jg diff   → real git apply   interop, just → real
 *   real diff → real git apply   control / fixture sanity
 */

const A_LINES = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n";

/** Deterministic binary blobs (distinct so the diff is a real content change). */
function binBlob(seed: number, len = 256): Uint8Array {
	const b = new Uint8Array(len);
	for (let i = 0; i < len; i++) b[i] = (i * 31 + seed) % 256;
	return b;
}

const SHAPES: Shape[] = [
	{
		name: "text modify (multi-hunk)",
		base: { "file.txt": A_LINES },
		// Two well-separated edits → two hunks.
		target: { "file.txt": "one\nTWO\nthree\nfour\nfive\nsix\nseven\neight\nNINE\nten\n" },
	},
	{
		name: "new file",
		base: { "keep.txt": "keep\n" },
		target: { "added.txt": "brand\nnew\nfile\n" },
	},
	{
		name: "delete file",
		base: { "keep.txt": "keep\n", "gone.txt": "remove\nme\n" },
		target: { "gone.txt": null },
	},
	{
		name: "rename + modify",
		base: { "a.txt": A_LINES },
		// High similarity so -M reports a rename (with one changed line).
		target: { "a.txt": null, "b.txt": A_LINES.replace("five\n", "FIVE\n") },
		diffArgs: ["-M"],
	},
	{
		name: "mode change (100644 → 100755)",
		base: { "s.sh": "echo hi\n" },
		target: {},
		targetSetup: (sandbox) => chmodSync(join(sandbox, "s.sh"), 0o755),
	},
	{
		name: "binary modify (real diff --binary → apply)",
		base: { "blob.bin": binBlob(0) },
		target: { "blob.bin": binBlob(7) },
		diffArgs: ["--binary"],
	},
	{
		name: "no trailing newline",
		base: { "f.txt": "a\nb\nc\n" },
		target: { "f.txt": "a\nb\nC" },
	},
	{
		name: "deep nested path",
		base: { "src/a/b/c/deep.txt": A_LINES },
		target: { "src/a/b/c/deep.txt": A_LINES.replace("one\n", "ONE\n") },
	},
	{
		name: "multi-file (modify + add + delete)",
		base: { "m.txt": A_LINES, "d.txt": "delete me\n" },
		target: {
			"m.txt": A_LINES.replace("ten\n", "TEN\n"),
			"d.txt": null,
			"n.txt": "newly added\n",
		},
	},
];

for (const shape of SHAPES) {
	describe(`interop: apply — ${shape.name}`, () => {
		let sandbox: string;
		let git: ReturnType<typeof realGitIn>;
		let built: BuiltShape;

		beforeAll(async () => {
			sandbox = createSandbox();
			git = realGitIn(sandbox);
			built = await buildShape(git, sandbox, shape);
		});
		afterAll(() => removeSandbox(sandbox));

		async function cell(produce: "real" | "jg", consume: "real" | "jg"): Promise<void> {
			await resetTo(git, built.aSha);
			const patch =
				produce === "real"
					? await realDiff(git, built.aSha, built.bSha, shape.diffArgs)
					: await jgDiff(sandbox, built.aSha, built.bSha, shape.diffArgs);
			const out =
				consume === "real" ? await realApply(sandbox, patch) : await jgApply(sandbox, patch);
			expect(out.exitCode).toBe(0);
			expect(await resultTree(git)).toBe(built.bTree);
		}

		const producers = shape.producers ?? ["real", "jg"];
		if (producers.includes("real")) {
			test("real diff → just-git apply", () => cell("real", "jg"));
			test("real diff → real git apply (control)", () => cell("real", "real"));
		}
		if (producers.includes("jg")) {
			test("just-git diff → just-git apply (round-trip)", () => cell("jg", "jg"));
			test("just-git diff → real git apply", () => cell("jg", "real"));
		}
	});
}
