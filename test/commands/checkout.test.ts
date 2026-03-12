import { describe, expect, test } from "bun:test";
import { BASIC_REPO, EMPTY_REPO, TEST_ENV_NAMED as TEST_ENV } from "../fixtures";
import { createTestBash, quickExec, readFile, runScenario } from "../util";

describe("git checkout", () => {
	describe("outside a git repo", () => {
		test("fails with exit 128", async () => {
			const result = await quickExec("git checkout main", {
				files: EMPTY_REPO,
			});
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("not a git repository");
		});
	});

	describe("no arguments", () => {
		test("fails with helpful message", async () => {
			const { results } = await runScenario(["git init", "git checkout"], {
				files: EMPTY_REPO,
				env: TEST_ENV,
			});
			expect(results[1].exitCode).toBe(128);
			expect(results[1].stderr).toContain("you must specify a branch");
		});
	});

	describe("switch to existing branch", () => {
		test("switches HEAD to the target branch", async () => {
			const bash = createTestBash({
				files: EMPTY_REPO,
				env: TEST_ENV,
			});
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');
			await bash.exec("git branch feature");

			const result = await bash.exec("git checkout feature");
			expect(result.exitCode).toBe(0);
			expect(result.stderr).toContain("Switched to branch 'feature'");

			const head = await readFile(bash.fs, "/repo/.git/HEAD");
			expect(head?.trim()).toBe("ref: refs/heads/feature");
		});

		test("already on the same branch", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "first"', "git checkout main"],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			expect(results[3].exitCode).toBe(0);
			expect(results[3].stderr).toContain("Already on 'main'");
		});

		test("fails when branch does not exist", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "first"', "git checkout nonexistent"],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			expect(results[3].exitCode).toBe(1);
			expect(results[3].stderr).toContain("did not match");
		});

		test("updates working tree files", async () => {
			const bash = createTestBash({
				files: BASIC_REPO,
				env: TEST_ENV,
			});
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			// Create a branch and make changes
			await bash.exec("git checkout -b feature");
			await bash.exec('echo "new content" > /repo/README.md');
			await bash.exec("git add README.md");
			await bash.exec('git commit -m "update readme"');

			// Switch back to main
			await bash.exec("git checkout main");
			const readme = await readFile(bash.fs, "/repo/README.md");
			expect(readme).toBe("# My Project");

			// Switch to feature and verify the change
			await bash.exec("git checkout feature");
			const updatedReadme = await readFile(bash.fs, "/repo/README.md");
			expect(updatedReadme).toBe("new content\n");
		});

		test("removes files not in target branch", async () => {
			const bash = createTestBash({
				files: EMPTY_REPO,
				env: TEST_ENV,
			});
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			// Create a branch and add a new file
			await bash.exec("git checkout -b feature");
			await bash.exec('echo "extra" > /repo/extra.txt');
			await bash.exec("git add extra.txt");
			await bash.exec('git commit -m "add extra"');

			// Switch back to main — extra.txt should be gone
			await bash.exec("git checkout main");
			const extra = await readFile(bash.fs, "/repo/extra.txt");
			expect(extra).toBeUndefined();
		});
	});

	describe("create and switch (-b)", () => {
		test("creates new branch and switches to it", async () => {
			const bash = createTestBash({
				files: EMPTY_REPO,
				env: TEST_ENV,
			});
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');

			const result = await bash.exec("git checkout -b feature");
			expect(result.exitCode).toBe(0);
			expect(result.stderr).toContain("Switched to a new branch 'feature'");

			// HEAD should point to the new branch
			const head = await readFile(bash.fs, "/repo/.git/HEAD");
			expect(head?.trim()).toBe("ref: refs/heads/feature");

			// The new branch ref should exist
			const ref = await readFile(bash.fs, "/repo/.git/refs/heads/feature");
			expect(ref?.trim()).toMatch(/^[a-f0-9]{40}$/);
		});

		test("works on empty repo (no commits)", async () => {
			const bash = createTestBash({
				files: EMPTY_REPO,
				env: TEST_ENV,
			});
			await bash.exec("git init");

			const result = await bash.exec("git checkout -b feature");
			expect(result.exitCode).toBe(0);

			const head = await readFile(bash.fs, "/repo/.git/HEAD");
			expect(head?.trim()).toBe("ref: refs/heads/feature");
		});

		test("fails when branch already exists", async () => {
			const { results } = await runScenario(
				[
					"git init",
					"git add .",
					'git commit -m "first"',
					"git branch feature",
					"git checkout -b feature",
				],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			expect(results[4].exitCode).toBe(128);
			expect(results[4].stderr).toContain("already exists");
		});
	});

	describe("checkout --orphan", () => {
		test("creates orphan branch and first commit has no parents", async () => {
			const bash = createTestBash({
				files: EMPTY_REPO,
				env: TEST_ENV,
			});
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			const result = await bash.exec("git checkout --orphan gh-pages");
			expect(result.exitCode).toBe(0);
			expect(result.stderr).toContain("Switched to a new branch 'gh-pages'");

			// HEAD should point to the new branch
			const head = await readFile(bash.fs, "/repo/.git/HEAD");
			expect(head?.trim()).toBe("ref: refs/heads/gh-pages");

			// The branch ref should NOT exist yet
			const ref = await readFile(bash.fs, "/repo/.git/refs/heads/gh-pages");
			expect(ref).toBeUndefined();

			// Commit on the orphan branch — should be a root commit
			await bash.exec('echo "page" > /repo/index.html');
			await bash.exec("git add index.html");
			await bash.exec('git commit -m "gh-pages root"');

			const log = await bash.exec("git log --oneline");
			expect(log.exitCode).toBe(0);
			// Only one commit on this branch (not the initial one from main)
			const lines = log.stdout.trim().split("\n");
			expect(lines).toHaveLength(1);
			expect(lines[0]).toContain("gh-pages root");
		});

		test("preserves index and worktree", async () => {
			const bash = createTestBash({
				files: EMPTY_REPO,
				env: TEST_ENV,
			});
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			// Stage a new file and modify an existing one
			await bash.exec('echo "staged" > /repo/staged.txt');
			await bash.exec("git add staged.txt");
			await bash.exec('echo "modified" > /repo/README.md');

			await bash.exec("git checkout --orphan orphan-branch");

			// Staged file should still be in worktree
			const staged = await readFile(bash.fs, "/repo/staged.txt");
			expect(staged).toBe("staged\n");

			// Modified file should still have modifications
			const readme = await readFile(bash.fs, "/repo/README.md");
			expect(readme).toBe("modified\n");
		});

		test("fails if branch already exists", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "first"', "git checkout --orphan main"],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			expect(results[3].exitCode).toBe(128);
			expect(results[3].stderr).toContain("already exists");
		});

		test("works on empty repo (no commits)", async () => {
			const bash = createTestBash({
				files: EMPTY_REPO,
				env: TEST_ENV,
			});
			await bash.exec("git init");

			const result = await bash.exec("git checkout --orphan other");
			expect(result.exitCode).toBe(0);

			const head = await readFile(bash.fs, "/repo/.git/HEAD");
			expect(head?.trim()).toBe("ref: refs/heads/other");
		});

		test("conflicts with -b", async () => {
			const { results } = await runScenario(["git init", "git checkout --orphan -b some-branch"], {
				files: EMPTY_REPO,
				env: TEST_ENV,
			});
			expect(results[1].exitCode).toBe(128);
			expect(results[1].stderr).toContain("incompatible");
		});
	});

	describe("conflict detection", () => {
		test("aborts when local changes would be overwritten", async () => {
			const bash = createTestBash({
				files: BASIC_REPO,
				env: TEST_ENV,
			});
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			// Create a feature branch and modify README
			await bash.exec("git checkout -b feature");
			await bash.exec('echo "feature change" > /repo/README.md');
			await bash.exec("git add .");
			await bash.exec('git commit -m "feature change"');

			// Switch back to main
			await bash.exec("git checkout main");

			// Make a local modification to README (unstaged)
			await bash.exec('echo "local edit" > /repo/README.md');

			// Try to switch to feature — should fail
			const result = await bash.exec("git checkout feature");
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("would be overwritten");
			expect(result.stderr).toContain("README.md");
		});
	});

	describe("restore files from index", () => {
		test("restores a modified file when target is not a branch", async () => {
			const bash = createTestBash({
				files: BASIC_REPO,
				env: TEST_ENV,
			});
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			// Modify a file in the working tree
			await bash.exec('echo "modified" > /repo/README.md');

			// Restore from index (README.md is not a branch, so falls
			// back to file restoration)
			const result = await bash.exec("git checkout README.md");
			expect(result.exitCode).toBe(0);

			const content = await readFile(bash.fs, "/repo/README.md");
			expect(content).toBe("# My Project");
		});

		test("fails for unknown path", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "first"', "git checkout nonexistent.txt"],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			expect(results[3].exitCode).toBe(1);
			expect(results[3].stderr).toContain("did not match");
		});
	});

	describe("integration: round-trip between branches", () => {
		test("files are preserved across branch switches", async () => {
			const bash = createTestBash({
				files: BASIC_REPO,
				env: TEST_ENV,
			});
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial with all files"');

			// Create feature branch and make changes
			await bash.exec("git checkout -b feature");
			await bash.exec('echo "feature code" > /repo/src/feature.ts');
			await bash.exec("git add .");
			await bash.exec('git commit -m "add feature"');

			// Switch to main — feature.ts should be gone
			await bash.exec("git checkout main");
			const featureFile = await readFile(bash.fs, "/repo/src/feature.ts");
			expect(featureFile).toBeUndefined();

			// Switch back to feature — feature.ts should reappear
			await bash.exec("git checkout feature");
			const featureFile2 = await readFile(bash.fs, "/repo/src/feature.ts");
			expect(featureFile2).toBe("feature code\n");

			// status should be clean
			const status = await bash.exec("git status");
			expect(status.stdout).toContain("nothing to commit");
		});
	});
});
