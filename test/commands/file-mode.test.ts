import { describe, expect, test } from "bun:test";
import { createGit, MemoryFileSystem } from "../../src";
import type { FileSystem } from "../../src";
import { Bash, InMemoryFs } from "just-bash";
import { chmod, lstat, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MaterializeTarget } from "../../src/repo";
import { readCommit, revParse } from "../../src/repo/reading.ts";
import { createTreeAccessor } from "../../src/repo/tree-accessor.ts";
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

// A target written against Node's fs: `lstat` returns a `Stats` whose
// `isSymbolicLink` is a method, and `mkdir` resolves to a path.
class NodeTarget implements MaterializeTarget {
	writeFile(p: string, content: string | Uint8Array) {
		return writeFile(p, content);
	}
	async mkdir(p: string, options?: { recursive?: boolean }) {
		await mkdir(p, options);
	}
	chmod(p: string, mode: number) {
		return chmod(p, mode);
	}
	lstat(p: string) {
		return lstat(p);
	}
}

class NodeStatOnlyTarget implements MaterializeTarget {
	writeFile(p: string, content: string | Uint8Array) {
		return writeFile(p, content);
	}
	async mkdir(p: string, options?: { recursive?: boolean }) {
		await mkdir(p, options);
	}
	chmod(p: string, mode: number) {
		return chmod(p, mode);
	}
	stat(p: string) {
		return stat(p);
	}
}

