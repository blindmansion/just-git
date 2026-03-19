import { describe, expect, test } from "bun:test";
import type { Identity, GitRepo } from "../../src/lib/types.ts";
import { MemoryStorage } from "../../src/server/memory-storage.ts";
import {
	createCommit,
	flattenTree,
	resolveRef,
	writeBlob,
	writeTree,
} from "../../src/repo/helpers.ts";

const ID: Identity = {
	name: "Test",
	email: "test@test.com",
	timestamp: 1000000000,
	timezone: "+0000",
};

function freshRepo(): GitRepo {
	return new MemoryStorage().repo("test");
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
