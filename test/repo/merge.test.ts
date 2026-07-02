import { describe, expect, test } from "bun:test";
import { everyPath } from "../../src/lib/attributes/attribute-resolver.ts";
import { withCapabilities } from "../../src/lib/capabilities.ts";
import type { GitRepo, Identity } from "../../src/lib/types.ts";
import { merge } from "../../src/repo/operations.ts";
import { textMergeDriver } from "../fixtures.ts";
import { readCommit, resolveRef } from "../../src/repo/reading.ts";
import { createTreeAccessor } from "../../src/repo/tree-accessor.ts";
import { commit, writeBlob } from "../../src/repo/writing.ts";
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

function readFileFromTree(repo: GitRepo, treeHash: string, path: string): Promise<string | null> {
	return createTreeAccessor(repo, treeHash).readFile(path);
}

async function fileAtCommit(
	repo: GitRepo,
	commitHash: string,
	path: string,
): Promise<string | null> {
	const c = await readCommit(repo, commitHash);
	return createTreeAccessor(repo, c.tree).readFile(path);
}

/**
 * main and feature diverge from a common base, both editing `shared.txt`
 * differently (a content conflict) while each adds its own file.
 */
async function setupConflict() {
	const repo = await freshRepo();
	const base = await commit(repo, {
		files: { "shared.txt": "base\n", "a.txt": "a\n" },
		message: "base",
		author: ID,
		branch: "main",
	});
	await repo.refStore.writeRef("refs/heads/feature", { type: "direct", hash: base });

	const oursTip = await commit(repo, {
		files: { "shared.txt": "ours\n", "main.txt": "m\n" },
		message: "ours edit",
		author: ID,
		branch: "main",
	});
	const theirsTip = await commit(repo, {
		files: { "shared.txt": "theirs\n", "feat.txt": "f\n" },
		message: "theirs edit",
		author: ID,
		branch: "feature",
	});

	return { repo, base, oursTip, theirsTip };
}

/** main and feature diverge but touch different files — a clean three-way merge. */
async function setupCleanDivergent() {
	const repo = await freshRepo();
	const base = await commit(repo, {
		files: { "a.txt": "a\n" },
		message: "base",
		author: ID,
		branch: "main",
	});
	await repo.refStore.writeRef("refs/heads/feature", { type: "direct", hash: base });

	const oursTip = await commit(repo, {
		files: { "main.txt": "m\n" },
		message: "ours edit",
		author: ID,
		branch: "main",
	});
	const theirsTip = await commit(repo, {
		files: { "feat.txt": "f\n" },
		message: "theirs edit",
		author: ID,
		branch: "feature",
	});

	return { repo, base, oursTip, theirsTip };
}

/** feature is strictly ahead of main (fast-forwardable). */
async function setupFastForward() {
	const repo = await freshRepo();
	const base = await commit(repo, {
		files: { "a.txt": "a\n" },
		message: "base",
		author: ID,
		branch: "main",
	});
	await repo.refStore.writeRef("refs/heads/feature", { type: "direct", hash: base });
	const ahead = await commit(repo, {
		files: { "b.txt": "b\n" },
		message: "ahead",
		author: ID,
		branch: "feature",
	});
	return { repo, base, ahead };
}