describe("materialize onto a Node fs target", () => {
	const targets: [string, () => MaterializeTarget][] = [
		["lstat with isSymbolicLink()", () => new NodeTarget()],
		["stat only", () => new NodeStatOnlyTarget()],
	];

	test.each(targets)("sets and clears exec bits on disk (%s)", async (_, makeTarget) => {
		const repo = await storedRepoWithExecutable();
		const commit = await readCommit(repo, (await revParse(repo, "main"))!);
		const dir = await mkdtemp(join(tmpdir(), "just-git-materialize-"));
		try {
			await writeFile(join(dir, "plain.txt"), "old\n");
			await chmod(join(dir, "plain.txt"), 0o755);
			const written = await createTreeAccessor(repo, commit.tree).materialize(makeTarget(), dir);
			expect(written).toBe(2);
			expect((await stat(join(dir, "run.sh"))).mode & 0o777).toBe(0o755);
			expect((await stat(join(dir, "plain.txt"))).mode & 0o777).toBe(0o644);
			expect(await Bun.file(join(dir, "plain.txt")).text()).toBe("a\n");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
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

// Expected output (including stash hashes) taken from real git 2.53 with the
// same identity and dates.
describe("stash keeps modes like git", () => {
	const STASH_ENV = {
		GIT_AUTHOR_NAME: "T",
		GIT_AUTHOR_EMAIL: "t@t",
		GIT_COMMITTER_NAME: "T",
		GIT_COMMITTER_EMAIL: "t@t",
		GIT_AUTHOR_DATE: "1000000000 +0000",
		GIT_COMMITTER_DATE: "1000000000 +0000",
	};
	const fOld = "100644 45b983be36b73c0788dc9cbcb76cbb80fc7bb057 0\tf\n";
	const gOld = "100644 e45c9c2666d44e0327c1f9c239a74c508336053e 0\tg\n";
	const saved = "Saved working directory and index state WIP on main: 487ea53 init\n";
	const modifiedF =
		"On branch main\n" +
		"Changes not staged for commit:\n" +
		'  (use "git add <file>..." to update what will be committed)\n' +
		'  (use "git restore <file>..." to discard changes in working directory)\n' +
		"\tmodified:   f\n" +
		"\n" +
		'no changes added to commit (use "git add" and/or "git commit -a")\n';
	const overwriteError =
		"error: Your local changes to the following files would be overwritten by merge:\n" +
		"\tf\n" +
		"Please commit your changes or stash them before you merge.\n" +
		"Aborting\n";

	async function setup(): Promise<Bash> {
		const bash = createTestBash({
			files: { "/repo/f": "hi\n", "/repo/g": "other\n" },
			env: STASH_ENV,
		});
		for (const cmd of ["git init -q -b main", "git add .", "git commit -q -m init"]) {
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

	async function perm(bash: Bash, path = "f") {
		return (await bash.fs.stat(`/repo/${path}`)).mode & 0o777;
	}

	async function expectStash(bash: Bash) {
		expect(await bash.exec("git stash")).toMatchObject({ stdout: saved, stderr: "", exitCode: 0 });
	}

	test("unstaged chmod: stash saves it, show reports it, pop restores it", async () => {
		const bash = await setup();
		await sh(bash, "chmod +x f");
		await expectStash(bash);
		expect(await perm(bash)).toBe(0o644);
		expect(await sh(bash, "git status --porcelain")).toBe("");
		expect(await sh(bash, "git stash show")).toBe(
			" f | 0\n 1 file changed, 0 insertions(+), 0 deletions(-)\n",
		);
		expect(await sh(bash, "git stash show -p")).toBe(
			"diff --git a/f b/f\nold mode 100644\nnew mode 100755\n",
		);
		expect(await bash.exec("git stash pop")).toMatchObject({
			stdout: `${modifiedF}Dropped refs/stash@{0} (649cc46b0379e66a1bca67ed0a340b4837917a44)\n`,
			stderr: "",
			exitCode: 0,
		});
		expect(await perm(bash)).toBe(0o755);
		expect(await sh(bash, "git status --porcelain")).toBe(" M f\n");
		expect(await sh(bash, "git ls-files -s")).toBe(fOld + gOld);
	});

	test("unstaged chmod -x of an executable", async () => {
		const bash = await setup();
		await sh(bash, "chmod +x f && git commit -q -am x && chmod -x f");
		expect((await bash.exec("git stash")).stdout).toBe(
			"Saved working directory and index state WIP on main: 634d417 x\n",
		);
		expect(await perm(bash)).toBe(0o755);
		expect((await bash.exec("git stash pop")).stdout).toBe(
			`${modifiedF}Dropped refs/stash@{0} (2cc270a6ce9e4600d2914bc3cdd7c757d8d7dff9)\n`,
		);
		expect(await perm(bash)).toBe(0o644);
		expect(await sh(bash, "git status --porcelain")).toBe(" M f\n");
	});

	test("staged chmod: pop without --index leaves it unstaged", async () => {
		const bash = await setup();
		await sh(bash, "chmod +x f && git add f");
		await expectStash(bash);
		expect(await perm(bash)).toBe(0o644);
		expect(await bash.exec("git stash pop")).toMatchObject({
			stdout: `${modifiedF}Dropped refs/stash@{0} (1c11897413804313659e5f65cd021bbe217b0565)\n`,
			stderr: "",
			exitCode: 0,
		});
		expect(await perm(bash)).toBe(0o755);
		expect(await sh(bash, "git status --porcelain")).toBe(" M f\n");
		expect(await sh(bash, "git ls-files -s")).toBe(fOld + gOld);
	});

	test("staged chmod with the worktree changed back saves the worktree mode", async () => {
		const bash = await setup();
		await sh(bash, "chmod +x f && git add f && chmod -x f");
		await expectStash(bash);
		expect(await bash.exec("git stash pop")).toMatchObject({
			stdout:
				"Already up to date.\nOn branch main\nnothing to commit, working tree clean\n" +
				"Dropped refs/stash@{0} (497975c30268863a783d752f3fa3246a34c5ae96)\n",
			exitCode: 0,
		});
		expect(await perm(bash)).toBe(0o644);
		expect(await sh(bash, "git ls-files -s f")).toBe(fOld);
	});

	test("chmod plus a content edit", async () => {
		const bash = await setup();
		await sh(bash, "echo more >> f && chmod +x f");
		await expectStash(bash);
		expect(await perm(bash)).toBe(0o644);
		expect((await bash.exec("git stash pop")).stdout).toBe(
			`${modifiedF}Dropped refs/stash@{0} (8ce0216980293d5d5dcfb129e5044104e0d2a19b)\n`,
		);
		expect(await perm(bash)).toBe(0o755);
		expect(await sh(bash, "git diff")).toBe(
			"diff --git a/f b/f\nold mode 100644\nnew mode 100755\nindex 45b983b..65ef226\n" +
				"--- a/f\n+++ b/f\n@@ -1 +1,2 @@\n hi\n+more\n",
		);
	});

	test("stash -u keeps a new executable's mode", async () => {
		const bash = await setup();
		await sh(bash, "echo '#!' > n && chmod +x n");
		expect((await bash.exec("git stash -u")).stdout).toBe(saved);
		expect(await sh(bash, "ls")).toBe("f\ng\n");
		expect((await bash.exec("git stash pop")).stdout).toBe(
			"Already up to date.\nOn branch main\nUntracked files:\n" +
				'  (use "git add <file>..." to include in what will be committed)\n' +
				"\tn\n\n" +
				'nothing added to commit but untracked files present (use "git add" to track)\n' +
				"Dropped refs/stash@{0} (89a515ff5c40fef74e2530987d42f68a72c63125)\n",
		);
		expect(await perm(bash, "n")).toBe(0o755);
		await sh(bash, "git add n");
		expect(await sh(bash, "git ls-files -s n")).toBe(
			"100755 7218afe77e9bf34f86390549f3008309e31dd9a6 0\tn\n",
		);
	});

	test("stash -u saves symlinks as links (tracked retarget and new link)", async () => {
		const bash = await setup();
		await sh(bash, "ln -s f l && git add l && git commit -q -m link");
		await sh(bash, "rm l && ln -s g l && ln -s f u");
		expect((await bash.exec("git stash -u")).stdout).toBe(
			"Saved working directory and index state WIP on main: d3becd9 link\n",
		);
		expect((await bash.exec("git stash pop")).stdout).toEndWith(
			"Dropped refs/stash@{0} (203030c426b3e0a071c5265311d89b168b32d953)\n",
		);
		expect(await sh(bash, "readlink l")).toBe("g\n");
		expect(await sh(bash, "readlink u")).toBe("f\n");
	});

	test("pop onto an upstream content change keeps the stashed mode", async () => {
		const bash = await setup();
		await sh(bash, "chmod +x f");
		await expectStash(bash);
		await sh(bash, "echo up >> f && git commit -q -am up");
		expect(await bash.exec("git stash pop")).toMatchObject({
			stdout: `${modifiedF}Dropped refs/stash@{0} (649cc46b0379e66a1bca67ed0a340b4837917a44)\n`,
			stderr: "",
			exitCode: 0,
		});
		expect(await perm(bash)).toBe(0o755);
		expect(await sh(bash, "cat f")).toBe("hi\nup\n");
		expect(await sh(bash, "git status --porcelain")).toBe(" M f\n");
		expect(await sh(bash, "git ls-files -s f")).toBe(
			"100644 9b9ff945069a9f6113d21efdb8d43d0f296d0ce6 0\tf\n",
		);
	});

	test.each([
		["a content stash", "echo x >> f"],
		["a content and mode stash", "echo x >> f && chmod +x f"],
	])("apply of %s refuses over a local chmod", async (_name, change) => {
		const bash = await setup();
		await sh(bash, change);
		await sh(bash, "git stash -q");
		await sh(bash, "chmod +x f");
		expect(await bash.exec("git stash apply")).toMatchObject({
			stdout: modifiedF,
			stderr: overwriteError,
			exitCode: 1,
		});
		expect(await perm(bash)).toBe(0o755);
		expect(await sh(bash, "cat f")).toBe("hi\n");
		expect(await sh(bash, "git status --porcelain")).toBe(" M f\n");

		expect(await bash.exec("git stash pop")).toMatchObject({
			stdout: `${modifiedF}The stash entry is kept in case you need it again.\n`,
			stderr: overwriteError,
			exitCode: 1,
		});
		expect(await sh(bash, "git stash list")).toBe("stash@{0}: WIP on main: 487ea53 init\n");
	});
});

describe("core.fileMode=false in config ignores the exec bit like git", () => {
	const ENV = {
		GIT_AUTHOR_NAME: "T",
		GIT_AUTHOR_EMAIL: "t@t",
		GIT_COMMITTER_NAME: "T",
		GIT_COMMITTER_EMAIL: "t@t",
		GIT_AUTHOR_DATE: "1000000000 +0000",
		GIT_COMMITTER_DATE: "1000000000 +0000",
	};
	const aEntry = "100644 78981922613b2afb6025042ff6bd878ac1994e85 0\ta\n";
	const bEntry = "100755 61780798228d17af2d34fce4cfbdf35556832472 0\tb\n";
	const clean = "On branch main\nnothing to commit, working tree clean\n";

	/** a is 100644 and b is 100755 in HEAD; then a gains and b loses the exec bit. */
	async function setup(
		options: { fileMode?: string | null; git?: ReturnType<typeof createGit> } = {},
	): Promise<Bash> {
		// fileMode: a value to set, null to unset it, undefined to keep init's.
		const { git } = options;
		const fileMode = "fileMode" in options ? options.fileMode : "false";
		const bash = new Bash({
			cwd: "/repo",
			files: { "/repo/a": "a\n", "/repo/b": "b\n" },
			env: ENV,
			customCommands: [git ?? createGit()],
		});
		const cmds = ["chmod +x b", "git init -q -b main", "git add .", "git commit -q -m init"];
		if (fileMode === null) cmds.push("git config --unset core.filemode");
		else if (fileMode !== undefined) cmds.push(`git config core.fileMode ${fileMode}`);
		cmds.push("chmod +x a", "chmod -x b");
		for (const cmd of cmds) await sh(bash, cmd);
		return bash;
	}

	async function sh(bash: Bash, cmd: string) {
		const r = await bash.exec(cmd);
		if (r.exitCode !== 0) throw new Error(`${cmd}: ${r.stderr}`);
		return r.stdout;
	}

	async function perm(bash: Bash, path: string) {
		return (await bash.fs.stat(`/repo/${path}`)).mode & 0o777;
	}

	test("status, diff, describe --dirty and commit -a ignore chmod", async () => {
		const bash = await setup();
		expect(await sh(bash, "git status --porcelain")).toBe("");
		expect(await sh(bash, "git status")).toBe(clean);
		expect(await sh(bash, "git diff")).toBe("");
		expect(await sh(bash, "git diff --stat")).toBe("");
		expect(await sh(bash, "git describe --dirty --always")).toBe("e631504\n");
		expect(await bash.exec("git commit -am x")).toMatchObject({
			stdout: clean,
			exitCode: 1,
		});
	});

	test("add keeps tracked modes and stages a new executable as 100644", async () => {
		const bash = await setup();
		await sh(bash, "echo n > n && chmod +x n");
		await sh(bash, "git add a b n");
		expect(await sh(bash, "git ls-files -s")).toBe(
			aEntry + bEntry + "100644 8ba3a16384aacc37d01564b28401755ce8053f51 0\tn\n",
		);
		await sh(bash, "git add -A");
		expect(await sh(bash, "git ls-files -s a b")).toBe(aEntry + bEntry);
	});

	test("a content edit keeps the index mode in diff and commit -a", async () => {
		const bash = await setup();
		await sh(bash, "echo b2 > b");
		expect(await sh(bash, "git diff")).toBe(
			"diff --git a/b b/b\n" +
				"index 6178079..e6bfff5 100755\n" +
				"--- a/b\n" +
				"+++ b/b\n" +
				"@@ -1 +1 @@\n" +
				"-b\n" +
				"+b2\n",
		);
		await sh(bash, "git commit -q -am edit");
		expect(await sh(bash, "git ls-files -s b")).toBe(
			"100755 e6bfff5c1d0f0ecd501552b43a1e13d8008abc31 0\tb\n",
		);
		expect(await sh(bash, "git log --oneline -1")).toBe("4eb3fce edit\n");
	});

	test.each(["false", "no", "OFF", "0", '""'])(
		"-c core.fileMode=%s applies to one command",
		async (value) => {
			const bash = await setup({ fileMode: undefined });
			expect(await sh(bash, `git -c core.fileMode=${value} status --porcelain`)).toBe("");
			expect(await sh(bash, "git status --porcelain")).toBe(" M a\n M b\n");
		},
	);

	test.each(["true", "yes", "On", "1", "2"])("core.fileMode=%s tracks chmod", async (value) => {
		const bash = await setup({ fileMode: value });
		expect(await sh(bash, "git status --porcelain")).toBe(" M a\n M b\n");
	});

	test("-c core.filemode=true overrides the file's false", async () => {
		const bash = await setup();
		expect(await sh(bash, "git -c core.filemode=true status --porcelain")).toBe(" M a\n M b\n");
	});

	test("an unset core.fileMode defaults to true", async () => {
		const bash = await setup({ fileMode: null });
		expect(await sh(bash, "git status --porcelain")).toBe(" M a\n M b\n");
	});

	test("operator config: locked and defaults", async () => {
		const locked = await setup({
			fileMode: undefined,
			git: createGit({ config: { locked: { "core.fileMode": "false" } } }),
		});
		expect(await sh(locked, "git status --porcelain")).toBe("");

		const defaults = await setup({
			fileMode: null,
			git: createGit({ config: { defaults: { "core.filemode": "false" } } }),
		});
		expect(await sh(defaults, "git status --porcelain")).toBe("");
		await sh(defaults, "git config core.filemode true");
		expect(await sh(defaults, "git status --porcelain")).toBe(" M a\n M b\n");
	});

	test("stash finds no local changes", async () => {
		const bash = await setup();
		expect(await bash.exec("git stash")).toMatchObject({
			stdout: "No local changes to save\n",
			exitCode: 0,
		});
	});

	test("rm accepts a file with only a chmod", async () => {
		const bash = await setup();
		expect(await bash.exec("git rm -q a")).toMatchObject({ stderr: "", exitCode: 0 });
	});

	test("switch neither lists nor refuses over a chmod", async () => {
		const bash = await setup();
		await sh(bash, "git branch side");
		await sh(bash, "git switch -q -c other");
		await sh(bash, "echo a2 > a && git commit -q -am a2");
		await sh(bash, "git switch -q main");
		await sh(bash, "chmod +x a && chmod -x b");

		expect(await bash.exec("git switch side")).toMatchObject({
			stdout: "",
			stderr: "Switched to branch 'side'\n",
			exitCode: 0,
		});
		expect(await bash.exec("git switch other")).toMatchObject({
			stdout: "",
			stderr: "Switched to branch 'other'\n",
			exitCode: 0,
		});
		expect(await sh(bash, "cat a")).toBe("a2\n");
		expect(await perm(bash, "a")).toBe(0o644);
		expect(await perm(bash, "b")).toBe(0o644);
		expect(await sh(bash, "git status --porcelain")).toBe("");
	});

	test("checkout still writes the exec bit of a 100755 entry", async () => {
		const bash = await setup();
		await sh(bash, "rm a b");
		await sh(bash, "git checkout -- a b");
		expect([await perm(bash, "a"), await perm(bash, "b")]).toEqual([0o644, 0o755]);
	});
});

describe("init records whether the FileSystem tracks the exec bit", () => {
	test("filemode = true with chmod, false without", async () => {
		const fs = new MemoryFileSystem();
		const git = createGit({ fs });
		const run = (cmd: string, cwd: string) => git.exec(cmd, { cwd, env: TEST_ENV });
		await run("init /with", "/");
		expect((await run("config core.filemode", "/with")).stdout).toBe("true\n");

		Object.defineProperty(fs, "chmod", { value: undefined });
		await run("init /without", "/");
		expect((await run("config core.filemode", "/without")).stdout).toBe("false\n");
		await run("init --bare /bare", "/");
		expect((await run("config core.filemode", "/bare")).stdout).toBe("false\n");
		await run("clone /with /clone", "/");
		expect((await run("config core.filemode", "/clone")).stdout).toBe("false\n");
	});
});

describe("typechange (file <-> symlink) shows as T like git", () => {
	// Expected output from real git 2.53 with TEST_ENV.
	const PATCH = [
		"diff --git a/f b/f",
		"deleted file mode 100644",
		"index ce01362..0000000",
		"--- a/f",
		"+++ /dev/null",
		"@@ -1 +0,0 @@",
		"-hello",
		"diff --git a/f b/f",
		"new file mode 120000",
		"index 0000000..c7e58fc",
		"--- /dev/null",
		"+++ b/f",
		"@@ -0,0 +1 @@",
		"+tgt",
		"\\ No newline at end of file",
		"diff --git a/l b/l",
		"deleted file mode 120000",
		"index c7e58fc..0000000",
		"--- a/l",
		"+++ /dev/null",
		"@@ -1 +0,0 @@",
		"-tgt",
		"\\ No newline at end of file",
		"diff --git a/l b/l",
		"new file mode 100644",
		"index 0000000..d95f3ad",
		"--- /dev/null",
		"+++ b/l",
		"@@ -0,0 +1 @@",
		"+content",
		"",
	].join("\n");
	const F_PATCH = `${PATCH.slice(0, PATCH.indexOf("diff --git a/l"))}`;

	/** f: regular file -> symlink; l: symlink -> regular file (unstaged). */
	async function setup() {
		const fs = new MemoryFileSystem();
		const git = createGit({ fs });
		const run = async (cmd: string) => {
			const r = await git.exec(cmd, { cwd: "/repo", env: TEST_ENV });
			if (r.exitCode !== 0) throw new Error(`${cmd}: ${r.stderr}`);
			return r.stdout;
		};
		await fs.mkdir("/repo", { recursive: true });
		await fs.writeFile("/repo/f", "hello\n");
		await fs.writeFile("/repo/tgt", "x\n");
		await fs.symlink("tgt", "/repo/l");
		await run("init -q -b main");
		await run("add .");
		await run("commit -q -m init");
		await run("branch other");
		await fs.rm("/repo/f");
		await fs.symlink("tgt", "/repo/f");
		await fs.rm("/repo/l");
		await fs.writeFile("/repo/l", "content\n");
		return { fs, git, run };
	}

	test("unstaged: status and diff", async () => {
		const { run } = await setup();
		expect(await run("status --short")).toBe(" T f\n T l\n");
		expect(await run("status --porcelain")).toBe(" T f\n T l\n");
		expect(await run("status")).toBe(
			[
				"On branch main",
				"Changes not staged for commit:",
				'  (use "git add <file>..." to update what will be committed)',
				'  (use "git restore <file>..." to discard changes in working directory)',
				"\ttypechange: f",
				"\ttypechange: l",
				"",
				'no changes added to commit (use "git add" and/or "git commit -a")',
				"",
			].join("\n"),
		);
		expect(await run("diff")).toBe(PATCH);
		expect(await run("diff HEAD")).toBe(PATCH);
		expect(await run("diff --name-status")).toBe("T\tf\nT\tl\n");
		expect(await run("diff HEAD --name-status")).toBe("T\tf\nT\tl\n");
		expect(await run("diff --stat")).toBe(
			" f | 2 +-\n l | 2 +-\n 2 files changed, 2 insertions(+), 2 deletions(-)\n",
		);
		expect(await run("diff --numstat")).toBe("1\t1\tf\n1\t1\tl\n");
		expect(await run("diff --summary")).toBe(
			" mode change 100644 => 120000 f\n mode change 120000 => 100644 l\n",
		);
	});

	test("staged: status and diff --cached, and TM with an unstaged retarget", async () => {
		const { fs, run } = await setup();
		await run("add -A");
		expect(await run("status --short")).toBe("T  f\nT  l\n");
		expect(await run("status")).toBe(
			[
				"On branch main",
				"Changes to be committed:",
				'  (use "git restore --staged <file>..." to unstage)',
				"\ttypechange: f",
				"\ttypechange: l",
				"",
				"",
			].join("\n"),
		);
		expect(await run("diff --cached")).toBe(PATCH);
		expect(await run("diff --cached --name-status")).toBe("T\tf\nT\tl\n");

		await fs.rm("/repo/f");
		await fs.symlink("other", "/repo/f");
		expect(await run("status --short")).toBe("TM f\nT  l\n");
		expect(await run("diff --name-status")).toBe("M\tf\n");
		expect(await run("diff")).toBe(
			[
				"diff --git a/f b/f",
				"index c7e58fc..27fa349 120000",
				"--- a/f",
				"+++ b/f",
				"@@ -1 +1 @@",
				"-tgt",
				"\\ No newline at end of file",
				"+other",
				"\\ No newline at end of file",
				"",
			].join("\n"),
		);
	});

	test("committed: commit summary, show, log and diff between commits", async () => {
		const { run } = await setup();
		await run("add -A");
		expect(await run("commit -m tc")).toBe(
			[
				"[main a1255e9] tc",
				" 2 files changed, 2 insertions(+), 2 deletions(-)",
				" mode change 100644 => 120000 f",
				" mode change 120000 => 100644 l",
				"",
			].join("\n"),
		);
		expect(await run("diff HEAD~1 HEAD")).toBe(PATCH);
		expect(await run("diff --name-status HEAD~1 HEAD")).toBe("T\tf\nT\tl\n");
		expect(await run("show --format=%h")).toBe(`a1255e9\n\n${PATCH}`);
		expect(await run("show --name-status --format=%h")).toBe("a1255e9\n\nT\tf\nT\tl\n");
		expect(await run("show --stat --format=%h")).toBe(
			"a1255e9\n\n f | 2 +-\n l | 2 +-\n 2 files changed, 2 insertions(+), 2 deletions(-)\n",
		);
		expect(await run("log --format=%h --name-status")).toBe(
			"a1255e9\n\nT\tf\nT\tl\nbcbc95a\n\nA\tf\nA\tl\nA\ttgt\n",
		);
		expect(await run("log -p --format=%s -1 -- f")).toBe(`tc\n\n${F_PATCH}`);
	});

	test("reset and switch list typechanges as T", async () => {
		const { run } = await setup();
		expect(await run("reset")).toBe("Unstaged changes after reset:\nT\tf\nT\tl\n");
		const sw = await run("switch other");
		expect(sw).toBe("T\tf\nT\tl\n");
	});

	test("a plain file standing in for a symlink (no symlink support) is M, not T", async () => {
		const fs = new MemoryFileSystem();
		const git = createGit({ fs });
		const run = (cmd: string, cwd: string) => git.exec(cmd, { cwd, env: TEST_ENV });
		await fs.mkdir("/repo", { recursive: true });
		await fs.writeFile("/repo/tgt", "x\n");
		await fs.symlink("tgt", "/repo/l");
		await run("init", "/repo");
		await run("add .", "/repo");
		await run("commit -m link", "/repo");
		for (const method of ["symlink", "readlink", "lstat"]) {
			Object.defineProperty(fs, method, { value: undefined });
		}
		await run("clone /repo /clone", "/");
		await fs.writeFile("/clone/l", "tgt2");
		expect((await run("status --short", "/clone")).stdout).toBe(" M l\n");
		expect((await run("diff --name-status", "/clone")).stdout).toBe("M\tl\n");
		expect((await run("diff", "/clone")).stdout).toBe(
			[
				"diff --git a/l b/l",
				"index c7e58fc..91e4cef 120000",
				"--- a/l",
				"+++ b/l",
				"@@ -1 +1 @@",
				"-tgt",
				"\\ No newline at end of file",
				"+tgt2",
				"\\ No newline at end of file",
				"",
			].join("\n"),
		);
	});
});
