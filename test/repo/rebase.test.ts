import { describe, expect, test } from "bun:test";
import type { MergeDriver } from "../../src/lib/merge-ort.ts";
import type { GitRepo, Identity } from "../../src/lib/types.ts";
import { merge, rebase } from "../../src/repo/operations.ts";
import { readCommit, resolveRef } from "../../src/repo/reading.ts";
import { createTreeAccessor } from "../../src/repo/tree-accessor.ts";
import { commit } from "../../src/repo/writing.ts";
import { MemoryStorage } from "../../src/storage/memory-storage.ts";
import { createRepoStore } from "../../src/storage/repo-store.ts";

/** Original author of the feature commits — must survive the replay. */
const AUTHOR: Identity = {
	name: "Alice",
	email: "alice@x.dev",
	timestamp: 1000000000,
	timezone: "+0000",
};

/** Identity that performs the rebase — becomes the committer of replayed commits. */
const BOT: Identity = {
	name: "Bot",
	email: "bot@x.dev",
	timestamp: 1000005000,
	timezone: "+0000",
};

async function freshRepo(): Promise<GitRepo> {
	return createRepoStore(new MemoryStorage()).createRepo("test");
}

async function fileAtCommit(
	repo: GitRepo,
	commitHash: string,
	path: string,
): Promise<string | null> {
	const c = await readCommit(repo, commitHash);
	return createTreeAccessor(repo, c.tree).readFile(path);
}

function branchFrom(repo: GitRepo, name: string, hash: string): Promise<void> {
	return repo.refStore.writeRef(`refs/heads/${name}`, { type: "direct", hash });
}

/**
 * main advances past the point feature branched off, and feature adds two
 * independent commits — the canonical linear rebase.
 */
async function setupLinear() {
	const repo = await freshRepo();
	const base = await commit(repo, {
		files: { "base.txt": "base\n" },
		message: "base",
		author: AUTHOR,
		branch: "main",
	});
	await branchFrom(repo, "feature", base);

	const mainTip = await commit(repo, {
		files: { "main.txt": "m\n" },
		message: "main work",
		author: AUTHOR,
		branch: "main",
	});
	const f1 = await commit(repo, {
		files: { "f1.txt": "1\n" },
		message: "feat 1",
		author: AUTHOR,
		branch: "feature",
	});
	const f2 = await commit(repo, {
		files: { "f2.txt": "2\n" },
		message: "feat 2",
		author: AUTHOR,
		branch: "feature",
	});

	return { repo, base, mainTip, f1, f2 };
}

describe("rebase: linear replay", () => {
	test("replays feature commits onto main, preserving author and order", async () => {
		const { repo, mainTip } = await setupLinear();

		const res = await rebase(repo, {
			rebase: "feature",
			upstream: "main",
			branch: "feature",
			committer: BOT,
		});

		expect(res.status).toBe("ok");
		if (res.status !== "ok") throw new Error("unreachable");

		expect(res.rebased.length).toBe(2);
		expect(res.skipped).toEqual([]);
		expect(res.dropped).toEqual([]);

		// The branch advanced to the new tip.
		expect(await resolveRef(repo, "refs/heads/feature")).toBe(res.head);

		// Linear chain: new feat2 → new feat1 → main tip.
		const top = await readCommit(repo, res.head);
		expect(top.parents.length).toBe(1);
		const lower = await readCommit(repo, top.parents[0] as string);
		expect(lower.parents).toEqual([mainTip]);

		// Both main's and feature's files survive.
		expect(await fileAtCommit(repo, res.head, "main.txt")).toBe("m\n");
		expect(await fileAtCommit(repo, res.head, "f1.txt")).toBe("1\n");
		expect(await fileAtCommit(repo, res.head, "f2.txt")).toBe("2\n");

		// Original author preserved; committer is the rebase identity.
		expect(top.author.email).toBe("alice@x.dev");
		expect(top.committer.email).toBe("bot@x.dev");
		expect(top.message).toContain("feat 2");
	});

	test("omitting `branch` does not advance any ref", async () => {
		const { repo } = await setupLinear();
		const featureTip = await resolveRef(repo, "refs/heads/feature");

		const res = await rebase(repo, { rebase: "feature", upstream: "main", committer: BOT });

		expect(res.status).toBe("ok");
		expect(await resolveRef(repo, "refs/heads/feature")).toBe(featureTip);
	});

	test("defaults `onto` to `upstream`", async () => {
		const { repo, mainTip } = await setupLinear();
		const res = await rebase(repo, { rebase: "feature", upstream: "main", committer: BOT });
		if (res.status !== "ok") throw new Error("unreachable");
		const first = await readCommit(repo, res.rebased[0] as string);
		expect(first.parents).toEqual([mainTip]);
	});
});

