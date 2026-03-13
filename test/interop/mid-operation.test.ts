import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { $ } from "bun";
import { createSandbox, jg, justBash, realGit, removeSandbox, writeToSandbox } from "./util";

/**
 * Sets up a repo with a base commit and two divergent branches that will
 * conflict on `conflict.txt`. Returns the sandbox path.
 */
async function setupConflictRepo() {
	const sandbox = createSandbox();
	await $`git -c init.defaultBranch=main init`.cwd(sandbox).quiet();
	writeToSandbox(sandbox, "conflict.txt", "base\n");
	writeToSandbox(sandbox, "clean.txt", "untouched\n");
	await $`git -c user.name="R" -c user.email="r@t" add .`.cwd(sandbox).quiet();
	await $`git -c user.name="R" -c user.email="r@t" commit -m "base"`.cwd(sandbox).quiet();

	await $`git checkout -b theirs`.cwd(sandbox).quiet();
	writeToSandbox(sandbox, "conflict.txt", "theirs side\n");
	await $`git -c user.name="R" -c user.email="r@t" add .`.cwd(sandbox).quiet();
	await $`git -c user.name="R" -c user.email="r@t" commit -m "theirs change"`.cwd(sandbox).quiet();

	await $`git checkout main`.cwd(sandbox).quiet();
	writeToSandbox(sandbox, "conflict.txt", "ours side\n");
	await $`git -c user.name="R" -c user.email="r@t" add .`.cwd(sandbox).quiet();
	await $`git -c user.name="R" -c user.email="r@t" commit -m "ours change"`.cwd(sandbox).quiet();

	return sandbox;
}

/**
 * Like setupConflictRepo but creates two commits on the topic branch
 * (for rebase testing — needs commits to replay).
 */
async function setupRebaseConflictRepo() {
	const sandbox = createSandbox();
	await $`git -c init.defaultBranch=main init`.cwd(sandbox).quiet();
	writeToSandbox(sandbox, "f.txt", "base\n");
	await $`git -c user.name="R" -c user.email="r@t" add .`.cwd(sandbox).quiet();
	await $`git -c user.name="R" -c user.email="r@t" commit -m "base"`.cwd(sandbox).quiet();

	await $`git checkout -b topic`.cwd(sandbox).quiet();
	writeToSandbox(sandbox, "f.txt", "topic change\n");
	await $`git -c user.name="R" -c user.email="r@t" add .`.cwd(sandbox).quiet();
	await $`git -c user.name="R" -c user.email="r@t" commit -m "topic edit"`.cwd(sandbox).quiet();

	await $`git checkout main`.cwd(sandbox).quiet();
	writeToSandbox(sandbox, "f.txt", "main change\n");
	await $`git -c user.name="R" -c user.email="r@t" add .`.cwd(sandbox).quiet();
	await $`git -c user.name="R" -c user.email="r@t" commit -m "main advance"`.cwd(sandbox).quiet();
	await $`git checkout topic`.cwd(sandbox).quiet();

	return sandbox;
}

// ── Merge handoff ───────────────────────────────────────────────────

describe("mid-operation: real git starts merge → just-git finishes", () => {
	let sandbox: string;
	beforeAll(async () => {
		sandbox = await setupConflictRepo();
		const r = await $`git -c user.name="R" -c user.email="r@t" merge theirs`
			.cwd(sandbox)
			.nothrow()
			.quiet();
		expect(r.exitCode).not.toBe(0);
	});
	afterAll(() => removeSandbox(sandbox));

	test("just-git sees the conflict state", async () => {
		const b = justBash(sandbox);
		const r = await jg(b, "git status");
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("Unmerged");
	});

	test("just-git resolves and continues the merge", async () => {
		const b = justBash(sandbox);
		await jg(b, 'echo "resolved" > conflict.txt');
		await jg(b, "git add conflict.txt");
		const r = await jg(b, "git merge --continue");
		expect(r.exitCode).toBe(0);
	});

	test("real git sees clean state after just-git merge --continue", async () => {
		const st = await realGit(sandbox, "status --porcelain");
		expect(st.stdout.trim()).toBe("");

		const log = await realGit(sandbox, "log --oneline");
		expect(log.exitCode).toBe(0);

		const fsck = await realGit(sandbox, "fsck --full");
		expect(fsck.exitCode).toBe(0);
	});
});