describe("merge: clean / fast-forward / up-to-date", () => {
	test("clean three-way merge creates a two-parent commit and advances the branch", async () => {
		const { repo, oursTip, theirsTip } = await setupCleanDivergent();

		const res = await merge(repo, { ours: "main", theirs: "feature", author: ID, branch: "main" });

		expect(res.status).toBe("merged");
		if (res.status !== "merged") throw new Error("unreachable");

		const commitObj = await readCommit(repo, res.hash);
		expect(commitObj.parents).toEqual([oursTip, theirsTip]);
		// Both sides' files are present in the merged tree.
		expect(await readFileFromTree(repo, res.treeHash, "main.txt")).toBe("m\n");
		expect(await readFileFromTree(repo, res.treeHash, "feat.txt")).toBe("f\n");
		// Branch advanced to the merge commit.
		expect(await resolveRef(repo, "refs/heads/main")).toBe(res.hash);
	});

	test("default fast-forwards when ours is an ancestor of theirs", async () => {
		const { repo, ahead } = await setupFastForward();

		const res = await merge(repo, { ours: "main", theirs: "feature", author: ID, branch: "main" });

		expect(res.status).toBe("fast-forward");
		if (res.status === "conflicts") throw new Error("unreachable");
		expect(res.hash).toBe(ahead);
		// No merge commit: the branch simply moved to theirs.
		expect(await resolveRef(repo, "refs/heads/main")).toBe(ahead);
		expect((await readCommit(repo, ahead)).parents).toHaveLength(1);
	});

	test('fastForward "never" forces a merge commit on a fast-forwardable merge', async () => {
		const { repo, base, ahead } = await setupFastForward();

		const res = await merge(repo, {
			ours: "main",
			theirs: "feature",
			author: ID,
			branch: "main",
			fastForward: "never",
		});

		expect(res.status).toBe("merged");
		if (res.status !== "merged") throw new Error("unreachable");
		expect((await readCommit(repo, res.hash)).parents).toEqual([base, ahead]);
		expect(await resolveRef(repo, "refs/heads/main")).toBe(res.hash);
	});

	test('fastForward "only" throws on a non-fast-forward merge', async () => {
		const { repo } = await setupCleanDivergent();
		await expect(
			merge(repo, { ours: "main", theirs: "feature", author: ID, fastForward: "only" }),
		).rejects.toThrow("not a fast-forward");
	});

	test("author may be omitted for a fast-forward (no commit is created)", async () => {
		const { repo, ahead } = await setupFastForward();
		// No author supplied — a fast-forward creates no commit, so none is needed.
		const res = await merge(repo, { ours: "main", theirs: "feature", branch: "main" });
		expect(res.status).toBe("fast-forward");
		if (res.status === "conflicts") throw new Error("unreachable");
		expect(res.hash).toBe(ahead);
	});

	test("author is required when a merge commit must be created", async () => {
		const { repo } = await setupCleanDivergent();
		await expect(merge(repo, { ours: "main", theirs: "feature" })).rejects.toThrow("author");
	});

	test("merging an ancestor reports up-to-date and leaves the branch untouched", async () => {
		const { repo, base, oursTip } = await setupCleanDivergent();

		const res = await merge(repo, { ours: "main", theirs: base, author: ID, branch: "main" });

		expect(res.status).toBe("up-to-date");
		if (res.status === "conflicts") throw new Error("unreachable");
		expect(res.hash).toBe(oursTip);
		expect(await resolveRef(repo, "refs/heads/main")).toBe(oursTip);
	});

	test("uses a default merge message and honors a custom one", async () => {
		const a = await setupCleanDivergent();
		const def = await merge(a.repo, { ours: "main", theirs: "feature", author: ID });
		expect(def.status).toBe("merged");
		if (def.status !== "merged") throw new Error("unreachable");
		expect((await readCommit(a.repo, def.hash)).message).toBe("Merge feature into main");

		const b = await setupCleanDivergent();
		const custom = await merge(b.repo, {
			ours: "main",
			theirs: "feature",
			author: ID,
			message: "custom merge\n",
		});
		expect(custom.status).toBe("merged");
		if (custom.status !== "merged") throw new Error("unreachable");
		expect((await readCommit(b.repo, custom.hash)).message).toBe("custom merge\n");
	});
});

describe("merge: conflict probe", () => {
	test("returns structured conflicts with per-side blobs and creates no commit", async () => {
		const { repo, oursTip } = await setupConflict();

		const res = await merge(repo, { ours: "main", theirs: "feature", author: ID, branch: "main" });

		expect(res.status).toBe("conflicts");
		if (res.status !== "conflicts") throw new Error("unreachable");

		expect(res.conflicts).toHaveLength(1);
		const c = res.conflicts[0]!;
		expect(c.path).toBe("shared.txt");
		expect(c.reason).toBe("content");
		expect(c.base?.hash).toBe(await writeBlob(repo, "base\n"));
		expect(c.ours?.hash).toBe(await writeBlob(repo, "ours\n"));
		expect(c.theirs?.hash).toBe(await writeBlob(repo, "theirs\n"));
		expect(res.unresolved).toEqual(["shared.txt"]);

		// The probe echoes the resolved commit hashes.
		expect(res.ours).toBe(oursTip);

		// No commit and no ref movement happened.
		expect(await resolveRef(repo, "refs/heads/main")).toBe(oursTip);
	});

	test("conflicted result tree carries conflict markers", async () => {
		const { repo } = await setupConflict();
		const res = await merge(repo, { ours: "main", theirs: "feature", author: ID });
		expect(res.status).toBe("conflicts");
		if (res.status !== "conflicts") throw new Error("unreachable");
		const content = await readFileFromTree(repo, res.treeHash, "shared.txt");
		expect(content).toContain("<<<<<<<");
		expect(content).toContain(">>>>>>>");
	});
});

