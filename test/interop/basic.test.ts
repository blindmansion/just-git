import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { $ } from "bun";
import { createSandbox, jg, justBash, realGit, removeSandbox, writeToSandbox } from "./util";

describe("interop: just-git creates → real git reads", () => {
	let sandbox: string;
	beforeAll(() => {
		sandbox = createSandbox();
	});
	afterAll(() => removeSandbox(sandbox));

	test("real git status on just-git repo", async () => {
		const bash = justBash(sandbox);
		await jg(bash, "git init");
		await jg(bash, 'echo "# Hello" > README.md');
		await jg(bash, 'echo "console.log(42)" > index.js');
		await jg(bash, "git add .");
		await jg(bash, 'git commit -m "initial from just-git"');

		const r = await realGit(sandbox, "status");
		expect(r.exitCode).toBe(0);
	});

	test("real git log reads just-git commits", async () => {
		const r = await realGit(sandbox, "log --oneline");
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("initial from just-git");
	});

	test("real git show HEAD", async () => {
		const r = await realGit(sandbox, "show HEAD");
		expect(r.exitCode).toBe(0);
	});

	test("real git diff (clean worktree)", async () => {
		const r = await realGit(sandbox, "diff");
		expect(r.exitCode).toBe(0);
		expect(r.stdout.trim()).toBe("");
	});

	test("real git blame README.md", async () => {
		const r = await realGit(sandbox, "blame README.md");
		expect(r.exitCode).toBe(0);
	});

	test("real git branch -v", async () => {
		const r = await realGit(sandbox, "branch -v");
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("main");
	});

	test("real git sees multi-commit history", async () => {
		const bash = justBash(sandbox);
		await jg(bash, 'echo "line 2" >> README.md');
		await jg(bash, "git add .");
		await jg(bash, 'git commit -m "update readme"');

		const r = await realGit(sandbox, "log --oneline");
		expect(r.exitCode).toBe(0);
		const lines = r.stdout.trim().split("\n");
		expect(lines.length).toBeGreaterThanOrEqual(2);
	});

	test("real git reads annotated tags", async () => {
		const bash = justBash(sandbox);
		await jg(bash, 'git tag -a v1.0 -m "release 1.0"');

		const r = await realGit(sandbox, "tag");
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("v1.0");

		const show = await realGit(sandbox, "show v1.0");
		expect(show.exitCode).toBe(0);
		expect(show.stdout).toContain("release 1.0");
	});

	test("real git sees just-git branches", async () => {
		const bash = justBash(sandbox);
		await jg(bash, "git switch -c feature");
		await jg(bash, 'echo "feat" > feat.txt');
		await jg(bash, "git add .");
		await jg(bash, 'git commit -m "feature commit"');

		const r = await realGit(sandbox, "branch -a");
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("feature");
	});

	test("real git log --all sees all branches", async () => {
		const r = await realGit(sandbox, "log --oneline --all");
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("feature commit");
	});
});

describe("interop: real git creates → just-git reads", () => {
	let sandbox: string;
	beforeAll(async () => {
		sandbox = createSandbox();
		await $`git -c init.defaultBranch=main init`.cwd(sandbox).quiet();
		await $`git -c user.name="Real Git" -c user.email="real@test.com" commit --allow-empty -m "empty init"`
			.cwd(sandbox)
			.quiet();
		writeToSandbox(sandbox, "hello.txt", "hello from real git\n");
		await $`git -c user.name="Real Git" -c user.email="real@test.com" add .`.cwd(sandbox).quiet();
		await $`git -c user.name="Real Git" -c user.email="real@test.com" commit -m "add hello.txt"`
			.cwd(sandbox)
			.quiet();
	});
	afterAll(() => removeSandbox(sandbox));

	test("just-git status on real git repo", async () => {
		const bash = justBash(sandbox);
		const r = await jg(bash, "git status");
		expect(r.exitCode).toBe(0);
	});

	test("just-git log on real git repo", async () => {
		const bash = justBash(sandbox);
		const r = await jg(bash, "git log --oneline");
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("add hello.txt");
	});

	test("just-git reads file from real git repo", async () => {
		const bash = justBash(sandbox);
		const r = await jg(bash, "cat hello.txt");
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("hello from real git");
	});

	test("just-git diff on real git repo", async () => {
		const bash = justBash(sandbox);
		await jg(bash, 'echo "modified" >> hello.txt');
		const r = await jg(bash, "git diff");
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("modified");
	});

	test("just-git commit on real git repo, real git reads it", async () => {
		const bash = justBash(sandbox);
		await jg(bash, "git add .");
		const r = await jg(bash, 'git commit -m "commit from just-git"');
		expect(r.exitCode).toBe(0);

		const log = await realGit(sandbox, "log --oneline");
		expect(log.exitCode).toBe(0);
		expect(log.stdout).toContain("commit from just-git");
	});
});

describe("interop: mixed interleaved operations", () => {
	let sandbox: string;
	beforeAll(async () => {
		sandbox = createSandbox();
		await $`git -c init.defaultBranch=main init`.cwd(sandbox).quiet();
		writeToSandbox(sandbox, "shared.txt", "line 1\n");
		await $`git -c user.name="Real Git" -c user.email="real@test.com" add .`.cwd(sandbox).quiet();
		await $`git -c user.name="Real Git" -c user.email="real@test.com" commit -m "real: line 1"`
			.cwd(sandbox)
			.quiet();
	});
	afterAll(() => removeSandbox(sandbox));

	test("just-git adds line, real git reads", async () => {
		const bash = justBash(sandbox);
		await jg(bash, 'echo "line 2" >> shared.txt');
		await jg(bash, "git add .");
		await jg(bash, 'git commit -m "just-git: line 2"');

		const r = await realGit(sandbox, "log --oneline");
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("just-git: line 2");
	});

	test("real git adds line, just-git reads", async () => {
		await $`bash -c 'echo "line 3" >> shared.txt'`.cwd(sandbox).quiet();
		await $`git -c user.name="Real Git" -c user.email="real@test.com" add .`.cwd(sandbox).quiet();
		await $`git -c user.name="Real Git" -c user.email="real@test.com" commit -m "real: line 3"`
			.cwd(sandbox)
			.quiet();

		const bash = justBash(sandbox);
		const r = await jg(bash, "git log --oneline");
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("real: line 3");
	});

	test("real git branch, just-git sees it", async () => {
		await $`git -c user.name="Real Git" -c user.email="real@test.com" checkout -b real-branch`
			.cwd(sandbox)
			.quiet();
		writeToSandbox(sandbox, "branch-file.txt", "from real branch\n");
		await $`git -c user.name="Real Git" -c user.email="real@test.com" add .`.cwd(sandbox).quiet();
		await $`git -c user.name="Real Git" -c user.email="real@test.com" commit -m "real: branch commit"`
			.cwd(sandbox)
			.quiet();
		await $`git checkout main`.cwd(sandbox).quiet();

		const bash = justBash(sandbox);
		const r = await jg(bash, "git branch -a");
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("real-branch");
	});

	test("just-git merge real git branch", async () => {
		const bash = justBash(sandbox);
		const r = await jg(bash, "git merge real-branch");
		expect(r.exitCode).toBe(0);
	});

	test("real git sees merge commit", async () => {
		const r = await realGit(sandbox, "log --oneline --all");
		expect(r.exitCode).toBe(0);
	});

	test("real git fsck on interleaved repo", async () => {
		const r = await realGit(sandbox, "fsck --full");
		expect(r.exitCode).toBe(0);
	});
});
