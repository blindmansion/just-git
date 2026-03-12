import { describe, expect, test } from "bun:test";
import { BASIC_REPO, EMPTY_REPO, NESTED_REPO, TEST_ENV } from "../fixtures";
import { createTestBash, quickExec, runScenario } from "../util";

describe("git add", () => {
	describe("outside a git repo", () => {
		test("fails with exit 128", async () => {
			const result = await quickExec("git add file.txt", {
				files: EMPTY_REPO,
			});
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("not a git repository");
		});
	});

	describe("with no arguments", () => {
		test("prints a warning when no paths are given", async () => {
			const { results } = await runScenario(["git init", "git add"], {
				files: EMPTY_REPO,
			});
			const result = results[1];
			expect(result.exitCode).toBe(0);
			expect(result.stderr).toContain("Nothing specified, nothing added");
		});
	});

	describe("staging a single file", () => {
		test("exits 0", async () => {
			const { results } = await runScenario(["git init", "git add README.md"], {
				files: EMPTY_REPO,
			});
			expect(results[1].exitCode).toBe(0);
		});

		test("file shows as staged in status", async () => {
			const { results } = await runScenario(["git init", "git add README.md", "git status"], {
				files: EMPTY_REPO,
			});
			const status = results[2];
			expect(status.stdout).toContain("new file");
			expect(status.stdout).toContain("README.md");
		});
	});

	describe("staging multiple files individually", () => {
		test("stages both files", async () => {
			const { results } = await runScenario(
				["git init", "git add src/main.ts", "git add src/util.ts", "git status"],
				{ files: BASIC_REPO },
			);
			const status = results[3];
			expect(status.stdout).toContain("src/main.ts");
			expect(status.stdout).toContain("src/util.ts");
		});
	});

	describe("staging a directory", () => {
		test("stages all files in the directory", async () => {
			const { results } = await runScenario(["git init", "git add src", "git status"], {
				files: BASIC_REPO,
			});
			const status = results[2];
			expect(status.stdout).toContain("src/main.ts");
			expect(status.stdout).toContain("src/util.ts");
		});
	});

	describe("staging with '.'", () => {
		test("stages all files in the repo", async () => {
			const { results } = await runScenario(["git init", "git add .", "git status"], {
				files: BASIC_REPO,
			});
			const status = results[2];
			expect(status.stdout).toContain("README.md");
			expect(status.stdout).toContain("src/main.ts");
			expect(status.stdout).toContain("src/util.ts");
		});

		test("stages nested directory structures", async () => {
			const { results } = await runScenario(["git init", "git add .", "git status"], {
				files: NESTED_REPO,
			});
			const status = results[2];
			expect(status.stdout).toContain("README.md");
			expect(status.stdout).toContain("src/index.ts");
			expect(status.stdout).toContain("src/lib/math.ts");
			expect(status.stdout).toContain("src/lib/string.ts");
			expect(status.stdout).toContain("docs/guide.md");
		});
	});

	describe("nonexistent file", () => {
		test("fails with exit 128", async () => {
			const { results } = await runScenario(["git init", "git add nonexistent.txt"], {
				files: EMPTY_REPO,
			});
			const result = results[1];
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("did not match any files");
		});
	});

	describe("deleted file", () => {
		test("removes a tracked file from the index when deleted", async () => {
			const bash = createTestBash({ files: BASIC_REPO });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"', {
				env: TEST_ENV,
			});

			// Delete a file from the working tree
			await bash.fs.rm("/repo/src/util.ts");

			// Stage the deletion
			await bash.exec("git add src/util.ts");

			// Status should show it as a staged deletion
			const status = await bash.exec("git status");
			expect(status.stdout).toContain("deleted");
			expect(status.stdout).toContain("src/util.ts");
		});
	});

	describe("re-staging a modified file", () => {
		test("updates the index with the new content", async () => {
			const bash = createTestBash({ files: BASIC_REPO });
			await bash.exec("git init");
			await bash.exec("git add README.md");
			await bash.exec('git commit -m "initial"', {
				env: TEST_ENV,
			});

			// Modify the file
			await bash.fs.writeFile("/repo/README.md", "# Updated Project");

			// Stage the modification
			await bash.exec("git add README.md");

			// Status should show it as a staged modification
			const status = await bash.exec("git status");
			expect(status.stdout).toContain("modified");
			expect(status.stdout).toContain("README.md");
			// Should be in the "Changes to be committed" section
			expect(status.stdout).toContain("Changes to be committed");
		});
	});

	describe("-A / --all", () => {
		test("stages all files in the entire worktree without explicit paths", async () => {
			const bash = createTestBash({ files: NESTED_REPO });
			await bash.exec("git init");
			const result = await bash.exec("git add -A");
			expect(result.exitCode).toBe(0);

			const status = await bash.exec("git status");
			expect(status.stdout).toContain("README.md");
			expect(status.stdout).toContain("src/index.ts");
			expect(status.stdout).toContain("src/lib/math.ts");
			expect(status.stdout).toContain("src/lib/string.ts");
			expect(status.stdout).toContain("docs/guide.md");
		});

		test("stages deletions across entire worktree", async () => {
			const bash = createTestBash({ files: BASIC_REPO });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"', {
				env: TEST_ENV,
			});

			await bash.fs.rm("/repo/src/main.ts");
			await bash.fs.rm("/repo/src/util.ts");

			const result = await bash.exec("git add -A");
			expect(result.exitCode).toBe(0);

			const status = await bash.exec("git status");
			expect(status.stdout).toContain("deleted:");
			expect(status.stdout).toContain("src/main.ts");
			expect(status.stdout).toContain("src/util.ts");
		});

		test("--all long form works", async () => {
			const bash = createTestBash({ files: BASIC_REPO });
			await bash.exec("git init");
			const result = await bash.exec("git add --all");
			expect(result.exitCode).toBe(0);

			const status = await bash.exec("git status");
			expect(status.stdout).toContain("README.md");
			expect(status.stdout).toContain("src/main.ts");
		});
	});

	describe("--force / -f", () => {
		test("stages a file that is normally ignored", async () => {
			const bash = createTestBash({
				files: {
					"/repo/README.md": "# Hello",
					"/repo/.gitignore": "build/\n",
					"/repo/build/output.js": "console.log('built');",
				},
			});
			await bash.exec("git init");

			// Without --force, git add . should skip the ignored file
			await bash.exec("git add .");
			let status = await bash.exec("git status");
			expect(status.stdout).not.toContain("build/output.js");

			// With --force, the ignored file should be staged
			const result = await bash.exec("git add -f build/output.js");
			expect(result.exitCode).toBe(0);

			status = await bash.exec("git status");
			expect(status.stdout).toContain("build/output.js");
		});

		test("stages ignored files via directory with --force", async () => {
			const bash = createTestBash({
				files: {
					"/repo/.gitignore": "*.log\n",
					"/repo/app.ts": "export {};",
					"/repo/debug.log": "some logs",
					"/repo/error.log": "some errors",
				},
			});
			await bash.exec("git init");

			const result = await bash.exec("git add --force .");
			expect(result.exitCode).toBe(0);

			const status = await bash.exec("git status");
			expect(status.stdout).toContain("debug.log");
			expect(status.stdout).toContain("error.log");
			expect(status.stdout).toContain("app.ts");
		});
	});

	describe("-u / --update", () => {
		test("stages modifications and deletions but not new untracked files", async () => {
			const bash = createTestBash({ files: BASIC_REPO });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"', {
				env: TEST_ENV,
			});

			// Modify a tracked file
			await bash.fs.writeFile("/repo/README.md", "# Updated");
			// Delete a tracked file
			await bash.fs.rm("/repo/src/util.ts");
			// Create a new untracked file
			await bash.fs.writeFile("/repo/newfile.txt", "new content");

			const result = await bash.exec("git add -u");
			expect(result.exitCode).toBe(0);

			const status = await bash.exec("git status");
			// Modification should be staged
			expect(status.stdout).toContain("modified:");
			expect(status.stdout).toContain("README.md");
			// Deletion should be staged
			expect(status.stdout).toContain("deleted:");
			expect(status.stdout).toContain("src/util.ts");
			// New file should remain untracked
			expect(status.stdout).toContain("Untracked files:");
			expect(status.stdout).toContain("newfile.txt");
		});

		test("--update long form works", async () => {
			const bash = createTestBash({ files: BASIC_REPO });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"', {
				env: TEST_ENV,
			});

			await bash.fs.writeFile("/repo/README.md", "# Updated");
			await bash.fs.writeFile("/repo/newfile.txt", "untracked");

			const result = await bash.exec("git add --update");
			expect(result.exitCode).toBe(0);

			const status = await bash.exec("git status");
			expect(status.stdout).toContain("modified:");
			expect(status.stdout).toContain("Untracked files:");
			expect(status.stdout).toContain("newfile.txt");
		});

		test("-u with a path argument restricts to that path", async () => {
			const bash = createTestBash({ files: BASIC_REPO });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"', {
				env: TEST_ENV,
			});

			await bash.fs.writeFile("/repo/README.md", "# Changed");
			await bash.fs.writeFile("/repo/src/main.ts", "console.log('updated');");

			const result = await bash.exec("git add -u src");
			expect(result.exitCode).toBe(0);

			const status = await bash.exec("git status");
			// src/main.ts should be staged (inside src/)
			expect(status.stdout).toContain("modified:   src/main.ts");
			// README.md should NOT be staged (outside src/)
			expect(status.stdout).toContain("Changes not staged for commit:");
			expect(status.stdout).toContain("README.md");
		});
	});

	describe("-n / --dry-run", () => {
		test("shows what would be added without staging", async () => {
			const bash = createTestBash({ files: BASIC_REPO });
			await bash.exec("git init");

			const result = await bash.exec("git add -n .");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("add '");

			// Nothing should actually be staged
			const status = await bash.exec("git status");
			expect(status.stdout).not.toContain("Changes to be committed");
		});

		test("--dry-run long form works", async () => {
			const bash = createTestBash({ files: BASIC_REPO });
			await bash.exec("git init");

			const result = await bash.exec("git add --dry-run .");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("add '");

			const status = await bash.exec("git status");
			expect(status.stdout).not.toContain("Changes to be committed");
		});

		test("dry-run shows remove for deleted tracked files", async () => {
			const bash = createTestBash({ files: BASIC_REPO });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"', {
				env: TEST_ENV,
			});

			await bash.fs.rm("/repo/src/util.ts");

			const result = await bash.exec("git add -n src/util.ts");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("remove 'src/util.ts'");

			// Deletion should not actually be staged
			const status = await bash.exec("git status");
			expect(status.stdout).toContain("Changes not staged for commit:");
		});
	});

	describe("pathspec glob matching", () => {
		test("git add '*.ts' stages all .ts files", async () => {
			const bash = createTestBash({ files: NESTED_REPO });
			await bash.exec("git init");
			const result = await bash.exec("git add '*.ts'");
			expect(result.exitCode).toBe(0);

			const status = await bash.exec("git status");
			expect(status.stdout).toContain("src/index.ts");
			expect(status.stdout).toContain("src/lib/math.ts");
			expect(status.stdout).toContain("src/lib/string.ts");
			// .md files should NOT be staged
			expect(status.stdout).not.toContain("Changes to be committed:\n\tnew file:   README.md");
		});

		test("git add '*.md' stages only markdown files", async () => {
			const bash = createTestBash({ files: NESTED_REPO });
			await bash.exec("git init");
			const result = await bash.exec("git add '*.md'");
			expect(result.exitCode).toBe(0);

			const status = await bash.exec("git status");
			expect(status.stdout).toContain("README.md");
			expect(status.stdout).toContain("docs/guide.md");
		});

		test("glob with no matches reports error", async () => {
			const bash = createTestBash({ files: NESTED_REPO });
			await bash.exec("git init");
			const result = await bash.exec("git add '*.py'");
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("pathspec '*.py' did not match any files");
		});

		test("glob handles tracked file deletions", async () => {
			const bash = createTestBash({ files: NESTED_REPO });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"', {
				env: TEST_ENV,
			});

			// Delete .ts files
			await bash.fs.rm("/repo/src/index.ts");
			await bash.fs.rm("/repo/src/lib/math.ts");

			const result = await bash.exec("git add '*.ts'");
			expect(result.exitCode).toBe(0);

			const status = await bash.exec("git status");
			expect(status.stdout).toContain("deleted:");
			expect(status.stdout).toContain("src/index.ts");
		});

		test("character class glob [ch] works", async () => {
			const bash = createTestBash({
				files: {
					"/repo/foo.c": "int main() {}",
					"/repo/foo.h": "#include",
					"/repo/foo.o": "binary",
				},
			});
			await bash.exec("git init");
			const result = await bash.exec("git add '*.[ch]'");
			expect(result.exitCode).toBe(0);

			const status = await bash.exec("git status");
			expect(status.stdout).toContain("foo.c");
			expect(status.stdout).toContain("foo.h");
			// .o should not be staged
			const lines = status.stdout.split("\n");
			const stagedLines = lines.filter((l: string) => l.includes("new file:"));
			expect(stagedLines.length).toBe(2);
		});
	});
});
