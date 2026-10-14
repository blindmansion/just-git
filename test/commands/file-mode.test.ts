import { describe, expect, test } from "bun:test";
import { createGit, MemoryFileSystem } from "../../src";
import type { FileSystem } from "../../src";
import { InMemoryFs, type Bash } from "just-bash";
import { createSandboxWorktree, createWorktree, extractTree } from "../../src/repo/worktree.ts";
import { createCommit, writeBlob, writeTree } from "../../src/repo/writing.ts";
import { MemoryStorage } from "../../src/server/memory-storage.ts";
import { createStorageAdapter } from "../../src/server/storage.ts";
import type { GitRepo } from "../../src/lib/types.ts";
import { TEST_ENV } from "../fixtures";
import { createTestBash } from "../util";

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

describe("mode-only local changes block operations like git", () => {
	async function setup(): Promise<Bash> {
		const bash = createTestBash({
			files: { "/repo/run.sh": "#!/bin/sh\necho hi\n", "/repo/plain.txt": "a\n" },
			env: TEST_ENV,
		});
		for (const cmd of [
			"git init -q -b main",
			"chmod 755 run.sh",
			"git add .",
			"git commit -q -m add",
			"git branch base",
			"git checkout -q -b content",
			"printf '#!/bin/sh\\necho changed\\n' > run.sh",
			"git commit -qam c",
			"git checkout -q main",
		]) {
			const r = await bash.exec(cmd);
			if (r.exitCode !== 0) throw new Error(`${cmd}: ${r.stderr}`);
		}
		return bash;
	}

	async function sh(bash: Bash, cmd: string) {
		const r = await bash.exec(cmd);
		if (r.exitCode !== 0) throw new Error(`${cmd}: ${r.stderr}`);
		return r.stdout;
	}

	const runShOld = "100644 4163036efa65bd4a469e752267498f01ea36a55c 0\trun.sh\n";

	test.each(["switch content", "checkout content"])(
		"%s refuses over a staged mode-only change",
		async (cmd) => {
			const bash = await setup();
			await sh(bash, "chmod -x run.sh && git add run.sh");
			const r = await bash.exec(`git ${cmd}`);
			expect(r.exitCode).toBe(1);
			expect(r.stdout).toBe("");
			expect(r.stderr).toBe(
				"error: Your local changes to the following files would be overwritten by checkout:\n" +
					"\trun.sh\n" +
					"Please commit your changes or stash them before you switch branches.\n" +
					"Aborting\n",
			);
			expect(await sh(bash, "git branch --show-current")).toBe("main\n");
			expect(await sh(bash, "git ls-files -s run.sh")).toBe(runShOld);
			expect(await sh(bash, "git status --short")).toBe("M  run.sh\n");
		},
	);

	test("fast-forward merge refuses over a staged mode-only change", async () => {
		const bash = await setup();
		await sh(bash, "chmod -x run.sh && git add run.sh");
		const r = await bash.exec("git merge content");
		expect(r.exitCode).toBe(1);
		expect(r.stdout).toMatch(/^Updating [0-9a-f]{7}\.\.[0-9a-f]{7}\n$/);
		expect(r.stderr).toBe(
			"error: Your local changes to the following files would be overwritten by merge:\n" +
				"\trun.sh\n" +
				"Please commit your changes or stash them before you merge.\n" +
				"Aborting\n",
		);
		expect(await sh(bash, "git ls-files -s run.sh")).toBe(runShOld);
		expect(await sh(bash, "git status --short")).toBe("M  run.sh\n");
	});

	test("switch refuses over a staged mode change on a file the target deletes", async () => {
		const bash = await setup();
		await sh(bash, "git checkout -q -b del base && git rm -q plain.txt && git commit -qm d");
		await sh(bash, "git checkout -q main && chmod +x plain.txt && git add plain.txt");
		const r = await bash.exec("git switch del");
		expect(r.exitCode).toBe(1);
		expect(r.stderr).toBe(
			"error: Your local changes to the following files would be overwritten by checkout:\n" +
				"\tplain.txt\n" +
				"Please commit your changes or stash them before you switch branches.\n" +
				"Aborting\n",
		);
		expect(await sh(bash, "git branch --show-current")).toBe("main\n");
		expect(await sh(bash, "git status --short")).toBe("M  plain.txt\n");
	});

	test("non-fast-forward merge refuses over a staged mode-only change", async () => {
		const bash = await setup();
		await sh(bash, "git checkout -q -b side base && echo s > s.txt && git add s.txt");
		await sh(bash, "git commit -qm s && git checkout -q main");
		await sh(bash, "echo q > q.txt && git add q.txt && git commit -qm q");
		await sh(bash, "chmod +x plain.txt && git add plain.txt");
		const r = await bash.exec("git merge --no-edit side");
		expect(r.exitCode).toBe(2);
		expect(r.stdout).toBe("");
		expect(r.stderr).toBe(
			"error: Your local changes to the following files would be overwritten by merge:\n" +
				"  plain.txt\n" +
				"Merge with strategy ort failed.\n",
		);
		expect(await sh(bash, "git ls-files -s plain.txt")).toBe(
			"100755 78981922613b2afb6025042ff6bd878ac1994e85 0\tplain.txt\n",
		);
		expect(await sh(bash, "git status --short")).toBe("M  plain.txt\n");
	});

	describe("switch lists mode-only local changes", () => {
		async function setupOther(): Promise<Bash> {
			const bash = await setup();
			await sh(bash, "git checkout -q -b other base && echo o > o.txt && git add o.txt");
			await sh(bash, "git commit -qm o && git checkout -q main");
			return bash;
		}

		test("unstaged chmod", async () => {
			const bash = await setupOther();
			await sh(bash, "chmod +x plain.txt");
			const r = await bash.exec("git switch other");
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toBe("M\tplain.txt\n");
			expect(r.stderr).toBe("Switched to branch 'other'\n");
		});

		test("staged chmod", async () => {
			const bash = await setupOther();
			await sh(bash, "chmod +x plain.txt && git add plain.txt");
			const r = await bash.exec("git switch other");
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toBe("M\tplain.txt\n");
			expect(await sh(bash, "git status --short")).toBe("M  plain.txt\n");
		});

		test("staged chmod with the worktree back at HEAD's mode", async () => {
			const bash = await setupOther();
			await sh(bash, "chmod +x plain.txt && git add plain.txt && chmod -x plain.txt");
			const r = await bash.exec("git checkout other");
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toBe("M\tplain.txt\n");
			expect(await sh(bash, "git status --short")).toBe("MM plain.txt\n");
		});
	});

	describe("cherry-pick -n of a mode-only commit", () => {
		async function setupPlain(): Promise<Bash> {
			const bash = await setup();
			await sh(
				bash,
				"git checkout -q -b plain base && chmod -x run.sh && git commit -qam 'drop x'",
			);
			await sh(bash, "git checkout -q main");
			return bash;
		}

		test("stages the mode change", async () => {
			const bash = await setupPlain();
			await sh(bash, "echo b > plain.txt && git add plain.txt");
			const r = await bash.exec("git cherry-pick -n plain");
			expect(r.exitCode).toBe(0);
			expect(await sh(bash, "git ls-files -s")).toBe(
				"100644 61780798228d17af2d34fce4cfbdf35556832472 0\tplain.txt\n" + runShOld,
			);
			expect(await sh(bash, "git status --short")).toBe("M  plain.txt\nM  run.sh\n");
			expect((await bash.fs.stat("/repo/run.sh")).mode & 0o111).toBe(0);
		});

		test("refuses over the same mode change made locally", async () => {
			const bash = await setupPlain();
			await sh(bash, "chmod -x run.sh");
			const r = await bash.exec("git cherry-pick -n plain");
			expect(r.exitCode).toBe(128);
			expect(r.stderr).toBe(
				"error: Your local changes to the following files would be overwritten by merge:\n" +
					"\trun.sh\n" +
					"Please commit your changes or stash them before you merge.\n" +
					"Aborting\n" +
					"fatal: cherry-pick failed\n",
			);
			expect(await sh(bash, "git status --short")).toBe(" M run.sh\n");
		});
	});

	test("rm refuses a file with an unstaged mode-only change", async () => {
		const bash = await setup();
		await sh(bash, "chmod -x run.sh");
		const r = await bash.exec("git rm run.sh");
		expect(r.exitCode).toBe(1);
		expect(r.stdout).toBe("");
		expect(r.stderr).toBe(
			"error: the following file has local modifications:\n" +
				"    run.sh\n" +
				"(use --cached to keep the file, or -f to force removal)\n",
		);
		expect(await sh(bash, "git ls-files run.sh")).toBe("run.sh\n");
	});

	test("rm refuses a file with a staged mode-only change, rm --cached allows it", async () => {
		const bash = await setup();
		await sh(bash, "chmod -x run.sh && git add run.sh");
		const r = await bash.exec("git rm run.sh");
		expect(r.exitCode).toBe(1);
		expect(r.stderr).toBe(
			"error: the following file has changes staged in the index:\n" +
				"    run.sh\n" +
				"(use --cached to keep the file, or -f to force removal)\n",
		);
		const cached = await bash.exec("git rm --cached run.sh");
		expect(cached.exitCode).toBe(0);
		expect(cached.stdout).toBe("rm 'run.sh'\n");
	});
});

