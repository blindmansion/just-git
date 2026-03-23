import { describe, expect, test } from "bun:test";
import type { GitRepo } from "../../src/lib/types.ts";
import { MemoryStorage } from "../../src/server/memory-storage.ts";
import { createStorageAdapter } from "../../src/server/storage.ts";
import { readTree } from "../../src/repo/reading.ts";
import { flattenTree } from "../../src/repo/diffing.ts";
import { updateTree, writeBlob, writeTree } from "../../src/repo/writing.ts";

async function freshRepo(): Promise<GitRepo> {
	return createStorageAdapter(new MemoryStorage()).createRepo("test");
}

// ── readTree ────────────────────────────────────────────────────────

describe("readTree", () => {
	test("returns root-level entries without recursion", async () => {
		const repo = await freshRepo();
		const blob = await writeBlob(repo, "hello\n");
		const subtree = await writeTree(repo, [{ name: "file.ts", hash: blob }]);
		const root = await writeTree(repo, [
			{ name: "README.md", hash: blob },
			{ name: "src", hash: subtree },
		]);

		const entries = await readTree(repo, root);
		expect(entries).toHaveLength(2);

		const names = entries.map((e) => e.name).sort();
		expect(names).toEqual(["README.md", "src"]);

		const srcEntry = entries.find((e) => e.name === "src")!;
		expect(srcEntry.mode).toBe("040000");
		expect(srcEntry.hash).toBe(subtree);
	});

	test("round-trips with writeTree", async () => {
		const repo = await freshRepo();
		const blob = await writeBlob(repo, "content\n");
		const original = await writeTree(repo, [
			{ name: "a.txt", hash: blob },
			{ name: "b.txt", hash: blob },
		]);

		const entries = await readTree(repo, original);
		const rebuilt = await writeTree(repo, entries);
		expect(rebuilt).toBe(original);
	});

	test("throws on non-tree object", async () => {
		const repo = await freshRepo();
		const blob = await writeBlob(repo, "not a tree\n");
		expect(readTree(repo, blob)).rejects.toThrow("Expected tree object");
	});
});

// ── updateTree ──────────────────────────────────────────────────────

describe("updateTree", () => {
	test("adds a file to the root", async () => {
		const repo = await freshRepo();
		const blob = await writeBlob(repo, "original\n");
		const root = await writeTree(repo, [{ name: "README.md", hash: blob }]);

		const newBlob = await writeBlob(repo, "new file\n");
		const updated = await updateTree(repo, root, [{ path: "added.txt", hash: newBlob }]);

		const entries = await readTree(repo, updated);
		const names = entries.map((e) => e.name).sort();
		expect(names).toEqual(["README.md", "added.txt"]);
	});

	test("adds a file in a nested path", async () => {
		const repo = await freshRepo();
		const blob = await writeBlob(repo, "readme\n");
		const root = await writeTree(repo, [{ name: "README.md", hash: blob }]);

		const newBlob = await writeBlob(repo, "export {};\n");
		const updated = await updateTree(repo, root, [{ path: "src/lib/new.ts", hash: newBlob }]);

		const flat = await flattenTree(repo, updated);
		const paths = flat.map((e) => e.path).sort();
		expect(paths).toEqual(["README.md", "src/lib/new.ts"]);
	});

	test("removes a file", async () => {
		const repo = await freshRepo();
		const blob = await writeBlob(repo, "content\n");
		const root = await writeTree(repo, [
			{ name: "a.txt", hash: blob },
			{ name: "b.txt", hash: blob },
		]);

		const updated = await updateTree(repo, root, [{ path: "a.txt", hash: null }]);

		const entries = await readTree(repo, updated);
		expect(entries).toHaveLength(1);
		expect(entries[0]!.name).toBe("b.txt");
	});

	test("removes a nested file and prunes empty subtrees", async () => {
		const repo = await freshRepo();
		const blob = await writeBlob(repo, "content\n");
		const subtree = await writeTree(repo, [{ name: "only.ts", hash: blob }]);
		const root = await writeTree(repo, [
			{ name: "README.md", hash: blob },
			{ name: "src", hash: subtree },
		]);

		const updated = await updateTree(repo, root, [{ path: "src/only.ts", hash: null }]);

		const entries = await readTree(repo, updated);
		expect(entries).toHaveLength(1);
		expect(entries[0]!.name).toBe("README.md");
	});

	test("replaces an existing file", async () => {
		const repo = await freshRepo();
		const oldBlob = await writeBlob(repo, "old\n");
		const root = await writeTree(repo, [{ name: "file.txt", hash: oldBlob }]);

		const newBlob = await writeBlob(repo, "new\n");
		const updated = await updateTree(repo, root, [{ path: "file.txt", hash: newBlob }]);

		const entries = await readTree(repo, updated);
		expect(entries[0]!.hash).toBe(newBlob);
	});

	test("applies multiple updates at once", async () => {
		const repo = await freshRepo();
		const blob = await writeBlob(repo, "content\n");
		const subtree = await writeTree(repo, [{ name: "old.ts", hash: blob }]);
		const root = await writeTree(repo, [
			{ name: "README.md", hash: blob },
			{ name: "src", hash: subtree },
		]);

		const newBlob = await writeBlob(repo, "new\n");
		const updated = await updateTree(repo, root, [
			{ path: "src/old.ts", hash: null },
			{ path: "src/new.ts", hash: newBlob },
			{ path: "docs/guide.md", hash: newBlob },
		]);

		const flat = await flattenTree(repo, updated);
		const paths = flat.map((e) => e.path).sort();
		expect(paths).toEqual(["README.md", "docs/guide.md", "src/new.ts"]);
	});

	test("preserves untouched entries", async () => {
		const repo = await freshRepo();
		const blob1 = await writeBlob(repo, "one\n");
		const blob2 = await writeBlob(repo, "two\n");
		const subtree = await writeTree(repo, [
			{ name: "a.ts", hash: blob1 },
			{ name: "b.ts", hash: blob2 },
		]);
		const root = await writeTree(repo, [
			{ name: "README.md", hash: blob1 },
			{ name: "src", hash: subtree },
		]);

		const newBlob = await writeBlob(repo, "three\n");
		const updated = await updateTree(repo, root, [{ path: "src/c.ts", hash: newBlob }]);

		const flat = await flattenTree(repo, updated);
		const paths = flat.map((e) => e.path).sort();
		expect(paths).toEqual(["README.md", "src/a.ts", "src/b.ts", "src/c.ts"]);

		const aEntry = flat.find((e) => e.path === "src/a.ts")!;
		expect(aEntry.hash).toBe(blob1);
	});
});
