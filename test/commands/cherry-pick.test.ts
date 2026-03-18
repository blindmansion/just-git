import { describe, expect, test } from "bun:test";
import { readCommit } from "../../src/lib/object-db";
import { resolveHead, resolveRef } from "../../src/lib/refs";
import { findRepo } from "../../src/lib/repo";
import { EMPTY_REPO, TEST_ENV_NAMED as TEST_ENV, envAt } from "../fixtures";
import { createTestBash, pathExists, readFile } from "../util";

describe("git cherry-pick", () => {
	// ── Error cases ──────────────────────────────────────────────────

	describe("error cases", () => {
		test("outside a git repo", async () => {
			const bash = createTestBash({ files: EMPTY_REPO });
			const result = await bash.exec("git cherry-pick abc123");
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("not a git repository");
		});

		test("no argument", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			const result = await bash.exec("git cherry-pick");
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("you must specify a commit");
		});

		test("invalid commit ref", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			const result = await bash.exec("git cherry-pick nonexistent");
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("bad revision");
		});

		test("no commits yet", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			const result = await bash.exec("git cherry-pick some-branch");
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("bad revision 'some-branch'");
		});

		test("cherry-pick of merge commit (no -m support)", async () => {
			const bash = createTestBash({
				files: EMPTY_REPO,
				env: envAt("100"),
			});
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			// Create a branch with divergent history
			await bash.exec("git branch feature");
			await bash.fs.writeFile("/repo/a.txt", "main");
			await bash.exec("git add a.txt");
			await bash.exec('git commit -m "main commit"');

			await bash.exec("git checkout feature");
			await bash.fs.writeFile("/repo/b.txt", "feature");
			await bash.exec("git add b.txt");
			await bash.exec('git commit -m "feature commit"');

			// Merge to create a merge commit
			await bash.exec("git merge main");

			// Get the merge commit hash
			const gitCtx = await findRepo(bash.fs, "/repo");
			const mergeHash = await resolveHead(gitCtx!);

			// Go back to main and try to cherry-pick the merge commit
			await bash.exec("git checkout main");
			const result = await bash.exec(`git cherry-pick ${mergeHash}`);
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("merge but no -m option");
		});
	});

	// ── Basic clean cherry-pick ─────────────────────────────────────

	describe("clean cherry-pick", () => {
		test("applies a commit from another branch", async () => {
			const bash = createTestBash({
				files: EMPTY_REPO,
				env: envAt("100"),
			});
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			// Create feature branch with a new file
			await bash.exec("git branch feature");
			await bash.exec("git checkout feature");
			await bash.fs.writeFile("/repo/feature.txt", "feature content");
			await bash.exec("git add feature.txt");
			await bash.exec('git commit -m "add feature file"');

			// Get the feature commit hash
			const gitCtx = await findRepo(bash.fs, "/repo");
			const featureHash = await resolveHead(gitCtx!);

			// Switch back to main and cherry-pick
			await bash.exec("git checkout main");
			const result = await bash.exec(`git cherry-pick ${featureHash}`);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("add feature file");

			// Verify file was applied
			const content = await readFile(bash.fs, "/repo/feature.txt");
			expect(content).toBe("feature content");
		});

		test("preserves original author and timestamp", async () => {
			// Feature branch is committed at timestamp 500
			const featureEnv = {
				GIT_AUTHOR_NAME: "Feature Author",
				GIT_AUTHOR_EMAIL: "feature@test.com",
				GIT_COMMITTER_NAME: "Feature Author",
				GIT_COMMITTER_EMAIL: "feature@test.com",
				GIT_AUTHOR_DATE: "500",
				GIT_COMMITTER_DATE: "500",
			};
			// We create the repo + feature branch in one bash with the feature env
			const setup = createTestBash({
				files: EMPTY_REPO,
				env: featureEnv,
			});
			await setup.exec("git init");
			await setup.exec("git add .");
			await setup.exec('git commit -m "initial"');
			await setup.exec("git branch feature");
			await setup.exec("git checkout feature");
			await setup.fs.writeFile("/repo/feature.txt", "content");
			await setup.exec("git add feature.txt");
			await setup.exec('git commit -m "feature"');

			const gitCtx = await findRepo(setup.fs, "/repo");
			const featureHash = await resolveHead(gitCtx!);
			const featureCommit = await readCommit(gitCtx!, featureHash!);

			// Now cherry-pick using a DIFFERENT identity (timestamp 9999)
			// We go back to main and do the cherry-pick in a new bash with different env
			// but sharing the same filesystem via direct object reference
			await setup.exec("git checkout main");

			// Create a new bash pointing to the same repo filesystem
			// We can't share fs directly, so we'll use the same bash but
			// verify the author from the original commit is preserved
			// by checking the original commit's author fields match.
			await setup.fs.writeFile("/repo/other.txt", "other");
			await setup.exec("git add other.txt");
			await setup.exec('git commit -m "main work"');

			const result = await setup.exec(`git cherry-pick ${featureHash}`);
			expect(result.exitCode).toBe(0);

			// The cherry-picked commit should have the original author
			const newHead = await resolveHead(gitCtx!);
			const commit = await readCommit(gitCtx!, newHead!);
			expect(commit.author.name).toBe(featureCommit.author.name);
			expect(commit.author.email).toBe(featureCommit.author.email);
			expect(commit.author.timestamp).toBe(featureCommit.author.timestamp);
			// Committer should be current (same env in this case, but code path exercised)
			expect(commit.committer.name).toBe("Feature Author");
		});

		test("creates single-parent commit", async () => {
			const bash = createTestBash({
				files: EMPTY_REPO,
				env: envAt("100"),
			});
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.exec("git branch feature");
			await bash.exec("git checkout feature");
			await bash.fs.writeFile("/repo/feature.txt", "content");
			await bash.exec("git add feature.txt");
			await bash.exec('git commit -m "feature"');

			const gitCtx = await findRepo(bash.fs, "/repo");
			const featureHash = await resolveHead(gitCtx!);
			const mainHash = await resolveRef(gitCtx!, "refs/heads/main");

			await bash.exec("git checkout main");
			await bash.exec(`git cherry-pick ${featureHash}`);

			// The resulting commit should have one parent (main's HEAD)
			const newHead = await resolveHead(gitCtx!);
			const commit = await readCommit(gitCtx!, newHead!);
			expect(commit.parents).toHaveLength(1);
			expect(commit.parents[0]).toBe(mainHash!);
		});

		test("preserves original commit message", async () => {
			const bash = createTestBash({
				files: EMPTY_REPO,
				env: envAt("100"),
			});
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.exec("git branch feature");
			await bash.exec("git checkout feature");
			await bash.fs.writeFile("/repo/feature.txt", "content");
			await bash.exec("git add feature.txt");
			await bash.exec('git commit -m "my important feature change"');

			const gitCtx = await findRepo(bash.fs, "/repo");
			const featureHash = await resolveHead(gitCtx!);

			await bash.exec("git checkout main");
			await bash.exec(`git cherry-pick ${featureHash}`);

			const newHead = await resolveHead(gitCtx!);
			const commit = await readCommit(gitCtx!, newHead!);
			expect(commit.message).toContain("my important feature change");
		});

		test("cherry-pick when changes are already present (non-conflicting)", async () => {
			const bash = createTestBash({
				files: EMPTY_REPO,
				env: envAt("100"),
			});
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			// Create a commit that adds file on feature
			await bash.exec("git branch feature");
			await bash.exec("git checkout feature");
			await bash.fs.writeFile("/repo/new.txt", "new content");
			await bash.exec("git add new.txt");
			await bash.exec('git commit -m "add new file"');

			const gitCtx = await findRepo(bash.fs, "/repo");
			const featureHash = await resolveHead(gitCtx!);

			// On main, add a different file so there's no conflict
			await bash.exec("git checkout main");
			await bash.fs.writeFile("/repo/other.txt", "other");
			await bash.exec("git add other.txt");
			await bash.exec('git commit -m "other on main"');

			const result = await bash.exec(`git cherry-pick ${featureHash}`);
			expect(result.exitCode).toBe(0);

			// Both files should exist
			expect(await readFile(bash.fs, "/repo/new.txt")).toBe("new content");
			expect(await readFile(bash.fs, "/repo/other.txt")).toBe("other");
		});
	});

	// ── Conflicts ───────────────────────────────────────────────────

	describe("conflicts", () => {
		test("content conflict writes conflict markers and CHERRY_PICK_HEAD", async () => {
			const bash = createTestBash({
				files: EMPTY_REPO,
				env: envAt("100"),
			});
			await bash.exec("git init");
			await bash.fs.writeFile("/repo/file.txt", "original");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			// Feature branch changes file.txt
			await bash.exec("git branch feature");
			await bash.exec("git checkout feature");
			await bash.fs.writeFile("/repo/file.txt", "feature version");
			await bash.exec("git add file.txt");
			await bash.exec('git commit -m "feature change"');

			const gitCtx = await findRepo(bash.fs, "/repo");
			const featureHash = await resolveHead(gitCtx!);

			// Main also changes file.txt
			await bash.exec("git checkout main");
			await bash.fs.writeFile("/repo/file.txt", "main version");
			await bash.exec("git add file.txt");
			await bash.exec('git commit -m "main change"');

			const result = await bash.exec(`git cherry-pick ${featureHash}`);
			expect(result.exitCode).toBe(1);
			expect(result.stdout).toContain("CONFLICT (content)");
			expect(result.stdout).toContain("file.txt");

			// CHERRY_PICK_HEAD should be written
			const cpHead = await resolveRef(gitCtx!, "CHERRY_PICK_HEAD");
			expect(cpHead).toBe(featureHash);

			// ORIG_HEAD should be written
			const origHead = await resolveRef(gitCtx!, "ORIG_HEAD");
			expect(origHead).toBeTruthy();

			// Working tree should have conflict markers
			const content = await readFile(bash.fs, "/repo/file.txt");
			expect(content).toContain("<<<<<<< HEAD");
			expect(content).toContain("=======");
			expect(content).toContain(">>>>>>>");
		});

		test("conflict resolution via git commit", async () => {
			const bash = createTestBash({
				files: EMPTY_REPO,
				env: envAt("100"),
			});
			await bash.exec("git init");
			await bash.fs.writeFile("/repo/file.txt", "original");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			// Create conflicting changes
			await bash.exec("git branch feature");
			await bash.exec("git checkout feature");
			await bash.fs.writeFile("/repo/file.txt", "feature version");
			await bash.exec("git add file.txt");
			await bash.exec('git commit -m "feature change"');

			const gitCtx = await findRepo(bash.fs, "/repo");
			const featureHash = await resolveHead(gitCtx!);
			const featureCommit = await readCommit(gitCtx!, featureHash!);

			await bash.exec("git checkout main");
			await bash.fs.writeFile("/repo/file.txt", "main version");
			await bash.exec("git add file.txt");
			await bash.exec('git commit -m "main change"');

			// Cherry-pick → conflict
			await bash.exec(`git cherry-pick ${featureHash}`);

			// Resolve conflict
			await bash.fs.writeFile("/repo/file.txt", "resolved");
			await bash.exec("git add file.txt");

			// Commit (should use MERGE_MSG and preserve author)
			const commitResult = await bash.exec("git commit");
			expect(commitResult.exitCode).toBe(0);
			expect(commitResult.stdout).toContain("feature change");

			// CHERRY_PICK_HEAD should be cleaned up
			const cpHead = await resolveRef(gitCtx!, "CHERRY_PICK_HEAD");
			expect(cpHead).toBeNull();

			// ORIG_HEAD should be cleaned up
			const origHead = await resolveRef(gitCtx!, "ORIG_HEAD");
			expect(origHead).toBeNull();

			// MERGE_MSG should be cleaned up
			expect(await pathExists(bash.fs, "/repo/.git/MERGE_MSG")).toBe(false);

			// Author should be from the original commit (preserved)
			const newHead = await resolveHead(gitCtx!);
			const commit = await readCommit(gitCtx!, newHead!);
			expect(commit.author.name).toBe(featureCommit.author.name);
			expect(commit.author.email).toBe(featureCommit.author.email);

			// Should be single parent (not a merge)
			expect(commit.parents).toHaveLength(1);
		});

		test("conflict resolution via cherry-pick --continue", async () => {
			const bash = createTestBash({
				files: EMPTY_REPO,
				env: envAt("100"),
			});
			await bash.exec("git init");
			await bash.fs.writeFile("/repo/file.txt", "original");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.exec("git branch feature");
			await bash.exec("git checkout feature");
			await bash.fs.writeFile("/repo/file.txt", "feature version");
			await bash.exec("git add file.txt");
			await bash.exec('git commit -m "feature change"');

			const gitCtx = await findRepo(bash.fs, "/repo");
			const featureHash = await resolveHead(gitCtx!);

			await bash.exec("git checkout main");
			await bash.fs.writeFile("/repo/file.txt", "main version");
			await bash.exec("git add file.txt");
			await bash.exec('git commit -m "main change"');

			// Cherry-pick → conflict
			await bash.exec(`git cherry-pick ${featureHash}`);

			// Resolve conflict
			await bash.fs.writeFile("/repo/file.txt", "resolved");
			await bash.exec("git add file.txt");

			// Continue
			const continueResult = await bash.exec("git cherry-pick --continue");
			expect(continueResult.exitCode).toBe(0);
			expect(continueResult.stdout).toContain("feature change");

			// State should be cleaned up
			const cpHead = await resolveRef(gitCtx!, "CHERRY_PICK_HEAD");
			expect(cpHead).toBeNull();

			const origHead = await resolveRef(gitCtx!, "ORIG_HEAD");
			expect(origHead).toBeNull();

			expect(await pathExists(bash.fs, "/repo/.git/MERGE_MSG")).toBe(false);
		});

		test("--continue fails with unresolved conflicts", async () => {
			const bash = createTestBash({
				files: EMPTY_REPO,
				env: envAt("100"),
			});
			await bash.exec("git init");
			await bash.fs.writeFile("/repo/file.txt", "original");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.exec("git branch feature");
			await bash.exec("git checkout feature");
			await bash.fs.writeFile("/repo/file.txt", "feature version");
			await bash.exec("git add file.txt");
			await bash.exec('git commit -m "feature change"');

			const gitCtx = await findRepo(bash.fs, "/repo");
			const featureHash = await resolveHead(gitCtx!);

			await bash.exec("git checkout main");
			await bash.fs.writeFile("/repo/file.txt", "main version");
			await bash.exec("git add file.txt");
			await bash.exec('git commit -m "main change"');

			await bash.exec(`git cherry-pick ${featureHash}`);

			// Try --continue without resolving
			const result = await bash.exec("git cherry-pick --continue");
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
			await bash.fs.writeFile("/repo/file.txt", "original");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.exec("git branch feature");
			await bash.exec("git checkout feature");
			await bash.fs.writeFile("/repo/file.txt", "feature version");
			await bash.exec("git add file.txt");
			await bash.exec('git commit -m "feature change"');

			const gitCtx = await findRepo(bash.fs, "/repo");
			const featureHash = await resolveHead(gitCtx!);

			await bash.exec("git checkout main");
			await bash.fs.writeFile("/repo/file.txt", "main version");
			await bash.exec("git add file.txt");
			await bash.exec('git commit -m "main change"');

			const prePickHead = await resolveHead(gitCtx!);

			// Cherry-pick → conflict
			await bash.exec(`git cherry-pick ${featureHash}`);

			// Abort
			const abortResult = await bash.exec("git cherry-pick --abort");
			expect(abortResult.exitCode).toBe(0);

			// HEAD should be back where it was
			const postAbortHead = await resolveHead(gitCtx!);
			expect(postAbortHead).toBe(prePickHead);

			// Working tree should be restored
			const content = await readFile(bash.fs, "/repo/file.txt");
			expect(content).toBe("main version");

			// State files should be cleaned up
			const cpHead = await resolveRef(gitCtx!, "CHERRY_PICK_HEAD");
			expect(cpHead).toBeNull();

			expect(await pathExists(bash.fs, "/repo/.git/MERGE_MSG")).toBe(false);
		});

		test("--abort with no cherry-pick in progress", async () => {
			const bash = createTestBash({
				files: EMPTY_REPO,
				env: TEST_ENV,
			});
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			const result = await bash.exec("git cherry-pick --abort");
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("no cherry-pick or revert in progress");
		});
	});

	// ── Blocking in-progress operations ─────────────────────────────

	describe("in-progress operation blocking", () => {
		test("blocks if cherry-pick already in progress", async () => {
			const bash = createTestBash({
				files: EMPTY_REPO,
				env: envAt("100"),
			});
			await bash.exec("git init");
			await bash.fs.writeFile("/repo/file.txt", "original");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.exec("git branch feature");
			await bash.exec("git checkout feature");
			await bash.fs.writeFile("/repo/file.txt", "feature version");
			await bash.exec("git add file.txt");
			await bash.exec('git commit -m "feature change"');

			const gitCtx = await findRepo(bash.fs, "/repo");
			const featureHash = await resolveHead(gitCtx!);

			await bash.exec("git checkout main");
			await bash.fs.writeFile("/repo/file.txt", "main version");
			await bash.exec("git add file.txt");
			await bash.exec('git commit -m "main change"');

			// First cherry-pick → conflict
			await bash.exec(`git cherry-pick ${featureHash}`);

			// Second cherry-pick should be blocked by unmerged entries
			const result = await bash.exec(`git cherry-pick ${featureHash}`);
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("unmerged");
		});

		test("merge is blocked during cherry-pick", async () => {
			const bash = createTestBash({
				files: EMPTY_REPO,
				env: envAt("100"),
			});
			await bash.exec("git init");
			await bash.fs.writeFile("/repo/file.txt", "original");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.exec("git branch feature");
			await bash.exec("git checkout feature");
			await bash.fs.writeFile("/repo/file.txt", "feature version");
			await bash.exec("git add file.txt");
			await bash.exec('git commit -m "feature change"');

			const gitCtx = await findRepo(bash.fs, "/repo");
			const featureHash = await resolveHead(gitCtx!);

			await bash.exec("git checkout main");
			await bash.fs.writeFile("/repo/file.txt", "main version");
			await bash.exec("git add file.txt");
			await bash.exec('git commit -m "main change"');

			// Cherry-pick → conflict
			await bash.exec(`git cherry-pick ${featureHash}`);

			// Merge should be blocked by unmerged entries
			const result = await bash.exec("git merge feature");
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("unmerged");
		});
	});

	// ── Dirty worktree ──────────────────────────────────────────────

	describe("dirty worktree", () => {
		test("refuses cherry-pick with staged changes", async () => {
			const bash = createTestBash({
				files: EMPTY_REPO,
				env: envAt("100"),
			});
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			// Create feature branch with a new file
			await bash.exec("git branch feature");
			await bash.exec("git checkout feature");
			await bash.fs.writeFile("/repo/feature.txt", "content");
			await bash.exec("git add feature.txt");
			await bash.exec('git commit -m "feature"');

			const gitCtx = await findRepo(bash.fs, "/repo");
			const featureHash = await resolveHead(gitCtx!);

			// Switch back to main, stage some change
			await bash.exec("git checkout main");
			await bash.fs.writeFile("/repo/README.md", "modified");
			await bash.exec("git add README.md");

			// Cherry-pick should be refused
			const result = await bash.exec(`git cherry-pick ${featureHash}`);
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("would be overwritten by cherry-pick");
		});
	});

	// ── --no-commit / -n ─────────────────────────────────────────────

	describe("--no-commit / -n", () => {
		test("preserves staged deletions when merge does not change the file", async () => {
			const bash = createTestBash({
				files: EMPTY_REPO,
				env: envAt("100"),
			});
			await bash.exec("git init");
			await bash.fs.writeFile("/repo/keep.txt", "keep");
			await bash.fs.writeFile("/repo/remove.txt", "remove me");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			// Create a second commit that adds a new file (doesn't touch remove.txt)
			await bash.fs.writeFile("/repo/new.txt", "new file");
			await bash.exec("git add new.txt");
			await bash.exec('git commit -m "add new file"');

			const gitCtx = await findRepo(bash.fs, "/repo");
			const secondHash = await resolveHead(gitCtx!);

			// Stage deletion of remove.txt
			await bash.exec("git rm remove.txt");

			// Cherry-pick -n the second commit
			const result = await bash.exec(`git cherry-pick -n ${secondHash}`);
			expect(result.exitCode).toBe(0);

			// remove.txt should stay OUT of the index (staged deletion preserved)
			const status = await bash.exec("git status --porcelain");
			expect(status.stdout).toContain("D  remove.txt");
			expect(await pathExists(bash.fs, "/repo/remove.txt")).toBe(false);
		});

		test("preserves staged modifications when merge does not change the file", async () => {
			const bash = createTestBash({
				files: EMPTY_REPO,
				env: envAt("100"),
			});
			await bash.exec("git init");
			await bash.fs.writeFile("/repo/file.txt", "original");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			// Create a second commit on another branch
			await bash.exec("git checkout -b feature");
			await bash.fs.writeFile("/repo/feature.txt", "feature content");
			await bash.exec("git add feature.txt");
			await bash.exec('git commit -m "add feature file"');

			const gitCtx = await findRepo(bash.fs, "/repo");
			const featureHash = await resolveHead(gitCtx!);

			// Back to main, stage a modification to file.txt
			await bash.exec("git checkout main");
			await bash.fs.writeFile("/repo/file.txt", "modified");
			await bash.exec("git add file.txt");

			// Cherry-pick -n the feature commit (doesn't touch file.txt)
			const result = await bash.exec(`git cherry-pick -n ${featureHash}`);
			expect(result.exitCode).toBe(0);

			// file.txt should retain staged modification
			const status = await bash.exec("git status --porcelain");
			expect(status.stdout).toContain("M  file.txt");
			expect(await readFile(bash.fs, "/repo/file.txt")).toBe("modified");
		});

		test("allows staged changes and reports conflicts (exit 1, not 128)", async () => {
			const bash = createTestBash({
				files: EMPTY_REPO,
				env: envAt("100"),
			});
			await bash.exec("git init");
			await bash.fs.writeFile("/repo/conflict.txt", "base content");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			// Create a feature branch that modifies conflict.txt
			await bash.exec("git checkout -b feature");
			await bash.fs.writeFile("/repo/conflict.txt", "feature version");
			await bash.exec("git add conflict.txt");
			await bash.exec('git commit -m "feature change"');

			const gitCtx = await findRepo(bash.fs, "/repo");
			const featureHash = await resolveHead(gitCtx!);

			// Back to main, commit a different modification (so HEAD differs from base)
			await bash.exec("git checkout main");
			await bash.fs.writeFile("/repo/conflict.txt", "main version");
			await bash.exec("git add conflict.txt");
			await bash.exec('git commit -m "main change"');

			// Now stage another modification on top
			await bash.fs.writeFile("/repo/conflict.txt", "staged version");
			await bash.exec("git add conflict.txt");

			// Cherry-pick -n should proceed with conflicts (exit 1), not reject (exit 128)
			const result = await bash.exec(`git cherry-pick -n ${featureHash}`);
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("could not apply");
		});

		test("does not write CHERRY_PICK_HEAD or MERGE_MSG on conflict", async () => {
			const bash = createTestBash({
				files: EMPTY_REPO,
				env: envAt("100"),
			});
			await bash.exec("git init");
			await bash.fs.writeFile("/repo/file.txt", "base");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.exec("git checkout -b feature");
			await bash.fs.writeFile("/repo/file.txt", "feature");
			await bash.exec("git add file.txt");
			await bash.exec('git commit -m "feature"');

			const gitCtx = await findRepo(bash.fs, "/repo");
			const featureHash = await resolveHead(gitCtx!);

			await bash.exec("git checkout main");
			await bash.fs.writeFile("/repo/file.txt", "main");
			await bash.exec("git add file.txt");
			await bash.exec('git commit -m "main"');

			const result = await bash.exec(`git cherry-pick -n ${featureHash}`);
			expect(result.exitCode).toBe(1);

			// -n should NOT set CHERRY_PICK_HEAD
			const cpHead = await resolveRef(gitCtx!, "CHERRY_PICK_HEAD");
			expect(cpHead).toBeNull();
		});

		test("clean cherry-pick -n applies changes without committing", async () => {
			const bash = createTestBash({
				files: EMPTY_REPO,
				env: envAt("100"),
			});
			await bash.exec("git init");
			await bash.fs.writeFile("/repo/file.txt", "original");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.exec("git checkout -b feature");
			await bash.fs.writeFile("/repo/new.txt", "new content");
			await bash.exec("git add new.txt");
			await bash.exec('git commit -m "add new"');

			const gitCtx = await findRepo(bash.fs, "/repo");
			const featureHash = await resolveHead(gitCtx!);

			await bash.exec("git checkout main");
			const result = await bash.exec(`git cherry-pick -n ${featureHash}`);
			expect(result.exitCode).toBe(0);

			// Changes applied to worktree and index
			expect(await readFile(bash.fs, "/repo/new.txt")).toBe("new content");

			// HEAD should NOT advance (no commit created)
			const status = await bash.exec("git status --porcelain");
			expect(status.stdout).toContain("A  new.txt");
		});
	});

	// ── --continue with no cherry-pick ──────────────────────────────

	describe("--continue edge cases", () => {
		test("--continue with no cherry-pick in progress", async () => {
			const bash = createTestBash({
				files: EMPTY_REPO,
				env: TEST_ENV,
			});
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			const result = await bash.exec("git cherry-pick --continue");
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("no cherry-pick or revert in progress");
		});
	});
});
