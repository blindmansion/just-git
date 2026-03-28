import { describe, expect, test } from "bun:test";
import type { Identity, GitRepo } from "../../src/lib/types.ts";
import { MemoryStorage } from "../../src/server/memory-storage.ts";
import { createStorageAdapter } from "../../src/server/storage.ts";
import { cherryPick, revert } from "../../src/repo/operations.ts";
import { readCommit } from "../../src/repo/reading.ts";
import { createCommit, updateTree, writeBlob, writeTree } from "../../src/repo/writing.ts";
import { readBlobContent } from "../../src/lib/object-db.ts";
import { flattenTree } from "../../src/repo/diffing.ts";

const ID: Identity = {
	name: "Test",
	email: "test@test.com",
	timestamp: 1000000000,
	timezone: "+0000",
};

function idAt(ts: number): Identity {
	return { ...ID, timestamp: ts };
}

async function freshRepo(): Promise<GitRepo> {
	return createStorageAdapter(new MemoryStorage()).createRepo("test");
}

async function treeWithFiles(repo: GitRepo, files: Record<string, string>): Promise<string> {
	const entries = await Promise.all(
		Object.entries(files).map(async ([name, content]) => ({
			name,
			hash: await writeBlob(repo, content),
		})),
	);
	return writeTree(repo, entries);
}

async function commitTree(
	repo: GitRepo,
	tree: string,
	parents: string[],
	ts = 1000000000,
	message = "commit\n",
): Promise<string> {
	return createCommit(repo, {
		tree,
		parents,
		author: idAt(ts),
		committer: idAt(ts),
		message,
	});
}

async function readFileFromTree(
	repo: GitRepo,
	treeHash: string,
	filename: string,
): Promise<string | null> {
	const entries = await flattenTree(repo, treeHash);
	const entry = entries.find((e) => e.path === filename);
	if (!entry) return null;
	return readBlobContent(repo, entry.hash);
}

/**
 * Build a scenario with two diverged branches:
 *
 *   c1 (base: a.txt="a\n")
 *   ├── c2 (main: b.txt="b\n")
 *   └── c3 (feature: c.txt="c\n")
 */
async function setupDivergent() {
	const repo = await freshRepo();
	const t1 = await treeWithFiles(repo, { "a.txt": "a\n" });
	const c1 = await commitTree(repo, t1, [], 1, "initial\n");

	const t2 = await updateTree(repo, t1, [{ path: "b.txt", hash: await writeBlob(repo, "b\n") }]);
	const c2 = await commitTree(repo, t2, [c1], 2, "add b\n");

	const t3 = await updateTree(repo, t1, [{ path: "c.txt", hash: await writeBlob(repo, "c\n") }]);
	const c3 = await commitTree(repo, t3, [c1], 3, "add c\n");

	await repo.refStore.writeRef("HEAD", { type: "symbolic", target: "refs/heads/main" });
	await repo.refStore.writeRef("refs/heads/main", c2);
	await repo.refStore.writeRef("refs/heads/feature", c3);

	return { repo, c1, c2, c3, t1, t2, t3 };
}

// ── Cherry-pick tests ───────────────────────────────────────────────