describe("mid-operation: just-git starts merge → real git finishes", () => {
	let sandbox: string;
	beforeAll(async () => {
		sandbox = await setupConflictRepo();
		const b = justBash(sandbox);
		const r = await jg(b, "git merge theirs");
		expect(r.exitCode).not.toBe(0);
	});
	afterAll(() => removeSandbox(sandbox));

	test("real git sees the conflict state", async () => {
		const st = await realGit(sandbox, "status");
		expect(st.exitCode).toBe(0);
		expect(st.stdout).toContain("Unmerged");
	});

	test("real git resolves and continues the merge", async () => {
		writeToSandbox(sandbox, "conflict.txt", "resolved by real git\n");
		await $`git -c user.name="R" -c user.email="r@t" add conflict.txt`.cwd(sandbox).quiet();
		const r = await $`GIT_EDITOR=true git -c user.name="R" -c user.email="r@t" merge --continue`
			.cwd(sandbox)
			.nothrow()
			.quiet();
		expect(r.exitCode).toBe(0);
	});

	test("just-git sees clean state after real git merge --continue", async () => {
		const b = justBash(sandbox);
		const st = await jg(b, "git status --porcelain");
		expect(st.stdout.trim()).toBe("");

		const log = await jg(b, "git log --oneline");
		expect(log.exitCode).toBe(0);
	});
});

describe("mid-operation: real git starts merge → just-git aborts", () => {
	let sandbox: string;
	beforeAll(async () => {
		sandbox = await setupConflictRepo();
		await $`git -c user.name="R" -c user.email="r@t" merge theirs`.cwd(sandbox).nothrow().quiet();
	});
	afterAll(() => removeSandbox(sandbox));

	test("just-git aborts the merge started by real git", async () => {
		const b = justBash(sandbox);
		const r = await jg(b, "git merge --abort");
		expect(r.exitCode).toBe(0);
	});

	test("real git sees clean state after just-git merge --abort", async () => {
		const st = await realGit(sandbox, "status --porcelain");
		expect(st.stdout.trim()).toBe("");

		const fsck = await realGit(sandbox, "fsck --full");
		expect(fsck.exitCode).toBe(0);
	});
});

describe("mid-operation: just-git starts merge → real git aborts", () => {
	let sandbox: string;
	beforeAll(async () => {
		sandbox = await setupConflictRepo();
		const b = justBash(sandbox);
		await jg(b, "git merge theirs");
	});
	afterAll(() => removeSandbox(sandbox));

	test("real git aborts the merge started by just-git", async () => {
		const r = await $`git -c user.name="R" -c user.email="r@t" merge --abort`
			.cwd(sandbox)
			.nothrow()
			.quiet();
		expect(r.exitCode).toBe(0);
	});

	test("just-git sees clean state after real git merge --abort", async () => {
		const b = justBash(sandbox);
		const st = await jg(b, "git status --porcelain");
		expect(st.stdout.trim()).toBe("");
	});
});

// ── Rebase handoff ──────────────────────────────────────────────────

describe("mid-operation: real git starts rebase → just-git finishes", () => {
	let sandbox: string;
	beforeAll(async () => {
		sandbox = await setupRebaseConflictRepo();
		const r = await $`git -c user.name="R" -c user.email="r@t" rebase main`
			.cwd(sandbox)
			.nothrow()
			.quiet();
		expect(r.exitCode).not.toBe(0);
	});
	afterAll(() => removeSandbox(sandbox));

	test("just-git sees rebase in progress", async () => {
		const b = justBash(sandbox);
		const r = await jg(b, "git status");
		expect(r.exitCode).toBe(0);
		expect(r.stdout.toLowerCase()).toContain("rebase");
	});

	test("just-git resolves and continues the rebase", async () => {
		const b = justBash(sandbox);
		await jg(b, 'echo "resolved" > f.txt');
		await jg(b, "git add f.txt");
		const r = await jg(b, "git rebase --continue");
		expect(r.exitCode).toBe(0);
	});

	test("real git sees clean state after just-git rebase --continue", async () => {
		const st = await realGit(sandbox, "status --porcelain");
		expect(st.stdout.trim()).toBe("");

		const fsck = await realGit(sandbox, "fsck --full");
		expect(fsck.exitCode).toBe(0);
	});
});

