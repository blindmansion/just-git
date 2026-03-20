import { describe, expect, test } from "bun:test";
import type { Identity, GitRepo } from "../../src/lib/types.ts";
import { MemoryStorage } from "../../src/server/memory-storage.ts";
import {
	blame,
	countAheadBehind,
	createCommit,
	flattenTree,
	resolveRef,
	walkCommitHistory,
	writeBlob,
	writeTree,
} from "../../src/repo/helpers.ts";

const ID: Identity = {
	name: "Test",
	email: "test@test.com",
	timestamp: 1000000000,
	timezone: "+0000",
};

function idAt(ts: number): Identity {
	return { ...ID, timestamp: ts };
}

function freshRepo(): GitRepo {
	return new MemoryStorage().repo("test");
}

async function commitFile(
	repo: GitRepo,
	filename: string,
	content: string,
	parents: string[],
	ts = 1000000000,
): Promise<string> {
	const blob = await writeBlob(repo, content);
	const tree = await writeTree(repo, [{ name: filename, hash: blob }]);
	return createCommit(repo, {
		tree,
		parents,
		author: idAt(ts),
		committer: idAt(ts),
		message: `update ${filename}\n`,
	});
}

// ── writeTree: auto-detect tree mode ────────────────────────────────

describe("writeTree auto-detects tree mode", () => {
	test("subtree entry without explicit mode gets 040000", async () => {
		const repo = freshRepo();

		const blobHash = await writeBlob(repo, "hello\n");
		const subtree = await writeTree(repo, [{ name: "file.txt", hash: blobHash }]);

		// Previously this required `mode: "040000"` — without it,
		// the entry was written as mode 100644 pointing to a tree object,
		// producing a corrupt tree that git could not checkout.
		const rootTree = await writeTree(repo, [
			{ name: "README.md", hash: blobHash },
			{ name: "src", hash: subtree },
		]);

		const entries = await flattenTree(repo, rootTree);
		const paths = entries.map((e) => e.path).sort();
		expect(paths).toEqual(["README.md", "src/file.txt"]);
	});

	test("blob entry without explicit mode stays 100644", async () => {
		const repo = freshRepo();
		const blobHash = await writeBlob(repo, "content\n");

		const tree = await writeTree(repo, [{ name: "file.txt", hash: blobHash }]);
		const raw = await repo.objectStore.read(tree);
		expect(raw.type).toBe("tree");

		const entries = await flattenTree(repo, tree);
		expect(entries).toHaveLength(1);
		expect(entries[0]!.mode).toBe("100644");
	});

	test("explicit mode is preserved even when it could be inferred", async () => {
		const repo = freshRepo();
		const blobHash = await writeBlob(repo, "#!/bin/sh\necho hello\n");

		const tree = await writeTree(repo, [{ name: "run.sh", hash: blobHash, mode: "100755" }]);

		const entries = await flattenTree(repo, tree);
		expect(entries[0]!.mode).toBe("100755");
	});

	test("deeply nested trees all get correct modes", async () => {
		const repo = freshRepo();
		const blob = await writeBlob(repo, "deep\n");
		const inner = await writeTree(repo, [{ name: "deep.txt", hash: blob }]);
		const middle = await writeTree(repo, [{ name: "inner", hash: inner }]);
		const root = await writeTree(repo, [
			{ name: "file.txt", hash: blob },
			{ name: "middle", hash: middle },
		]);

		const entries = await flattenTree(repo, root);
		const paths = entries.map((e) => e.path).sort();
		expect(paths).toEqual(["file.txt", "middle/inner/deep.txt"]);
	});
});

// ── createCommit: branch option ─────────────────────────────────────

