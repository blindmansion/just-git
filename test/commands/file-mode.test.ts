import { describe, expect, test } from "bun:test";
import { createGit, MemoryFileSystem } from "../../src";
import { TEST_ENV } from "../fixtures";

async function repoWithExecutable(): Promise<{
	fs: MemoryFileSystem;
	run: (cmd: string, cwd: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
}> {
	const fs = new MemoryFileSystem();
	const git = createGit({ fs });
	const run = (cmd: string, cwd: string) => git.exec(cmd, { cwd, env: TEST_ENV });
	await fs.mkdir("/repo", { recursive: true });
	await fs.writeFile("/repo/run.sh", "#!/bin/sh\necho hi\n");
	await fs.chmod("/repo/run.sh", 0o755);
	await run("init", "/repo");
	await run("add run.sh", "/repo");
	await run("commit -m exec", "/repo");
	return { fs, run };
}

describe("FileSystem without chmod behaves like core.fileMode=false", () => {
	test("clone, status, commit -a and add -A keep 100755 without the exec bit on disk", async () => {
		const { fs, run } = await repoWithExecutable();
		Object.defineProperty(fs, "chmod", { value: undefined });

		expect((await run("clone /repo /clone", "/")).exitCode).toBe(0);
		expect((await fs.stat("/clone/run.sh")).mode).toBe(0o100644);
		expect((await run("ls-files -s", "/clone")).stdout).toMatch(/^100755 /);
		expect((await run("status --short", "/clone")).stdout).toBe("");

		const commitAll = await run("commit -a -m noop", "/clone");
		expect(commitAll.exitCode).toBe(1);
		expect(commitAll.stdout).toContain("nothing to commit, working tree clean");

		await run("add -A", "/clone");
		expect((await run("ls-files -s", "/clone")).stdout).toMatch(/^100755 /);
		expect((await run("status --short", "/clone")).stdout).toBe("");
	});

	test("a new file is added as 100644 even when stat reports an exec bit", async () => {
		const { fs, run } = await repoWithExecutable();
		await fs.writeFile("/repo/new.sh", "x\n");
		await fs.chmod("/repo/new.sh", 0o755);
		Object.defineProperty(fs, "chmod", { value: undefined });

		await run("add new.sh", "/repo");
		expect((await run("ls-files -s new.sh", "/repo")).stdout).toMatch(/^100644 /);
	});
});

describe("FileSystem without symlinks behaves like core.symlinks=false", () => {
	test("status is clean after checking out a 120000 entry as a plain file", async () => {
		const fs = new MemoryFileSystem();
		const git = createGit({ fs });
		const run = (cmd: string, cwd: string) => git.exec(cmd, { cwd, env: TEST_ENV });
		await fs.mkdir("/repo", { recursive: true });
		await fs.writeFile("/repo/a.txt", "a\n");
		await fs.symlink("a.txt", "/repo/link");
		await run("init", "/repo");
		await run("add .", "/repo");
		await run("commit -m link", "/repo");
		for (const method of ["symlink", "readlink", "lstat"]) {
			Object.defineProperty(fs, method, { value: undefined });
		}

		expect((await run("clone /repo /clone", "/")).exitCode).toBe(0);
		expect((await fs.stat("/clone/link")).isFile).toBe(true);
		expect(await fs.readFile("/clone/link")).toBe("a.txt");
		expect((await run("ls-files -s link", "/clone")).stdout).toMatch(/^120000 /);
		expect((await run("status --short", "/clone")).stdout).toBe("");
		expect((await run("diff", "/clone")).stdout).toBe("");
	});
});