describe("mid-operation: just-git starts rebase → real git finishes", () => {
	let sandbox: string;
	beforeAll(async () => {
		sandbox = await setupRebaseConflictRepo();
		const b = justBash(sandbox);
		const r = await jg(b, "git rebase main");
		expect(r.exitCode).not.toBe(0);
	});
	afterAll(() => removeSandbox(sandbox));

	test("real git sees rebase in progress", async () => {
		const st = await realGit(sandbox, "status");
		expect(st.exitCode).toBe(0);
		expect(st.stdout.toLowerCase()).toContain("rebase");
	});

	test("real git resolves and continues the rebase", async () => {
		writeToSandbox(sandbox, "f.txt", "resolved by real git\n");
		await $`git -c user.name="R" -c user.email="r@t" add f.txt`.cwd(sandbox).quiet();
		const r = await $`GIT_EDITOR=true git -c user.name="R" -c user.email="r@t" rebase --continue`
			.cwd(sandbox)
			.nothrow()
			.quiet();
		expect(r.exitCode).toBe(0);
	});

	test("just-git sees clean state after real git rebase --continue", async () => {
		const b = justBash(sandbox);
		const st = await jg(b, "git status --porcelain");
		expect(st.stdout.trim()).toBe("");

		const log = await jg(b, "git log --oneline");
		expect(log.exitCode).toBe(0);
	});
});

describe("mid-operation: real git starts rebase → just-git aborts", () => {
	let sandbox: string;
	beforeAll(async () => {
		sandbox = await setupRebaseConflictRepo();
		await $`git -c user.name="R" -c user.email="r@t" rebase main`.cwd(sandbox).nothrow().quiet();
	});
	afterAll(() => removeSandbox(sandbox));

	test("just-git aborts the rebase started by real git", async () => {
		const b = justBash(sandbox);
		const r = await jg(b, "git rebase --abort");
		expect(r.exitCode).toBe(0);
	});

	test("real git sees clean state after just-git rebase --abort", async () => {
		const st = await realGit(sandbox, "status --porcelain");
		expect(st.stdout.trim()).toBe("");

		const fsck = await realGit(sandbox, "fsck --full");
		expect(fsck.exitCode).toBe(0);
	});
});

describe("mid-operation: just-git starts rebase → real git aborts", () => {
	let sandbox: string;
	beforeAll(async () => {
		sandbox = await setupRebaseConflictRepo();
		const b = justBash(sandbox);
		await jg(b, "git rebase main");
	});
	afterAll(() => removeSandbox(sandbox));

	test("real git aborts the rebase started by just-git", async () => {
		const r = await $`git -c user.name="R" -c user.email="r@t" rebase --abort`
			.cwd(sandbox)
			.nothrow()
			.quiet();
		expect(r.exitCode).toBe(0);
	});

	test("just-git sees clean state after real git rebase --abort", async () => {
		const b = justBash(sandbox);
		const st = await jg(b, "git status --porcelain");
		expect(st.stdout.trim()).toBe("");
	});
});

// ── Cherry-pick handoff ─────────────────────────────────────────────

describe("mid-operation: real git starts cherry-pick → just-git finishes", () => {
	let sandbox: string;
	let cherryHash: string;
	beforeAll(async () => {
		sandbox = await setupConflictRepo();
		cherryHash = (await $`git rev-parse theirs`.cwd(sandbox).quiet()).stdout.toString().trim();
		const r = await $`git -c user.name="R" -c user.email="r@t" cherry-pick ${cherryHash}`
			.cwd(sandbox)
			.nothrow()
			.quiet();
		expect(r.exitCode).not.toBe(0);
	});
	afterAll(() => removeSandbox(sandbox));

	test("just-git sees cherry-pick in progress", async () => {
		const b = justBash(sandbox);
		const r = await jg(b, "git status");
		expect(r.exitCode).toBe(0);
		expect(r.stdout.toLowerCase()).toContain("cherry");
	});

	test("just-git resolves and continues the cherry-pick", async () => {
		const b = justBash(sandbox);
		await jg(b, 'echo "resolved" > conflict.txt');
		await jg(b, "git add conflict.txt");
		const r = await jg(b, "git cherry-pick --continue");
		expect(r.exitCode).toBe(0);
	});

	test("real git sees clean state after just-git cherry-pick --continue", async () => {
		const st = await realGit(sandbox, "status --porcelain");
		expect(st.stdout.trim()).toBe("");

		const fsck = await realGit(sandbox, "fsck --full");
		expect(fsck.exitCode).toBe(0);
	});
});

