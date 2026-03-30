import { describe, expect, test } from "bun:test";
import { readCommit } from "../../src/lib/object-db";
import { isRebaseInProgress, readRebaseState } from "../../src/lib/rebase";
import { resolveHead, resolveRef } from "../../src/lib/refs";
import { findRepo } from "../../src/lib/repo";
import { EMPTY_REPO, TEST_ENV_NAMED as TEST_ENV, envAt } from "../fixtures";
import { createTestBash, pathExists, readFile } from "../util";

/**
 * Helper: create a repo with a divergent history for rebase testing.
 *
 * History:
 *   main:    init -- A       (A adds a.txt)
 *   feature: init -- B       (B adds b.txt)
 *
 * Returns bash on the feature branch.
 */
async function setupDivergent(env = envAt("100")) {
	const bash = createTestBash({ files: EMPTY_REPO, env });
	await bash.exec("git init");
	await bash.exec("git add .");
	await bash.exec('git commit -m "initial"');

	// Create feature branch at initial commit
	await bash.exec("git branch feature");

	// Diverge main
	await bash.fs.writeFile("/repo/a.txt", "main content");
	await bash.exec("git add a.txt");
	await bash.exec('git commit -m "add a.txt on main"');

	// Switch to feature and diverge
	await bash.exec("git checkout feature");
	await bash.fs.writeFile("/repo/b.txt", "feature content");
	await bash.exec("git add b.txt");
	await bash.exec('git commit -m "add b.txt on feature"');

	return bash;
}

/**
 * Helper: create a repo where feature and main modify the same file.
 *
 * History:
 *   main:    init -- "main change" (file.txt = "main version")
 *   feature: init -- "feature change" (file.txt = "feature version")
 *
 * Returns bash on the feature branch.
 */
async function setupConflict(env = envAt("100")) {
	const bash = createTestBash({ files: EMPTY_REPO, env });
	await bash.exec("git init");
	await bash.exec("git add .");
	await bash.exec('git commit -m "initial"');

	// Create feature branch at initial
	await bash.exec("git branch feature");

	// Main modifies file
	await bash.fs.writeFile("/repo/file.txt", "main version");
	await bash.exec("git add file.txt");
	await bash.exec('git commit -m "main change"');

	// Feature modifies same file
	await bash.exec("git checkout feature");
	await bash.fs.writeFile("/repo/file.txt", "feature version");
	await bash.exec("git add file.txt");
	await bash.exec('git commit -m "feature change"');

	return bash;
}

