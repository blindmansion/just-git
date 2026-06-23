import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { createSandbox, jg, justBash, realGitIn, removeSandbox, writeToSandbox } from "./util";

// ── Packfiles ───────────────────────────────────────────────────────

describe("interop: real git gc → just-git reads", () => {
	let sandbox: string;
	let git: ReturnType<typeof realGitIn>;
	beforeAll(async () => {
		sandbox = createSandbox();
		git = realGitIn(sandbox);
		await git.execAsync(["init"]);
		for (let i = 0; i < 10; i++) {
			writeFileSync(join(sandbox, "file.txt"), `version ${i}\n`);
			await git.execAsync(["add", "."]);
			await git.execAsync(["commit", "-m", "commit " + i]);
		}
		await git.execAsync(["gc", "--aggressive"]);
	});
	afterAll(() => removeSandbox(sandbox));

	test("just-git log after real git gc", async () => {
		const b = justBash(sandbox);
		const r = await jg(b, "git log --oneline");
		expect(r.exitCode).toBe(0);
		expect(r.stdout.trim().split("\n").length).toBeGreaterThanOrEqual(10);
	});

	test("just-git show HEAD after gc", async () => {
		const b = justBash(sandbox);
		const r = await jg(b, "git show HEAD");
		expect(r.exitCode).toBe(0);
	});

	test("just-git diff HEAD~3..HEAD after gc", async () => {
		const b = justBash(sandbox);
		const r = await jg(b, "git diff HEAD~3..HEAD");
		expect(r.exitCode).toBe(0);
	});

	test("just-git blame after gc", async () => {
		const b = justBash(sandbox);
		const r = await jg(b, "git blame file.txt");
		expect(r.exitCode).toBe(0);
	});

	test("just-git commit on top of packed repo", async () => {
		const b = justBash(sandbox);
		await jg(b, 'echo "new line" >> file.txt');
		await jg(b, "git add .");
		const r = await jg(b, 'git commit -m "just-git on packed repo"');
		expect(r.exitCode).toBe(0);

		const r2 = await git.execAsync(["log", "--oneline", "-3"]);
		expect(r2.stdout).toContain("just-git on packed repo");
	});

	test("real git fsck after just-git commit on packed repo", async () => {
		const r = await git.execAsync(["fsck", "--full"]);
		expect(r.exitCode).toBe(0);
	});
});

describe("interop: just-git gc → real git reads", () => {
	let sandbox: string;
	let git: ReturnType<typeof realGitIn>;
	beforeAll(async () => {
		sandbox = createSandbox();
		git = realGitIn(sandbox);
		const b = justBash(sandbox);
		await jg(b, "git init");
		for (let i = 0; i < 10; i++) {
			await jg(b, `echo "v${i}" > file.txt`);
			await jg(b, "git add .");
			await jg(b, `git commit -m "jg commit ${i}"`);
		}
		await jg(b, "git gc --aggressive");
	});
	afterAll(() => removeSandbox(sandbox));

	test("real git log after just-git gc", async () => {
		const r = await git.execAsync(["log", "--oneline"]);
		expect(r.exitCode).toBe(0);
		expect(r.stdout.trim().split("\n").length).toBeGreaterThanOrEqual(10);
	});

	test("real git fsck after just-git gc", async () => {
		const r = await git.execAsync(["fsck", "--full"]);
		expect(r.exitCode).toBe(0);
	});

	test("real git show after just-git gc", async () => {
		const r = await git.execAsync(["show", "HEAD"]);
		expect(r.exitCode).toBe(0);
	});
});

// ── Reflog ──────────────────────────────────────────────────────────