describe("createCommit with branch option", () => {
	test("advances a branch ref and sets HEAD", async () => {
		const repo = freshRepo();
		const blob = await writeBlob(repo, "hello\n");
		const tree = await writeTree(repo, [{ name: "README.md", hash: blob }]);

		const hash = await createCommit(repo, {
			tree,
			parents: [],
			author: ID,
			committer: ID,
			message: "initial\n",
			branch: "main",
		});

		expect(await resolveRef(repo, "HEAD")).toBe(hash);
		expect(await resolveRef(repo, "refs/heads/main")).toBe(hash);

		const headRef = await repo.refStore.readRef("HEAD");
		expect(headRef).toEqual({ type: "symbolic", target: "refs/heads/main" });
	});

	test("second commit advances the branch without touching HEAD symref", async () => {
		const repo = freshRepo();
		const blob1 = await writeBlob(repo, "v1\n");
		const tree1 = await writeTree(repo, [{ name: "f.txt", hash: blob1 }]);

		const first = await createCommit(repo, {
			tree: tree1,
			parents: [],
			author: ID,
			committer: ID,
			message: "first\n",
			branch: "main",
		});

		const blob2 = await writeBlob(repo, "v2\n");
		const tree2 = await writeTree(repo, [{ name: "f.txt", hash: blob2 }]);

		const second = await createCommit(repo, {
			tree: tree2,
			parents: [first],
			author: ID,
			committer: ID,
			message: "second\n",
			branch: "main",
		});

		expect(await resolveRef(repo, "HEAD")).toBe(second);
		expect(await resolveRef(repo, "refs/heads/main")).toBe(second);

		const headRef = await repo.refStore.readRef("HEAD");
		expect(headRef).toEqual({ type: "symbolic", target: "refs/heads/main" });
	});

	test("without branch option, refs are not updated (existing behavior)", async () => {
		const repo = freshRepo();
		const blob = await writeBlob(repo, "hello\n");
		const tree = await writeTree(repo, [{ name: "README.md", hash: blob }]);

		await createCommit(repo, {
			tree,
			parents: [],
			author: ID,
			committer: ID,
			message: "initial\n",
		});

		expect(await resolveRef(repo, "HEAD")).toBeNull();
	});
});

// ── writeRef: plain hash string shorthand ───────────────────────────

describe("writeRef accepts plain hash strings", () => {
	test("string argument is treated as direct ref", async () => {
		const repo = freshRepo();
		const blob = await writeBlob(repo, "x\n");
		const tree = await writeTree(repo, [{ name: "x.txt", hash: blob }]);
		const hash = await createCommit(repo, {
			tree,
			parents: [],
			author: ID,
			committer: ID,
			message: "test\n",
		});

		await repo.refStore.writeRef("refs/heads/main", hash);

		const ref = await repo.refStore.readRef("refs/heads/main");
		expect(ref).toEqual({ type: "direct", hash });
	});

	test("Ref object still works as before", async () => {
		const repo = freshRepo();
		const blob = await writeBlob(repo, "x\n");
		const tree = await writeTree(repo, [{ name: "x.txt", hash: blob }]);
		const hash = await createCommit(repo, {
			tree,
			parents: [],
			author: ID,
			committer: ID,
			message: "test\n",
		});

		await repo.refStore.writeRef("refs/heads/main", { type: "direct", hash });

		const ref = await repo.refStore.readRef("refs/heads/main");
		expect(ref).toEqual({ type: "direct", hash });
	});

	test("symbolic ref still works", async () => {
		const repo = freshRepo();

		await repo.refStore.writeRef("HEAD", {
			type: "symbolic",
			target: "refs/heads/main",
		});

		const ref = await repo.refStore.readRef("HEAD");
		expect(ref).toEqual({ type: "symbolic", target: "refs/heads/main" });
	});
});

// ── countAheadBehind ────────────────────────────────────────────────

