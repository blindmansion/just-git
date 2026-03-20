import { describe, expect, test } from "bun:test";
import { BASIC_REPO, EMPTY_REPO, TEST_ENV_NAMED as TEST_ENV } from "../fixtures";
import { createTestBash, quickExec } from "../util";

describe("git diff", () => {
	describe("outside a git repo", () => {
		test("fails with exit 128", async () => {
			const result = await quickExec("git diff", { files: EMPTY_REPO });
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("not a git repository");
		});
	});

	describe("unified format (default)", () => {
		test("shows modified file diff", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.exec('echo "new content" > /repo/README.md');

			const result = await bash.exec("git diff");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("diff --git a/README.md b/README.md");
			expect(result.stdout).toContain("-# My Project");
			expect(result.stdout).toContain("+new content");
		});

		test("--cached shows staged changes", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.exec('echo "updated" > /repo/README.md');
			await bash.exec("git add README.md");

			const result = await bash.exec("git diff --cached");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("diff --git a/README.md b/README.md");
			expect(result.stdout).toContain("-# My Project");
			expect(result.stdout).toContain("+updated");
		});

		test("no diff produces empty output", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			const result = await bash.exec("git diff");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toBe("");
		});
	});

	describe("--name-only", () => {
		test("unstaged: lists changed file names", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.exec('echo "changed" > /repo/README.md');
			await bash.exec('echo "also changed" > /repo/src/main.ts');

			const result = await bash.exec("git diff --name-only");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("README.md");
			expect(result.stdout).toContain("src/main.ts");
			expect(result.stdout).not.toContain("diff --git");
		});

		test("--cached: lists staged file names", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.exec('echo "changed" > /repo/README.md');
			await bash.exec("git add README.md");

			const result = await bash.exec("git diff --cached --name-only");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toBe("README.md\n");
		});

		test("commit-to-commit: lists changed files", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add README.md");
			await bash.exec('git commit -m "first"');
			await bash.exec("git tag v1");
			await bash.exec("git add src/main.ts");
			await bash.exec('git commit -m "second"');
			await bash.exec("git tag v2");

			const result = await bash.exec("git diff --name-only v1 v2");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toBe("src/main.ts\n");
		});

		test("no changes produces empty output", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			const result = await bash.exec("git diff --name-only");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toBe("");
		});
	});

	describe("--name-status", () => {
		test("shows status letters with file names", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.exec('echo "changed" > /repo/README.md');

			const result = await bash.exec("git diff --name-status");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toBe("M\tREADME.md\n");
		});

		test("--cached shows added files with A status", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.exec('echo "new file" > /repo/newfile.txt');
			await bash.exec("git add newfile.txt");

			const result = await bash.exec("git diff --cached --name-status");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toBe("A\tnewfile.txt\n");
		});

		test("--cached shows deleted files with D status", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.exec("git rm README.md");

			const result = await bash.exec("git diff --cached --name-status");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("D\tREADME.md\n");
		});

		test("shows multiple statuses sorted", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.exec('echo "changed" > /repo/README.md');
			await bash.exec('echo "new" > /repo/newfile.txt');
			await bash.exec("git add .");

			const result = await bash.exec("git diff --cached --name-status");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("M\tREADME.md");
			expect(result.stdout).toContain("A\tnewfile.txt");
		});
	});

	describe("--stat", () => {
		test("shows file name with insertion/deletion counts and bar", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.exec('echo "line 1\nline 2\nline 3" > /repo/README.md');

			const result = await bash.exec("git diff --stat");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("README.md");
			expect(result.stdout).toContain("|");
			expect(result.stdout).toMatch(/\d+ file/);
			expect(result.stdout).toMatch(/insertion|deletion/);
		});

		test("--cached shows staged diffstat", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.exec('echo "updated" > /repo/README.md');
			await bash.exec("git add README.md");

			const result = await bash.exec("git diff --cached --stat");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("README.md");
			expect(result.stdout).toContain("|");
			expect(result.stdout).toMatch(/1 file changed/);
		});

		test("shows bar graph with + and -", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.exec('echo "line 1\nline 2\nline 3\nline 4\nline 5" > /repo/README.md');

			const result = await bash.exec("git diff --stat");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("+");
			// Original had 1 line, new has 5 → 4 insertions, 1 deletion
		});

		test("commit-to-commit stat", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add README.md");
			await bash.exec('git commit -m "first"');
			await bash.exec("git tag v1");
			await bash.exec("git add src/main.ts src/util.ts");
			await bash.exec('git commit -m "second"');
			await bash.exec("git tag v2");

			const result = await bash.exec("git diff --stat v1 v2");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("src/main.ts");
			expect(result.stdout).toContain("src/util.ts");
			expect(result.stdout).toMatch(/2 files changed/);
		});

		test("no changes produces empty output", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			const result = await bash.exec("git diff --stat");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toBe("");
		});
	});

	describe("--shortstat", () => {
		test("shows only the summary line", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.exec('echo "changed" > /repo/README.md');
			await bash.exec('echo "also" > /repo/src/main.ts');

			const result = await bash.exec("git diff --shortstat");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toMatch(/2 files changed/);
			expect(result.stdout).toMatch(/insertion/);
			expect(result.stdout).toMatch(/deletion/);
			// Should not contain file-level stat lines
			expect(result.stdout).not.toContain("|");
		});

		test("no changes produces empty output", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			const result = await bash.exec("git diff --shortstat");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toBe("");
		});

		test("--cached shortstat", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.exec('echo "new" > /repo/file.txt');
			await bash.exec("git add file.txt");

			const result = await bash.exec("git diff --cached --shortstat");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toMatch(/1 file changed/);
			expect(result.stdout).toMatch(/1 insertion/);
		});
	});

	describe("--numstat", () => {
		test("shows tab-separated insertions/deletions/path", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.exec('echo "line 1\nline 2\nline 3" > /repo/README.md');

			const result = await bash.exec("git diff --numstat");
			expect(result.exitCode).toBe(0);
			const lines = result.stdout.trim().split("\n");
			expect(lines).toHaveLength(1);
			const parts = (lines[0] as string).split("\t");
			expect(parts).toHaveLength(3);
			expect(Number(parts[0])).toBeGreaterThanOrEqual(0);
			expect(Number(parts[1])).toBeGreaterThanOrEqual(0);
			expect(parts[2]).toBe("README.md");
		});

		test("--cached numstat with new file", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.exec('echo "one\ntwo\nthree" > /repo/new.txt');
			await bash.exec("git add new.txt");

			const result = await bash.exec("git diff --cached --numstat");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("3\t0\tnew.txt");
		});

		test("no changes produces empty output", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			const result = await bash.exec("git diff --numstat");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toBe("");
		});

		test("multiple files", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.exec('echo "a" > /repo/README.md');
			await bash.exec('echo "b" > /repo/src/main.ts');

			const result = await bash.exec("git diff --numstat");
			expect(result.exitCode).toBe(0);
			const lines = result.stdout.trim().split("\n");
			expect(lines).toHaveLength(2);
			expect(result.stdout).toContain("README.md");
			expect(result.stdout).toContain("src/main.ts");
		});
	});

	describe("pathspec filtering with format flags", () => {
		test("--name-only with pathspec", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.exec('echo "a" > /repo/README.md');
			await bash.exec('echo "b" > /repo/src/main.ts');
			await bash.exec('echo "c" > /repo/src/util.ts');

			const result = await bash.exec("git diff --name-only -- 'src/*.ts'");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("src/main.ts");
			expect(result.stdout).toContain("src/util.ts");
			expect(result.stdout).not.toContain("README.md");
		});

		test("--stat with pathspec", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.exec('echo "a" > /repo/README.md');
			await bash.exec('echo "b" > /repo/src/main.ts');

			const result = await bash.exec("git diff --stat -- README.md");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("README.md");
			expect(result.stdout).not.toContain("src/main.ts");
			expect(result.stdout).toMatch(/1 file changed/);
		});

		test("--numstat with pathspec", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.exec('echo "a" > /repo/README.md');
			await bash.exec('echo "b" > /repo/src/main.ts');

			const result = await bash.exec("git diff --numstat -- README.md");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("README.md");
			expect(result.stdout).not.toContain("src/main.ts");
		});
	});

	describe("commit-to-worktree shows new files", () => {
		test("new staged file appears as A", async () => {
			const bash = createTestBash({ files: { "/repo/a.txt": "a\n" }, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.exec('echo "b" > /repo/b.txt');
			await bash.exec("git add /repo/b.txt");

			const result = await bash.exec("git diff HEAD --name-status");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("A\tb.txt");
		});

		test("M + D + A all appear together", async () => {
			const bash = createTestBash({
				files: { "/repo/a.txt": "a\n", "/repo/b.txt": "b\n" },
				env: TEST_ENV,
			});
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.exec('echo "c" > /repo/c.txt');
			await bash.exec("git add /repo/c.txt");
			await bash.exec("git rm /repo/b.txt");
			await bash.exec('echo "aa" > /repo/a.txt');

			const result = await bash.exec("git diff HEAD --name-status");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toBe("M\ta.txt\nD\tb.txt\nA\tc.txt\n");
		});

		test("new file shows 'new file mode' header in unified diff", async () => {
			const bash = createTestBash({ files: { "/repo/a.txt": "a\n" }, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.exec('echo "new" > /repo/new.txt');
			await bash.exec("git add /repo/new.txt");

			const result = await bash.exec("git diff HEAD -- new.txt");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("new file mode");
			expect(result.stdout).toContain("--- /dev/null");
			expect(result.stdout).toContain("+++ b/new.txt");
		});

		test("untracked files do not appear", async () => {
			const bash = createTestBash({ files: { "/repo/a.txt": "a\n" }, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.exec('echo "tracked" > /repo/tracked.txt');
			await bash.exec("git add /repo/tracked.txt");
			await bash.exec('echo "untracked" > /repo/untracked.txt');

			const result = await bash.exec("git diff HEAD --name-status");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("A\ttracked.txt");
			expect(result.stdout).not.toContain("untracked.txt");
		});

		test("diff against older commit shows files added across multiple commits", async () => {
			const bash = createTestBash({ files: { "/repo/a.txt": "a\n" }, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "c1"');
			await bash.exec("git tag v1");
			await bash.exec('echo "b" > /repo/b.txt');
			await bash.exec("git add .");
			await bash.exec('git commit -m "c2"');
			await bash.exec('echo "c" > /repo/c.txt');
			await bash.exec("git add /repo/c.txt");

			const result = await bash.exec("git diff v1 --name-status");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("A\tb.txt");
			expect(result.stdout).toContain("A\tc.txt");
		});

		test("pathspec filter works on new files", async () => {
			const bash = createTestBash({ files: { "/repo/a.txt": "a\n" }, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.exec('echo "b" > /repo/b.txt');
			await bash.exec('echo "c" > /repo/c.txt');
			await bash.exec("git add .");

			const result = await bash.exec("git diff HEAD --name-status -- c.txt");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toBe("A\tc.txt\n");
		});
	});

	describe("commit-to-worktree with format flags", () => {
		test("--name-only against a commit", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.exec("git tag v1");
			await bash.exec('echo "changed" > /repo/README.md');

			const result = await bash.exec("git diff --name-only v1");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toBe("README.md\n");
		});

		test("--stat against a commit", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.exec("git tag v1");
			await bash.exec('echo "changed" > /repo/README.md');

			const result = await bash.exec("git diff --stat v1");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("README.md");
			expect(result.stdout).toMatch(/1 file changed/);
		});
	});

	describe("A..B two-dot range syntax", () => {
		test("A..B is equivalent to git diff A B", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.exec("git tag v1");
			await bash.exec('echo "changed" > /repo/README.md');
			await bash.exec("git add .");
			await bash.exec('git commit -m "second"');
			await bash.exec("git tag v2");

			const rangeResult = await bash.exec("git diff --name-only v1..v2");
			const twoArgResult = await bash.exec("git diff --name-only v1 v2");
			expect(rangeResult.exitCode).toBe(0);
			expect(rangeResult.stdout).toBe(twoArgResult.stdout);
			expect(rangeResult.stdout).toBe("README.md\n");
		});

		test("empty left defaults to HEAD", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.exec("git tag v1");
			await bash.exec('echo "changed" > /repo/README.md');
			await bash.exec("git add .");
			await bash.exec('git commit -m "second"');

			const result = await bash.exec("git diff --name-only ..v1");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toBe("README.md\n");
		});

		test("empty right defaults to HEAD", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.exec("git tag v1");
			await bash.exec('echo "changed" > /repo/README.md');
			await bash.exec("git add .");
			await bash.exec('git commit -m "second"');

			const result = await bash.exec("git diff --name-only v1..");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toBe("README.md\n");
		});

		test("works with --stat", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.exec("git tag v1");
			await bash.exec('echo "changed" > /repo/README.md');
			await bash.exec("git add .");
			await bash.exec('git commit -m "second"');
			await bash.exec("git tag v2");

			const result = await bash.exec("git diff --stat v1..v2");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("README.md");
			expect(result.stdout).toMatch(/1 file changed/);
		});

		test("works with pathspec filtering", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.exec("git tag v1");
			await bash.exec('echo "changed" > /repo/README.md');
			await bash.exec('echo "also" > /repo/src/main.ts');
			await bash.exec("git add .");
			await bash.exec('git commit -m "second"');
			await bash.exec("git tag v2");

			const result = await bash.exec("git diff --name-only v1..v2 -- README.md");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toBe("README.md\n");
			expect(result.stdout).not.toContain("src/main.ts");
		});

		test("bad revision in range", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			const result = await bash.exec("git diff --name-only badrev..HEAD");
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("bad revision");
		});
	});

	describe("A...B three-dot range syntax", () => {
		test("diffs merge-base against right side", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.exec("git checkout -b feature");
			await bash.exec('echo "feature change" > /repo/feature.txt');
			await bash.exec("git add .");
			await bash.exec('git commit -m "feature commit"');
			await bash.exec("git checkout main");
			await bash.exec('echo "main change" > /repo/main.txt');
			await bash.exec("git add .");
			await bash.exec('git commit -m "main commit"');

			const result = await bash.exec("git diff --name-only main...feature");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("feature.txt");
			expect(result.stdout).not.toContain("main.txt");
		});

		test("shows only changes on left side when reversed", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.exec("git checkout -b feature");
			await bash.exec('echo "feature change" > /repo/feature.txt');
			await bash.exec("git add .");
			await bash.exec('git commit -m "feature commit"');
			await bash.exec("git checkout main");
			await bash.exec('echo "main change" > /repo/main.txt');
			await bash.exec("git add .");
			await bash.exec('git commit -m "main commit"');

			const result = await bash.exec("git diff --name-only feature...main");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("main.txt");
			expect(result.stdout).not.toContain("feature.txt");
		});

		test("empty left defaults to HEAD", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.exec("git checkout -b feature");
			await bash.exec('echo "feature change" > /repo/feature.txt');
			await bash.exec("git add .");
			await bash.exec('git commit -m "feature commit"');
			await bash.exec("git checkout main");
			await bash.exec('echo "main change" > /repo/main.txt');
			await bash.exec("git add .");
			await bash.exec('git commit -m "main commit"');

			const result = await bash.exec("git diff --name-only ...feature");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("feature.txt");
			expect(result.stdout).not.toContain("main.txt");
		});

		test("empty right defaults to HEAD", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.exec("git checkout -b feature");
			await bash.exec('echo "feature change" > /repo/feature.txt');
			await bash.exec("git add .");
			await bash.exec('git commit -m "feature commit"');

			const result = await bash.exec("git diff --name-only main...");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("feature.txt");
		});

		test("works with --stat", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.exec("git checkout -b feature");
			await bash.exec('echo "feature change" > /repo/feature.txt');
			await bash.exec("git add .");
			await bash.exec('git commit -m "feature commit"');
			await bash.exec("git checkout main");
			await bash.exec('echo "main change" > /repo/main.txt');
			await bash.exec("git add .");
			await bash.exec('git commit -m "main commit"');

			const result = await bash.exec("git diff --stat main...feature");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("feature.txt");
			expect(result.stdout).toMatch(/1 file changed/);
		});

		test("works with pathspec filtering", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.exec("git checkout -b feature");
			await bash.exec('echo "feature change" > /repo/feature.txt');
			await bash.exec('echo "another" > /repo/another.txt');
			await bash.exec("git add .");
			await bash.exec('git commit -m "feature commit"');
			await bash.exec("git checkout main");

			const result = await bash.exec("git diff --name-only main...feature -- feature.txt");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toBe("feature.txt\n");
			expect(result.stdout).not.toContain("another.txt");
		});

		test("bad revision in range", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			const result = await bash.exec("git diff --name-only HEAD...badrev");
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("bad revision");
		});
	});

	describe("binary files", () => {
		test("unstaged diff shows 'Binary files differ' for modified binary", async () => {
			const binaryV1 = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]);
			const binaryV2 = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0xfd]);

			const bash = createTestBash({ env: TEST_ENV });
			await bash.fs.writeFile("/repo/foo.bin", binaryV1);
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "add binary"');
			await bash.fs.writeFile("/repo/foo.bin", binaryV2);

			const result = await bash.exec("git diff");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Binary files a/foo.bin and b/foo.bin differ");
		});

		test("staged diff shows 'Binary files differ'", async () => {
			const binaryV1 = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]);
			const binaryV2 = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0xfd]);

			const bash = createTestBash({ env: TEST_ENV });
			await bash.fs.writeFile("/repo/foo.bin", binaryV1);
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "add binary"');
			await bash.fs.writeFile("/repo/foo.bin", binaryV2);
			await bash.exec("git add .");

			const result = await bash.exec("git diff --cached");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Binary files a/foo.bin and b/foo.bin differ");
		});

		test("new binary file shows 'Binary files differ'", async () => {
			const binary = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]);

			const bash = createTestBash({ env: TEST_ENV });
			await bash.exec("git init");
			await bash.fs.writeFile("/repo/foo.bin", binary);
			await bash.exec("git add .");

			const result = await bash.exec("git diff --cached");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Binary files /dev/null and b/foo.bin differ");
		});
	});

	describe("error cases", () => {
		test("bad revision", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			const result = await bash.exec("git diff --name-only badrev HEAD");
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("bad revision");
		});

		test("too many arguments", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			const result = await bash.exec("git diff a b c");
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("too many arguments");
		});
	});
});
