import { describe, expect, test } from "bun:test";
import { BASIC_REPO, EMPTY_REPO, NESTED_REPO } from "../fixtures";
import { createTestBash, pathExists, runScenario } from "../util";

const TEST_ENV = {
	GIT_AUTHOR_NAME: "Test",
	GIT_AUTHOR_EMAIL: "test@test.com",
	GIT_COMMITTER_NAME: "Test",
	GIT_COMMITTER_EMAIL: "test@test.com",
};

describe("git rm", () => {
	describe("outside a git repo", () => {
		test("fails with exit 128", async () => {
			const { results } = await runScenario(["git rm file.txt"], {
				files: EMPTY_REPO,
			});
			expect(results[0].exitCode).toBe(128);
			expect(results[0].stderr).toContain("not a git repository");
		});
	});

	describe("with no arguments", () => {
		test("prints usage and exits 1", async () => {
			const { results } = await runScenario(["git init", "git rm"], {
				files: EMPTY_REPO,
			});
			expect(results[1].exitCode).toBe(1);
			expect(results[1].stderr).toContain("usage:");
		});
	});

	describe("basic removal", () => {
		test("removes a committed file from index and working tree", async () => {
			const bash = createTestBash({ files: BASIC_REPO });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"', { env: TEST_ENV });

			const result = await bash.exec("git rm README.md");
			expect(result.exitCode).toBe(0);

			// File should be gone from working tree
			expect(await pathExists(bash.fs, "/repo/README.md")).toBe(false);

			// Status should show staged deletion
			const status = await bash.exec("git status");
			expect(status.stdout).toContain("deleted");
			expect(status.stdout).toContain("README.md");
		});

		test("removes multiple files", async () => {
			const bash = createTestBash({ files: BASIC_REPO });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"', { env: TEST_ENV });

			const result = await bash.exec("git rm README.md src/main.ts");
			expect(result.exitCode).toBe(0);

			expect(await pathExists(bash.fs, "/repo/README.md")).toBe(false);
			expect(await pathExists(bash.fs, "/repo/src/main.ts")).toBe(false);
		});

		test("works when file was already deleted from working tree", async () => {
			const bash = createTestBash({ files: BASIC_REPO });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"', { env: TEST_ENV });

			// Delete from working tree manually
			await bash.fs.rm("/repo/README.md");

			// git rm should still succeed (removes from index)
			const result = await bash.exec("git rm README.md");
			expect(result.exitCode).toBe(0);

			const status = await bash.exec("git status");
			expect(status.stdout).toContain("deleted");
			expect(status.stdout).toContain("README.md");
		});
	});

	describe("--cached", () => {
		test("removes from index but leaves file on disk", async () => {
			const bash = createTestBash({ files: BASIC_REPO });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"', { env: TEST_ENV });

			const result = await bash.exec("git rm --cached README.md");
			expect(result.exitCode).toBe(0);

			// File should still exist on disk
			expect(await pathExists(bash.fs, "/repo/README.md")).toBe(true);

			// Status: staged deletion + untracked
			const status = await bash.exec("git status");
			expect(status.stdout).toContain("deleted");
			expect(status.stdout).toContain("README.md");
		});

		test("can unstage a newly added file", async () => {
			const bash = createTestBash({ files: BASIC_REPO });
			await bash.exec("git init");
			await bash.exec("git add README.md");

			// File is staged but not committed
			const result = await bash.exec("git rm --cached README.md");
			expect(result.exitCode).toBe(0);

			// File should still exist
			expect(await pathExists(bash.fs, "/repo/README.md")).toBe(true);

			// File should now be untracked
			const status = await bash.exec("git status");
			expect(status.stdout).toContain("Untracked files");
			expect(status.stdout).toContain("README.md");
		});
	});

	describe("-r (recursive)", () => {
		test("removes a directory recursively", async () => {
			const bash = createTestBash({ files: NESTED_REPO });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"', { env: TEST_ENV });

			const result = await bash.exec("git rm -r src");
			expect(result.exitCode).toBe(0);

			expect(await pathExists(bash.fs, "/repo/src/index.ts")).toBe(false);
			expect(await pathExists(bash.fs, "/repo/src/lib/math.ts")).toBe(false);
			expect(await pathExists(bash.fs, "/repo/src/lib/string.ts")).toBe(false);

			// Other files should be untouched
			expect(await pathExists(bash.fs, "/repo/README.md")).toBe(true);
			expect(await pathExists(bash.fs, "/repo/docs/guide.md")).toBe(true);
		});

		test("refuses to remove a directory without -r", async () => {
			const bash = createTestBash({ files: NESTED_REPO });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"', { env: TEST_ENV });

			const result = await bash.exec("git rm src");
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("not removing 'src' recursively without -r");
		});

		test("--cached -r removes directory from index only", async () => {
			const bash = createTestBash({ files: NESTED_REPO });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"', { env: TEST_ENV });

			const result = await bash.exec("git rm --cached -r src");
			expect(result.exitCode).toBe(0);

			// Files should still exist on disk
			expect(await pathExists(bash.fs, "/repo/src/index.ts")).toBe(true);
			expect(await pathExists(bash.fs, "/repo/src/lib/math.ts")).toBe(true);

			// Status should show staged deletions
			const status = await bash.exec("git status");
			expect(status.stdout).toContain("deleted");
			expect(status.stdout).toContain("src/index.ts");
		});
	});

	describe("safety checks", () => {
		test("refuses when file has staged changes", async () => {
			const bash = createTestBash({ files: BASIC_REPO });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"', { env: TEST_ENV });

			// Modify and stage
			await bash.fs.writeFile("/repo/README.md", "# Modified");
			await bash.exec("git add README.md");

			const result = await bash.exec("git rm README.md");
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("changes staged in the index");
			expect(result.stderr).toContain("README.md");

			// File should still exist
			expect(await pathExists(bash.fs, "/repo/README.md")).toBe(true);
		});

		test("refuses when file has unstaged modifications", async () => {
			const bash = createTestBash({ files: BASIC_REPO });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"', { env: TEST_ENV });

			// Modify without staging
			await bash.fs.writeFile("/repo/README.md", "# Modified");

			const result = await bash.exec("git rm README.md");
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("local modifications");
			expect(result.stderr).toContain("README.md");
		});

		test("refuses when file has both staged and unstaged changes", async () => {
			const bash = createTestBash({ files: BASIC_REPO });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"', { env: TEST_ENV });

			// Stage a modification
			await bash.fs.writeFile("/repo/README.md", "# Staged");
			await bash.exec("git add README.md");

			// Modify again without staging
			await bash.fs.writeFile("/repo/README.md", "# Both");

			const result = await bash.exec("git rm README.md");
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("staged content different from both");
		});

		test("--cached refuses when both staged and unstaged changes exist", async () => {
			const bash = createTestBash({ files: BASIC_REPO });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"', { env: TEST_ENV });

			// Stage a modification
			await bash.fs.writeFile("/repo/README.md", "# Staged");
			await bash.exec("git add README.md");

			// Modify again
			await bash.fs.writeFile("/repo/README.md", "# Both");

			const result = await bash.exec("git rm --cached README.md");
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("staged content different from both");
		});

		test("--cached allows removal with only staged changes", async () => {
			const bash = createTestBash({ files: BASIC_REPO });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"', { env: TEST_ENV });

			// Stage a modification
			await bash.fs.writeFile("/repo/README.md", "# Staged");
			await bash.exec("git add README.md");

			const result = await bash.exec("git rm --cached README.md");
			expect(result.exitCode).toBe(0);

			// File should still be on disk
			expect(await pathExists(bash.fs, "/repo/README.md")).toBe(true);
		});

		test("--cached allows removal with only unstaged changes", async () => {
			const bash = createTestBash({ files: BASIC_REPO });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"', { env: TEST_ENV });

			// Modify without staging
			await bash.fs.writeFile("/repo/README.md", "# Modified");

			const result = await bash.exec("git rm --cached README.md");
			expect(result.exitCode).toBe(0);
		});
	});

	describe("-f (force)", () => {
		test("bypasses staged changes check", async () => {
			const bash = createTestBash({ files: BASIC_REPO });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"', { env: TEST_ENV });

			await bash.fs.writeFile("/repo/README.md", "# Staged");
			await bash.exec("git add README.md");

			const result = await bash.exec("git rm -f README.md");
			expect(result.exitCode).toBe(0);
			expect(await pathExists(bash.fs, "/repo/README.md")).toBe(false);
		});

		test("bypasses unstaged changes check", async () => {
			const bash = createTestBash({ files: BASIC_REPO });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"', { env: TEST_ENV });

			await bash.fs.writeFile("/repo/README.md", "# Modified");

			const result = await bash.exec("git rm -f README.md");
			expect(result.exitCode).toBe(0);
			expect(await pathExists(bash.fs, "/repo/README.md")).toBe(false);
		});

		test("bypasses both staged + unstaged changes check", async () => {
			const bash = createTestBash({ files: BASIC_REPO });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"', { env: TEST_ENV });

			await bash.fs.writeFile("/repo/README.md", "# Staged");
			await bash.exec("git add README.md");
			await bash.fs.writeFile("/repo/README.md", "# Both");

			const result = await bash.exec("git rm -f README.md");
			expect(result.exitCode).toBe(0);
			expect(await pathExists(bash.fs, "/repo/README.md")).toBe(false);
		});
	});

	describe("error cases", () => {
		test("fails on untracked file", async () => {
			const bash = createTestBash({ files: BASIC_REPO });
			await bash.exec("git init");

			// README.md exists but is not tracked
			const result = await bash.exec("git rm README.md");
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("did not match any files");
		});

		test("fails on nonexistent file", async () => {
			const bash = createTestBash({ files: BASIC_REPO });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"', { env: TEST_ENV });

			const result = await bash.exec("git rm nonexistent.txt");
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("did not match any files");
		});
	});
});