describe("countAheadBehind", () => {
	test("same commit → 0/0", async () => {
		const repo = freshRepo();
		const c1 = await commitFile(repo, "f.txt", "v1\n", []);
		const result = await countAheadBehind(repo, c1, c1);
		expect(result).toEqual({ ahead: 0, behind: 0 });
	});

	test("linear ahead", async () => {
		const repo = freshRepo();
		const c1 = await commitFile(repo, "f.txt", "v1\n", [], 1);
		const c2 = await commitFile(repo, "f.txt", "v2\n", [c1], 2);
		const c3 = await commitFile(repo, "f.txt", "v3\n", [c2], 3);

		const result = await countAheadBehind(repo, c3, c1);
		expect(result).toEqual({ ahead: 2, behind: 0 });
	});

	test("linear behind", async () => {
		const repo = freshRepo();
		const c1 = await commitFile(repo, "f.txt", "v1\n", [], 1);
		const c2 = await commitFile(repo, "f.txt", "v2\n", [c1], 2);

		const result = await countAheadBehind(repo, c1, c2);
		expect(result).toEqual({ ahead: 0, behind: 1 });
	});

	test("diverged branches", async () => {
		const repo = freshRepo();
		//     c2 (local)
		//    /
		// c1
		//    \
		//     c3 -- c4 (upstream)
		const c1 = await commitFile(repo, "f.txt", "v1\n", [], 1);
		const c2 = await commitFile(repo, "f.txt", "local\n", [c1], 2);
		const c3 = await commitFile(repo, "f.txt", "up1\n", [c1], 3);
		const c4 = await commitFile(repo, "f.txt", "up2\n", [c3], 4);

		const result = await countAheadBehind(repo, c2, c4);
		expect(result).toEqual({ ahead: 1, behind: 2 });
	});
});

// ── blame ───────────────────────────────────────────────────────────

describe("blame", () => {
	test("single commit blames all lines to it", async () => {
		const repo = freshRepo();
		const blob = await writeBlob(repo, "line1\nline2\nline3\n");
		const tree = await writeTree(repo, [{ name: "file.txt", hash: blob }]);
		const hash = await createCommit(repo, {
			tree,
			parents: [],
			author: ID,
			committer: ID,
			message: "initial\n",
		});

		const entries = await blame(repo, hash, "file.txt");
		expect(entries).toHaveLength(3);
		for (const entry of entries) {
			expect(entry.hash).toBe(hash);
			expect(entry.author.name).toBe("Test");
		}
		expect(entries[0]!.content).toBe("line1");
		expect(entries[0]!.finalLine).toBe(1);
		expect(entries[2]!.content).toBe("line3");
		expect(entries[2]!.finalLine).toBe(3);
	});

	test("modified lines blame to the modifying commit", async () => {
		const repo = freshRepo();
		const blob1 = await writeBlob(repo, "line1\noriginal\nline3\n");
		const tree1 = await writeTree(repo, [{ name: "file.txt", hash: blob1 }]);
		const c1 = await createCommit(repo, {
			tree: tree1,
			parents: [],
			author: idAt(1),
			committer: idAt(1),
			message: "first\n",
		});

		const blob2 = await writeBlob(repo, "line1\nchanged\nline3\n");
		const tree2 = await writeTree(repo, [{ name: "file.txt", hash: blob2 }]);
		const c2 = await createCommit(repo, {
			tree: tree2,
			parents: [c1],
			author: idAt(2),
			committer: idAt(2),
			message: "second\n",
		});

		const entries = await blame(repo, c2, "file.txt");
		expect(entries).toHaveLength(3);
		expect(entries[0]!.hash).toBe(c1);
		expect(entries[1]!.hash).toBe(c2);
		expect(entries[1]!.content).toBe("changed");
		expect(entries[2]!.hash).toBe(c1);
	});

	test("line range restricts output", async () => {
		const repo = freshRepo();
		const blob = await writeBlob(repo, "a\nb\nc\nd\ne\n");
		const tree = await writeTree(repo, [{ name: "file.txt", hash: blob }]);
		const hash = await createCommit(repo, {
			tree,
			parents: [],
			author: ID,
			committer: ID,
			message: "init\n",
		});

		const entries = await blame(repo, hash, "file.txt", { startLine: 2, endLine: 4 });
		expect(entries).toHaveLength(3);
		expect(entries[0]!.content).toBe("b");
		expect(entries[0]!.finalLine).toBe(2);
		expect(entries[2]!.content).toBe("d");
		expect(entries[2]!.finalLine).toBe(4);
	});

	test("throws for nonexistent path", async () => {
		const repo = freshRepo();
		const blob = await writeBlob(repo, "x\n");
		const tree = await writeTree(repo, [{ name: "exists.txt", hash: blob }]);
		const hash = await createCommit(repo, {
			tree,
			parents: [],
			author: ID,
			committer: ID,
			message: "init\n",
		});

		expect(blame(repo, hash, "nope.txt")).rejects.toThrow("no such path");
	});
});