describe("mid-operation: just-git starts cherry-pick → real git finishes", () => {
	let sandbox: string;
	let cherryHash: string;
	beforeAll(async () => {
		sandbox = await setupConflictRepo();
		cherryHash = (await $`git rev-parse theirs`.cwd(sandbox).quiet()).stdout.toString().trim();
		const b = justBash(sandbox);
		const r = await jg(b, `git cherry-pick ${cherryHash}`);
		expect(r.exitCode).not.toBe(0);
	});
	afterAll(() => removeSandbox(sandbox));

	test("real git sees cherry-pick in progress", async () => {
		const st = await realGit(sandbox, "status");
		expect(st.exitCode).toBe(0);
		expect(st.stdout.toLowerCase()).toContain("cherry");
	});

	test("real git resolves and continues the cherry-pick", async () => {
		writeToSandbox(sandbox, "conflict.txt", "resolved by real git\n");
		await $`git -c user.name="R" -c user.email="r@t" add conflict.txt`.cwd(sandbox).quiet();
		const r =
			await $`GIT_EDITOR=true git -c user.name="R" -c user.email="r@t" cherry-pick --continue`
				.cwd(sandbox)
				.nothrow()
				.quiet();
		expect(r.exitCode).toBe(0);
	});

	test("just-git sees clean state after real git cherry-pick --continue", async () => {
		const b = justBash(sandbox);
		const st = await jg(b, "git status --porcelain");
		expect(st.stdout.trim()).toBe("");

		const log = await jg(b, "git log --oneline");
		expect(log.exitCode).toBe(0);
	});
});

describe("mid-operation: real git starts cherry-pick → just-git aborts", () => {
	let sandbox: string;
	beforeAll(async () => {
		sandbox = await setupConflictRepo();
		const cherryHash = (await $`git rev-parse theirs`.cwd(sandbox).quiet()).stdout
			.toString()
			.trim();
		await $`git -c user.name="R" -c user.email="r@t" cherry-pick ${cherryHash}`
			.cwd(sandbox)
			.nothrow()
			.quiet();
	});
	afterAll(() => removeSandbox(sandbox));

	test("just-git aborts the cherry-pick started by real git", async () => {
		const b = justBash(sandbox);
		const r = await jg(b, "git cherry-pick --abort");
		expect(r.exitCode).toBe(0);
	});

	test("real git sees clean state after just-git cherry-pick --abort", async () => {
		const st = await realGit(sandbox, "status --porcelain");
		expect(st.stdout.trim()).toBe("");

		const fsck = await realGit(sandbox, "fsck --full");
		expect(fsck.exitCode).toBe(0);
	});
});

describe("mid-operation: just-git starts cherry-pick → real git aborts", () => {
	let sandbox: string;
	beforeAll(async () => {
		sandbox = await setupConflictRepo();
		const cherryHash = (await $`git rev-parse theirs`.cwd(sandbox).quiet()).stdout
			.toString()
			.trim();
		const b = justBash(sandbox);
		await jg(b, `git cherry-pick ${cherryHash}`);
	});
	afterAll(() => removeSandbox(sandbox));

	test("real git aborts the cherry-pick started by just-git", async () => {
		const r = await $`git -c user.name="R" -c user.email="r@t" cherry-pick --abort`
			.cwd(sandbox)
			.nothrow()
			.quiet();
		expect(r.exitCode).toBe(0);
	});

	test("just-git sees clean state after real git cherry-pick --abort", async () => {
		const b = justBash(sandbox);
		const st = await jg(b, "git status --porcelain");
		expect(st.stdout.trim()).toBe("");
	});
});

// ── Revert handoff ──────────────────────────────────────────────────