describe("cherryPick", () => {
	test("applies a commit's changes onto another branch", async () => {
		const { repo, c2, c3 } = await setupDivergent();

		const result = await cherryPick(repo, {
			commit: c3,
			onto: c2,
		});

		expect(result.clean).toBe(true);
		if (!result.clean) return;

		// Result tree should have a.txt, b.txt, and c.txt
		expect(await readFileFromTree(repo, result.treeHash, "a.txt")).toBe("a\n");
		expect(await readFileFromTree(repo, result.treeHash, "b.txt")).toBe("b\n");
		expect(await readFileFromTree(repo, result.treeHash, "c.txt")).toBe("c\n");
	});

	test("preserves original author", async () => {
		const { repo, c2, c3 } = await setupDivergent();
		const committer: Identity = {
			name: "Committer",
			email: "committer@test.com",
			timestamp: 999,
			timezone: "+0000",
		};

		const result = await cherryPick(repo, {
			commit: c3,
			onto: c2,
			committer,
		});

		expect(result.clean).toBe(true);
		if (!result.clean) return;

		const commit = await readCommit(repo, result.hash);
		expect(commit.author).toEqual(idAt(3));
		expect(commit.committer).toEqual(committer);
	});

	test("preserves original commit message", async () => {
		const { repo, c2, c3 } = await setupDivergent();

		const result = await cherryPick(repo, { commit: c3, onto: c2 });

		expect(result.clean).toBe(true);
		if (!result.clean) return;

		const commit = await readCommit(repo, result.hash);
		expect(commit.message).toBe("add c\n");
	});

	test("recordOrigin appends trailer", async () => {
		const { repo, c2, c3 } = await setupDivergent();

		const result = await cherryPick(repo, {
			commit: c3,
			onto: c2,
			recordOrigin: true,
		});

		expect(result.clean).toBe(true);
		if (!result.clean) return;

		const commit = await readCommit(repo, result.hash);
		expect(commit.message).toContain(`(cherry picked from commit ${c3})`);
	});

	test("advances branch ref when branch is provided", async () => {
		const { repo, c2, c3 } = await setupDivergent();

		const result = await cherryPick(repo, {
			commit: c3,
			onto: c2,
			branch: "main",
		});

		expect(result.clean).toBe(true);
		if (!result.clean) return;

		const mainRef = await repo.refStore.readRef("refs/heads/main");
		expect(mainRef).toEqual({ type: "direct", hash: result.hash });
	});

	test("does not update refs when branch is omitted", async () => {
		const { repo, c2, c3 } = await setupDivergent();

		const mainBefore = await repo.refStore.readRef("refs/heads/main");
		await cherryPick(repo, { commit: c3, onto: c2 });
		const mainAfter = await repo.refStore.readRef("refs/heads/main");

		expect(mainAfter).toEqual(mainBefore);
	});

	test("parent of new commit is the onto commit", async () => {
		const { repo, c2, c3 } = await setupDivergent();

		const result = await cherryPick(repo, { commit: c3, onto: c2 });

		expect(result.clean).toBe(true);
		if (!result.clean) return;

		const commit = await readCommit(repo, result.hash);
		expect(commit.parents).toEqual([c2]);
	});

	test("resolves rev-parse expressions for commit and onto", async () => {
		const { repo } = await setupDivergent();

		const result = await cherryPick(repo, {
			commit: "feature",
			onto: "main",
		});

		expect(result.clean).toBe(true);
	});

	test("returns conflicts when changes overlap", async () => {
		const repo = await freshRepo();

		const t1 = await treeWithFiles(repo, { "f.txt": "base\n" });
		const c1 = await commitTree(repo, t1, [], 1);

		const t2 = await updateTree(repo, t1, [
			{ path: "f.txt", hash: await writeBlob(repo, "ours\n") },
		]);
		const c2 = await commitTree(repo, t2, [c1], 2);

		const t3 = await updateTree(repo, t1, [
			{ path: "f.txt", hash: await writeBlob(repo, "theirs\n") },
		]);
		const c3 = await commitTree(repo, t3, [c1], 3);

		const result = await cherryPick(repo, { commit: c3, onto: c2 });

		expect(result.clean).toBe(false);
		if (result.clean) return;
		expect(result.conflicts.length).toBeGreaterThan(0);
		expect(result.conflicts[0].path).toBe("f.txt");
	});

	test("cherry-picks a root commit (no parent)", async () => {
		const repo = await freshRepo();

		const t1 = await treeWithFiles(repo, { "new.txt": "hello\n" });
		const c1 = await commitTree(repo, t1, [], 1, "root commit\n");

		const t2 = await treeWithFiles(repo, { "existing.txt": "existing\n" });
		const c2 = await commitTree(repo, t2, [], 2, "other root\n");

		const result = await cherryPick(repo, { commit: c1, onto: c2 });

		expect(result.clean).toBe(true);
		if (!result.clean) return;

		expect(await readFileFromTree(repo, result.treeHash, "new.txt")).toBe("hello\n");
		expect(await readFileFromTree(repo, result.treeHash, "existing.txt")).toBe("existing\n");
	});

	test("cherry-picks a merge commit with mainline", async () => {
		const { repo, c1, c2, c3 } = await setupDivergent();

		// Create a merge commit: merge c3 into c2
		const mergeTree = await updateTree(
			repo,
			await (async () => {
				const commit = await readCommit(repo, c2);
				return commit.tree;
			})(),
			[{ path: "c.txt", hash: await writeBlob(repo, "c\n") }],
		);
		const mergeCommit = await commitTree(repo, mergeTree, [c2, c3], 4, "merge feature\n");

		// Cherry-pick the merge using mainline=1 (diff against first parent c2)
		const result = await cherryPick(repo, {
			commit: mergeCommit,
			onto: c1,
			mainline: 1,
		});

		expect(result.clean).toBe(true);
		if (!result.clean) return;

		// mainline=1 means base is c2. The diff c2→merge adds c.txt.
		expect(await readFileFromTree(repo, result.treeHash, "c.txt")).toBe("c\n");
	});

	test("throws when cherry-picking merge without mainline", async () => {
		const { repo, c1, c2, c3 } = await setupDivergent();

		const mergeTree = await (async () => {
			const commit = await readCommit(repo, c2);
			return commit.tree;
		})();
		const mergeCommit = await commitTree(repo, mergeTree, [c2, c3], 4);

		await expect(cherryPick(repo, { commit: mergeCommit, onto: c1 })).rejects.toThrow(
			"merge but no mainline",
		);
	});

	test("throws when mainline specified for non-merge commit", async () => {
		const { repo, c2, c3 } = await setupDivergent();

		await expect(cherryPick(repo, { commit: c3, onto: c2, mainline: 1 })).rejects.toThrow(
			"not a merge",
		);
	});

	test("throws when mainline is out of range", async () => {
		const { repo, c1, c2, c3 } = await setupDivergent();

		const mergeTree = await (async () => {
			const commit = await readCommit(repo, c2);
			return commit.tree;
		})();
		const mergeCommit = await commitTree(repo, mergeTree, [c2, c3], 4);

		await expect(cherryPick(repo, { commit: mergeCommit, onto: c1, mainline: 5 })).rejects.toThrow(
			"does not have parent 5",
		);
	});

	test("throws for unresolvable revision", async () => {
		const { repo, c2 } = await setupDivergent();

		await expect(cherryPick(repo, { commit: "nonexistent", onto: c2 })).rejects.toThrow(
			"not found",
		);
	});
});