describe("interop: reflog", () => {
	let sandbox: string;
	let git: ReturnType<typeof realGitIn>;
	beforeAll(async () => {
		sandbox = createSandbox();
		git = realGitIn(sandbox);
		await git.execAsync(["init"]);
		writeToSandbox(sandbox, "f.txt", "a\n");
		await git.execAsync(["add", "."]);
		await git.execAsync(["commit", "-m", "real commit 1"]);
		writeToSandbox(sandbox, "f.txt", "b\n");
		await git.execAsync(["add", "."]);
		await git.execAsync(["commit", "-m", "real commit 2"]);
	});
	afterAll(() => removeSandbox(sandbox));

	test("just-git reads real git reflog", async () => {
		const b = justBash(sandbox);
		const r = await jg(b, "git reflog");
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("real commit 2");
	});

	test("just-git commits produce reflog entries readable by real git", async () => {
		const b = justBash(sandbox);
		await jg(b, 'echo "c" > f.txt');
		await jg(b, "git add .");
		await jg(b, 'git commit -m "jg reflog commit"');

		const r = await git.execAsync(["reflog"]);
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("jg reflog commit");
	});
});

// ── Index format ────────────────────────────────────────────────────

describe("interop: index format compatibility", () => {
	let sandbox: string;
	let git: ReturnType<typeof realGitIn>;
	beforeAll(async () => {
		sandbox = createSandbox();
		git = realGitIn(sandbox);
		await git.execAsync(["init"]);
		git.execShell("echo a > a.txt && echo b > b.txt && echo c > c.txt");
		await git.execAsync(["add", "."]);
	});
	afterAll(() => removeSandbox(sandbox));

	test("just-git status reads real git index", async () => {
		const b = justBash(sandbox);
		const r = await jg(b, "git status -s");
		expect(r.exitCode).toBe(0);
	});

	test("just-git ls-files reads real git index", async () => {
		const b = justBash(sandbox);
		const r = await jg(b, "git ls-files --cached");
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("a.txt");
	});

	test("just-git add + commit, real git status clean", async () => {
		await git.execAsync(["commit", "-m", "index test"]);

		const b = justBash(sandbox);
		await jg(b, 'echo "new" > new.txt');
		await jg(b, "git add new.txt");
		await jg(b, 'git commit -m "jg index commit"');

		const r = await git.execAsync(["status", "--porcelain"]);
		expect(r.exitCode).toBe(0);
		expect(r.stdout.trim()).toBe("");
	});

	test("real git reads just-git staged files before commit", async () => {
		const b = justBash(sandbox);
		await jg(b, 'echo "staged" > staged.txt');
		await jg(b, "git add staged.txt");

		const r = await git.execAsync(["status", "--porcelain"]);
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("staged.txt");
	});
});

// ── Binary files ────────────────────────────────────────────────────

describe("interop: binary files", () => {
	let sandbox: string;
	let git: ReturnType<typeof realGitIn>;
	beforeAll(async () => {
		sandbox = createSandbox();
		git = realGitIn(sandbox);
		await git.execAsync(["init"]);
		const binaryData = new Uint8Array(1024);
		for (let i = 0; i < binaryData.length; i++) binaryData[i] = i % 256;
		writeFileSync(join(sandbox, "binary.bin"), binaryData);
		await git.execAsync(["add", "."]);
		await git.execAsync(["commit", "-m", "add binary"]);
	});
	afterAll(() => removeSandbox(sandbox));

	test("just-git status with binary file", async () => {
		const b = justBash(sandbox);
		const r = await jg(b, "git status");
		expect(r.exitCode).toBe(0);
	});

	test("just-git log with binary file", async () => {
		const b = justBash(sandbox);
		const r = await jg(b, "git log --oneline");
		expect(r.exitCode).toBe(0);
	});

	test("just-git diff of modified binary", async () => {
		const modified = new Uint8Array(1024);
		for (let i = 0; i < modified.length; i++) modified[i] = (i + 1) % 256;
		writeFileSync(join(sandbox, "binary.bin"), modified);

		const b = justBash(sandbox);
		const r = await jg(b, "git diff");
		expect(r.exitCode).toBe(0);
	});
});

// ── Merge conflicts ─────────────────────────────────────────────────

