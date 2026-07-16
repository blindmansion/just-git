import { describe, expect, test } from "bun:test";
import { readBlobContent } from "../../src/lib/object-db.ts";
import type { GitRepo, Identity } from "../../src/lib/types.ts";
import { flattenTree, formatDiff } from "../../src/repo/diffing.ts";
import { applyPatch, parsePatch, reversePatch } from "../../src/repo/patching.ts";
import { readCommit, revParse } from "../../src/repo/reading.ts";
import { commit } from "../../src/repo/writing.ts";
import { MemoryStorage } from "../../src/store/memory-storage.ts";
import { createRepoStore } from "../../src/store/repo-store.ts";

const ID: Identity = {
	name: "Test",
	email: "test@test.com",
	timestamp: 1000000000,
	timezone: "+0000",
};

async function freshRepo(): Promise<GitRepo> {
	return createRepoStore(new MemoryStorage()).createRepo("test");
}

/** Commit `files` onto `branch` (building on its tip) and return commit + tree. */
async function commitOn(
	repo: GitRepo,
	branch: string,
	files: Record<string, string | null>,
): Promise<{ hash: string; tree: string }> {
	await commit(repo, { files, message: "c\n", author: ID, branch });
	const hash = (await revParse(repo, branch)) as string;
	const c = await readCommit(repo, hash);
	return { hash, tree: c.tree };
}

async function fileInTree(repo: GitRepo, tree: string, path: string): Promise<string | null> {
	const entries = await flattenTree(repo, tree);
	const e = entries.find((x) => x.path === path);
	return e ? readBlobContent(repo, e.hash) : null;
}

describe("applyPatch — happy path (tree round-trip)", () => {
	test("modify + add + delete reproduces the target tree exactly", async () => {
		const repo = await freshRepo();
		const a = await commitOn(repo, "main", {
			"a.txt": "one\ntwo\nthree\n",
			"b.txt": "keep\n",
			"dir/nested.txt": "n1\nn2\n",
		});
		const b = await commitOn(repo, "main", {
			"a.txt": "one\nTWO\nthree\n", // modify
			"b.txt": null, // delete
			"dir/nested.txt": "n1\nn2\nn3\n", // modify nested
			"c.txt": "brand new\n", // add
		});

		const patch = await formatDiff(repo, a.hash, b.hash);
		const res = await applyPatch(repo, { patch, onto: a.hash });

		expect(res.status).toBe("applied");
		if (res.status !== "applied") return;
		expect(res.treeHash).toBe(b.tree);
	});

	test("accepts a raw tree hash as onto", async () => {
		const repo = await freshRepo();
		const a = await commitOn(repo, "main", { "a.txt": "x\n" });
		const b = await commitOn(repo, "main", { "a.txt": "y\n" });
		const patch = await formatDiff(repo, a.hash, b.hash);

		const res = await applyPatch(repo, { patch, onto: a.tree });
		expect(res.status).toBe("applied");
		if (res.status === "applied") expect(res.treeHash).toBe(b.tree);
	});

	test("reverse (-R) reconstructs the preimage tree", async () => {
		const repo = await freshRepo();
		const a = await commitOn(repo, "main", { "a.txt": "one\ntwo\nthree\n" });
		const b = await commitOn(repo, "main", { "a.txt": "one\nTWO\nthree\n" });
		const patch = await formatDiff(repo, a.hash, b.hash);

		const res = await applyPatch(repo, { patch, onto: b.hash, reverse: true });
		expect(res.status).toBe("applied");
		if (res.status === "applied") expect(res.treeHash).toBe(a.tree);
	});
});