async function storedRepoWithExecutable(): Promise<GitRepo> {
	const repo = await createStorageAdapter(new MemoryStorage()).createRepo("exec");
	const script = await writeBlob(repo, "#!/bin/sh\necho hi\n");
	const plain = await writeBlob(repo, "a\n");
	const tree = await writeTree(repo, [
		{ name: "run.sh", hash: script, mode: "100755" },
		{ name: "plain.txt", hash: plain, mode: "100644" },
	]);
	await createCommit(repo, {
		tree,
		parents: [],
		author: { name: "T", email: "t@t", date: new Date(1_000_000_000_000) },
		message: "exec\n",
		branch: "main",
	});
	return repo;
}

function gitFor(repo: GitRepo, fs: FileSystem) {
	const git = createGit({ objectStore: repo.objectStore, refStore: repo.refStore });
	return (cmd: string) => git.exec(cmd, { fs, cwd: "/repo", env: TEST_ENV });
}

describe("createWorktree and extractTree write exec bits", () => {
	const filesystems: [string, () => FileSystem][] = [
		["MemoryFileSystem", () => new MemoryFileSystem()],
		["just-bash InMemoryFs", () => new InMemoryFs() as unknown as FileSystem],
	];

	test.each(filesystems)("status is clean right after createWorktree (%s)", async (_, makeFs) => {
		const repo = await storedRepoWithExecutable();
		const fs = makeFs();
		await createWorktree(repo, fs, { workTree: "/repo" });
		expect((await fs.stat("/repo/run.sh")).mode & 0o777).toBe(0o755);
		expect((await fs.stat("/repo/plain.txt")).mode & 0o777).toBe(0o644);
		const status = await gitFor(repo, fs)("status --short");
		expect(status.stderr).toBe("");
		expect(status.stdout).toBe("");
	});

	test.each(filesystems)("extractTree applies the exec bit (%s)", async (_, makeFs) => {
		const repo = await storedRepoWithExecutable();
		const fs = makeFs();
		await extractTree(repo, "main", fs, "/out");
		expect((await fs.stat("/out/run.sh")).mode & 0o777).toBe(0o755);
		expect((await fs.stat("/out/plain.txt")).mode & 0o777).toBe(0o644);
	});

	test("extractTree clears the exec bit of an existing file for a 100644 entry", async () => {
		const repo = await storedRepoWithExecutable();
		const fs = new MemoryFileSystem({ "/out/plain.txt": "old\n" });
		await fs.chmod("/out/plain.txt", 0o755);
		await extractTree(repo, "main", fs, "/out");
		expect((await fs.stat("/out/plain.txt")).mode).toBe(0o100644);
		expect(await fs.readFile("/out/plain.txt")).toBe("a\n");
	});

	test("a target without chmod still materializes (exec bit dropped)", async () => {
		const repo = await storedRepoWithExecutable();
		const fs = new MemoryFileSystem();
		Object.defineProperty(fs, "chmod", { value: undefined });
		await extractTree(repo, "main", fs, "/out");
		expect((await fs.stat("/out/run.sh")).mode).toBe(0o100644);
	});
});