describe("rebase: empty ranges", () => {
	test("reports up-to-date when feature already equals onto", async () => {
		const repo = await freshRepo();
		const base = await commit(repo, {
			files: { "a.txt": "a\n" },
			message: "base",
			author: AUTHOR,
			branch: "main",
		});
		await branchFrom(repo, "feature", base);

		const res = await rebase(repo, { rebase: "feature", upstream: "main", committer: BOT });
		expect(res.status).toBe("up-to-date");
		if (res.status !== "up-to-date") throw new Error("unreachable");
		expect(res.head).toBe(base);
	});

	test("fast-forwards feature to onto when it has no unique commits", async () => {
		const repo = await freshRepo();
		const base = await commit(repo, {
			files: { "a.txt": "a\n" },
			message: "base",
			author: AUTHOR,
			branch: "main",
		});
		await branchFrom(repo, "feature", base);
		const mainTip = await commit(repo, {
			files: { "b.txt": "b\n" },
			message: "main work",
			author: AUTHOR,
			branch: "main",
		});

		const res = await rebase(repo, {
			rebase: "feature",
			upstream: "main",
			branch: "feature",
			committer: BOT,
		});

		expect(res.status).toBe("ok");
		if (res.status !== "ok") throw new Error("unreachable");
		expect(res.head).toBe(mainTip);
		expect(res.rebased).toEqual([]);
		expect(await resolveRef(repo, "refs/heads/feature")).toBe(mainTip);
	});
});

describe("rebase: cherry-pick dedup and empty commits", () => {
	/** feature and main each introduce the same change (identical patch-id). */
	async function setupDedup() {
		const repo = await freshRepo();
		const base = await commit(repo, {
			files: { "base.txt": "base\n" },
			message: "base",
			author: AUTHOR,
			branch: "main",
		});
		await branchFrom(repo, "feature", base);

		const f1 = await commit(repo, {
			files: { "foo.txt": "hello\n" },
			message: "add foo",
			author: AUTHOR,
			branch: "feature",
		});
		const mainTip = await commit(repo, {
			files: { "foo.txt": "hello\n" },
			message: "also add foo",
			author: AUTHOR,
			branch: "main",
		});
		return { repo, f1, mainTip };
	}

	test("skips a commit already applied upstream (by patch-id)", async () => {
		const { repo, f1, mainTip } = await setupDedup();

		const res = await rebase(repo, { rebase: "feature", upstream: "main", committer: BOT });

		expect(res.status).toBe("ok");
		if (res.status !== "ok") throw new Error("unreachable");
		expect(res.skipped).toEqual([f1]);
		expect(res.rebased).toEqual([]);
		expect(res.head).toBe(mainTip);
	});

	test("reapplyCherryPicks replays the commit, which then drops as empty", async () => {
		const { repo, f1, mainTip } = await setupDedup();

		const res = await rebase(repo, {
			rebase: "feature",
			upstream: "main",
			committer: BOT,
			reapplyCherryPicks: true,
		});

		expect(res.status).toBe("ok");
		if (res.status !== "ok") throw new Error("unreachable");
		expect(res.skipped).toEqual([]);
		expect(res.dropped).toEqual([f1]);
		expect(res.rebased).toEqual([]);
		expect(res.head).toBe(mainTip);
	});

	test("preserves a commit that was already empty in the original history", async () => {
		const repo = await freshRepo();
		const base = await commit(repo, {
			files: { "base.txt": "base\n" },
			message: "base",
			author: AUTHOR,
			branch: "main",
		});
		await branchFrom(repo, "feature", base);
		const mainTip = await commit(repo, {
			files: { "main.txt": "m\n" },
			message: "main work",
			author: AUTHOR,
			branch: "main",
		});
		// An intentionally empty feature commit (tree unchanged from its parent).
		await commit(repo, { files: {}, message: "empty marker", author: AUTHOR, branch: "feature" });

		const res = await rebase(repo, { rebase: "feature", upstream: "main", committer: BOT });

		expect(res.status).toBe("ok");
		if (res.status !== "ok") throw new Error("unreachable");
		expect(res.rebased.length).toBe(1);
		expect(res.dropped).toEqual([]);
		const top = await readCommit(repo, res.head);
		expect(top.parents).toEqual([mainTip]);
		const mainCommit = await readCommit(repo, mainTip);
		expect(top.tree).toBe(mainCommit.tree);
		expect(top.message).toContain("empty marker");
	});
});