describe("interop: cross-tool merge conflict", () => {
	let sandbox: string;
	let git: ReturnType<typeof realGitIn>;
	beforeAll(async () => {
		sandbox = createSandbox();
		git = realGitIn(sandbox);
		await git.execAsync(["init"]);
		writeToSandbox(sandbox, "conflict.txt", "base\n");
		await git.execAsync(["add", "."]);
		await git.execAsync(["commit", "-m", "base"]);

		await git.execAsync(["checkout", "-b", "branch-a"]);
		writeToSandbox(sandbox, "conflict.txt", "from branch a\n");
		await git.execAsync(["add", "."]);
		await git.execAsync(["commit", "-m", "branch a change"]);

		await git.execAsync(["checkout", "main"]);
		writeToSandbox(sandbox, "conflict.txt", "from main\n");
		await git.execAsync(["add", "."]);
		await git.execAsync(["commit", "-m", "main change"]);
	});
	afterAll(() => removeSandbox(sandbox));

	test("just-git merge detects conflict from real git branches", async () => {
		const b = justBash(sandbox);
		const r = await jg(b, "git merge branch-a");
		expect(r.exitCode).not.toBe(0);
		expect(r.stdout).toContain("CONFLICT");
	});

	test("just-git resolves conflict, real git validates with fsck", async () => {
		const b = justBash(sandbox);
		await jg(b, "git merge branch-a");
		await jg(b, 'echo "resolved" > conflict.txt');
		await jg(b, "git add .");
		const r = await jg(b, "git merge --continue");
		expect(r.exitCode).toBe(0);

		const fsck = await git.execAsync(["fsck", "--full"]);
		expect(fsck.exitCode).toBe(0);
	});
});

// ── Rebase ──────────────────────────────────────────────────────────

describe("interop: rebase", () => {
	let sandbox: string;
	let git: ReturnType<typeof realGitIn>;
	beforeAll(async () => {
		sandbox = createSandbox();
		git = realGitIn(sandbox);
		await git.execAsync(["init"]);
		writeToSandbox(sandbox, "f.txt", "base\n");
		await git.execAsync(["add", "."]);
		await git.execAsync(["commit", "-m", "base"]);
		await git.execAsync(["checkout", "-b", "topic"]);
		writeToSandbox(sandbox, "t.txt", "topic1\n");
		await git.execAsync(["add", "."]);
		await git.execAsync(["commit", "-m", "topic 1"]);
		git.execShell('echo "topic2" >> t.txt');
		await git.execAsync(["add", "."]);
		await git.execAsync(["commit", "-m", "topic 2"]);
		await git.execAsync(["checkout", "main"]);
		git.execShell('echo "main2" >> f.txt');
		await git.execAsync(["add", "."]);
		await git.execAsync(["commit", "-m", "main advance"]);
		await git.execAsync(["checkout", "topic"]);
	});
	afterAll(() => removeSandbox(sandbox));

	test("just-git rebase on real git repo", async () => {
		const b = justBash(sandbox);
		const r = await jg(b, "git rebase main");
		expect(r.exitCode).toBe(0);

		const log = await jg(b, "git log --oneline");
		expect(log.stdout).toContain("topic 1");
		expect(log.stdout).toContain("main advance");
	});

	test("real git fsck after just-git rebase", async () => {
		const r = await git.execAsync(["fsck", "--full"]);
		expect(r.exitCode).toBe(0);
	});

	test("real git log after just-git rebase", async () => {
		const r = await git.execAsync(["log", "--oneline", "--all"]);
		expect(r.exitCode).toBe(0);
	});
});

// ── Cherry-pick ─────────────────────────────────────────────────────

describe("interop: cherry-pick", () => {
	test("just-git cherry-picks from real git branch, fsck passes", async () => {
		const sandbox = createSandbox();
		const git = realGitIn(sandbox);
		try {
			await git.execAsync(["init"]);
			writeToSandbox(sandbox, "f.txt", "base\n");
			await git.execAsync(["add", "."]);
			await git.execAsync(["commit", "-m", "base"]);
			await git.execAsync(["checkout", "-b", "pick-src"]);
			writeToSandbox(sandbox, "cherry.txt", "cherry\n");
			await git.execAsync(["add", "."]);
			await git.execAsync(["commit", "-m", "the cherry"]);
			const cherryHash = (await git.execAsync(["rev-parse", "HEAD"])).stdout.trim();
			await git.execAsync(["checkout", "main"]);

			const b = justBash(sandbox);
			const r = await jg(b, `git cherry-pick ${cherryHash}`);
			expect(r.exitCode).toBe(0);

			const fsck = await git.execAsync(["fsck", "--full"]);
			expect(fsck.exitCode).toBe(0);
		} finally {
			removeSandbox(sandbox);
		}
	});
});

