import { describe, expect, test } from "bun:test";
import type { Identity, GitRepo } from "../../src/lib/types.ts";
import { MemoryStorage } from "../../src/server/memory-storage.ts";
import { createStorageAdapter } from "../../src/server/storage.ts";
import { revParse } from "../../src/repo/reading.ts";
import { createAnnotatedTag, createCommit, writeBlob, writeTree } from "../../src/repo/writing.ts";

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

async function setupLinearRepo() {
	const repo = await freshRepo();
	const c1 = await commitFile(repo, "f.txt", "v1\n", [], 1);
	const c2 = await commitFile(repo, "f.txt", "v2\n", [c1], 2);
	const c3 = await commitFile(repo, "f.txt", "v3\n", [c2], 3);
	await repo.refStore.writeRef("HEAD", { type: "symbolic", target: "refs/heads/main" });
	await repo.refStore.writeRef("refs/heads/main", c3);
	return { repo, c1, c2, c3 };
}

// ── Basic ref resolution ────────────────────────────────────────────

describe("revParse", () => {
	test("resolves HEAD", async () => {
		const { repo, c3 } = await setupLinearRepo();
		expect(await revParse(repo, "HEAD")).toBe(c3);
	});

	test("resolves @ as alias for HEAD", async () => {
		const { repo, c3 } = await setupLinearRepo();
		expect(await revParse(repo, "@")).toBe(c3);
	});

	test("resolves branch name", async () => {
		const { repo, c3 } = await setupLinearRepo();
		expect(await revParse(repo, "main")).toBe(c3);
	});

	test("resolves full ref path", async () => {
		const { repo, c3 } = await setupLinearRepo();
		expect(await revParse(repo, "refs/heads/main")).toBe(c3);
	});

	test("resolves full 40-char hash", async () => {
		const { repo, c1 } = await setupLinearRepo();
		expect(await revParse(repo, c1)).toBe(c1);
	});

	test("resolves short hash prefix", async () => {
		const { repo, c2 } = await setupLinearRepo();
		const short = c2.slice(0, 7);
		expect(await revParse(repo, short)).toBe(c2);
	});

	test("returns null for nonexistent ref", async () => {
		const { repo } = await setupLinearRepo();
		expect(await revParse(repo, "nonexistent")).toBeNull();
	});

	test("returns null for nonexistent hash", async () => {
		const { repo } = await setupLinearRepo();
		expect(await revParse(repo, "0000000000000000000000000000000000000000")).toBeNull();
	});

	// ── Tilde suffix ────────────────────────────────────────────────

	test("HEAD~1 resolves to first parent", async () => {
		const { repo, c2 } = await setupLinearRepo();
		expect(await revParse(repo, "HEAD~1")).toBe(c2);
	});

	test("HEAD~ is equivalent to HEAD~1", async () => {
		const { repo, c2 } = await setupLinearRepo();
		expect(await revParse(repo, "HEAD~")).toBe(c2);
	});

	test("HEAD~2 walks two ancestors", async () => {
		const { repo, c1 } = await setupLinearRepo();
		expect(await revParse(repo, "HEAD~2")).toBe(c1);
	});

	test("branch~N works", async () => {
		const { repo, c1 } = await setupLinearRepo();
		expect(await revParse(repo, "main~2")).toBe(c1);
	});

	test("~N past root returns null", async () => {
		const { repo } = await setupLinearRepo();
		expect(await revParse(repo, "HEAD~10")).toBeNull();
	});

	// ── Caret suffix ────────────────────────────────────────────────

	test("HEAD^ resolves to first parent", async () => {
		const { repo, c2 } = await setupLinearRepo();
		expect(await revParse(repo, "HEAD^")).toBe(c2);
	});

	test("HEAD^1 is equivalent to HEAD^", async () => {
		const { repo, c2 } = await setupLinearRepo();
		expect(await revParse(repo, "HEAD^1")).toBe(c2);
	});

	test("^2 selects second parent of a merge commit", async () => {
		const repo = await freshRepo();
		const c1 = await commitFile(repo, "f.txt", "v1\n", [], 1);
		const c2 = await commitFile(repo, "f.txt", "branch\n", [c1], 2);
		const c3 = await commitFile(repo, "g.txt", "other\n", [c1], 3);

		const blob = await writeBlob(repo, "merged\n");
		const tree = await writeTree(repo, [
			{ name: "f.txt", hash: blob },
			{ name: "g.txt", hash: blob },
		]);
		const merge = await createCommit(repo, {
			tree,
			parents: [c2, c3],
			author: idAt(4),
			committer: idAt(4),
			message: "merge\n",
		});

		await repo.refStore.writeRef("HEAD", { type: "symbolic", target: "refs/heads/main" });
		await repo.refStore.writeRef("refs/heads/main", merge);

		expect(await revParse(repo, "HEAD^1")).toBe(c2);
		expect(await revParse(repo, "HEAD^2")).toBe(c3);
	});

	test("^N beyond parent count returns null", async () => {
		const { repo } = await setupLinearRepo();
		expect(await revParse(repo, "HEAD^2")).toBeNull();
	});

	// ── Chained suffixes ────────────────────────────────────────────

	test("HEAD~1~1 chains tilde operators", async () => {
		const { repo, c1 } = await setupLinearRepo();
		expect(await revParse(repo, "HEAD~1~1")).toBe(c1);
	});

	test("HEAD^1~1 chains caret then tilde", async () => {
		const { repo, c1 } = await setupLinearRepo();
		expect(await revParse(repo, "HEAD^1~1")).toBe(c1);
	});

	// ── Tag resolution ──────────────────────────────────────────────

	test("resolves lightweight tag", async () => {
		const { repo, c2 } = await setupLinearRepo();
		await repo.refStore.writeRef("refs/tags/v1.0", c2);

		expect(await revParse(repo, "v1.0")).toBe(c2);
	});

	test("resolves annotated tag to tag object hash", async () => {
		const { repo, c2 } = await setupLinearRepo();
		const tagHash = await createAnnotatedTag(repo, {
			target: c2,
			name: "v2.0",
			tagger: ID,
			message: "Release 2.0\n",
		});

		const resolved = await revParse(repo, "v2.0");
		expect(resolved).toBe(tagHash);
		expect(resolved).not.toBe(c2);
	});

	test("annotated tag with ^{commit} peels to commit", async () => {
		const { repo, c2 } = await setupLinearRepo();
		await createAnnotatedTag(repo, {
			target: c2,
			name: "v2.0",
			tagger: ID,
			message: "Release 2.0\n",
		});

		expect(await revParse(repo, "v2.0^{commit}")).toBe(c2);
	});

	test("annotated tag with ~N peels through to commit ancestors", async () => {
		const { repo, c1, c2 } = await setupLinearRepo();
		await createAnnotatedTag(repo, {
			target: c2,
			name: "v2.0",
			tagger: ID,
			message: "Release 2.0\n",
		});

		expect(await revParse(repo, "v2.0~1")).toBe(c1);
	});

	// ── Special refs ────────────────────────────────────────────────

	test("resolves ORIG_HEAD", async () => {
		const { repo, c1 } = await setupLinearRepo();
		await repo.refStore.writeRef("ORIG_HEAD", c1);

		expect(await revParse(repo, "ORIG_HEAD")).toBe(c1);
	});

	test("resolves MERGE_HEAD", async () => {
		const { repo, c2 } = await setupLinearRepo();
		await repo.refStore.writeRef("MERGE_HEAD", c2);

		expect(await revParse(repo, "MERGE_HEAD")).toBe(c2);
	});

	// ── Remote tracking refs ────────────────────────────────────────

	test("resolves origin/main as remote tracking ref", async () => {
		const { repo, c1 } = await setupLinearRepo();
		await repo.refStore.writeRef("refs/remotes/origin/main", c1);

		expect(await revParse(repo, "origin/main")).toBe(c1);
	});

	// ── Reflog returns null ─────────────────────────────────────────

	test("reflog syntax returns null (not supported on GitRepo)", async () => {
		const { repo } = await setupLinearRepo();
		expect(await revParse(repo, "HEAD@{0}")).toBeNull();
		expect(await revParse(repo, "main@{1}")).toBeNull();
	});

	// ── Peel syntax ─────────────────────────────────────────────────

	test("HEAD^{tree} resolves to the commit's tree hash", async () => {
		const { repo, c3 } = await setupLinearRepo();
		const treeHash = await revParse(repo, "HEAD^{tree}");
		expect(treeHash).not.toBeNull();
		expect(treeHash).not.toBe(c3);

		const obj = await repo.objectStore.read(treeHash!);
		expect(obj.type).toBe("tree");
	});

	test("HEAD^{commit} on a commit is identity", async () => {
		const { repo, c3 } = await setupLinearRepo();
		expect(await revParse(repo, "HEAD^{commit}")).toBe(c3);
	});
});