describe("rebase: merge commits are dropped", () => {
	test("linearizes a feature that contains a merge commit", async () => {
		const repo = await freshRepo();
		const base = await commit(repo, {
			files: { "base.txt": "base\n" },
			message: "base",
			author: AUTHOR,
			branch: "main",
		});
		await branchFrom(repo, "feature", base);
		await branchFrom(repo, "side", base);

		await commit(repo, {
			files: { "a.txt": "a\n" },
			message: "feat a",
			author: AUTHOR,
			branch: "feature",
		});
		await commit(repo, {
			files: { "b.txt": "b\n" },
			message: "side b",
			author: AUTHOR,
			branch: "side",
		});
		// Merge side into feature.
		const mergeRes = await merge(repo, {
			ours: "feature",
			theirs: "side",
			author: AUTHOR,
			branch: "feature",
		});
		expect(mergeRes.status).toBe("merged");
		await commit(repo, {
			files: { "c.txt": "c\n" },
			message: "feat c",
			author: AUTHOR,
			branch: "feature",
		});

		const mainTip = await commit(repo, {
			files: { "main.txt": "m\n" },
			message: "main work",
			author: AUTHOR,
			branch: "main",
		});

		const res = await rebase(repo, {
			rebase: "feature",
			upstream: "main",
			branch: "feature",
			committer: BOT,
		});

		expect(res.status).toBe("ok");
		if (res.status !== "ok") throw new Error("unreachable");

		// The three non-merge commits replay; the merge itself is dropped.
		expect(res.rebased.length).toBe(3);
		for (const h of res.rebased) {
			const cm = await readCommit(repo, h);
			expect(cm.parents.length).toBe(1);
		}

		// The chain roots at main's tip and carries every file.
		const first = await readCommit(repo, res.rebased[0] as string);
		expect(first.parents).toEqual([mainTip]);
		expect(await fileAtCommit(repo, res.head, "a.txt")).toBe("a\n");
		expect(await fileAtCommit(repo, res.head, "b.txt")).toBe("b\n");
		expect(await fileAtCommit(repo, res.head, "c.txt")).toBe("c\n");
		expect(await fileAtCommit(repo, res.head, "main.txt")).toBe("m\n");
	});
});