describe("mid-operation: real git starts revert → just-git finishes", () => {
	let sandbox: string;
	beforeAll(async () => {
		sandbox = createSandbox();
		await $`git -c init.defaultBranch=main init`.cwd(sandbox).quiet();
		writeToSandbox(sandbox, "f.txt", "original\n");
		await $`git -c user.name="R" -c user.email="r@t" add .`.cwd(sandbox).quiet();
		await $`git -c user.name="R" -c user.email="r@t" commit -m "original"`.cwd(sandbox).quiet();

		writeToSandbox(sandbox, "f.txt", "changed A\n");
		await $`git -c user.name="R" -c user.email="r@t" add .`.cwd(sandbox).quiet();
		await $`git -c user.name="R" -c user.email="r@t" commit -m "change A"`.cwd(sandbox).quiet();

		writeToSandbox(sandbox, "f.txt", "changed B on top of A\n");
		await $`git -c user.name="R" -c user.email="r@t" add .`.cwd(sandbox).quiet();
		await $`git -c user.name="R" -c user.email="r@t" commit -m "change B"`.cwd(sandbox).quiet();

		const changeA = (await $`git rev-parse HEAD~1`.cwd(sandbox).quiet()).stdout.toString().trim();
		const r = await $`git -c user.name="R" -c user.email="r@t" revert ${changeA}`
			.cwd(sandbox)
			.nothrow()
			.quiet();
		expect(r.exitCode).not.toBe(0);
	});
	afterAll(() => removeSandbox(sandbox));

	test("just-git sees revert in progress", async () => {
		const b = justBash(sandbox);
		const r = await jg(b, "git status");
		expect(r.exitCode).toBe(0);
		expect(r.stdout.toLowerCase()).toContain("revert");
	});

	test("just-git resolves and continues the revert", async () => {
		const b = justBash(sandbox);
		await jg(b, 'echo "resolved revert" > f.txt');
		await jg(b, "git add f.txt");
		const r = await jg(b, "git revert --continue");
		expect(r.exitCode).toBe(0);
	});

	test("real git sees clean state after just-git revert --continue", async () => {
		const st = await realGit(sandbox, "status --porcelain");
		expect(st.stdout.trim()).toBe("");

		const fsck = await realGit(sandbox, "fsck --full");
		expect(fsck.exitCode).toBe(0);
	});
});

describe("mid-operation: just-git starts revert → real git finishes", () => {
	let sandbox: string;
	beforeAll(async () => {
		sandbox = createSandbox();
		await $`git -c init.defaultBranch=main init`.cwd(sandbox).quiet();
		writeToSandbox(sandbox, "f.txt", "original\n");
		await $`git -c user.name="R" -c user.email="r@t" add .`.cwd(sandbox).quiet();
		await $`git -c user.name="R" -c user.email="r@t" commit -m "original"`.cwd(sandbox).quiet();

		writeToSandbox(sandbox, "f.txt", "changed A\n");
		await $`git -c user.name="R" -c user.email="r@t" add .`.cwd(sandbox).quiet();
		await $`git -c user.name="R" -c user.email="r@t" commit -m "change A"`.cwd(sandbox).quiet();

		writeToSandbox(sandbox, "f.txt", "changed B on top of A\n");
		await $`git -c user.name="R" -c user.email="r@t" add .`.cwd(sandbox).quiet();
		await $`git -c user.name="R" -c user.email="r@t" commit -m "change B"`.cwd(sandbox).quiet();

		const b = justBash(sandbox);
		const changeA = await jg(b, "git rev-parse HEAD~1");
		const r = await jg(b, `git revert ${changeA.stdout.trim()}`);
		expect(r.exitCode).not.toBe(0);
	});
	afterAll(() => removeSandbox(sandbox));

	test("real git sees revert in progress", async () => {
		const st = await realGit(sandbox, "status");
		expect(st.exitCode).toBe(0);
		expect(st.stdout.toLowerCase()).toContain("revert");
	});

	test("real git resolves and continues the revert", async () => {
		writeToSandbox(sandbox, "f.txt", "resolved by real git\n");
		await $`git -c user.name="R" -c user.email="r@t" add f.txt`.cwd(sandbox).quiet();
		const r = await $`GIT_EDITOR=true git -c user.name="R" -c user.email="r@t" revert --continue`
			.cwd(sandbox)
			.nothrow()
			.quiet();
		expect(r.exitCode).toBe(0);
	});

	test("just-git sees clean state after real git revert --continue", async () => {
		const b = justBash(sandbox);
		const st = await jg(b, "git status --porcelain");
		expect(st.stdout.trim()).toBe("");

		const log = await jg(b, "git log --oneline");
		expect(log.exitCode).toBe(0);
	});
});