describe("applyPatch — rejects as data", () => {
	test("context drift yields structured rejects, not a tree", async () => {
		const repo = await freshRepo();
		const a = await commitOn(repo, "main", { "a.txt": "one\ntwo\nthree\n" });
		const b = await commitOn(repo, "main", { "a.txt": "one\nTWO\nthree\n" });
		const patch = await formatDiff(repo, a.hash, b.hash);

		// A drifted tree whose a.txt no longer matches the patch context.
		const drift = await commitOn(repo, "other", { "a.txt": "totally\ndifferent\nlines\n" });

		const res = await applyPatch(repo, { patch, onto: drift.hash });
		expect(res.status).toBe("rejected");
		if (res.status !== "rejected") return;

		expect(res.rejects).toHaveLength(1);
		const r = res.rejects[0]!;
		expect(r.path).toBe("a.txt");
		expect(r.currentContent).toBe("totally\ndifferent\nlines\n");
		expect(r.appliedHunks).toBe(0);
		expect(r.rejectedHunks).toHaveLength(1);
		const h = r.rejectedHunks[0]!;
		expect(h.reason).toBe("context-mismatch");
		expect(h.header.startsWith("@@")).toBe(true);
		expect(h.raw).toContain("-two");
		expect(h.raw).toContain("+TWO");
	});

	test("partial multi-hunk failure reports appliedHunks and the failing hunk only", async () => {
		const repo = await freshRepo();
		// Two well-separated edits produce two independent hunks.
		const lines = Array.from({ length: 40 }, (_, i) => `line${i}\n`).join("");
		const a = await commitOn(repo, "main", { "big.txt": lines });
		const edited = lines.replace("line2\n", "LINE2\n").replace("line37\n", "LINE37\n");
		const b = await commitOn(repo, "main", { "big.txt": edited });
		const patch = await formatDiff(repo, a.hash, b.hash);

		// Drift only the region around the second hunk so the first still applies.
		const driftContent = lines.replace("line36\n", "XXX36\n");
		const drift = await commitOn(repo, "other", { "big.txt": driftContent });

		const res = await applyPatch(repo, { patch, onto: drift.hash });
		expect(res.status).toBe("rejected");
		if (res.status !== "rejected") return;
		const r = res.rejects[0]!;
		expect(r.appliedHunks).toBe(1);
		expect(r.rejectedHunks).toHaveLength(1);
	});

	test("all-or-nothing: a reject leaves the target tree unbuilt", async () => {
		const repo = await freshRepo();
		const a = await commitOn(repo, "main", { "a.txt": "one\ntwo\n" });
		const b = await commitOn(repo, "main", { "a.txt": "one\nTWO\n" });
		const patch = await formatDiff(repo, a.hash, b.hash);
		const drift = await commitOn(repo, "other", { "a.txt": "x\ny\n" });

		const res = await applyPatch(repo, { patch, onto: drift.hash });
		// The reject contract: nothing is returned but the reject data, and the
		// drift tree itself is untouched (still resolvable to its own content).
		expect(res.status).toBe("rejected");
		expect(await fileInTree(repo, drift.tree, "a.txt")).toBe("x\ny\n");
	});

	test("applying a creation patch onto an existing path rejects with a reason", async () => {
		const repo = await freshRepo();
		const empty = await commitOn(repo, "main", { "seed.txt": "seed\n" });
		const withNew = await commitOn(repo, "main", { "new.txt": "created\n" });
		const patch = await formatDiff(repo, empty.hash, withNew.hash);

		// Onto a tree that already has new.txt.
		const clash = await commitOn(repo, "other", { "new.txt": "already here\n" });
		const res = await applyPatch(repo, { patch, onto: clash.hash });
		expect(res.status).toBe("rejected");
		if (res.status !== "rejected") return;
		expect(res.rejects[0]!.error).toContain("already exists");
	});
});