describe("rebase: conflicts and resume", () => {
	/** main and feature both change shared.txt — feature's commit conflicts on replay. */
	async function setupConflict() {
		const repo = await freshRepo();
		const base = await commit(repo, {
			files: { "shared.txt": "base\n" },
			message: "base",
			author: AUTHOR,
			branch: "main",
		});
		await branchFrom(repo, "feature", base);
		const mainTip = await commit(repo, {
			files: { "shared.txt": "main\n" },
			message: "main edit",
			author: AUTHOR,
			branch: "main",
		});
		const f1 = await commit(repo, {
			files: { "shared.txt": "feature\n", "feat.txt": "f\n" },
			message: "feature edit",
			author: AUTHOR,
			branch: "feature",
		});
		return { repo, mainTip, f1 };
	}

	test("stops on conflict and resumes with a resolution", async () => {
		const { repo, f1 } = await setupConflict();

		const res = await rebase(repo, {
			rebase: "feature",
			upstream: "main",
			branch: "feature",
			committer: BOT,
		});

		expect(res.status).toBe("conflicts");
		if (res.status !== "conflicts") throw new Error("unreachable");
		expect(res.commit).toBe(f1);
		expect(res.conflicts.map((c) => c.path)).toContain("shared.txt");
		expect(res.unresolved).toContain("shared.txt");

		const res2 = await rebase(repo, {
			continue: res.continuation,
			resolutions: { "shared.txt": "theirs" },
		});

		expect(res2.status).toBe("ok");
		if (res2.status !== "ok") throw new Error("unreachable");
		expect(await fileAtCommit(repo, res2.head, "shared.txt")).toBe("feature\n");
		expect(await fileAtCommit(repo, res2.head, "feat.txt")).toBe("f\n");
		expect(await resolveRef(repo, "refs/heads/feature")).toBe(res2.head);

		const top = await readCommit(repo, res2.head);
		expect(top.author.email).toBe("alice@x.dev");
		expect(top.committer.email).toBe("bot@x.dev");
	});

	test("explicit content resolution is honored on resume", async () => {
		const { repo } = await setupConflict();
		const res = await rebase(repo, { rebase: "feature", upstream: "main", committer: BOT });
		if (res.status !== "conflicts") throw new Error("unreachable");

		const res2 = await rebase(repo, {
			continue: res.continuation,
			resolutions: { "shared.txt": { content: "reconciled\n" } },
		});
		if (res2.status !== "ok") throw new Error("unreachable");
		expect(await fileAtCommit(repo, res2.head, "shared.txt")).toBe("reconciled\n");
	});

	test("a merge driver auto-resolves conflicts during replay", async () => {
		const { repo } = await setupConflict();
		const driver: MergeDriver = (ctx) =>
			ctx.path === "shared.txt" ? { content: "auto\n", conflict: false } : null;

		const res = await rebase(repo, {
			rebase: "feature",
			upstream: "main",
			branch: "feature",
			committer: BOT,
			mergeDriver: driver,
		});

		expect(res.status).toBe("ok");
		if (res.status !== "ok") throw new Error("unreachable");
		expect(await fileAtCommit(repo, res.head, "shared.txt")).toBe("auto\n");
	});
});