describe("overwriting an executable keeps its mode", () => {
	const script2 = "#!/bin/sh\necho bye\n";
	const expectedDiff =
		"diff --git a/run.sh b/run.sh\n" +
		"index 4163036..ac23810 100755\n" +
		"--- a/run.sh\n" +
		"+++ b/run.sh\n" +
		"@@ -1,2 +1,2 @@\n" +
		" #!/bin/sh\n" +
		"-echo hi\n" +
		"+echo bye\n";

	async function overwriteAndCommit(
		fs: FileSystem,
		run: (cmd: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>,
	) {
		await fs.writeFile("/repo/run.sh", script2);
		expect((await fs.stat("/repo/run.sh")).mode & 0o777).toBe(0o755);
		expect((await run("diff")).stdout).toBe(expectedDiff);
		expect((await run("status --short")).stdout).toBe(" M run.sh\n");
		expect((await run("commit -q -am edit")).exitCode).toBe(0);
		expect((await run("ls-tree HEAD run.sh")).stdout).toBe(
			"100755 blob ac238105ba996fbbc6410e8b63ac6efc29786f1d\trun.sh\n",
		);
		expect((await run("status --short")).stdout).toBe("");
	}

	test("MemoryFileSystem", async () => {
		const { fs, run } = await repoWithExecutable();
		await overwriteAndCommit(fs, (cmd) => run(cmd, "/repo"));
	});

	test("TreeBackedFs (sandbox worktree), tree-backed file", async () => {
		const repo = await storedRepoWithExecutable();
		const { ctx } = await createSandboxWorktree(repo, { ref: "main", workTree: "/repo" });
		await overwriteAndCommit(ctx.fs, gitFor(ctx, ctx.fs));
	});

	test("TreeBackedFs (sandbox worktree), file already in the overlay", async () => {
		const repo = await storedRepoWithExecutable();
		const { ctx } = await createSandboxWorktree(repo, { ref: "main", workTree: "/repo" });
		await ctx.fs.writeFile("/repo/run.sh", "tmp\n");
		await overwriteAndCommit(ctx.fs, gitFor(ctx, ctx.fs));
	});
});