// ── Revert tests ────────────────────────────────────────────────────

describe("revert", () => {
	test("reverses a commit's changes", async () => {
		const repo = await freshRepo();

		const t1 = await treeWithFiles(repo, { "a.txt": "a\n" });
		const c1 = await commitTree(repo, t1, [], 1);

		const t2 = await updateTree(repo, t1, [{ path: "b.txt", hash: await writeBlob(repo, "b\n") }]);
		const c2 = await commitTree(repo, t2, [c1], 2, "add b\n");

		// Revert c2 on top of c2 — should remove b.txt
		const result = await revert(repo, {
			commit: c2,
			onto: c2,
			committer: ID,
		});

		expect(result.clean).toBe(true);
		if (!result.clean) return;

		expect(await readFileFromTree(repo, result.treeHash, "a.txt")).toBe("a\n");
		expect(await readFileFromTree(repo, result.treeHash, "b.txt")).toBeNull();
	});

	test("generates Revert message", async () => {
		const repo = await freshRepo();

		const t1 = await treeWithFiles(repo, { "a.txt": "a\n" });
		const c1 = await commitTree(repo, t1, [], 1, "original subject\n");

		const result = await revert(repo, {
			commit: c1,
			onto: c1,
			committer: ID,
		});

		expect(result.clean).toBe(true);
		if (!result.clean) return;

		const commit = await readCommit(repo, result.hash);
		expect(commit.message).toContain('Revert "original subject"');
		expect(commit.message).toContain(`This reverts commit ${c1}.`);
	});

	test("uses author when provided", async () => {
		const repo = await freshRepo();

		const t1 = await treeWithFiles(repo, { "a.txt": "a\n" });
		const c1 = await commitTree(repo, t1, [], 1);

		const author: Identity = {
			name: "Author",
			email: "author@test.com",
			timestamp: 500,
			timezone: "+0000",
		};
		const committer: Identity = {
			name: "Committer",
			email: "committer@test.com",
			timestamp: 600,
			timezone: "+0000",
		};

		const result = await revert(repo, {
			commit: c1,
			onto: c1,
			author,
			committer,
		});

		expect(result.clean).toBe(true);
		if (!result.clean) return;

		const commit = await readCommit(repo, result.hash);
		expect(commit.author).toEqual(author);
		expect(commit.committer).toEqual(committer);
	});

	test("advances branch ref when branch is provided", async () => {
		const { repo, c2 } = await setupDivergent();

		const result = await revert(repo, {
			commit: c2,
			onto: c2,
			branch: "main",
			committer: ID,
		});

		expect(result.clean).toBe(true);
		if (!result.clean) return;

		const mainRef = await repo.refStore.readRef("refs/heads/main");
		expect(mainRef).toEqual({ type: "direct", hash: result.hash });
	});

	test("returns conflicts when revert conflicts with current state", async () => {
		const repo = await freshRepo();

		const t1 = await treeWithFiles(repo, { "f.txt": "original\n" });
		const c1 = await commitTree(repo, t1, [], 1);

		const t2 = await updateTree(repo, t1, [
			{ path: "f.txt", hash: await writeBlob(repo, "changed\n") },
		]);
		const c2 = await commitTree(repo, t2, [c1], 2);

		// Modify f.txt further after c2
		const t3 = await updateTree(repo, t2, [
			{ path: "f.txt", hash: await writeBlob(repo, "further changed\n") },
		]);
		const c3 = await commitTree(repo, t3, [c2], 3);

		// Revert c2 on top of c3 — c2 changed "original"->"changed",
		// reverting wants "changed"->"original", but c3 has "further changed"
		const result = await revert(repo, {
			commit: c2,
			onto: c3,
			committer: ID,
		});

		expect(result.clean).toBe(false);
		if (result.clean) return;
		expect(result.conflicts.length).toBeGreaterThan(0);
	});

	test("reverts a merge commit with mainline", async () => {
		const { repo, c2, c3 } = await setupDivergent();

		// Merge: c2 + c3 → merge commit
		const mergeTree = await updateTree(
			repo,
			await (async () => {
				const commit = await readCommit(repo, c2);
				return commit.tree;
			})(),
			[{ path: "c.txt", hash: await writeBlob(repo, "c\n") }],
		);
		const mergeCommit = await commitTree(repo, mergeTree, [c2, c3], 4, "merge\n");

		// Revert the merge with mainline=1 (undo changes relative to first parent c2)
		const result = await revert(repo, {
			commit: mergeCommit,
			onto: mergeCommit,
			mainline: 1,
			committer: ID,
		});

		expect(result.clean).toBe(true);
		if (!result.clean) return;

		// Reverting relative to c2 should remove what the merge added vs c2 (c.txt)
		expect(await readFileFromTree(repo, result.treeHash, "a.txt")).toBe("a\n");
		expect(await readFileFromTree(repo, result.treeHash, "b.txt")).toBe("b\n");
		expect(await readFileFromTree(repo, result.treeHash, "c.txt")).toBeNull();
	});

	test("throws when reverting merge without mainline", async () => {
		const { repo, c1, c2, c3 } = await setupDivergent();

		const mergeTree = await (async () => {
			const commit = await readCommit(repo, c2);
			return commit.tree;
		})();
		const mergeCommit = await commitTree(repo, mergeTree, [c2, c3], 4);

		await expect(revert(repo, { commit: mergeCommit, onto: c1, committer: ID })).rejects.toThrow(
			"merge but no mainline",
		);
	});

	test("throws without author or committer", async () => {
		const { repo, c2, c3 } = await setupDivergent();

		await expect(revert(repo, { commit: c3, onto: c2 })).rejects.toThrow("at least one of");
	});

	test("reverts a root commit", async () => {
		const repo = await freshRepo();

		const t1 = await treeWithFiles(repo, { "a.txt": "a\n", "b.txt": "b\n" });
		const c1 = await commitTree(repo, t1, [], 1, "root\n");

		// Reverting a root commit should remove all files it introduced
		const result = await revert(repo, {
			commit: c1,
			onto: c1,
			committer: ID,
		});

		expect(result.clean).toBe(true);
		if (!result.clean) return;

		const files = await flattenTree(repo, result.treeHash);
		expect(files.length).toBe(0);
	});
});
