import { describe, expect, test } from "bun:test";
import { MemoryFileSystem } from "../src/memory-fs";

describe("MemoryFileSystem", () => {
	// ── Constructor ──────────────────────────────────────────────────

	test("starts with root directory", async () => {
		const fs = new MemoryFileSystem();
		expect(await fs.exists("/")).toBe(true);
		const s = await fs.stat("/");
		expect(s.isDirectory).toBe(true);
	});

	test("seeds initial files from constructor", async () => {
		const fs = new MemoryFileSystem({
			"/a.txt": "hello",
			"/dir/b.txt": "world",
		});
		expect(await fs.readFile("/a.txt")).toBe("hello");
		expect(await fs.readFile("/dir/b.txt")).toBe("world");
	});

	test("accepts Uint8Array in initial files", async () => {
		const buf = new Uint8Array([0x00, 0xff, 0x42]);
		const fs = new MemoryFileSystem({ "/bin": buf });
		const read = await fs.readFileBuffer("/bin");
		expect(read).toEqual(buf);
	});

	test("auto-creates parent directories for initial files", async () => {
		const fs = new MemoryFileSystem({ "/a/b/c/file.txt": "deep" });
		expect(await fs.exists("/a")).toBe(true);
		expect(await fs.exists("/a/b")).toBe(true);
		expect(await fs.exists("/a/b/c")).toBe(true);
		expect((await fs.stat("/a/b")).isDirectory).toBe(true);
	});

	// ── readFile / readFileBuffer ────────────────────────────────────

	test("readFile returns string content", async () => {
		const fs = new MemoryFileSystem({ "/f.txt": "content" });
		expect(await fs.readFile("/f.txt")).toBe("content");
	});

	test("readFileBuffer returns Uint8Array", async () => {
		const fs = new MemoryFileSystem({ "/f.txt": "abc" });
		const buf = await fs.readFileBuffer("/f.txt");
		expect(buf).toBeInstanceOf(Uint8Array);
		expect(new TextDecoder().decode(buf)).toBe("abc");
	});

	test("readFile throws ENOENT for missing file", async () => {
		const fs = new MemoryFileSystem();
		await expect(fs.readFile("/nope")).rejects.toThrow("ENOENT");
	});

	test("readFile throws EISDIR for directory", async () => {
		const fs = new MemoryFileSystem({ "/dir/f.txt": "x" });
		await expect(fs.readFile("/dir")).rejects.toThrow("EISDIR");
	});

	// ── writeFile ────────────────────────────────────────────────────

	test("writeFile creates a new file", async () => {
		const fs = new MemoryFileSystem();
		await fs.writeFile("/new.txt", "data");
		expect(await fs.readFile("/new.txt")).toBe("data");
	});

	test("writeFile overwrites existing content", async () => {
		const fs = new MemoryFileSystem({ "/f.txt": "old" });
		await fs.writeFile("/f.txt", "new");
		expect(await fs.readFile("/f.txt")).toBe("new");
	});

	test("writeFile creates parent directories", async () => {
		const fs = new MemoryFileSystem();
		await fs.writeFile("/a/b/c.txt", "deep");
		expect(await fs.readFile("/a/b/c.txt")).toBe("deep");
		expect((await fs.stat("/a/b")).isDirectory).toBe(true);
	});

	test("writeFile accepts Uint8Array", async () => {
		const fs = new MemoryFileSystem();
		const buf = new Uint8Array([1, 2, 3]);
		await fs.writeFile("/bin", buf);
		expect(await fs.readFileBuffer("/bin")).toEqual(buf);
	});

	// ── exists ───────────────────────────────────────────────────────

	test("exists returns true for files and directories", async () => {
		const fs = new MemoryFileSystem({ "/dir/f.txt": "x" });
		expect(await fs.exists("/dir/f.txt")).toBe(true);
		expect(await fs.exists("/dir")).toBe(true);
		expect(await fs.exists("/")).toBe(true);
	});

	test("exists returns false for missing paths", async () => {
		const fs = new MemoryFileSystem();
		expect(await fs.exists("/nope")).toBe(false);
		expect(await fs.exists("/a/b/c")).toBe(false);
	});

	// ── stat ─────────────────────────────────────────────────────────

	test("stat returns file info", async () => {
		const fs = new MemoryFileSystem({ "/f.txt": "hello" });
		const s = await fs.stat("/f.txt");
		expect(s.isFile).toBe(true);
		expect(s.isDirectory).toBe(false);
		expect(s.isSymbolicLink).toBe(false);
		expect(s.size).toBe(5);
	});

	test("stat returns directory info", async () => {
		const fs = new MemoryFileSystem({ "/dir/f.txt": "x" });
		const s = await fs.stat("/dir");
		expect(s.isFile).toBe(false);
		expect(s.isDirectory).toBe(true);
		expect(s.size).toBe(0);
	});

	test("stat throws ENOENT for missing path", async () => {
		const fs = new MemoryFileSystem();
		await expect(fs.stat("/nope")).rejects.toThrow("ENOENT");
	});

	// ── mkdir ────────────────────────────────────────────────────────

	test("mkdir creates a directory", async () => {
		const fs = new MemoryFileSystem();
		await fs.mkdir("/newdir");
		expect((await fs.stat("/newdir")).isDirectory).toBe(true);
	});

	test("mkdir recursive creates nested directories", async () => {
		const fs = new MemoryFileSystem();
		await fs.mkdir("/a/b/c", { recursive: true });
		expect((await fs.stat("/a/b/c")).isDirectory).toBe(true);
	});

	test("mkdir throws EEXIST without recursive", async () => {
		const fs = new MemoryFileSystem({ "/dir/f.txt": "x" });
		await expect(fs.mkdir("/dir")).rejects.toThrow("EEXIST");
	});

	test("mkdir recursive on existing directory succeeds", async () => {
		const fs = new MemoryFileSystem({ "/dir/f.txt": "x" });
		await fs.mkdir("/dir", { recursive: true });
	});

	test("mkdir throws ENOENT for missing parent without recursive", async () => {
		const fs = new MemoryFileSystem();
		await expect(fs.mkdir("/a/b")).rejects.toThrow("ENOENT");
	});

	// ── readdir ──────────────────────────────────────────────────────

	test("readdir lists direct children sorted", async () => {
		const fs = new MemoryFileSystem({
			"/dir/b.txt": "b",
			"/dir/a.txt": "a",
			"/dir/sub/c.txt": "c",
		});
		const entries = await fs.readdir("/dir");
		expect(entries).toEqual(["a.txt", "b.txt", "sub"]);
	});

	test("readdir throws ENOENT for missing directory", async () => {
		const fs = new MemoryFileSystem();
		await expect(fs.readdir("/nope")).rejects.toThrow("ENOENT");
	});

	test("readdir throws ENOTDIR for a file", async () => {
		const fs = new MemoryFileSystem({ "/f.txt": "x" });
		await expect(fs.readdir("/f.txt")).rejects.toThrow("ENOTDIR");
	});

	// ── rm ───────────────────────────────────────────────────────────

	test("rm removes a file", async () => {
		const fs = new MemoryFileSystem({ "/f.txt": "x" });
		await fs.rm("/f.txt");
		expect(await fs.exists("/f.txt")).toBe(false);
	});

	test("rm recursive removes a directory and children", async () => {
		const fs = new MemoryFileSystem({
			"/dir/a.txt": "a",
			"/dir/sub/b.txt": "b",
		});
		await fs.rm("/dir", { recursive: true });
		expect(await fs.exists("/dir")).toBe(false);
		expect(await fs.exists("/dir/a.txt")).toBe(false);
		expect(await fs.exists("/dir/sub/b.txt")).toBe(false);
	});

	test("rm throws ENOENT for missing path", async () => {
		const fs = new MemoryFileSystem();
		await expect(fs.rm("/nope")).rejects.toThrow("ENOENT");
	});

	test("rm force on missing path succeeds silently", async () => {
		const fs = new MemoryFileSystem();
		await fs.rm("/nope", { force: true });
	});

	test("rm non-recursive on non-empty directory throws ENOTEMPTY", async () => {
		const fs = new MemoryFileSystem({ "/dir/f.txt": "x" });
		await expect(fs.rm("/dir")).rejects.toThrow("ENOTEMPTY");
	});

	// ── Symlinks ─────────────────────────────────────────────────────

	test("symlink + readlink round-trip", async () => {
		const fs = new MemoryFileSystem({ "/target.txt": "content" });
		await fs.symlink!("/target.txt", "/link");
		expect(await fs.readlink!("/link")).toBe("/target.txt");
	});

	test("stat follows symlinks", async () => {
		const fs = new MemoryFileSystem({ "/target.txt": "hello" });
		await fs.symlink!("/target.txt", "/link");
		const s = await fs.stat("/link");
		expect(s.isFile).toBe(true);
		expect(s.isSymbolicLink).toBe(false);
		expect(s.size).toBe(5);
	});

	test("lstat does not follow symlinks", async () => {
		const fs = new MemoryFileSystem({ "/target.txt": "hello" });
		await fs.symlink!("/target.txt", "/link");
		const s = await fs.lstat!("/link");
		expect(s.isSymbolicLink).toBe(true);
		expect(s.isFile).toBe(false);
	});

	test("readFile follows symlinks", async () => {
		const fs = new MemoryFileSystem({ "/target.txt": "content" });
		await fs.symlink!("/target.txt", "/link");
		expect(await fs.readFile("/link")).toBe("content");
	});

	test("writeFile through symlink overwrites target", async () => {
		const fs = new MemoryFileSystem({ "/target.txt": "old" });
		await fs.symlink!("/target.txt", "/link");
		await fs.writeFile("/link", "new");
		expect(await fs.readFile("/target.txt")).toBe("new");
	});

	test("symlink throws EEXIST if link path exists", async () => {
		const fs = new MemoryFileSystem({ "/existing": "x" });
		await expect(fs.symlink!("/target", "/existing")).rejects.toThrow("EEXIST");
	});

	test("readlink throws EINVAL on non-symlink", async () => {
		const fs = new MemoryFileSystem({ "/f.txt": "x" });
		await expect(fs.readlink!("/f.txt")).rejects.toThrow("EINVAL");
	});

	test("exists returns false for broken symlinks", async () => {
		const fs = new MemoryFileSystem();
		await fs.symlink!("/nonexistent", "/broken");
		expect(await fs.exists("/broken")).toBe(false);
	});

	// ── Path normalization ───────────────────────────────────────────

	test("normalizes paths with . and ..", async () => {
		const fs = new MemoryFileSystem({ "/a/b/c.txt": "yes" });
		expect(await fs.readFile("/a/./b/../b/c.txt")).toBe("yes");
	});

	test("normalizes double slashes", async () => {
		const fs = new MemoryFileSystem({ "/a/b.txt": "ok" });
		expect(await fs.readFile("/a//b.txt")).toBe("ok");
	});

	// ── Git integration ──────────────────────────────────────────────

	test("works with createGit for basic workflow", async () => {
		const { createGit } = await import("../src");
		const fs = new MemoryFileSystem({ "/repo/README.md": "# Hello" });
		const git = createGit({ identity: { name: "Test", email: "test@test.com", locked: true } });

		let r = await git.exec("git init", { fs, cwd: "/repo" });
		expect(r.exitCode).toBe(0);

		r = await git.exec("git add .", { fs, cwd: "/repo" });
		expect(r.exitCode).toBe(0);

		r = await git.exec('git commit -m "initial"', { fs, cwd: "/repo" });
		expect(r.exitCode).toBe(0);

		r = await git.exec("git log --oneline", { fs, cwd: "/repo" });
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("initial");
	});

	test("supports branches and merge", async () => {
		const { createGit } = await import("../src");
		const fs = new MemoryFileSystem({ "/repo/file.txt": "main content" });
		const git = createGit({ identity: { name: "Test", email: "test@test.com", locked: true } });

		await git.exec("git init", { fs, cwd: "/repo" });
		await git.exec("git add .", { fs, cwd: "/repo" });
		await git.exec('git commit -m "initial"', { fs, cwd: "/repo" });

		await git.exec("git checkout -b feature", { fs, cwd: "/repo" });
		await fs.writeFile("/repo/feature.txt", "new feature");
		await git.exec("git add .", { fs, cwd: "/repo" });
		await git.exec('git commit -m "add feature"', { fs, cwd: "/repo" });

		await git.exec("git checkout master", { fs, cwd: "/repo" });
		const r = await git.exec("git merge feature", { fs, cwd: "/repo" });
		expect(r.exitCode).toBe(0);

		expect(await fs.readFile("/repo/feature.txt")).toBe("new feature");
	});
});