describe("git rebase", () => {
	// ── Error cases ──────────────────────────────────────────────────

	describe("error cases", () => {
		test("outside a git repo", async () => {
			const bash = createTestBash({ files: EMPTY_REPO });
			const result = await bash.exec("git rebase main");
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("not a git repository");
		});

		test("no upstream argument", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			const result = await bash.exec("git rebase");
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("no upstream");
		});

		test("invalid upstream ref", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			const result = await bash.exec("git rebase nonexistent");
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("invalid upstream");
		});

		test("no commits yet", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			const result = await bash.exec("git rebase main");
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("does not have any commits");
		});

		test("blocks if rebase already in progress", async () => {
			const bash = await setupConflict();
			// First rebase will conflict
			await bash.exec("git rebase main");

			// Second rebase should be blocked
			const result = await bash.exec("git rebase main");
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("already a rebase-merge directory");
		});
	});

	// ── Basic rebase ─────────────────────────────────────────────────

	describe("basic rebase", () => {
		test("rebases feature branch onto main", async () => {
			const bash = await setupDivergent();
			const result = await bash.exec("git rebase main");
			expect(result.exitCode).toBe(0);

			// Feature branch should now be on top of main
			const gitCtx = await findRepo(bash.fs, "/repo");
			const headHash = await resolveHead(gitCtx!);
			const headCommit = await readCommit(gitCtx!, headHash!);

			// The rebased commit should have "add b.txt on feature" as message
			expect(headCommit.message).toContain("add b.txt on feature");

			// The parent should be the main branch tip (add a.txt on main)
			expect(headCommit.parents.length).toBe(1);
			const parentCommit = await readCommit(gitCtx!, headCommit.parents[0]!);
			expect(parentCommit.message).toContain("add a.txt on main");

			// Both files should exist
			expect(await pathExists(bash.fs, "/repo/a.txt")).toBe(true);
			expect(await pathExists(bash.fs, "/repo/b.txt")).toBe(true);

			// HEAD should be re-attached to the feature branch
			const featureRef = await resolveRef(gitCtx!, "refs/heads/feature");
			expect(featureRef).toBe(headHash);
		});

		test("preserves original author during rebase", async () => {
			const bash = createTestBash({
				files: EMPTY_REPO,
				env: envAt("100"),
			});
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			// Create feature branch at initial
			await bash.exec("git branch feature");

			// Add a commit to main with one timestamp
			const mainEnv = envAt("3000000000");
			await bash.fs.writeFile("/repo/main.txt", "main work");
			await bash.exec("git add main.txt", { env: mainEnv });
			await bash.exec('git commit -m "main work"', { env: mainEnv });

			// Switch to feature, commit with a specific author timestamp
			await bash.exec("git checkout feature");
			const featureEnv = envAt("2000000000");
			await bash.fs.writeFile("/repo/feature.txt", "feature work");
			await bash.exec("git add feature.txt", { env: featureEnv });
			await bash.exec('git commit -m "feature work"', { env: featureEnv });

			// Rebase feature onto main with a different timestamp
			const rebaseEnv = envAt("4000000000");
			await bash.exec("git rebase main", { env: rebaseEnv });

			// Check that the author is preserved from the original commit
			const gitCtx = await findRepo(bash.fs, "/repo");
			const headHash = await resolveHead(gitCtx!);
			const headCommit = await readCommit(gitCtx!, headHash!);
			expect(headCommit.author.timestamp).toBe(2000000000);
			// Committer should be the current env
			expect(headCommit.committer.timestamp).toBe(4000000000);
		});

		test("multiple commits are replayed in order", async () => {
			const bash = createTestBash({
				files: EMPTY_REPO,
				env: envAt("100"),
			});
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			// Create feature at initial
			await bash.exec("git branch feature");

			// Add to main
			await bash.fs.writeFile("/repo/m.txt", "main");
			await bash.exec("git add m.txt");
			await bash.exec('git commit -m "main commit"');

			// Switch to feature with 2 commits
			await bash.exec("git checkout feature");
			await bash.fs.writeFile("/repo/f1.txt", "first");
			await bash.exec("git add f1.txt");
			await bash.exec('git commit -m "feature commit 1"');
			await bash.fs.writeFile("/repo/f2.txt", "second");
			await bash.exec("git add f2.txt");
			await bash.exec('git commit -m "feature commit 2"');

			// Rebase
			const result = await bash.exec("git rebase main");
			expect(result.exitCode).toBe(0);

			// Verify commit chain
			const gitCtx = await findRepo(bash.fs, "/repo");
			const headHash = await resolveHead(gitCtx!);
			const head = await readCommit(gitCtx!, headHash!);
			expect(head.message).toContain("feature commit 2");

			const parent1 = await readCommit(gitCtx!, head.parents[0]!);
			expect(parent1.message).toContain("feature commit 1");

			const parent2 = await readCommit(gitCtx!, parent1.parents[0]!);
			expect(parent2.message).toContain("main commit");

			// All files should exist
			expect(await pathExists(bash.fs, "/repo/f1.txt")).toBe(true);
			expect(await pathExists(bash.fs, "/repo/f2.txt")).toBe(true);
			expect(await pathExists(bash.fs, "/repo/m.txt")).toBe(true);
		});

		test("preserves intentionally empty commits during rebase", async () => {
			const bash = createTestBash({
				files: EMPTY_REPO,
				env: envAt("100"),
			});
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.exec("git branch feature");

			await bash.fs.writeFile("/repo/main.txt", "main\n");
			await bash.exec("git add main.txt");
			await bash.exec('git commit -m "main commit"');

			await bash.exec("git checkout feature");
			await bash.fs.writeFile("/repo/feature.txt", "feature\n");
			await bash.exec("git add feature.txt");
			await bash.exec('git commit -m "feature commit"');
			await bash.exec('git commit --allow-empty -m "empty marker"');

			const beforeRebase = (await bash.exec("git rev-list --count HEAD")).stdout.trim();
			const result = await bash.exec("git rebase main");
			expect(result.exitCode).toBe(0);
			expect(result.stderr).not.toContain("dropping");

			const afterRebase = (await bash.exec("git rev-list --count HEAD")).stdout.trim();
			expect(afterRebase).toBe(beforeRebase);

			const gitCtx = await findRepo(bash.fs, "/repo");
			const headHash = await resolveHead(gitCtx!);
			const headCommit = await readCommit(gitCtx!, headHash!);
			expect(headCommit.message).toContain("empty marker");

			const parent = await readCommit(gitCtx!, headCommit.parents[0]!);
			expect(parent.message).toContain("feature commit");
		});

		test("up-to-date rebase is a no-op", async () => {
			const bash = createTestBash({
				files: EMPTY_REPO,
				env: envAt("100"),
			});
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			// feature is at initial, main is also at initial — up to date
			const result = await bash.exec("git rebase main");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("up to date");
		});

		test("rebase cleans up state after success", async () => {
			const bash = await setupDivergent();
			await bash.exec("git rebase main");

			const gitCtx = await findRepo(bash.fs, "/repo");
			expect(await isRebaseInProgress(gitCtx!)).toBe(false);
			expect(await resolveRef(gitCtx!, "REBASE_HEAD")).toBeNull();
			expect(await resolveRef(gitCtx!, "ORIG_HEAD")).toBeNull();
		});
	});

	// ── --onto ───────────────────────────────────────────────────────

	describe("--onto", () => {
		test("rebase --onto allows rebasing to a different base", async () => {
			const bash = createTestBash({
				files: EMPTY_REPO,
				env: envAt("100"),
			});
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			// Build: initial -- A -- B (main)
			await bash.fs.writeFile("/repo/a.txt", "A");
			await bash.exec("git add a.txt");
			await bash.exec('git commit -m "commit A"');

			// Create feature branch at commit A
			await bash.exec("git branch feature");

			await bash.fs.writeFile("/repo/b.txt", "B");
			await bash.exec("git add b.txt");
			await bash.exec('git commit -m "commit B"');

			// Switch to feature and add commit C
			await bash.exec("git checkout feature");
			await bash.fs.writeFile("/repo/c.txt", "C");
			await bash.exec("git add c.txt");
			await bash.exec('git commit -m "commit C"');

			// Now: main = initial → A → B, feature = initial → A → C
			// git rebase --onto main feature~1(=A)
			// But we can't use ~1, so let's use a different approach:
			// "git rebase --onto main main" — rebase feature onto main,
			// using main as the upstream (A is the merge base, so C gets replayed onto B)
			const result = await bash.exec("git rebase --onto main main");
			expect(result.exitCode).toBe(0);

			const gitCtx = await findRepo(bash.fs, "/repo");
			const headHash = await resolveHead(gitCtx!);
			const headCommit = await readCommit(gitCtx!, headHash!);
			expect(headCommit.message).toContain("commit C");

			// Parent should be main tip (commit B)
			const parent = await readCommit(gitCtx!, headCommit.parents[0]!);
			expect(parent.message).toContain("commit B");

			const reflog = await bash.exec("git reflog -n 10");
			expect(reflog.stdout).toContain("rebase (start): checkout main");
		});
	});

	// ── Conflicts ────────────────────────────────────────────────────

	describe("conflicts", () => {
		test("conflict stops rebase and writes REBASE_HEAD", async () => {
			const bash = await setupConflict();
			const result = await bash.exec("git rebase main");
			expect(result.exitCode).toBe(1);
			expect(result.stdout).toContain("CONFLICT");

			const gitCtx = await findRepo(bash.fs, "/repo");
			expect(await isRebaseInProgress(gitCtx!)).toBe(true);
			expect(await resolveRef(gitCtx!, "REBASE_HEAD")).not.toBeNull();
		});

		test("conflict writes MERGE_MSG", async () => {
			const bash = await setupConflict();
			await bash.exec("git rebase main");

			const msg = await readFile(bash.fs, "/repo/.git/MERGE_MSG");
			expect(msg).toContain("feature change");
		});

		test("conflict writes conflict markers", async () => {
			const bash = await setupConflict();
			await bash.exec("git rebase main");

			const content = await readFile(bash.fs, "/repo/file.txt");
			expect(content).toContain("<<<<<<<");
			expect(content).toContain(">>>>>>>");
		});

		test("--continue resolves conflict and completes rebase", async () => {
			const bash = await setupConflict();
			await bash.exec("git rebase main");

			// Resolve conflict
			await bash.fs.writeFile("/repo/file.txt", "resolved");
			await bash.exec("git add file.txt");
			const result = await bash.exec("git rebase --continue");
			expect(result.exitCode).toBe(0);

			// Rebase should be complete
			const gitCtx = await findRepo(bash.fs, "/repo");
			expect(await isRebaseInProgress(gitCtx!)).toBe(false);

			// Verify the commit chain
			const headHash = await resolveHead(gitCtx!);
			const headCommit = await readCommit(gitCtx!, headHash!);
			expect(headCommit.message).toContain("feature change");

			// File should have resolved content
			expect(await readFile(bash.fs, "/repo/file.txt")).toBe("resolved");
		});

		test("--continue fails with unresolved conflicts", async () => {
			const bash = await setupConflict();
			await bash.exec("git rebase main");

			// Don't resolve, try to continue
			const result = await bash.exec("git rebase --continue");
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("unmerged files");
		});

		test("--skip skips conflicted commit", async () => {
			const bash = await setupConflict();
			await bash.exec("git rebase main");

			const result = await bash.exec("git rebase --skip");
			expect(result.exitCode).toBe(0);

			// Rebase should be complete
			const gitCtx = await findRepo(bash.fs, "/repo");
			expect(await isRebaseInProgress(gitCtx!)).toBe(false);

			// HEAD should be at main's tip (the skipped commit's changes are gone)
			const headHash = await resolveHead(gitCtx!);
			const headCommit = await readCommit(gitCtx!, headHash!);
			expect(headCommit.message).toContain("main change");
		});
	});

	// ── --abort ──────────────────────────────────────────────────────

	describe("--abort", () => {
		test("abort restores original branch and HEAD", async () => {
			const bash = await setupConflict();

			const gitCtx = await findRepo(bash.fs, "/repo");
			const origFeatureHead = await resolveHead(gitCtx!);

			// Start rebase (will conflict)
			await bash.exec("git rebase main");

			// Abort
			const result = await bash.exec("git rebase --abort");
			expect(result.exitCode).toBe(0);

			// HEAD should be back to original feature commit
			const headHash = await resolveHead(gitCtx!);
			expect(headHash).toBe(origFeatureHead);

			// Feature branch should be restored
			const featureRef = await resolveRef(gitCtx!, "refs/heads/feature");
			expect(featureRef).toBe(origFeatureHead);

			// Rebase state should be cleaned up
			expect(await isRebaseInProgress(gitCtx!)).toBe(false);

			// Working tree should be restored
			expect(await readFile(bash.fs, "/repo/file.txt")).toBe("feature version");
		});

		test("--abort with no rebase in progress", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			const result = await bash.exec("git rebase --abort");
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("no rebase in progress");
		});
	});

	// ── Blocking during other operations ─────────────────────────────

	describe("in-progress operation blocking", () => {
		test("merge is blocked during rebase with conflicts", async () => {
			const bash = await setupConflict();
			// Start a conflicted rebase
			await bash.exec("git rebase main");

			// Try merge — blocked by unmerged entries, not rebase check
			const result = await bash.exec("git merge main");
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("unmerged");
		});

		test("cherry-pick is blocked during rebase", async () => {
			const bash = await setupConflict();
			// Start a conflicted rebase
			await bash.exec("git rebase main");

			// Try cherry-pick — blocked by unmerged entries, not rebase itself
			const result = await bash.exec("git cherry-pick main");
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toContain("unmerged");
		});
	});

	// ── Dirty worktree ───────────────────────────────────────────────

	describe("dirty worktree", () => {
		test("refuses rebase with unstaged changes", async () => {
			const bash = createTestBash({
				files: EMPTY_REPO,
				env: envAt("100"),
			});
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			// Create feature at initial
			await bash.exec("git branch feature");

			await bash.fs.writeFile("/repo/new.txt", "main");
			await bash.exec("git add new.txt");
			await bash.exec('git commit -m "main commit"');

			await bash.exec("git checkout feature");
			await bash.fs.writeFile("/repo/feature.txt", "feat");
			await bash.exec("git add feature.txt");
			await bash.exec('git commit -m "feature commit"');

			// Make dirty change
			await bash.fs.writeFile("/repo/feature.txt", "modified");

			const result = await bash.exec("git rebase main");
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("unstaged changes");
		});
	});

	// ── Status indicator ─────────────────────────────────────────────

	describe("status during rebase", () => {
		test("git status shows rebase in progress", async () => {
			const bash = await setupConflict();
			await bash.exec("git rebase main");

			const status = await bash.exec("git status");
			expect(status.stdout).toContain("currently rebasing");
		});
	});

	// ── --continue edge cases ────────────────────────────────────────

	describe("--continue edge cases", () => {
		test("--continue with no rebase in progress", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			const result = await bash.exec("git rebase --continue");
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("no rebase in progress");
		});

		test("--skip with no rebase in progress", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			const result = await bash.exec("git rebase --skip");
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("no rebase in progress");
		});

		test("--continue after user manually commits", async () => {
			const bash = await setupConflict();

			// Start rebase (conflicts)
			await bash.exec("git rebase main");

			// Resolve and commit manually
			await bash.fs.writeFile("/repo/file.txt", "resolved");
			await bash.exec("git add file.txt");
			await bash.exec('git commit -m "resolved"');

			// Continue should still work
			const result = await bash.exec("git rebase --continue");
			expect(result.exitCode).toBe(0);

			const gitCtx = await findRepo(bash.fs, "/repo");
			expect(await isRebaseInProgress(gitCtx!)).toBe(false);
		});
	});

	// ── Abort with untracked file conflicts ─────────────────────────

	describe("abort untracked file conflicts", () => {
		test("--abort fails when untracked files would be overwritten", async () => {
			const bash = createTestBash({
				files: EMPTY_REPO,
				env: envAt("100"),
			});
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			// Create feature branch with extra file
			await bash.exec("git checkout -b feature");
			await bash.fs.writeFile("/repo/extra.txt", "feature content");
			await bash.exec("git add extra.txt");
			await bash.exec('git commit -m "add extra"');

			// Also create a conflicting change
			await bash.fs.writeFile("/repo/README.md", "feature version");
			await bash.exec("git add README.md");
			await bash.exec('git commit -m "modify readme"');

			// Main: create a conflicting change
			await bash.exec("git checkout main");
			await bash.fs.writeFile("/repo/README.md", "main version");
			await bash.exec("git add README.md");
			await bash.exec('git commit -m "main readme"');

			// Go back to feature and start rebase (will conflict)
			await bash.exec("git checkout feature");
			const rebaseResult = await bash.exec("git rebase main");
			expect(rebaseResult.exitCode).toBe(1);

			// Now create an untracked file with the same name as a file
			// that exists in the pre-rebase state (extra.txt was added on
			// feature). During rebase, HEAD is detached at a rebased commit
			// that may not have extra.txt yet. Delete it from the worktree
			// and index, then create it as untracked.
			await bash.fs.rm("/repo/extra.txt");

			// The index was modified by the rebase, so extra.txt might still
			// be there. Reset the staging to remove it and then recreate as
			// untracked.
			await bash.exec("git rm --cached extra.txt 2>/dev/null; true");
			await bash.fs.writeFile("/repo/extra.txt", "untracked content");

			const abortResult = await bash.exec("git rebase --abort");
			expect(abortResult.exitCode).toBe(128);
			expect(abortResult.stderr).toContain(
				"untracked working tree files would be overwritten by reset",
			);
			expect(abortResult.stderr).toContain("extra.txt");
			expect(abortResult.stderr).toContain("could not move back to");

			// Rebase should still be in progress
			const gitCtx = await findRepo(bash.fs, "/repo");
			const inProgress = await isRebaseInProgress(gitCtx!);
			expect(inProgress).toBe(true);
		});
	});

	// ── Multi-commit conflict scenarios ──────────────────────────────

	describe("--reapply-cherry-picks", () => {
		/**
		 * Setup: trunk has a cherry-picked version of feature's commit,
		 * plus an extra commit so the branches actually diverge.
		 * Different committer timestamps force different commit hashes.
		 */
		async function setupCherryPickScenario() {
			const env = envAt("100");
			const bash = createTestBash({ files: EMPTY_REPO, env });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.exec("git checkout -b feature");
			await bash.fs.writeFile("/repo/feat.txt", "feature work");
			await bash.exec("git add feat.txt");
			await bash.exec('git commit -m "feature work"', { env: envAt("200") });
			await bash.exec("git checkout main");
			// Cherry-pick with a different committer date → different hash
			await bash.exec("git cherry-pick feature", { env: envAt("300") });
			// Add an extra commit so the branches diverge
			await bash.fs.writeFile("/repo/extra.txt", "extra");
			await bash.exec("git add extra.txt");
			await bash.exec('git commit -m "extra on main"');
			await bash.exec("git checkout feature");
			return bash;
		}

		test("default skips cherry-picked commits with warning", async () => {
			const bash = await setupCherryPickScenario();
			const result = await bash.exec("git rebase main");
			expect(result.exitCode).toBe(0);
			expect(result.stderr).toContain("skipped previously applied commit");
			expect(result.stderr).toContain("--reapply-cherry-picks");
		});

		test("--reapply-cherry-picks does not skip", async () => {
			const bash = await setupCherryPickScenario();
			const result = await bash.exec("git rebase --reapply-cherry-picks main");
			expect(result.exitCode).toBe(0);
			expect(result.stderr).not.toContain("skipped previously applied commit");
			expect(result.stderr).not.toContain("--reapply-cherry-picks");
			// Commit enters pick loop — dropped because tree matches upstream
			expect(result.stderr).toContain("dropping");
			expect(result.stderr).toContain("patch contents already upstream");
		});

		test("--no-reapply-cherry-picks behaves like default", async () => {
			const bash = await setupCherryPickScenario();
			const result = await bash.exec("git rebase --no-reapply-cherry-picks main");
			expect(result.exitCode).toBe(0);
			expect(result.stderr).toContain("skipped previously applied commit");
			expect(result.stderr).toContain("--reapply-cherry-picks");
		});
	});

	describe("multi-commit conflicts", () => {
		test("conflict in second commit during rebase", async () => {
			const bash = createTestBash({
				files: EMPTY_REPO,
				env: envAt("100"),
			});
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			// Create feature at initial
			await bash.exec("git branch feature");

			// Main: add conflicting file
			await bash.fs.writeFile("/repo/conflict.txt", "main");
			await bash.exec("git add conflict.txt");
			await bash.exec('git commit -m "main conflict file"');

			// Feature: two commits, second one conflicts
			await bash.exec("git checkout feature");
			await bash.fs.writeFile("/repo/clean.txt", "clean");
			await bash.exec("git add clean.txt");
			await bash.exec('git commit -m "clean commit"');
			await bash.fs.writeFile("/repo/conflict.txt", "feature");
			await bash.exec("git add conflict.txt");
			await bash.exec('git commit -m "conflicting commit"');

			// Rebase should apply first commit cleanly, then conflict
			const result = await bash.exec("git rebase main");
			expect(result.exitCode).toBe(1);
			expect(result.stdout).toContain("CONFLICT");

			// Check rebase state
			const gitCtx = await findRepo(bash.fs, "/repo");
			const state = await readRebaseState(gitCtx!);
			expect(state).not.toBeNull();
			// Both commits are in done (state is advanced before each pick attempt,
			// matching real git's behavior where done records attempted picks)
			expect(state!.done.length).toBe(2);
			expect(state!.todo.length).toBe(0);

			// Resolve and continue
			await bash.fs.writeFile("/repo/conflict.txt", "resolved");
			await bash.exec("git add conflict.txt");
			const continueResult = await bash.exec("git rebase --continue");
			expect(continueResult.exitCode).toBe(0);

			// All files should exist
			expect(await pathExists(bash.fs, "/repo/clean.txt")).toBe(true);
			expect(await pathExists(bash.fs, "/repo/conflict.txt")).toBe(true);
			expect(await readFile(bash.fs, "/repo/conflict.txt")).toBe("resolved");
		});
	});
});