// ── Stash ───────────────────────────────────────────────────────────

describe("interop: stash — both directions", () => {
	let sandbox: string;
	let git: ReturnType<typeof realGitIn>;
	beforeAll(async () => {
		sandbox = createSandbox();
		git = realGitIn(sandbox);
		await git.execAsync(["init"]);
		writeToSandbox(sandbox, "f.txt", "base\n");
		await git.execAsync(["add", "."]);
		await git.execAsync(["commit", "-m", "base"]);
	});
	afterAll(() => removeSandbox(sandbox));

	test("real git stash, just-git stash list sees it", async () => {
		git.execShell('echo "dirty" >> f.txt');
		await git.execAsync(["stash", "push", "-m", "real stash"]);

		const b = justBash(sandbox);
		const r = await jg(b, "git stash list");
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("real stash");
	});

	test("just-git stash pop from real git stash", async () => {
		const b = justBash(sandbox);
		const r = await jg(b, "git stash pop");
		expect(r.exitCode).toBe(0);
	});

	test("just-git stash push, real git stash list sees it", async () => {
		const b = justBash(sandbox);
		await jg(b, 'echo "jg dirty" >> f.txt');
		await jg(b, "git stash push -m 'jg stash'");

		const r = await git.execAsync(["stash", "list"]);
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("jg stash");
	});

	test("real git stash pop from just-git stash", async () => {
		const r = await git.execAsync(["stash", "pop"]);
		expect(r.exitCode).toBe(0);
	});
});

// ── .gitignore ──────────────────────────────────────────────────────

describe("interop: .gitignore", () => {
	test("just-git respects .gitignore from real repo", async () => {
		const sandbox = createSandbox();
		const git = realGitIn(sandbox);
		try {
			await git.execAsync(["init"]);
			writeToSandbox(sandbox, ".gitignore", "node_modules/\n");
			writeToSandbox(sandbox, "node_modules/pkg.js", "pkg\n");
			writeToSandbox(sandbox, "app.js", "app\n");
			await git.execAsync(["add", "."]);
			await git.execAsync(["commit", "-m", "with gitignore"]);

			const b = justBash(sandbox);
			await jg(b, 'echo "new" > new.js');
			await jg(b, 'echo "ignored" > node_modules/ignored.js');
			const r = await jg(b, "git status -s");
			expect(r.exitCode).toBe(0);
			expect(r.stdout).not.toContain("node_modules");
			expect(r.stdout).toContain("new.js");
		} finally {
			removeSandbox(sandbox);
		}
	});
});

// ── Detached HEAD ───────────────────────────────────────────────────

describe("interop: detached HEAD", () => {
	let sandbox: string;
	let git: ReturnType<typeof realGitIn>;
	let v1Hash: string;
	beforeAll(async () => {
		sandbox = createSandbox();
		git = realGitIn(sandbox);
		await git.execAsync(["init"]);
		writeToSandbox(sandbox, "f.txt", "v1\n");
		await git.execAsync(["add", "."]);
		await git.execAsync(["commit", "-m", "v1"]);
		writeToSandbox(sandbox, "f.txt", "v2\n");
		await git.execAsync(["add", "."]);
		await git.execAsync(["commit", "-m", "v2"]);
		v1Hash = (await git.execAsync(["rev-parse", "HEAD~1"])).stdout.trim();
	});
	afterAll(() => removeSandbox(sandbox));

	test("just-git detach HEAD on real repo", async () => {
		const b = justBash(sandbox);
		const r = await jg(b, `git checkout ${v1Hash}`);
		expect(r.exitCode).toBe(0);

		const head = readFileSync(join(sandbox, ".git/HEAD"), "utf-8").trim();
		expect(head.startsWith("ref:")).toBe(false);
	});

	test("real git confirms detached state", async () => {
		const r = await git.execAsync(["status"]);
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("detached");
	});
});