describe("rebase: partial resolution", () => {
	test("re-reports remaining conflicts until every path is resolved", async () => {
		const repo = await freshRepo();
		const base = await commit(repo, {
			files: { "x.txt": "bx\n", "y.txt": "by\n" },
			message: "base",
			author: AUTHOR,
			branch: "main",
		});
		await branchFrom(repo, "feature", base);
		await commit(repo, {
			files: { "x.txt": "mx\n", "y.txt": "my\n" },
			message: "main edit",
			author: AUTHOR,
			branch: "main",
		});
		const f1 = await commit(repo, {
			files: { "x.txt": "fx\n", "y.txt": "fy\n" },
			message: "feature edit",
			author: AUTHOR,
			branch: "feature",
		});

		const res = await rebase(repo, { rebase: "feature", upstream: "main", committer: BOT });
		if (res.status !== "conflicts") throw new Error("unreachable");
		expect(res.unresolved.sort()).toEqual(["x.txt", "y.txt"]);

		// Resolve only one path — still conflicted, same commit.
		const partial = await rebase(repo, {
			continue: res.continuation,
			resolutions: { "x.txt": "theirs" },
		});
		expect(partial.status).toBe("conflicts");
		if (partial.status !== "conflicts") throw new Error("unreachable");
		expect(partial.commit).toBe(f1);
		expect(partial.unresolved).toEqual(["y.txt"]);

		// Resolve both — completes.
		const done = await rebase(repo, {
			continue: partial.continuation,
			resolutions: { "x.txt": "theirs", "y.txt": "ours" },
		});
		expect(done.status).toBe("ok");
		if (done.status !== "ok") throw new Error("unreachable");
		expect(await fileAtCommit(repo, done.head, "x.txt")).toBe("fx\n");
		expect(await fileAtCommit(repo, done.head, "y.txt")).toBe("my\n");
	});
});

describe("rebase: multi-step conflicts", () => {
	test("resumes through conflicts in consecutive commits", async () => {
		const repo = await freshRepo();
		const base = await commit(repo, {
			files: { "p.txt": "bp\n", "q.txt": "bq\n" },
			message: "base",
			author: AUTHOR,
			branch: "main",
		});
		await branchFrom(repo, "feature", base);
		await commit(repo, {
			files: { "p.txt": "mp\n", "q.txt": "mq\n" },
			message: "main edit",
			author: AUTHOR,
			branch: "main",
		});
		const f1 = await commit(repo, {
			files: { "p.txt": "fp\n" },
			message: "feature p",
			author: AUTHOR,
			branch: "feature",
		});
		const f2 = await commit(repo, {
			files: { "q.txt": "fq\n" },
			message: "feature q",
			author: AUTHOR,
			branch: "feature",
		});

		let res = await rebase(repo, {
			rebase: "feature",
			upstream: "main",
			branch: "feature",
			committer: BOT,
		});
		expect(res.status).toBe("conflicts");
		if (res.status !== "conflicts") throw new Error("unreachable");
		expect(res.commit).toBe(f1);

		res = await rebase(repo, { continue: res.continuation, resolutions: { "p.txt": "theirs" } });
		expect(res.status).toBe("conflicts");
		if (res.status !== "conflicts") throw new Error("unreachable");
		expect(res.commit).toBe(f2);

		res = await rebase(repo, { continue: res.continuation, resolutions: { "q.txt": "theirs" } });
		expect(res.status).toBe("ok");
		if (res.status !== "ok") throw new Error("unreachable");
		expect(res.rebased.length).toBe(2);
		expect(await fileAtCommit(repo, res.head, "p.txt")).toBe("fp\n");
		expect(await fileAtCommit(repo, res.head, "q.txt")).toBe("fq\n");
		expect(await resolveRef(repo, "refs/heads/feature")).toBe(res.head);
	});
});

describe("rebase: branch CAS guard", () => {
	test("a stale expectedOldHash aborts the branch advance", async () => {
		const { repo } = await setupLinear();
		await expect(
			rebase(repo, {
				rebase: "feature",
				upstream: "main",
				branch: "feature",
				committer: BOT,
				expectedOldHash: "0".repeat(40),
			}),
		).rejects.toThrow("CAS failed");
	});

	test("a matching expectedOldHash allows the advance", async () => {
		const { repo } = await setupLinear();
		const featureTip = await resolveRef(repo, "refs/heads/feature");

		const res = await rebase(repo, {
			rebase: "feature",
			upstream: "main",
			branch: "feature",
			committer: BOT,
			expectedOldHash: featureTip,
		});

		expect(res.status).toBe("ok");
		if (res.status !== "ok") throw new Error("unreachable");
		expect(await resolveRef(repo, "refs/heads/feature")).toBe(res.head);
	});
});