describe("merge: resolutions", () => {
	test('resolves with "theirs" and commits', async () => {
		const { repo, oursTip, theirsTip } = await setupConflict();
		const res = await merge(repo, {
			ours: "main",
			theirs: "feature",
			author: ID,
			branch: "main",
			resolutions: { "shared.txt": "theirs" },
		});
		expect(res.status).toBe("merged");
		if (res.status !== "merged") throw new Error("unreachable");
		expect((await readCommit(repo, res.hash)).parents).toEqual([oursTip, theirsTip]);
		expect(await readFileFromTree(repo, res.treeHash, "shared.txt")).toBe("theirs\n");
		expect(await resolveRef(repo, "refs/heads/main")).toBe(res.hash);
	});

	test('resolves with "ours"', async () => {
		const { repo } = await setupConflict();
		const res = await merge(repo, {
			ours: "main",
			theirs: "feature",
			author: ID,
			resolutions: { "shared.txt": "ours" },
		});
		expect(res.status).toBe("merged");
		if (res.status !== "merged") throw new Error("unreachable");
		expect(await readFileFromTree(repo, res.treeHash, "shared.txt")).toBe("ours\n");
	});

	test("resolves with explicit merged content", async () => {
		const { repo } = await setupConflict();
		const res = await merge(repo, {
			ours: "main",
			theirs: "feature",
			author: ID,
			resolutions: { "shared.txt": { content: "reconciled\n" } },
		});
		expect(res.status).toBe("merged");
		if (res.status !== "merged") throw new Error("unreachable");
		expect(await readFileFromTree(repo, res.treeHash, "shared.txt")).toBe("reconciled\n");
	});

	test("resolves with null to delete the conflicted path", async () => {
		const { repo } = await setupConflict();
		const res = await merge(repo, {
			ours: "main",
			theirs: "feature",
			author: ID,
			resolutions: { "shared.txt": null },
		});
		expect(res.status).toBe("merged");
		if (res.status !== "merged") throw new Error("unreachable");
		expect(await readFileFromTree(repo, res.treeHash, "shared.txt")).toBeNull();
		// Non-conflicted files from both sides survive.
		expect(await readFileFromTree(repo, res.treeHash, "main.txt")).toBe("m\n");
		expect(await readFileFromTree(repo, res.treeHash, "feat.txt")).toBe("f\n");
	});

	test("partial resolution stays in conflict and lists the remainder", async () => {
		const repo = await freshRepo();
		const base = await commit(repo, {
			files: { "x.txt": "x\n", "y.txt": "y\n" },
			message: "base",
			author: ID,
			branch: "main",
		});
		await repo.refStore.writeRef("refs/heads/feature", { type: "direct", hash: base });
		await commit(repo, {
			files: { "x.txt": "x-ours\n", "y.txt": "y-ours\n" },
			message: "ours",
			author: ID,
			branch: "main",
		});
		await commit(repo, {
			files: { "x.txt": "x-theirs\n", "y.txt": "y-theirs\n" },
			message: "theirs",
			author: ID,
			branch: "feature",
		});

		const res = await merge(repo, {
			ours: "main",
			theirs: "feature",
			author: ID,
			resolutions: { "x.txt": "ours" },
		});
		expect(res.status).toBe("conflicts");
		if (res.status !== "conflicts") throw new Error("unreachable");
		expect(res.unresolved).toEqual(["y.txt"]);
	});

	test("a resolution for a non-conflicted path is rejected", async () => {
		const { repo } = await setupConflict();
		await expect(
			merge(repo, {
				ours: "main",
				theirs: "feature",
				author: ID,
				resolutions: { "shared.txt": "ours", "not-a-conflict.txt": "ours" },
			}),
		).rejects.toThrow("not a conflicted path");
	});
});

