import { describe, expect, test } from "bun:test";
import { writeBlob, writeTree } from "../src/repo/writing.ts";
import { MemoryStorage } from "../src/server/memory-storage.ts";
import { createStorageAdapter } from "../src/server/storage.ts";
import { TreeBackedFs } from "../src/tree-backed-fs.ts";

async function treeFs(): Promise<TreeBackedFs> {
	const repo = await createStorageAdapter(new MemoryStorage()).createRepo("test");
	const blob = await writeBlob(repo, "#!/bin/sh\n");
	const link = await writeBlob(repo, "plain.sh");
	const tree = await writeTree(repo, [
		{ name: "plain.sh", hash: blob, mode: "100644" },
		{ name: "exec.sh", hash: blob, mode: "100755" },
		{ name: "link", hash: link, mode: "120000" },
	]);
	return new TreeBackedFs(repo.objectStore, tree, "/wt");
}

describe("TreeBackedFs chmod", () => {
	test("chmod follows a tree-backed symlink to its target", async () => {
		const fs = await treeFs();
		await fs.chmod("/wt/link", 0o755);
		expect((await fs.lstat("/wt/plain.sh")).mode).toBe(0o100755);
		expect((await fs.lstat("/wt/link")).isSymbolicLink).toBe(true);
		expect((await fs.lstat("/wt/link")).mode).toBe(0o120000);
	});

	test("chmod follows an overlay symlink to its target", async () => {
		const fs = await treeFs();
		await fs.symlink("exec.sh", "/wt/link2");
		await fs.chmod("/wt/link2", 0o644);
		expect((await fs.lstat("/wt/exec.sh")).mode).toBe(0o100644);
		expect((await fs.lstat("/wt/link2")).isSymbolicLink).toBe(true);
	});

	test("chmod on a tree-backed file changes its mode and keeps its content", async () => {
		const fs = await treeFs();
		await fs.chmod("/wt/plain.sh", 0o755);
		expect((await fs.lstat("/wt/plain.sh")).mode).toBe(0o100755);
		expect((await fs.stat("/wt/plain.sh")).mode).toBe(0o100755);
		expect(await fs.readFile("/wt/plain.sh")).toBe("#!/bin/sh\n");
		await fs.chmod("/wt/exec.sh", 0o644);
		expect((await fs.lstat("/wt/exec.sh")).mode).toBe(0o100644);
	});

	test("chmod on an overlay file changes its mode", async () => {
		const fs = await treeFs();
		await fs.writeFile("/wt/new.sh", "echo\n");
		await fs.chmod("/wt/new.sh", 0o755);
		expect((await fs.stat("/wt/new.sh")).mode).toBe(0o100755);
		expect(await fs.readFile("/wt/new.sh")).toBe("echo\n");
	});

	test("chmod throws ENOENT for a missing or removed path", async () => {
		const fs = await treeFs();
		await expect(fs.chmod("/wt/missing", 0o755)).rejects.toThrow("ENOENT");
		await fs.rm("/wt/plain.sh");
		await expect(fs.chmod("/wt/plain.sh", 0o755)).rejects.toThrow("ENOENT");
	});
});

describe("TreeBackedFs writeFile modes", () => {
	test("overwriting a tree-backed file keeps the tree entry's mode", async () => {
		const fs = await treeFs();
		await fs.writeFile("/wt/exec.sh", "new\n");
		expect((await fs.stat("/wt/exec.sh")).mode).toBe(0o100755);
		expect(await fs.readFile("/wt/exec.sh")).toBe("new\n");
		await fs.writeFile("/wt/plain.sh", "new\n");
		expect((await fs.stat("/wt/plain.sh")).mode).toBe(0o100644);
	});

	test("overwriting an overlay file keeps its mode", async () => {
		const fs = await treeFs();
		await fs.writeFile("/wt/new.sh", "a");
		await fs.chmod("/wt/new.sh", 0o755);
		await fs.writeFile("/wt/new.sh", "b");
		expect((await fs.stat("/wt/new.sh")).mode).toBe(0o100755);
	});

	test("a new file, or one recreated after rm, gets the default mode", async () => {
		const fs = await treeFs();
		await fs.writeFile("/wt/new", "x");
		expect((await fs.stat("/wt/new")).mode).toBe(0o100644);
		await fs.rm("/wt/exec.sh");
		await fs.writeFile("/wt/exec.sh", "x");
		expect((await fs.stat("/wt/exec.sh")).mode).toBe(0o100644);
	});
});

describe("TreeBackedFs chmod symlink loops", () => {
	test("chmod on an overlay symlink loop throws ELOOP", async () => {
		const fs = await treeFs();
		await fs.symlink("b", "/wt/a");
		await fs.symlink("a", "/wt/b");
		await expect(fs.chmod("/wt/a", 0o755)).rejects.toThrow(
			"ELOOP: too many levels of symbolic links, '/wt/a'",
		);
	});

	test("chmod on a tree-backed symlink loop throws ELOOP", async () => {
		const repo = await createStorageAdapter(new MemoryStorage()).createRepo("loop");
		const toB = await writeBlob(repo, "b");
		const toA = await writeBlob(repo, "a");
		const tree = await writeTree(repo, [
			{ name: "a", hash: toB, mode: "120000" },
			{ name: "b", hash: toA, mode: "120000" },
		]);
		const fs = new TreeBackedFs(repo.objectStore, tree, "/wt");
		await expect(fs.chmod("/wt/a", 0o755)).rejects.toThrow(
			"ELOOP: too many levels of symbolic links, '/wt/a'",
		);
	});
});
