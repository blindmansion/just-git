import { describe, expect, test } from "bun:test";
import { BASIC_REPO, EMPTY_REPO, TEST_ENV_NAMED as TEST_ENV } from "../fixtures";
import { createTestBash, quickExec, readFile, runScenario } from "../util";

describe("git switch", () => {
	describe("errors", () => {
		test("fails outside a git repo", async () => {
			const result = await quickExec("git switch main", {
				files: EMPTY_REPO,
			});
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("not a git repository");
		});

		test("fails with no arguments", async () => {
			const { results } = await runScenario(["git init", "git switch"], {
				files: EMPTY_REPO,
				env: TEST_ENV,
			});
			expect(results[1].exitCode).toBe(128);
			expect(results[1].stderr).toContain("missing branch or commit argument");
		});

		test("fails for invalid reference", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "init"', "git switch nonexistent"],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			expect(results[3].exitCode).toBe(128);
			expect(results[3].stderr).toContain("invalid reference: nonexistent");
		});
	});

	describe("switch to existing branch", () => {
		test("switches HEAD to the target branch", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');
			await bash.exec("git branch feature");

			const result = await bash.exec("git switch feature");
			expect(result.exitCode).toBe(0);
			expect(result.stderr).toContain("Switched to branch 'feature'");

			const head = await readFile(bash.fs, "/repo/.git/HEAD");
			expect(head?.trim()).toBe("ref: refs/heads/feature");
		});

		test("already on the same branch", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "first"', "git switch main"],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			expect(results[3].exitCode).toBe(0);
			expect(results[3].stderr).toContain("Already on 'main'");
		});

		test("updates working tree files", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');
			await bash.exec("git switch -c feature");

			await bash.fs.writeFile("/repo/feature.txt", "feature content");
			await bash.exec("git add feature.txt");
			await bash.exec('git commit -m "add feature file"');

			await bash.exec("git switch main");
			const exists = await bash.fs.exists("/repo/feature.txt");
			expect(exists).toBe(false);

			await bash.exec("git switch feature");
			const content = await readFile(bash.fs, "/repo/feature.txt");
			expect(content).toBe("feature content");
		});
	});

	describe("create branch (-c)", () => {
		test("creates new branch and switches to it", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');

			const result = await bash.exec("git switch -c feature");
			expect(result.exitCode).toBe(0);
			expect(result.stderr).toContain("Switched to a new branch 'feature'");

			const head = await readFile(bash.fs, "/repo/.git/HEAD");
			expect(head?.trim()).toBe("ref: refs/heads/feature");
		});

		test("fails when branch already exists", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "first"', "git switch -c main"],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			expect(results[3].exitCode).toBe(128);
			expect(results[3].stderr).toContain("a branch named 'main' already exists");
		});

		test("creates branch from start-point", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');
			await bash.exec("git switch -c feature");
			await bash.fs.writeFile("/repo/feature.txt", "feature");
			await bash.exec("git add feature.txt");
			await bash.exec('git commit -m "feature"');

			// Create new branch from main (should not have feature.txt)
			const result = await bash.exec("git switch -c new-branch -- main");
			expect(result.exitCode).toBe(0);
			expect(result.stderr).toContain("Switched to a new branch 'new-branch'");
			const exists = await bash.fs.exists("/repo/feature.txt");
			expect(exists).toBe(false);
		});

		test("works on empty repo (no commits)", async () => {
			const { results } = await runScenario(["git init", "git switch -c feature"], {
				files: EMPTY_REPO,
				env: TEST_ENV,
			});
			expect(results[1].exitCode).toBe(0);
			expect(results[1].stderr).toContain("Switched to a new branch 'feature'");
		});
	});

	describe("force create branch (-C)", () => {
		test("resets existing branch", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');
			await bash.exec("git switch -c feature");
			await bash.fs.writeFile("/repo/extra.txt", "extra");
			await bash.exec("git add extra.txt");
			await bash.exec('git commit -m "second"');

			// -C should reset 'feature' to main's HEAD
			await bash.exec("git switch main");
			const result = await bash.exec("git switch -C feature");
			expect(result.exitCode).toBe(0);
			expect(result.stderr).toContain("Switched to and reset branch 'feature'");
		});

		test("creates new branch if it does not exist", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');

			const result = await bash.exec("git switch -C newbranch");
			expect(result.exitCode).toBe(0);
			expect(result.stderr).toContain("Switched to a new branch 'newbranch'");
		});
	});

	describe("detach (--detach / -d)", () => {
		test("detaches HEAD at current commit", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');

			const result = await bash.exec("git switch --detach HEAD");
			expect(result.exitCode).toBe(0);
			expect(result.stderr).toContain("HEAD is now at");
		});

		test("detaches HEAD at specific commit", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');
			await bash.fs.writeFile("/repo/file2.txt", "two");
			await bash.exec("git add file2.txt");
			await bash.exec('git commit -m "second"');

			const result = await bash.exec("git switch -d HEAD~1");
			expect(result.exitCode).toBe(0);
			expect(result.stderr).toContain("HEAD is now at");
		});

		test("does not detach without --detach flag", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');

			// Using a commit hash without --detach should fail
			const log = await bash.exec("git rev-parse HEAD");
			const hash = log.stdout.trim();
			const result = await bash.exec(`git switch ${hash}`);
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("invalid reference");
		});
	});

	describe("orphan (--orphan)", () => {
		test("creates orphan branch and clears index", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');

			const result = await bash.exec("git switch --orphan orphan-branch");
			expect(result.exitCode).toBe(0);
			expect(result.stderr).toContain("Switched to a new branch 'orphan-branch'");

			const head = await readFile(bash.fs, "/repo/.git/HEAD");
			expect(head?.trim()).toBe("ref: refs/heads/orphan-branch");

			// Index should be cleared (unlike checkout --orphan)
			const lsFiles = await bash.exec("git ls-files");
			expect(lsFiles.stdout.trim()).toBe("");

			// Tracked files should be removed from worktree
			const exists = await bash.fs.exists("/repo/README.md");
			expect(exists).toBe(false);
		});

		test("fails if branch already exists", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "first"', "git switch --orphan main"],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			expect(results[3].exitCode).toBe(128);
			expect(results[3].stderr).toContain("a branch named 'main' already exists");
		});
	});

	describe("incompatible flags", () => {
		test("--orphan and -c are incompatible", async () => {
			const { results } = await runScenario(["git init", "git switch --orphan foo -c bar"], {
				files: EMPTY_REPO,
				env: TEST_ENV,
			});
			expect(results[1].exitCode).toBe(128);
			expect(results[1].stderr).toContain("incompatible");
		});

		test("--detach and -c are incompatible", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "first"', "git switch --detach -c test"],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			expect(results[3].exitCode).toBe(128);
			expect(results[3].stderr).toContain("incompatible");
		});
	});
});