// ── walkCommitHistory ───────────────────────────────────────────────

describe("walkCommitHistory", () => {
	test("walks linear history in reverse chronological order", async () => {
		const repo = freshRepo();
		const c1 = await commitFile(repo, "f.txt", "v1\n", [], 1);
		const c2 = await commitFile(repo, "f.txt", "v2\n", [c1], 2);
		const c3 = await commitFile(repo, "f.txt", "v3\n", [c2], 3);

		const hashes: string[] = [];
		for await (const info of walkCommitHistory(repo, c3)) {
			hashes.push(info.hash);
		}
		expect(hashes).toEqual([c3, c2, c1]);
	});

	test("exclude stops traversal", async () => {
		const repo = freshRepo();
		const c1 = await commitFile(repo, "f.txt", "v1\n", [], 1);
		const c2 = await commitFile(repo, "f.txt", "v2\n", [c1], 2);
		const c3 = await commitFile(repo, "f.txt", "v3\n", [c2], 3);

		const hashes: string[] = [];
		for await (const info of walkCommitHistory(repo, c3, { exclude: [c1] })) {
			hashes.push(info.hash);
		}
		expect(hashes).toEqual([c3, c2]);
	});

	test("multiple start hashes", async () => {
		const repo = freshRepo();
		//     c2 (branch A)
		//    /
		// c1
		//    \
		//     c3 (branch B)
		const c1 = await commitFile(repo, "f.txt", "v1\n", [], 1);
		const c2 = await commitFile(repo, "f.txt", "brA\n", [c1], 2);
		const c3 = await commitFile(repo, "f.txt", "brB\n", [c1], 3);

		const hashes: string[] = [];
		for await (const info of walkCommitHistory(repo, [c2, c3])) {
			hashes.push(info.hash);
		}
		expect(hashes).toHaveLength(3);
		expect(hashes).toContain(c1);
		expect(hashes).toContain(c2);
		expect(hashes).toContain(c3);
	});

	test("firstParent follows only first parent of merges", async () => {
		const repo = freshRepo();
		const c1 = await commitFile(repo, "f.txt", "v1\n", [], 1);
		const c2 = await commitFile(repo, "f.txt", "brA\n", [c1], 2);
		const c3 = await commitFile(repo, "f.txt", "brB\n", [c1], 3);

		// Merge commit with c2 as first parent, c3 as second
		const mergeBlob = await writeBlob(repo, "merged\n");
		const mergeTree = await writeTree(repo, [{ name: "f.txt", hash: mergeBlob }]);
		const merge = await createCommit(repo, {
			tree: mergeTree,
			parents: [c2, c3],
			author: idAt(4),
			committer: idAt(4),
			message: "merge\n",
		});

		const hashes: string[] = [];
		for await (const info of walkCommitHistory(repo, merge, { firstParent: true })) {
			hashes.push(info.hash);
		}
		// Should follow merge → c2 → c1, skipping c3
		expect(hashes).toEqual([merge, c2, c1]);
	});

	test("yields CommitInfo fields correctly", async () => {
		const repo = freshRepo();
		const blob = await writeBlob(repo, "hello\n");
		const tree = await writeTree(repo, [{ name: "readme.md", hash: blob }]);
		const hash = await createCommit(repo, {
			tree,
			parents: [],
			author: ID,
			committer: ID,
			message: "the message\n",
		});

		let info:
			| {
					hash: string;
					tree: string;
					parents: string[];
					message: string;
					author: { name: string };
					committer: { email: string };
			  }
			| undefined;
		let count = 0;
		for await (const entry of walkCommitHistory(repo, hash)) {
			info = entry;
			count++;
		}
		expect(count).toBe(1);
		expect(info!.hash).toBe(hash);
		expect(info!.tree).toBe(tree);
		expect(info!.parents).toEqual([]);
		expect(info!.message).toBe("the message\n");
		expect(info!.author.name).toBe("Test");
		expect(info!.committer.email).toBe("test@test.com");
	});
});