describe("applyPatch — three-way fallback", () => {
	test("merges a drifted patch cleanly after direct application rejects", async () => {
		const repo = await freshRepo();
		const base = await commitOn(repo, "main", {
			"lines.txt": "a\nb\nc\nd\ne\n",
		});
		const source = await commitOn(repo, "main", {
			"lines.txt": "a\nB\nc\nd\ne\n",
		});
		const patch = await formatDiff(repo, base.hash, source.hash);
		const target = await commitOn(repo, "target", {
			"lines.txt": "a\nb\nc\nD\ne\n",
		});

		const direct = await applyPatch(repo, { patch, onto: target.hash });
		expect(direct.status).toBe("rejected");

		const result = await applyPatch(repo, {
			patch,
			onto: target.hash,
			threeWay: true,
		});
		expect(result.status).toBe("applied");
		if (result.status !== "applied") return;
		expect(await fileInTree(repo, result.treeHash, "lines.txt")).toBe("a\nB\nc\nD\ne\n");
	});

	test("returns stage data when the fallback merge conflicts", async () => {
		const repo = await freshRepo();
		const base = await commitOn(repo, "main", { "value.txt": "base\n" });
		const source = await commitOn(repo, "main", { "value.txt": "theirs\n" });
		const patch = await formatDiff(repo, base.hash, source.hash);
		const target = await commitOn(repo, "target", { "value.txt": "ours\n" });

		const result = await applyPatch(repo, {
			patch,
			onto: target.hash,
			threeWay: true,
		});
		expect(result.status).toBe("conflicts");
		if (result.status !== "conflicts") return;
		expect(result.conflicts).toHaveLength(1);
		expect(result.conflicts[0]).toMatchObject({
			path: "value.txt",
			reason: "content",
			base: { hash: expect.any(String), mode: "100644" },
			ours: { hash: expect.any(String), mode: "100644" },
			theirs: { hash: expect.any(String), mode: "100644" },
		});
		expect(await fileInTree(repo, result.treeHash, "value.txt")).toContain("<<<<<<< onto");
	});

	test("uses the reversed postimage as the recorded three-way base", async () => {
		const repo = await freshRepo();
		const base = await commitOn(repo, "main", {
			"lines.txt": "a\nb\nc\nd\ne\n",
		});
		const source = await commitOn(repo, "main", {
			"lines.txt": "a\nB\nc\nd\ne\n",
		});
		const patch = await formatDiff(repo, base.hash, source.hash);
		const target = await commitOn(repo, "target", {
			"lines.txt": "a\nB\nc\nD\ne\n",
		});

		const result = await applyPatch(repo, {
			patch,
			onto: target.hash,
			reverse: true,
			threeWay: true,
		});
		expect(result.status).toBe("applied");
		if (result.status !== "applied") return;
		expect(await fileInTree(repo, result.treeHash, "lines.txt")).toBe("a\nb\nc\nD\ne\n");
	});

	test("preserves direct rejects when the patch has no recorded base", async () => {
		const repo = await freshRepo();
		const target = await commitOn(repo, "main", { "a.txt": "drifted\n" });
		const patch =
			"diff --git a/a.txt b/a.txt\n" +
			"--- a/a.txt\n" +
			"+++ b/a.txt\n" +
			"@@ -1 +1 @@\n" +
			"-base\n" +
			"+patched\n";

		const result = await applyPatch(repo, {
			patch,
			onto: target.hash,
			threeWay: true,
		});
		expect(result.status).toBe("rejected");
		if (result.status !== "rejected") return;
		expect(result.rejects[0]?.path).toBe("a.txt");
		expect(result.rejects[0]?.currentContent).toBe("drifted\n");
	});
});

describe("promoted pure primitives", () => {
	test("parsePatch + reversePatch are exposed on the repo surface", async () => {
		const repo = await freshRepo();
		const a = await commitOn(repo, "main", { "a.txt": "one\ntwo\n" });
		const b = await commitOn(repo, "main", { "a.txt": "one\ntwo\nthree\n" });
		const text = await formatDiff(repo, a.hash, b.hash);

		const parsed = parsePatch(text);
		expect(parsed).toHaveLength(1);
		expect(parsed[0]!.newName).toBe("a.txt");

		const reversed = reversePatch(parsed[0]!);
		// Reversing swaps add/delete line counts.
		expect(reversed.linesAdded).toBe(parsed[0]!.linesDeleted);
		expect(reversed.linesDeleted).toBe(parsed[0]!.linesAdded);

		// Applying the parsed patches (not text) works too.
		const res = await applyPatch(repo, { patch: parsed, onto: a.hash });
		expect(res.status).toBe("applied");
		if (res.status === "applied") expect(res.treeHash).toBe(b.tree);
	});
});