describe("merge: two-call determinism", () => {
	test("probe then commit with echoed hashes yields a clean merge commit", async () => {
		const { repo, oursTip, theirsTip } = await setupConflict();

		const probe = await merge(repo, {
			ours: "main",
			theirs: "feature",
			author: ID,
			branch: "main",
		});
		expect(probe.status).toBe("conflicts");
		if (probe.status !== "conflicts") throw new Error("unreachable");

		// Resolve every conflict by taking theirs, re-using the resolved hashes.
		const resolutions = Object.fromEntries(probe.conflicts.map((c) => [c.path, "theirs" as const]));
		const committed = await merge(repo, {
			ours: probe.ours,
			theirs: probe.theirs,
			author: ID,
			branch: "main",
			resolutions,
		});

		expect(committed.status).toBe("merged");
		if (committed.status !== "merged") throw new Error("unreachable");
		expect((await readCommit(repo, committed.hash)).parents).toEqual([oursTip, theirsTip]);
		expect(await fileAtCommit(repo, committed.hash, "shared.txt")).toBe("theirs\n");
	});
});

describe("merge: delete/modify conflict", () => {
	test("surfaces a null side and resolves via theirs or delete", async () => {
		async function scenario() {
			const repo = await freshRepo();
			const base = await commit(repo, {
				files: { "del.txt": "x\n", "keep.txt": "k\n" },
				message: "base",
				author: ID,
				branch: "main",
			});
			await repo.refStore.writeRef("refs/heads/feature", { type: "direct", hash: base });
			// ours deletes del.txt
			await commit(repo, {
				files: { "del.txt": null },
				message: "delete",
				author: ID,
				branch: "main",
			});
			// theirs modifies del.txt
			await commit(repo, {
				files: { "del.txt": "modified\n" },
				message: "modify",
				author: ID,
				branch: "feature",
			});
			return repo;
		}

		const probeRepo = await scenario();
		const probe = await merge(probeRepo, { ours: "main", theirs: "feature", author: ID });
		expect(probe.status).toBe("conflicts");
		if (probe.status !== "conflicts") throw new Error("unreachable");
		const c = probe.conflicts.find((c) => c.path === "del.txt")!;
		expect(c.reason).toBe("delete-modify");
		expect(c.ours).toBeNull(); // ours deleted it
		expect(c.theirs?.hash).toBe(await writeBlob(probeRepo, "modified\n"));

		// "theirs" keeps the modified content.
		const keepRepo = await scenario();
		const keep = await merge(keepRepo, {
			ours: "main",
			theirs: "feature",
			author: ID,
			resolutions: { "del.txt": "theirs" },
		});
		expect(keep.status).toBe("merged");
		if (keep.status !== "merged") throw new Error("unreachable");
		expect(await readFileFromTree(keepRepo, keep.treeHash, "del.txt")).toBe("modified\n");

		// "ours" (deleted side) removes the path.
		const dropRepo = await scenario();
		const drop = await merge(dropRepo, {
			ours: "main",
			theirs: "feature",
			author: ID,
			resolutions: { "del.txt": "ours" },
		});
		expect(drop.status).toBe("merged");
		if (drop.status !== "merged") throw new Error("unreachable");
		expect(await readFileFromTree(dropRepo, drop.treeHash, "del.txt")).toBeNull();
	});
});

describe("merge: mergeDriver auto-resolution", () => {
	test("a mergeDriver can clear a content conflict before it surfaces", async () => {
		const { repo } = await setupConflict();
		const res = await merge(
			withCapabilities(repo, {
				attributes: everyPath({
					merge: textMergeDriver((_ctx, { path }) =>
						path === "shared.txt" ? { content: "driver-merged\n", conflict: false } : null,
					),
				}),
			}),
			{
				ours: "main",
				theirs: "feature",
				author: ID,
				branch: "main",
			},
		);
		expect(res.status).toBe("merged");
		if (res.status !== "merged") throw new Error("unreachable");
		expect(await readFileFromTree(repo, res.treeHash, "shared.txt")).toBe("driver-merged\n");
	});
});

describe("merge: branch CAS guard", () => {
	test("expectedOldHash matching the current tip advances the branch", async () => {
		const { repo, oursTip } = await setupCleanDivergent();
		const res = await merge(repo, {
			ours: "main",
			theirs: "feature",
			author: ID,
			branch: "main",
			expectedOldHash: oursTip,
		});
		expect(res.status).toBe("merged");
		if (res.status !== "merged") throw new Error("unreachable");
		expect(await resolveRef(repo, "refs/heads/main")).toBe(res.hash);
	});

	test("a stale expectedOldHash aborts the branch advance", async () => {
		const { repo, base } = await setupCleanDivergent();
		await expect(
			merge(repo, {
				ours: "main",
				theirs: "feature",
				author: ID,
				branch: "main",
				expectedOldHash: base, // not the current tip
			}),
		).rejects.toThrow("CAS failed");
	});
});
