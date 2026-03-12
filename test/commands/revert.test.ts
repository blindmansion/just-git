import { describe, expect, test } from "bun:test";
import { readCommit } from "../../src/lib/object-db";
import { resolveHead, resolveRef } from "../../src/lib/refs";
import { findGitDir } from "../../src/lib/repo";
import { EMPTY_REPO, TEST_ENV_NAMED as TEST_ENV, envAt } from "../fixtures";
import { createTestBash, pathExists, readFile } from "../util";

describe("git revert", () => {
	// ── Error cases ──────────────────────────────────────────────────

	describe("error cases", () => {
		test("outside a git repo", async () => {
			const bash = createTestBash({ files: EMPTY_REPO });
			const result = await bash.exec("git revert abc123");
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("not a git repository");
		});

		test("no argument", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			const result = await bash.exec("git revert");
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("you must specify a commit");
		});

		test("invalid commit ref", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			const result = await bash.exec("git revert nonexistent");
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("bad revision");
		});

		test("no commits yet", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			const result = await bash.exec("git revert some-ref");
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("bad revision");
		});

		test("merge commit without -m", async () => {
			const bash = createTestBash({
				files: EMPTY_REPO,
				env: envAt("100"),
			});
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.exec("git branch feature");
			await bash.fs.writeFile("/repo/a.txt", "main");
			await bash.exec("git add a.txt");
			await bash.exec('git commit -m "main commit"');

			await bash.exec("git checkout feature");
			await bash.fs.writeFile("/repo/b.txt", "feature");
			await bash.exec("git add b.txt");
			await bash.exec('git commit -m "feature commit"');

			await bash.exec("git checkout main");
			await bash.exec("git merge feature");

			const result = await bash.exec("git revert HEAD");
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("merge but no -m option");
		});
	});

	// ── Basic clean revert ─────────────────────────────────────────

	describe("clean revert", () => {
		test("reverts the most recent commit", async () => {
			const bash = createTestBash({
				files: EMPTY_REPO,
				env: envAt("100"),
			});
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.fs.writeFile("/repo/new.txt", "new content");
			await bash.exec("git add new.txt");
			await bash.exec('git commit -m "add new file"');

			const result = await bash.exec("git revert HEAD");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain('Revert "add new file"');

			// The new file should be deleted
			expect(await pathExists(bash.fs, "/repo/new.txt")).toBe(false);
		});

		test("reverts a non-HEAD commit", async () => {
			const bash = createTestBash({
				files: EMPTY_REPO,
				env: envAt("100"),
			});
			await bash.exec("git init");
			await bash.fs.writeFile("/repo/file.txt", "line1\n");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.fs.writeFile("/repo/extra.txt", "extra");
			await bash.exec("git add extra.txt");
			await bash.exec('git commit -m "add extra"');

			const gitCtx = await findGitDir(bash.fs, "/repo");
			const secondHash = await resolveHead(gitCtx!);

			await bash.fs.writeFile("/repo/another.txt", "another");
			await bash.exec("git add another.txt");
			await bash.exec('git commit -m "add another"');

			const result = await bash.exec(`git revert ${secondHash}`);
			expect(result.exitCode).toBe(0);

			// extra.txt should be removed (reverting "add extra")
			expect(await pathExists(bash.fs, "/repo/extra.txt")).toBe(false);
			// another.txt should still exist
			expect(await pathExists(bash.fs, "/repo/another.txt")).toBe(true);
		});

		test("commit message format", async () => {
			const bash = createTestBash({
				files: EMPTY_REPO,
				env: envAt("100"),
			});
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.fs.writeFile("/repo/new.txt", "content");
			await bash.exec("git add new.txt");
			await bash.exec('git commit -m "add new file"');

			const gitCtx = await findGitDir(bash.fs, "/repo");
			const commitHash = await resolveHead(gitCtx!);

			await bash.exec("git revert HEAD");

			const newHead = await resolveHead(gitCtx!);
			const commit = await readCommit(gitCtx!, newHead!);
			expect(commit.message).toContain('Revert "add new file"');
			expect(commit.message).toContain(`This reverts commit ${commitHash}`);
		});

		test("uses current committer as author (not original)", async () => {
			const bash = createTestBash({
				files: EMPTY_REPO,
				env: {
					GIT_AUTHOR_NAME: "Original Author",
					GIT_AUTHOR_EMAIL: "original@test.com",
					GIT_COMMITTER_NAME: "Current Committer",
					GIT_COMMITTER_EMAIL: "current@test.com",
					GIT_AUTHOR_DATE: "100",
					GIT_COMMITTER_DATE: "100",
				},
			});
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.fs.writeFile("/repo/new.txt", "content");
			await bash.exec("git add new.txt");
			await bash.exec('git commit -m "add new file"');

			await bash.exec("git revert HEAD");

			const gitCtx = await findGitDir(bash.fs, "/repo");
			const newHead = await resolveHead(gitCtx!);
			const commit = await readCommit(gitCtx!, newHead!);
			// Author should be from env (current identity), not preserved from original
			expect(commit.author.name).toBe("Original Author");
			expect(commit.author.email).toBe("original@test.com");
		});

		test("creates single-parent commit", async () => {
			const bash = createTestBash({
				files: EMPTY_REPO,
				env: envAt("100"),
			});
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.fs.writeFile("/repo/new.txt", "content");
			await bash.exec("git add new.txt");
			await bash.exec('git commit -m "add file"');

			const gitCtx = await findGitDir(bash.fs, "/repo");
			const preRevertHead = await resolveHead(gitCtx!);

			await bash.exec("git revert HEAD");

			const newHead = await resolveHead(gitCtx!);
			const commit = await readCommit(gitCtx!, newHead!);
			expect(commit.parents).toHaveLength(1);
			expect(commit.parents[0]).toBe(preRevertHead!);
		});
	});

	// ── Root commit revert ─────────────────────────────────────────

	describe("root commit revert", () => {
		test("reverts initial commit (empty parent tree)", async () => {
			const bash = createTestBash({
				files: EMPTY_REPO,
				env: envAt("100"),
			});
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "root"');

			const result = await bash.exec("git revert HEAD");
			expect(result.exitCode).toBe(0);

			// README.md (from EMPTY_REPO) should be deleted
			expect(await pathExists(bash.fs, "/repo/README.md")).toBe(false);
		});
	});

	// ── Merge commit revert with -m ─────────────────────────────────

	describe("merge commit revert", () => {
		test("-m 1 reverts using first parent", async () => {
			const bash = createTestBash({
				files: EMPTY_REPO,
				env: envAt("100"),
			});
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			// Create divergent history
			await bash.exec("git checkout -b feature");
			await bash.fs.writeFile("/repo/feature.txt", "feature content");
			await bash.exec("git add feature.txt");
			await bash.exec('git commit -m "feature change"');

			await bash.exec("git checkout main");
			await bash.fs.writeFile("/repo/main.txt", "main content");
			await bash.exec("git add main.txt");
			await bash.exec('git commit -m "main change"');

			await bash.exec("git merge feature");

			// feature.txt should exist after merge
			expect(await pathExists(bash.fs, "/repo/feature.txt")).toBe(true);

			// Revert the merge, keeping parent 1 (main side)
			const result = await bash.exec("git revert HEAD -m 1");
			expect(result.exitCode).toBe(0);

			// feature.txt should be removed (feature side undone)
			expect(await pathExists(bash.fs, "/repo/feature.txt")).toBe(false);
			// main.txt should still exist (main side preserved)
			expect(await pathExists(bash.fs, "/repo/main.txt")).toBe(true);
		});

		test("commit message for merge revert includes reversing info", async () => {
			const bash = createTestBash({
				files: EMPTY_REPO,
				env: envAt("100"),
			});
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			// Create divergent history
			await bash.exec("git checkout -b feature");
			await bash.fs.writeFile("/repo/feature.txt", "content");
			await bash.exec("git add feature.txt");
			await bash.exec('git commit -m "feature"');

			await bash.exec("git checkout main");
			await bash.fs.writeFile("/repo/main.txt", "content");
			await bash.exec("git add main.txt");
			await bash.exec('git commit -m "main"');

			await bash.exec("git merge feature");

			await bash.exec("git revert HEAD -m 1");

			const gitCtx = await findGitDir(bash.fs, "/repo");
			const newHead = await resolveHead(gitCtx!);
			const commit = await readCommit(gitCtx!, newHead!);
			expect(commit.message).toContain("reversing");
			expect(commit.message).toContain("changes made to");
		});
	});

	// ── Conflicts ───────────────────────────────────────────────────

	describe("conflicts", () => {
		test("content conflict writes markers and REVERT_HEAD", async () => {
			const bash = createTestBash({
				files: EMPTY_REPO,
				env: envAt("100"),
			});
			await bash.exec("git init");
			await bash.fs.writeFile("/repo/file.txt", "base");
			await bash.exec("git add .");
			await bash.exec('git commit -m "base"');

			await bash.fs.writeFile("/repo/file.txt", "change1");
			await bash.exec("git add file.txt");
			await bash.exec('git commit -m "change1"');

			const gitCtx = await findGitDir(bash.fs, "/repo");
			const change1Hash = await resolveHead(gitCtx!);

			await bash.fs.writeFile("/repo/file.txt", "change2");
			await bash.exec("git add file.txt");
			await bash.exec('git commit -m "change2"');

			// Revert change1 — should conflict because change2 modified the same area
			const result = await bash.exec(`git revert ${change1Hash}`);
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("could not revert");

			// REVERT_HEAD should be written
			const revertHead = await resolveRef(gitCtx!, "REVERT_HEAD");
			expect(revertHead).toBe(change1Hash);

			// MERGE_MSG should be written
			expect(await pathExists(bash.fs, "/repo/.git/MERGE_MSG")).toBe(true);

			// Working tree should have conflict markers
			const content = await readFile(bash.fs, "/repo/file.txt");
			expect(content).toContain("<<<<<<< HEAD");
			expect(content).toContain("=======");
			expect(content).toContain(">>>>>>>");
		});

		test("conflict resolution via revert --continue", async () => {
			const bash = createTestBash({
				files: EMPTY_REPO,
				env: envAt("100"),
			});
			await bash.exec("git init");
			await bash.fs.writeFile("/repo/file.txt", "base");
			await bash.exec("git add .");
			await bash.exec('git commit -m "base"');

			await bash.fs.writeFile("/repo/file.txt", "change1");
			await bash.exec("git add file.txt");
			await bash.exec('git commit -m "change1"');

			const gitCtx = await findGitDir(bash.fs, "/repo");
			const change1Hash = await resolveHead(gitCtx!);

			await bash.fs.writeFile("/repo/file.txt", "change2");
			await bash.exec("git add file.txt");
			await bash.exec('git commit -m "change2"');

			// Revert → conflict
			await bash.exec(`git revert ${change1Hash}`);

			// Resolve conflict
			await bash.fs.writeFile("/repo/file.txt", "resolved");
			await bash.exec("git add file.txt");

			// Continue
			const continueResult = await bash.exec("git revert --continue");
			expect(continueResult.exitCode).toBe(0);
			expect(continueResult.stdout).toContain('Revert "change1"');

			// State should be cleaned up
			const revertHead = await resolveRef(gitCtx!, "REVERT_HEAD");
			expect(revertHead).toBeNull();
			expect(await pathExists(bash.fs, "/repo/.git/MERGE_MSG")).toBe(false);
		});

		test("conflict resolution via git commit", async () => {
			const bash = createTestBash({
				files: EMPTY_REPO,
				env: envAt("100"),
			});
			await bash.exec("git init");
			await bash.fs.writeFile("/repo/file.txt", "base");
			await bash.exec("git add .");
			await bash.exec('git commit -m "base"');

			await bash.fs.writeFile("/repo/file.txt", "change1");
			await bash.exec("git add file.txt");
			await bash.exec('git commit -m "change1"');

			const gitCtx = await findGitDir(bash.fs, "/repo");
			const change1Hash = await resolveHead(gitCtx!);

			await bash.fs.writeFile("/repo/file.txt", "change2");
			await bash.exec("git add file.txt");
			await bash.exec('git commit -m "change2"');

			await bash.exec(`git revert ${change1Hash}`);

			// Resolve and commit directly
			await bash.fs.writeFile("/repo/file.txt", "resolved");
			await bash.exec("git add file.txt");

			const commitResult = await bash.exec("git commit");
			expect(commitResult.exitCode).toBe(0);
			expect(commitResult.stdout).toContain('Revert "change1"');

			// REVERT_HEAD should be cleaned up
			const revertHead = await resolveRef(gitCtx!, "REVERT_HEAD");
			expect(revertHead).toBeNull();
			expect(await pathExists(bash.fs, "/repo/.git/MERGE_MSG")).toBe(false);
		});

		test("--continue fails with unresolved conflicts", async () => {
			const bash = createTestBash({
				files: EMPTY_REPO,
				env: envAt("100"),
			});
			await bash.exec("git init");
			await bash.fs.writeFile("/repo/file.txt", "base");
			await bash.exec("git add .");
			await bash.exec('git commit -m "base"');

			await bash.fs.writeFile("/repo/file.txt", "change1");
			await bash.exec("git add file.txt");
			await bash.exec('git commit -m "change1"');

			const gitCtx = await findGitDir(bash.fs, "/repo");
			const change1Hash = await resolveHead(gitCtx!);

			await bash.fs.writeFile("/repo/file.txt", "change2");
			await bash.exec("git add file.txt");
			await bash.exec('git commit -m "change2"');

			await bash.exec(`git revert ${change1Hash}`);

			// Try --continue without resolving
			const result = await bash.exec("git revert --continue");
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("unmerged files");
		});
	});

	// ── --abort ──────────────────────────────────────────────────────

	describe("--abort", () => {
		test("restores HEAD, index and working tree", async () => {
			const bash = createTestBash({
				files: EMPTY_REPO,
				env: envAt("100"),
			});
			await bash.exec("git init");
			await bash.fs.writeFile("/repo/file.txt", "base");
			await bash.exec("git add .");
			await bash.exec('git commit -m "base"');

			await bash.fs.writeFile("/repo/file.txt", "change1");
			await bash.exec("git add file.txt");
			await bash.exec('git commit -m "change1"');

			const gitCtx = await findGitDir(bash.fs, "/repo");
			const change1Hash = await resolveHead(gitCtx!);

			await bash.fs.writeFile("/repo/file.txt", "change2");
			await bash.exec("git add file.txt");
			await bash.exec('git commit -m "change2"');

			const preRevertHead = await resolveHead(gitCtx!);

			// Revert → conflict
			await bash.exec(`git revert ${change1Hash}`);

			// Abort
			const abortResult = await bash.exec("git revert --abort");
			expect(abortResult.exitCode).toBe(0);

			// HEAD should be back where it was
			const postAbortHead = await resolveHead(gitCtx!);
			expect(postAbortHead).toBe(preRevertHead);

			// Working tree should be restored
			const content = await readFile(bash.fs, "/repo/file.txt");
			expect(content).toBe("change2");

			// State files should be cleaned up
			const revertHead = await resolveRef(gitCtx!, "REVERT_HEAD");
			expect(revertHead).toBeNull();
			expect(await pathExists(bash.fs, "/repo/.git/MERGE_MSG")).toBe(false);
		});

		test("--abort with no revert in progress", async () => {
			const bash = createTestBash({
				files: EMPTY_REPO,
				env: TEST_ENV,
			});
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			const result = await bash.exec("git revert --abort");
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("no cherry-pick or revert in progress");
		});
	});

	// ── --no-commit ──────────────────────────────────────────────────

	describe("--no-commit", () => {
		test("stages changes without committing", async () => {
			const bash = createTestBash({
				files: EMPTY_REPO,
				env: envAt("100"),
			});
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.fs.writeFile("/repo/new.txt", "content");
			await bash.exec("git add new.txt");
			await bash.exec('git commit -m "add new file"');

			const gitCtx = await findGitDir(bash.fs, "/repo");
			const commitHash = await resolveHead(gitCtx!);

			const result = await bash.exec("git revert HEAD --no-commit");
			expect(result.exitCode).toBe(0);

			// The file should be deleted in worktree
			expect(await pathExists(bash.fs, "/repo/new.txt")).toBe(false);

			// REVERT_HEAD should be written
			const revertHead = await resolveRef(gitCtx!, "REVERT_HEAD");
			expect(revertHead).toBe(commitHash);

			// MERGE_MSG should be written
			expect(await pathExists(bash.fs, "/repo/.git/MERGE_MSG")).toBe(true);

			// HEAD should not have changed (no new commit)
			const currentHead = await resolveHead(gitCtx!);
			expect(currentHead).toBe(commitHash);
		});

		test("-n is alias for --no-commit", async () => {
			const bash = createTestBash({
				files: EMPTY_REPO,
				env: envAt("100"),
			});
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.fs.writeFile("/repo/new.txt", "content");
			await bash.exec("git add new.txt");
			await bash.exec('git commit -m "add new file"');

			const result = await bash.exec("git revert HEAD -n");
			expect(result.exitCode).toBe(0);

			expect(await pathExists(bash.fs, "/repo/new.txt")).toBe(false);
		});
	});

	// ── Dirty worktree ──────────────────────────────────────────────

	describe("dirty worktree", () => {
		test("refuses revert with staged changes", async () => {
			const bash = createTestBash({
				files: EMPTY_REPO,
				env: envAt("100"),
			});
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.fs.writeFile("/repo/new.txt", "content");
			await bash.exec("git add new.txt");
			await bash.exec('git commit -m "add new file"');

			// Stage a change
			await bash.fs.writeFile("/repo/README.md", "modified");
			await bash.exec("git add README.md");

			const result = await bash.exec("git revert HEAD");
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("would be overwritten by revert");
		});
	});

	// ── --continue edge cases ───────────────────────────────────────

	describe("--continue edge cases", () => {
		test("--continue with no revert in progress", async () => {
			const bash = createTestBash({
				files: EMPTY_REPO,
				env: TEST_ENV,
			});
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			const result = await bash.exec("git revert --continue");
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("no cherry-pick or revert in progress");
		});
	});

	// ── Status display ──────────────────────────────────────────────

	describe("status during revert", () => {
		test("shows revert in progress message", async () => {
			const bash = createTestBash({
				files: EMPTY_REPO,
				env: envAt("100"),
			});
			await bash.exec("git init");
			await bash.fs.writeFile("/repo/file.txt", "base");
			await bash.exec("git add .");
			await bash.exec('git commit -m "base"');

			await bash.fs.writeFile("/repo/file.txt", "change1");
			await bash.exec("git add file.txt");
			await bash.exec('git commit -m "change1"');

			const gitCtx = await findGitDir(bash.fs, "/repo");
			const change1Hash = await resolveHead(gitCtx!);

			await bash.fs.writeFile("/repo/file.txt", "change2");
			await bash.exec("git add file.txt");
			await bash.exec('git commit -m "change2"');

			await bash.exec(`git revert ${change1Hash}`);

			const status = await bash.exec("git status");
			expect(status.stdout).toContain("currently reverting commit");
			expect(status.stdout).toContain("git revert --continue");
		});
	});

	// ── Commit --amend during revert ────────────────────────────────

	describe("blocking", () => {
		test("--amend is allowed during revert (unlike cherry-pick)", async () => {
			const bash = createTestBash({
				files: EMPTY_REPO,
				env: envAt("100"),
			});
			await bash.exec("git init");
			await bash.fs.writeFile("/repo/file.txt", "base");
			await bash.exec("git add .");
			await bash.exec('git commit -m "base"');

			await bash.fs.writeFile("/repo/file.txt", "change1");
			await bash.exec("git add file.txt");
			await bash.exec('git commit -m "change1"');

			const gitCtx = await findGitDir(bash.fs, "/repo");
			const change1Hash = await resolveHead(gitCtx!);

			await bash.fs.writeFile("/repo/file.txt", "change2");
			await bash.exec("git add file.txt");
			await bash.exec('git commit -m "change2"');

			await bash.exec(`git revert ${change1Hash}`);

			// Resolve conflict
			await bash.fs.writeFile("/repo/file.txt", "resolved");
			await bash.exec("git add file.txt");

			const result = await bash.exec('git commit --amend -m "amended"');
			expect(result.exitCode).toBe(0);
		});

		test("--amend blocked during revert with unmerged files", async () => {
			const bash = createTestBash({
				files: EMPTY_REPO,
				env: envAt("100"),
			});
			await bash.exec("git init");
			await bash.fs.writeFile("/repo/file.txt", "base");
			await bash.exec("git add .");
			await bash.exec('git commit -m "base"');

			await bash.fs.writeFile("/repo/file.txt", "change1");
			await bash.exec("git add file.txt");
			await bash.exec('git commit -m "change1"');

			const gitCtx = await findGitDir(bash.fs, "/repo");
			const change1Hash = await resolveHead(gitCtx!);

			await bash.fs.writeFile("/repo/file.txt", "change2");
			await bash.exec("git add file.txt");
			await bash.exec('git commit -m "change2"');

			await bash.exec(`git revert ${change1Hash}`);

			const result = await bash.exec('git commit --amend -m "bad amend"');
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("unmerged files");
		});
	});
});
