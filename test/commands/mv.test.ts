import { describe, expect, test } from "bun:test";
import { BASIC_REPO, EMPTY_REPO, NESTED_REPO } from "../fixtures";
import { createTestBash, pathExists, readFile, runScenario } from "../util";

const TEST_ENV = {
	GIT_AUTHOR_NAME: "Test",
	GIT_AUTHOR_EMAIL: "test@test.com",
	GIT_COMMITTER_NAME: "Test",
	GIT_COMMITTER_EMAIL: "test@test.com",
};

describe("git mv", () => {
	describe("outside a git repo", () => {
		test("fails with exit 128", async () => {
			const { results } = await runScenario(["git mv file.txt other.txt"], {
				files: EMPTY_REPO,
			});
			expect(results[0].exitCode).toBe(128);
			expect(results[0].stderr).toContain("not a git repository");
		});
	});

	describe("with insufficient arguments", () => {
		test("prints usage with no args", async () => {
			const { results } = await runScenario(["git init", "git mv"], {
				files: EMPTY_REPO,
			});
			expect(results[1].exitCode).toBe(1);
			expect(results[1].stderr).toContain("usage:");
		});

		test("prints usage with one arg", async () => {
			const { results } = await runScenario(["git init", "git mv file.txt"], {
				files: EMPTY_REPO,
			});
			expect(results[1].exitCode).toBe(1);
			expect(results[1].stderr).toContain("usage:");
		});
	});

	describe("basic rename", () => {
		test("renames a tracked file", async () => {
			const bash = createTestBash({ files: BASIC_REPO });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"', { env: TEST_ENV });

			const result = await bash.exec("git mv README.md CHANGELOG.md");
			expect(result.exitCode).toBe(0);

			// Old file gone, new file exists
			expect(await pathExists(bash.fs, "/repo/README.md")).toBe(false);
			expect(await pathExists(bash.fs, "/repo/CHANGELOG.md")).toBe(true);

			// Content preserved
			const content = await readFile(bash.fs, "/repo/CHANGELOG.md");
			expect(content).toBe("# My Project");

			// Status shows rename
			const status = await bash.exec("git status");
			expect(status.stdout).toContain("renamed:");
			expect(status.stdout).toContain("README.md -> CHANGELOG.md");
		});

		test("renames a file in a subdirectory", async () => {
			const bash = createTestBash({ files: BASIC_REPO });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"', { env: TEST_ENV });

			const result = await bash.exec("git mv src/main.ts src/app.ts");
			expect(result.exitCode).toBe(0);

			expect(await pathExists(bash.fs, "/repo/src/main.ts")).toBe(false);
			expect(await pathExists(bash.fs, "/repo/src/app.ts")).toBe(true);

			const content = await readFile(bash.fs, "/repo/src/app.ts");
			expect(content).toBe('console.log("hello world");');
		});

		test("moves a file into an existing directory", async () => {
			const bash = createTestBash({ files: BASIC_REPO });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"', { env: TEST_ENV });

			const result = await bash.exec("git mv README.md src");
			expect(result.exitCode).toBe(0);

			expect(await pathExists(bash.fs, "/repo/README.md")).toBe(false);
			expect(await pathExists(bash.fs, "/repo/src/README.md")).toBe(true);
		});

		test("moves a file into a new directory (if parent exists)", async () => {
			const bash = createTestBash({ files: BASIC_REPO });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"', { env: TEST_ENV });

			// Create the parent directory first (real git doesn't auto-create)
			await bash.fs.mkdir("/repo/docs");
			const result = await bash.exec("git mv README.md docs/README.md");
			expect(result.exitCode).toBe(0);

			expect(await pathExists(bash.fs, "/repo/README.md")).toBe(false);
			expect(await pathExists(bash.fs, "/repo/docs/README.md")).toBe(true);
		});

		test("fails when destination directory does not exist", async () => {
			const bash = createTestBash({ files: BASIC_REPO });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"', { env: TEST_ENV });

			const result = await bash.exec("git mv README.md nonexistent/README.md");
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("No such file or directory");
		});

		test("produces no stdout on success", async () => {
			const bash = createTestBash({ files: BASIC_REPO });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"', { env: TEST_ENV });

			const result = await bash.exec("git mv README.md CHANGELOG.md");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toBe("");
		});
	});

	describe("directory rename", () => {
		test("renames a directory", async () => {
			const bash = createTestBash({ files: NESTED_REPO });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"', { env: TEST_ENV });

			const result = await bash.exec("git mv src lib");
			expect(result.exitCode).toBe(0);

			// Old directory gone
			expect(await pathExists(bash.fs, "/repo/src/index.ts")).toBe(false);
			expect(await pathExists(bash.fs, "/repo/src/lib/math.ts")).toBe(false);

			// New directory has the files
			expect(await pathExists(bash.fs, "/repo/lib/index.ts")).toBe(true);
			expect(await pathExists(bash.fs, "/repo/lib/lib/math.ts")).toBe(true);

			// Other files untouched
			expect(await pathExists(bash.fs, "/repo/README.md")).toBe(true);
			expect(await pathExists(bash.fs, "/repo/docs/guide.md")).toBe(true);

			// Status shows renames
			const status = await bash.exec("git status");
			expect(status.stdout).toContain("renamed:");
		});

		test("moves a directory into another existing directory", async () => {
			const bash = createTestBash({ files: NESTED_REPO });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"', { env: TEST_ENV });

			const result = await bash.exec("git mv src docs");
			expect(result.exitCode).toBe(0);

			expect(await pathExists(bash.fs, "/repo/docs/src/index.ts")).toBe(true);
			expect(await pathExists(bash.fs, "/repo/docs/src/lib/math.ts")).toBe(true);
		});
	});

	describe("multiple sources", () => {
		test("moves multiple files into a directory", async () => {
			const bash = createTestBash({ files: BASIC_REPO });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"', { env: TEST_ENV });

			// Create a target dir
			await bash.fs.mkdir("/repo/archive");

			const result = await bash.exec("git mv README.md src/main.ts archive");
			expect(result.exitCode).toBe(0);

			expect(await pathExists(bash.fs, "/repo/archive/README.md")).toBe(true);
			expect(await pathExists(bash.fs, "/repo/archive/main.ts")).toBe(true);
			expect(await pathExists(bash.fs, "/repo/README.md")).toBe(false);
			expect(await pathExists(bash.fs, "/repo/src/main.ts")).toBe(false);
		});

		test("fails if destination is not a directory for multiple sources", async () => {
			const bash = createTestBash({ files: BASIC_REPO });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"', { env: TEST_ENV });

			const result = await bash.exec("git mv README.md src/main.ts nonexistent");
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("does not exist");
		});
	});

	describe("--force", () => {
		test("overwrites existing file at destination", async () => {
			const bash = createTestBash({ files: BASIC_REPO });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"', { env: TEST_ENV });

			// Without force: should fail
			const fail = await bash.exec("git mv README.md src/main.ts");
			expect(fail.exitCode).toBe(128);
			expect(fail.stderr).toContain("destination exists");

			// With force: should succeed
			const result = await bash.exec("git mv -f README.md src/main.ts");
			expect(result.exitCode).toBe(0);

			expect(await pathExists(bash.fs, "/repo/README.md")).toBe(false);
			const content = await readFile(bash.fs, "/repo/src/main.ts");
			expect(content).toBe("# My Project");
		});
	});

	describe("--dry-run / -n", () => {
		test("does nothing but exits 0", async () => {
			const bash = createTestBash({ files: BASIC_REPO });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"', { env: TEST_ENV });

			const result = await bash.exec("git mv -n README.md CHANGELOG.md");
			expect(result.exitCode).toBe(0);

			// File should NOT have been moved
			expect(await pathExists(bash.fs, "/repo/README.md")).toBe(true);
			expect(await pathExists(bash.fs, "/repo/CHANGELOG.md")).toBe(false);
		});
	});

	describe("-k (skip errors)", () => {
		test("skips untracked sources instead of failing", async () => {
			const bash = createTestBash({ files: BASIC_REPO });
			await bash.exec("git init");
			await bash.exec("git add README.md");
			await bash.exec('git commit -m "initial"', { env: TEST_ENV });

			// src/main.ts is not tracked — without -k it would fail
			await bash.fs.mkdir("/repo/archive");
			const result = await bash.exec("git mv -k README.md src/main.ts archive");
			expect(result.exitCode).toBe(0);

			// README.md was tracked, so it gets moved
			expect(await pathExists(bash.fs, "/repo/archive/README.md")).toBe(true);
			// src/main.ts was not tracked, so it's skipped (still in place)
			expect(await pathExists(bash.fs, "/repo/src/main.ts")).toBe(true);
		});
	});

	describe("error cases", () => {
		test("fails when source does not exist", async () => {
			const bash = createTestBash({ files: BASIC_REPO });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"', { env: TEST_ENV });

			const result = await bash.exec("git mv nonexistent.txt other.txt");
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("bad source");
		});

		test("fails when source is not tracked", async () => {
			const bash = createTestBash({ files: BASIC_REPO });
			await bash.exec("git init");
			// Don't add anything

			const result = await bash.exec("git mv README.md CHANGELOG.md");
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("not under version control");
		});

		test("fails when destination exists and no force", async () => {
			const bash = createTestBash({ files: BASIC_REPO });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"', { env: TEST_ENV });

			const result = await bash.exec("git mv README.md src/main.ts");
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("destination exists");
		});
	});

	describe("empty directory cleanup", () => {
		test("removes empty parent directories after move", async () => {
			const bash = createTestBash({
				files: {
					"/repo/a/b/c/file.txt": "content",
				},
			});
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"', { env: TEST_ENV });

			const result = await bash.exec("git mv a/b/c/file.txt file.txt");
			expect(result.exitCode).toBe(0);

			expect(await pathExists(bash.fs, "/repo/file.txt")).toBe(true);
			// Empty parent dirs should be cleaned up
			expect(await pathExists(bash.fs, "/repo/a/b/c")).toBe(false);
			expect(await pathExists(bash.fs, "/repo/a/b")).toBe(false);
			expect(await pathExists(bash.fs, "/repo/a")).toBe(false);
		});
	});
});
