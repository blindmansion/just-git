import { describe, expect, test } from "bun:test";
import { BASIC_REPO, EMPTY_REPO, NESTED_REPO } from "../fixtures";
import { createTestBash, pathExists, runScenario } from "../util";

const TEST_ENV = {
	GIT_AUTHOR_NAME: "Test",
	GIT_AUTHOR_EMAIL: "test@test.com",
	GIT_COMMITTER_NAME: "Test",
	GIT_COMMITTER_EMAIL: "test@test.com",
};

describe("git clean", () => {
	describe("outside a git repo", () => {
		test("fails with exit 128", async () => {
			const { results } = await runScenario(["git clean -f"], {
				files: EMPTY_REPO,
			});
			expect(results[0].exitCode).toBe(128);
			expect(results[0].stderr).toContain("not a git repository");
		});
	});

	describe("requires -f flag", () => {
		test("refuses without -f or -n", async () => {
			const { results } = await runScenario(["git init", "git clean"], {
				files: EMPTY_REPO,
			});
			expect(results[1].exitCode).toBe(128);
			expect(results[1].stderr).toContain("refusing to clean");
		});

		test("allows -n without -f", async () => {
			const { results } = await runScenario(["git init", "git clean -n"], {
				files: EMPTY_REPO,
			});
			expect(results[1].exitCode).toBe(0);
		});
	});

	describe("basic file removal", () => {
		test("removes untracked files", async () => {
			const bash = createTestBash({ files: BASIC_REPO });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"', { env: TEST_ENV });

			// Create untracked files
			await bash.fs.writeFile("/repo/untracked.txt", "junk");
			await bash.fs.writeFile("/repo/temp.log", "log data");

			const result = await bash.exec("git clean -f");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Removing temp.log");
			expect(result.stdout).toContain("Removing untracked.txt");

			expect(await pathExists(bash.fs, "/repo/untracked.txt")).toBe(false);
			expect(await pathExists(bash.fs, "/repo/temp.log")).toBe(false);
			// Tracked files should remain
			expect(await pathExists(bash.fs, "/repo/README.md")).toBe(true);
			expect(await pathExists(bash.fs, "/repo/src/main.ts")).toBe(true);
		});

		test("does not remove tracked files", async () => {
			const bash = createTestBash({ files: BASIC_REPO });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"', { env: TEST_ENV });

			const result = await bash.exec("git clean -f");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toBe("");

			expect(await pathExists(bash.fs, "/repo/README.md")).toBe(true);
		});

		test("does not remove staged but uncommitted files", async () => {
			const bash = createTestBash({ files: BASIC_REPO });
			await bash.exec("git init");
			await bash.exec("git add .");

			// staged.txt is in the index (tracked)
			await bash.fs.writeFile("/repo/staged.txt", "staged content");
			await bash.exec("git add staged.txt");

			// untracked.txt is not in the index
			await bash.fs.writeFile("/repo/untracked.txt", "junk");

			const result = await bash.exec("git clean -f");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Removing untracked.txt");
			expect(result.stdout).not.toContain("staged.txt");

			expect(await pathExists(bash.fs, "/repo/staged.txt")).toBe(true);
			expect(await pathExists(bash.fs, "/repo/untracked.txt")).toBe(false);
		});
	});

	describe("-n / --dry-run", () => {
		test("shows what would be removed without removing", async () => {
			const bash = createTestBash({ files: BASIC_REPO });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"', { env: TEST_ENV });

			await bash.fs.writeFile("/repo/untracked.txt", "junk");

			const result = await bash.exec("git clean -n");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Would remove untracked.txt");

			// File should still exist
			expect(await pathExists(bash.fs, "/repo/untracked.txt")).toBe(true);
		});
	});

	describe("-d (remove directories)", () => {
		test("does not remove untracked dirs without -d", async () => {
			const bash = createTestBash({ files: BASIC_REPO });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"', { env: TEST_ENV });

			await bash.fs.mkdir("/repo/build", { recursive: true });
			await bash.fs.writeFile("/repo/build/output.js", "compiled");

			const result = await bash.exec("git clean -f");
			expect(result.exitCode).toBe(0);
			// Without -d, untracked directories are not traversed or removed.
			expect(result.stdout).toBe("");
			expect(await pathExists(bash.fs, "/repo/build/output.js")).toBe(true);
		});

		test("removes untracked dirs with -d", async () => {
			const bash = createTestBash({ files: BASIC_REPO });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"', { env: TEST_ENV });

			await bash.fs.mkdir("/repo/build", { recursive: true });
			await bash.fs.writeFile("/repo/build/output.js", "compiled");
			await bash.fs.mkdir("/repo/build/sub", { recursive: true });
			await bash.fs.writeFile("/repo/build/sub/nested.js", "nested");

			const result = await bash.exec("git clean -fd");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Removing build/");

			expect(await pathExists(bash.fs, "/repo/build")).toBe(false);
		});

		test("does not collapse dirs that contain tracked files", async () => {
			const bash = createTestBash({ files: BASIC_REPO });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"', { env: TEST_ENV });

			// src/ has tracked files, so adding an untracked file in src/
			// should not collapse it
			await bash.fs.writeFile("/repo/src/temp.js", "temp");

			const result = await bash.exec("git clean -fd");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Removing src/temp.js");
			// Should not collapse src/ as a whole directory
			expect(result.stdout).not.toMatch(/Removing src\/\n/);

			// Tracked files should remain
			expect(await pathExists(bash.fs, "/repo/src/main.ts")).toBe(true);
		});
	});

	describe("-x (remove ignored files)", () => {
		test("normally skips ignored files", async () => {
			const bash = createTestBash({
				files: {
					...BASIC_REPO,
					"/repo/.gitignore": "*.log\nbuild/\n",
				},
			});
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"', { env: TEST_ENV });

			await bash.fs.writeFile("/repo/debug.log", "log data");
			await bash.fs.writeFile("/repo/untracked.txt", "junk");

			const result = await bash.exec("git clean -f");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Removing untracked.txt");
			expect(result.stdout).not.toContain("debug.log");

			expect(await pathExists(bash.fs, "/repo/debug.log")).toBe(true);
		});

		test("removes ignored files with -x", async () => {
			const bash = createTestBash({
				files: {
					...BASIC_REPO,
					"/repo/.gitignore": "*.log\n",
				},
			});
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"', { env: TEST_ENV });

			await bash.fs.writeFile("/repo/debug.log", "log data");
			await bash.fs.writeFile("/repo/untracked.txt", "junk");

			const result = await bash.exec("git clean -fx");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Removing debug.log");
			expect(result.stdout).toContain("Removing untracked.txt");

			expect(await pathExists(bash.fs, "/repo/debug.log")).toBe(false);
			expect(await pathExists(bash.fs, "/repo/untracked.txt")).toBe(false);
		});

		test("does not recurse into untracked dirs without -d", async () => {
			const bash = createTestBash({
				files: {
					...BASIC_REPO,
					"/repo/.gitignore": "*.log\n",
				},
			});
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"', { env: TEST_ENV });

			await bash.fs.mkdir("/repo/build", { recursive: true });
			await bash.fs.writeFile("/repo/build/debug.log", "nested log");
			await bash.fs.writeFile("/repo/build/keep.txt", "keep");
			await bash.fs.writeFile("/repo/root.log", "root log");

			const result = await bash.exec("git clean -fx");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Removing root.log");
			expect(result.stdout).not.toContain("build/debug.log");

			expect(await pathExists(bash.fs, "/repo/root.log")).toBe(false);
			expect(await pathExists(bash.fs, "/repo/build/debug.log")).toBe(true);
			expect(await pathExists(bash.fs, "/repo/build/keep.txt")).toBe(true);
		});
	});

	describe("-X (remove only ignored files)", () => {
		test("removes only ignored files", async () => {
			const bash = createTestBash({
				files: {
					...BASIC_REPO,
					"/repo/.gitignore": "*.log\n",
				},
			});
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"', { env: TEST_ENV });

			await bash.fs.writeFile("/repo/debug.log", "log data");
			await bash.fs.writeFile("/repo/untracked.txt", "junk");

			const result = await bash.exec("git clean -fX");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Removing debug.log");
			expect(result.stdout).not.toContain("untracked.txt");

			expect(await pathExists(bash.fs, "/repo/debug.log")).toBe(false);
			expect(await pathExists(bash.fs, "/repo/untracked.txt")).toBe(true);
		});

		test("removes only ignored directories with -Xd", async () => {
			const bash = createTestBash({
				files: {
					...BASIC_REPO,
					"/repo/.gitignore": "build/\n",
				},
			});
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"', { env: TEST_ENV });

			await bash.fs.mkdir("/repo/build", { recursive: true });
			await bash.fs.writeFile("/repo/build/output.js", "compiled");
			await bash.fs.mkdir("/repo/newdir", { recursive: true });
			await bash.fs.writeFile("/repo/newdir/file.txt", "data");

			const result = await bash.exec("git clean -fXd");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Removing build/");
			expect(result.stdout).not.toContain("newdir");

			expect(await pathExists(bash.fs, "/repo/build")).toBe(false);
			expect(await pathExists(bash.fs, "/repo/newdir/file.txt")).toBe(true);
		});

		test("recurses into non-ignored dirs for ignored files", async () => {
			const bash = createTestBash({
				files: {
					...BASIC_REPO,
					"/repo/.gitignore": "*.log\nbuild/\n",
				},
			});
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"', { env: TEST_ENV });

			await bash.fs.writeFile("/repo/root.log", "root");
			await bash.fs.mkdir("/repo/tmp", { recursive: true });
			await bash.fs.writeFile("/repo/tmp/inner.log", "inner");
			await bash.fs.mkdir("/repo/build", { recursive: true });
			await bash.fs.writeFile("/repo/build/ignored.log", "ignored dir");

			const result = await bash.exec("git clean -fX");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Removing root.log");
			expect(result.stdout).toContain("Removing tmp/inner.log");
			expect(result.stdout).not.toContain("build/ignored.log");

			expect(await pathExists(bash.fs, "/repo/root.log")).toBe(false);
			expect(await pathExists(bash.fs, "/repo/tmp/inner.log")).toBe(false);
			expect(await pathExists(bash.fs, "/repo/build/ignored.log")).toBe(true);
		});
	});

	describe("-e / --exclude", () => {
		test("excludes files matching the pattern", async () => {
			const bash = createTestBash({ files: BASIC_REPO });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"', { env: TEST_ENV });

			await bash.fs.writeFile("/repo/keep.txt", "keep me");
			await bash.fs.writeFile("/repo/remove.log", "remove me");

			const result = await bash.exec("git clean -f -e '*.txt'");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Removing remove.log");
			expect(result.stdout).not.toContain("keep.txt");

			expect(await pathExists(bash.fs, "/repo/keep.txt")).toBe(true);
			expect(await pathExists(bash.fs, "/repo/remove.log")).toBe(false);
		});
	});

	describe("pathspec filtering", () => {
		test("only cleans files matching pathspec", async () => {
			const bash = createTestBash({ files: NESTED_REPO });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"', { env: TEST_ENV });

			await bash.fs.writeFile("/repo/src/temp.ts", "temp");
			await bash.fs.writeFile("/repo/docs/temp.md", "temp");
			await bash.fs.writeFile("/repo/untracked.txt", "junk");

			const result = await bash.exec("git clean -f src/");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Removing src/temp.ts");
			expect(result.stdout).not.toContain("docs/temp.md");
			expect(result.stdout).not.toContain("untracked.txt");

			expect(await pathExists(bash.fs, "/repo/src/temp.ts")).toBe(false);
			expect(await pathExists(bash.fs, "/repo/docs/temp.md")).toBe(true);
			expect(await pathExists(bash.fs, "/repo/untracked.txt")).toBe(true);
		});
	});

	describe("no untracked files", () => {
		test("produces no output when nothing to clean", async () => {
			const bash = createTestBash({ files: BASIC_REPO });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"', { env: TEST_ENV });

			const result = await bash.exec("git clean -f");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toBe("");
		});
	});

	describe("outside repo", () => {
		test("fails outside a git repo", async () => {
			const { results } = await runScenario(["git clean -f"], {
				files: { "/repo/file.txt": "data" },
			});
			expect(results[0].exitCode).toBe(128);
			expect(results[0].stderr).toContain("not a git repository");
		});
	});
});
