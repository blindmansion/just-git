import { describe, expect, test } from "bun:test";
import { EMPTY_REPO, TEST_ENV_NAMED as TEST_ENV } from "../fixtures";
import { createTestBash, quickExec, readFile, runScenario } from "../util";

describe("git restore", () => {
	describe("errors", () => {
		test("fails outside a git repo", async () => {
			const result = await quickExec("git restore file.txt", {
				files: EMPTY_REPO,
			});
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("not a git repository");
		});

		test("fails with no paths", async () => {
			const { results } = await runScenario(["git init", "git restore"], {
				files: EMPTY_REPO,
				env: TEST_ENV,
			});
			expect(results[1].exitCode).toBe(128);
			expect(results[1].stderr).toContain("you must specify path(s) to restore");
		});

		test("fails with invalid source", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "init"');

			const result = await bash.exec("git restore --source nonexistent file.txt");
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("could not resolve 'nonexistent'");
		});
	});

	describe("restore worktree from index (default)", () => {
		test("restores a modified file", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "init"');

			await bash.fs.writeFile("/repo/README.md", "modified!");
			const before = await readFile(bash.fs, "/repo/README.md");
			expect(before).toBe("modified!");

			const result = await bash.exec("git restore README.md");
			expect(result.exitCode).toBe(0);

			const after = await readFile(bash.fs, "/repo/README.md");
			expect(after).toBe("# My Project");
		});

		test("fails for unknown path", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "init"');

			const result = await bash.exec("git restore nonexistent.txt");
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("did not match any file(s)");
		});

		test("supports glob pathspecs", async () => {
			const bash = createTestBash({
				files: {
					"/repo/a.txt": "a-original",
					"/repo/b.txt": "b-original",
					"/repo/c.md": "c-original",
				},
				env: TEST_ENV,
			});
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "init"');

			await bash.fs.writeFile("/repo/a.txt", "a-modified");
			await bash.fs.writeFile("/repo/b.txt", "b-modified");
			await bash.fs.writeFile("/repo/c.md", "c-modified");

			const result = await bash.exec("git restore '*.txt'");
			expect(result.exitCode).toBe(0);

			expect(await readFile(bash.fs, "/repo/a.txt")).toBe("a-original");
			expect(await readFile(bash.fs, "/repo/b.txt")).toBe("b-original");
			expect(await readFile(bash.fs, "/repo/c.md")).toBe("c-modified");
		});
	});

	describe("restore --staged (unstage)", () => {
		test("unstages a file from HEAD", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "init"');

			await bash.fs.writeFile("/repo/README.md", "staged change");
			await bash.exec("git add README.md");

			// Verify it's staged
			const statusBefore = await bash.exec("git status --porcelain");
			expect(statusBefore.stdout).toContain("M  README.md");

			const result = await bash.exec("git restore --staged README.md");
			expect(result.exitCode).toBe(0);

			// After unstaging, the file should show as unstaged modification
			const statusAfter = await bash.exec("git status --porcelain");
			expect(statusAfter.stdout).toContain(" M README.md");

			// Worktree should still have the modified content
			const content = await readFile(bash.fs, "/repo/README.md");
			expect(content).toBe("staged change");
		});

		test("unstages a new file (removes from index)", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "init"');

			await bash.fs.writeFile("/repo/new.txt", "new content");
			await bash.exec("git add new.txt");

			const statusBefore = await bash.exec("git status --porcelain");
			expect(statusBefore.stdout).toContain("A  new.txt");

			const result = await bash.exec("git restore --staged new.txt");
			expect(result.exitCode).toBe(0);

			const statusAfter = await bash.exec("git status --porcelain");
			expect(statusAfter.stdout).toContain("?? new.txt");
		});
	});

	describe("restore --source", () => {
		test("restores worktree from a specific commit", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "v1"');

			await bash.fs.writeFile("/repo/README.md", "version 2");
			await bash.exec("git add README.md");
			await bash.exec('git commit -m "v2"');

			const result = await bash.exec("git restore --source HEAD~1 README.md");
			expect(result.exitCode).toBe(0);

			const content = await readFile(bash.fs, "/repo/README.md");
			expect(content).toBe("# My Project");
		});

		test("restores from a branch name", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "init"');
			await bash.exec("git switch -c feature");
			await bash.fs.writeFile("/repo/README.md", "feature version");
			await bash.exec("git add README.md");
			await bash.exec('git commit -m "feature"');
			await bash.exec("git switch main");

			const result = await bash.exec("git restore --source feature README.md");
			expect(result.exitCode).toBe(0);
			const content = await readFile(bash.fs, "/repo/README.md");
			expect(content).toBe("feature version");
		});
	});

	describe("restore --staged --worktree", () => {
		test("restores both index and worktree from HEAD", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "init"');

			await bash.fs.writeFile("/repo/README.md", "modified");
			await bash.exec("git add README.md");

			const result = await bash.exec("git restore --staged --worktree README.md");
			expect(result.exitCode).toBe(0);

			const content = await readFile(bash.fs, "/repo/README.md");
			expect(content).toBe("# My Project");

			const status = await bash.exec("git status --porcelain");
			expect(status.stdout.trim()).toBe("");
		});

		test("restores both from a specific source", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "v1"');

			await bash.fs.writeFile("/repo/README.md", "version 2");
			await bash.exec("git add README.md");
			await bash.exec('git commit -m "v2"');

			await bash.fs.writeFile("/repo/README.md", "version 3");
			await bash.exec("git add README.md");

			const result = await bash.exec("git restore --source HEAD~1 --staged --worktree README.md");
			expect(result.exitCode).toBe(0);

			const content = await readFile(bash.fs, "/repo/README.md");
			expect(content).toBe("# My Project");
		});
	});

	describe("--ours / --theirs", () => {
		test("restores conflicted file with --ours", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "init"');

			await bash.exec("git checkout -b feature");
			await bash.fs.writeFile("/repo/README.md", "feature version");
			await bash.exec("git add README.md");
			await bash.exec('git commit -m "feature"');

			await bash.exec("git checkout main");
			await bash.fs.writeFile("/repo/README.md", "main version");
			await bash.exec("git add README.md");
			await bash.exec('git commit -m "main change"');

			const merge = await bash.exec("git merge feature");
			expect(merge.exitCode).toBe(1);

			const result = await bash.exec("git restore --ours -- README.md");
			expect(result.exitCode).toBe(0);

			const content = await readFile(bash.fs, "/repo/README.md");
			expect(content).toBe("main version");
		});

		test("restores conflicted file with --theirs", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "init"');

			await bash.exec("git checkout -b feature");
			await bash.fs.writeFile("/repo/README.md", "feature version");
			await bash.exec("git add README.md");
			await bash.exec('git commit -m "feature"');

			await bash.exec("git checkout main");
			await bash.fs.writeFile("/repo/README.md", "main version");
			await bash.exec("git add README.md");
			await bash.exec('git commit -m "main change"');

			const merge = await bash.exec("git merge feature");
			expect(merge.exitCode).toBe(1);

			const result = await bash.exec("git restore --theirs -- README.md");
			expect(result.exitCode).toBe(0);

			const content = await readFile(bash.fs, "/repo/README.md");
			expect(content).toBe("feature version");
		});

		test("--ours/--theirs incompatible with --source", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "init"');

			const result = await bash.exec("git restore --ours --source HEAD README.md");
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("cannot specify both --source and --ours/--theirs");
		});
	});
});