// ── Many files / deep paths ─────────────────────────────────────────

describe("interop: many files / deep paths", () => {
	let sandbox: string;
	let git: ReturnType<typeof realGitIn>;
	beforeAll(async () => {
		sandbox = createSandbox();
		git = realGitIn(sandbox);
		await git.execAsync(["init"]);
		for (let i = 0; i < 50; i++) {
			const dir = `src/pkg${Math.floor(i / 10)}`;
			mkdirSync(join(sandbox, dir), { recursive: true });
			writeFileSync(join(sandbox, dir, `file${i}.ts`), `export const x${i} = ${i};\n`);
		}
		await git.execAsync(["add", "."]);
		await git.execAsync(["commit", "-m", "50 files"]);
	});
	afterAll(() => removeSandbox(sandbox));

	test("just-git ls-files on 50-file real repo", async () => {
		const b = justBash(sandbox);
		const r = await jg(b, "git ls-files");
		expect(r.exitCode).toBe(0);
		expect(r.stdout.trim().split("\n").length).toBeGreaterThanOrEqual(50);
	});

	test("just-git add + commit new files, fsck passes", async () => {
		const b = justBash(sandbox);
		for (let i = 50; i < 55; i++) {
			await jg(b, `echo "new${i}" > src/pkg0/new${i}.ts`);
		}
		await jg(b, "git add .");
		const r = await jg(b, 'git commit -m "add 5 more"');
		expect(r.exitCode).toBe(0);

		const fsck = await git.execAsync(["fsck", "--full"]);
		expect(fsck.exitCode).toBe(0);
	});
});

// ── Reset ───────────────────────────────────────────────────────────

describe("interop: reset", () => {
	test("reset --soft HEAD~1, both tools agree on staged state", async () => {
		const sandbox = createSandbox();
		const git = realGitIn(sandbox);
		try {
			await git.execAsync(["init"]);
			writeToSandbox(sandbox, "a.txt", "a\n");
			await git.execAsync(["add", "."]);
			await git.execAsync(["commit", "-m", "commit a"]);
			writeToSandbox(sandbox, "b.txt", "b\n");
			await git.execAsync(["add", "."]);
			await git.execAsync(["commit", "-m", "commit b"]);

			const b = justBash(sandbox);
			const r = await jg(b, "git reset --soft HEAD~1");
			expect(r.exitCode).toBe(0);

			const st = await jg(b, "git status -s");
			expect(st.stdout).toContain("b.txt");

			const realSt = await git.execAsync(["status", "--porcelain"]);
			expect(realSt.stdout).toContain("b.txt");
		} finally {
			removeSandbox(sandbox);
		}
	});

	test("reset --hard HEAD~1, real git validates", async () => {
		const sandbox = createSandbox();
		const git = realGitIn(sandbox);
		try {
			await git.execAsync(["init"]);
			writeToSandbox(sandbox, "a.txt", "a\n");
			await git.execAsync(["add", "."]);
			await git.execAsync(["commit", "-m", "commit a"]);
			writeToSandbox(sandbox, "b.txt", "b\n");
			await git.execAsync(["add", "."]);
			await git.execAsync(["commit", "-m", "commit b"]);

			const b = justBash(sandbox);
			const r = await jg(b, "git reset --hard HEAD~1");
			expect(r.exitCode).toBe(0);

			const realLog = await git.execAsync(["log", "--oneline"]);
			expect(realLog.stdout).not.toContain("commit b");

			const realSt = await git.execAsync(["status", "--porcelain"]);
			expect(realSt.stdout.trim()).toBe("");
		} finally {
			removeSandbox(sandbox);
		}
	});
});
