import { describe, expect, test } from "bun:test";
import type { Identity, GitRepo } from "../../src/lib/types.ts";
import { MemoryStorage } from "../../src/server/memory-storage.ts";
import { createStorageAdapter } from "../../src/server/storage.ts";
import { walkCommitHistory } from "../../src/repo/diffing.ts";
import { createCommit, writeBlob, writeTree } from "../../src/repo/writing.ts";

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

async function commitFiles(
	repo: GitRepo,
	files: Record<string, string>,
	parents: string[],
	ts: number,
): Promise<string> {
	const entries: { name: string; hash: string }[] = [];
	for (const [name, content] of Object.entries(files)) {
		const blob = await writeBlob(repo, content);
		entries.push({ name, hash: blob });
	}
	const tree = await writeTree(repo, entries);
	return createCommit(repo, {
		tree,
		parents,
		author: idAt(ts),
		committer: idAt(ts),
		message: `commit at ${ts}\n`,
	});
}

async function collectHashes(iter: AsyncGenerator<{ hash: string }>): Promise<string[]> {
	const result: string[] = [];
	for await (const entry of iter) result.push(entry.hash);
	return result;
}

// ── walkCommitHistory with paths ────────────────────────────────────

describe("walkCommitHistory with paths filter", () => {
	test("filters to commits touching a specific file", async () => {
		const repo = await freshRepo();

		const c1 = await commitFiles(repo, { "a.txt": "v1\n", "b.txt": "v1\n" }, [], 1);
		const c2 = await commitFiles(repo, { "a.txt": "v2\n", "b.txt": "v1\n" }, [c1], 2);
		const c3 = await commitFiles(repo, { "a.txt": "v2\n", "b.txt": "v2\n" }, [c2], 3);
		const c4 = await commitFiles(repo, { "a.txt": "v3\n", "b.txt": "v2\n" }, [c3], 4);

		const aHistory = await collectHashes(walkCommitHistory(repo, c4, { paths: ["a.txt"] }));
		expect(aHistory).toEqual([c4, c2, c1]);

		const bHistory = await collectHashes(walkCommitHistory(repo, c4, { paths: ["b.txt"] }));
		expect(bHistory).toEqual([c3, c1]);
	});

	test("root commit is included when path exists", async () => {
		const repo = await freshRepo();
		const c1 = await commitFiles(repo, { "a.txt": "hello\n" }, [], 1);
		const c2 = await commitFiles(repo, { "a.txt": "world\n" }, [c1], 2);

		const history = await collectHashes(walkCommitHistory(repo, c2, { paths: ["a.txt"] }));
		expect(history).toEqual([c2, c1]);
	});

	test("root commit is excluded when path doesn't exist", async () => {
		const repo = await freshRepo();
		const c1 = await commitFiles(repo, { "a.txt": "hello\n" }, [], 1);
		const c2 = await commitFiles(repo, { "a.txt": "hello\n", "b.txt": "new\n" }, [c1], 2);

		const history = await collectHashes(walkCommitHistory(repo, c2, { paths: ["b.txt"] }));
		expect(history).toEqual([c2]);
	});

	test("multiple paths filter (OR semantics)", async () => {
		const repo = await freshRepo();
		const c1 = await commitFiles(repo, { "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n" }, [], 1);
		const c2 = await commitFiles(repo, { "a.txt": "A\n", "b.txt": "b\n", "c.txt": "c\n" }, [c1], 2);
		const c3 = await commitFiles(repo, { "a.txt": "A\n", "b.txt": "b\n", "c.txt": "C\n" }, [c2], 3);

		const history = await collectHashes(walkCommitHistory(repo, c3, { paths: ["a.txt", "c.txt"] }));
		// c3 changed c.txt, c2 changed a.txt, c1 introduced both
		expect(history).toEqual([c3, c2, c1]);
	});

	test("no matching paths yields empty result", async () => {
		const repo = await freshRepo();
		const c1 = await commitFiles(repo, { "a.txt": "hello\n" }, [], 1);

		const history = await collectHashes(
			walkCommitHistory(repo, c1, { paths: ["nonexistent.txt"] }),
		);
		expect(history).toEqual([]);
	});

	test("works with firstParent option", async () => {
		const repo = await freshRepo();
		//     c2 (modifies a.txt)
		//    /
		// c1           → merge (c4, parents: [c3, c2])
		//    \
		//     c3 (modifies b.txt)
		const c1 = await commitFiles(repo, { "a.txt": "v1\n", "b.txt": "v1\n" }, [], 1);
		const c2 = await commitFiles(repo, { "a.txt": "v2\n", "b.txt": "v1\n" }, [c1], 2);
		const c3 = await commitFiles(repo, { "a.txt": "v1\n", "b.txt": "v2\n" }, [c1], 3);

		const mergeBlob = await writeBlob(repo, "v2\n");
		const mergeBlobB = await writeBlob(repo, "v2\n");
		const mergeTree = await writeTree(repo, [
			{ name: "a.txt", hash: mergeBlob },
			{ name: "b.txt", hash: mergeBlobB },
		]);
		const c4 = await createCommit(repo, {
			tree: mergeTree,
			parents: [c3, c2],
			author: idAt(4),
			committer: idAt(4),
			message: "merge\n",
		});

		const history = await collectHashes(
			walkCommitHistory(repo, c4, { paths: ["a.txt"], firstParent: true }),
		);
		// Following only first parent (c3), a.txt is unchanged from c1
		// c4: a.txt changed vs c3 → yield; c3: a.txt same as c1 → skip; c1: root with a.txt → yield
		expect(history).toContain(c1);
	});

	test("TREESAME simplification at merge points", async () => {
		const repo = await freshRepo();
		// c1 → c2 (change a.txt) → merge (c4)
		// c1 → c3 (change b.txt) ↗
		const c1 = await commitFiles(repo, { "a.txt": "v1\n", "b.txt": "v1\n" }, [], 1);
		const c2 = await commitFiles(repo, { "a.txt": "v2\n", "b.txt": "v1\n" }, [c1], 2);
		const c3 = await commitFiles(repo, { "a.txt": "v1\n", "b.txt": "v2\n" }, [c1], 3);

		const mergeTree = await writeTree(repo, [
			{ name: "a.txt", hash: await writeBlob(repo, "v2\n") },
			{ name: "b.txt", hash: await writeBlob(repo, "v2\n") },
		]);
		const c4 = await createCommit(repo, {
			tree: mergeTree,
			parents: [c2, c3],
			author: idAt(4),
			committer: idAt(4),
			message: "merge\n",
		});

		// History of a.txt: merge is TREESAME to c2 (a.txt unchanged),
		// so simplified history follows c2 → c1
		const aHistory = await collectHashes(walkCommitHistory(repo, c4, { paths: ["a.txt"] }));
		expect(aHistory).toContain(c2);
		expect(aHistory).toContain(c1);
		expect(aHistory).not.toContain(c4);
		expect(aHistory).not.toContain(c3);
	});

	test("works with exclude option", async () => {
		const repo = await freshRepo();
		const c1 = await commitFiles(repo, { "a.txt": "v1\n" }, [], 1);
		const c2 = await commitFiles(repo, { "a.txt": "v2\n" }, [c1], 2);
		const c3 = await commitFiles(repo, { "a.txt": "v3\n" }, [c2], 3);

		const history = await collectHashes(
			walkCommitHistory(repo, c3, { paths: ["a.txt"], exclude: [c1] }),
		);
		expect(history).toEqual([c3, c2]);
	});

	test("prefix path matching includes subdirectory files", async () => {
		const repo = await freshRepo();

		const blob1 = await writeBlob(repo, "v1\n");
		const srcTree1 = await writeTree(repo, [{ name: "app.ts", hash: blob1 }]);
		const root1 = await writeTree(repo, [
			{ name: "readme.md", hash: blob1 },
			{ name: "src", hash: srcTree1, mode: "040000" },
		]);
		const c1 = await createCommit(repo, {
			tree: root1,
			parents: [],
			author: idAt(1),
			committer: idAt(1),
			message: "init\n",
		});

		const blob2 = await writeBlob(repo, "v2\n");
		const srcTree2 = await writeTree(repo, [{ name: "app.ts", hash: blob2 }]);
		const root2 = await writeTree(repo, [
			{ name: "readme.md", hash: blob1 },
			{ name: "src", hash: srcTree2, mode: "040000" },
		]);
		const c2 = await createCommit(repo, {
			tree: root2,
			parents: [c1],
			author: idAt(2),
			committer: idAt(2),
			message: "update src\n",
		});

		const blob3 = await writeBlob(repo, "v2 readme\n");
		const root3 = await writeTree(repo, [
			{ name: "readme.md", hash: blob3 },
			{ name: "src", hash: srcTree2, mode: "040000" },
		]);
		const c3 = await createCommit(repo, {
			tree: root3,
			parents: [c2],
			author: idAt(3),
			committer: idAt(3),
			message: "update readme\n",
		});

		const srcHistory = await collectHashes(walkCommitHistory(repo, c3, { paths: ["src/"] }));
		// c3 only changed readme.md, not src/
		expect(srcHistory).toEqual([c2, c1]);
	});

	test("without paths option, all commits returned (existing behavior)", async () => {
		const repo = await freshRepo();
		const c1 = await commitFiles(repo, { "a.txt": "v1\n" }, [], 1);
		const c2 = await commitFiles(repo, { "a.txt": "v1\n", "b.txt": "new\n" }, [c1], 2);

		const all = await collectHashes(walkCommitHistory(repo, c2));
		expect(all).toEqual([c2, c1]);
	});

	test("limit restricts results with paths filter", async () => {
		const repo = await freshRepo();
		const c1 = await commitFiles(repo, { "a.txt": "v1\n" }, [], 1);
		const c2 = await commitFiles(repo, { "a.txt": "v2\n" }, [c1], 2);
		const c3 = await commitFiles(repo, { "a.txt": "v3\n" }, [c2], 3);
		const c4 = await commitFiles(repo, { "a.txt": "v4\n" }, [c3], 4);

		const limited = await collectHashes(
			walkCommitHistory(repo, c4, { paths: ["a.txt"], limit: 2 }),
		);
		expect(limited).toEqual([c4, c3]);
	});
});
