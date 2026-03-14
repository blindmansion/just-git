import { describe, expect, test } from "bun:test";
import { BASIC_REPO, NESTED_REPO, TEST_ENV } from "../fixtures";
import { createTestBash, pathExists, readFile } from "../util";

/**
 * Tests that git correctly detects working-tree changes made through
 * plain shell commands (rm, mv, cp, echo, mkdir, etc.) rather than
 * through git-aware commands (git rm, git mv, git add).
 *
 * Users often manipulate files outside of git and expect status, diff,
 * add, commit, checkout, and restore to reflect the true working tree.
 */
describe("shell file operations + git detection", () => {
	// ── Shell rm (without git rm) ────────────────────────────────────

	describe("shell rm of tracked files", () => {
		test("git status shows unstaged deletion after shell rm", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.exec("rm /repo/README.md");

			const status = await bash.exec("git status");
			expect(status.stdout).toContain("Changes not staged for commit:");
			expect(status.stdout).toContain("deleted:");
			expect(status.stdout).toContain("README.md");
			expect(status.stdout).not.toContain("Changes to be committed:");
		});

		test("git status --short shows ' D' for shell-deleted file", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.exec("rm /repo/src/main.ts");

			const status = await bash.exec("git status -s");
			expect(status.stdout).toMatch(/^\s*D src\/main\.ts$/m);
		});

		test("git add stages a shell-deleted file as deletion", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.exec("rm /repo/README.md");
			await bash.exec("git add README.md");

			const status = await bash.exec("git status");
			expect(status.stdout).toContain("Changes to be committed:");
			expect(status.stdout).toContain("deleted:");
			expect(status.stdout).toContain("README.md");
		});

		test("git add . stages all shell-deleted files", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.exec("rm /repo/README.md");
			await bash.exec("rm /repo/src/main.ts");
			await bash.exec("git add .");

			const status = await bash.exec("git status");
			expect(status.stdout).toContain("Changes to be committed:");
			expect(status.stdout).toContain("README.md");
			expect(status.stdout).toContain("src/main.ts");
		});

		test("git checkout restores a shell-deleted file", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.exec("rm /repo/README.md");
			expect(await pathExists(bash.fs, "/repo/README.md")).toBe(false);

			await bash.exec("git checkout -- README.md");
			expect(await pathExists(bash.fs, "/repo/README.md")).toBe(true);
			expect(await readFile(bash.fs, "/repo/README.md")).toBe("# My Project");
		});

		test("git restore restores a shell-deleted file", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.exec("rm /repo/src/util.ts");

			const restore = await bash.exec("git restore src/util.ts");
			expect(restore.exitCode).toBe(0);
			expect(await readFile(bash.fs, "/repo/src/util.ts")).toBe("export const VERSION = 1;");
		});

		test("git diff shows deletion for shell-removed file", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.exec("rm /repo/README.md");

			const diff = await bash.exec("git diff");
			expect(diff.stdout).toContain("deleted file mode");
			expect(diff.stdout).toContain("a/README.md");
		});

		test("shell-deleted file can be committed after git add", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.exec("rm /repo/README.md");
			await bash.exec("git add README.md");
			const commit = await bash.exec('git commit -m "remove readme via shell"');
			expect(commit.exitCode).toBe(0);

			const status = await bash.exec("git status");
			expect(status.stdout).toContain("nothing to commit");
		});
	});

	// ── Shell mv (without git mv) ────────────────────────────────────

	describe("shell mv of tracked files", () => {
		test("git status shows deletion + untracked after shell mv", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.exec("mv /repo/README.md /repo/DOCS.md");

			const status = await bash.exec("git status");
			expect(status.stdout).toContain("deleted:");
			expect(status.stdout).toContain("README.md");
			expect(status.stdout).toContain("Untracked files:");
			expect(status.stdout).toContain("DOCS.md");
		});

		test("git add . after shell mv stages both deletion and new file", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.exec("mv /repo/README.md /repo/DOCS.md");
			await bash.exec("git add .");

			const status = await bash.exec("git status");
			expect(status.stdout).toContain("Changes to be committed:");
			// git may detect it as a rename or show as delete+new
			const stdout = status.stdout;
			const isRename = stdout.includes("renamed:");
			const isDeleteAndNew = stdout.includes("deleted:") && stdout.includes("new file:");
			expect(isRename || isDeleteAndNew).toBe(true);
		});

		test("shell mv to nested directory is detected", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.exec("mkdir -p /repo/docs");
			await bash.exec("mv /repo/README.md /repo/docs/README.md");

			const status = await bash.exec("git status -s");
			expect(status.stdout).toContain("D README.md");
			expect(status.stdout).toContain("docs/");
		});
	});

	// ── Shell cp (copy) ──────────────────────────────────────────────

	describe("shell cp of tracked files", () => {
		test("copied file appears as untracked", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.exec("cp /repo/README.md /repo/README_COPY.md");

			const status = await bash.exec("git status");
			expect(status.stdout).toContain("Untracked files:");
			expect(status.stdout).toContain("README_COPY.md");
			// Original should still be clean
			expect(status.stdout).not.toContain("modified:");
		});

		test("cp to new directory shows untracked", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.exec("mkdir -p /repo/backup");
			await bash.exec("cp /repo/src/main.ts /repo/backup/main.ts");

			const status = await bash.exec("git status");
			expect(status.stdout).toContain("Untracked files:");
			expect(status.stdout).toContain("backup/");
		});

		test("git add picks up copied file", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.exec("cp /repo/README.md /repo/README2.md");
			await bash.exec("git add README2.md");

			const status = await bash.exec("git status");
			expect(status.stdout).toContain("Changes to be committed:");
			expect(status.stdout).toContain("new file:");
			expect(status.stdout).toContain("README2.md");
		});
	});

	// ── Shell echo / content modification ────────────────────────────

	describe("shell content modification", () => {
		test("overwriting content with echo shows unstaged modification", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.exec("echo 'new content' > /repo/README.md");

			const status = await bash.exec("git status");
			expect(status.stdout).toContain("Changes not staged for commit:");
			expect(status.stdout).toContain("modified:");
			expect(status.stdout).toContain("README.md");
		});

		test("appending with >> shows unstaged modification", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.exec("echo 'appended line' >> /repo/README.md");

			const status = await bash.exec("git status -s");
			expect(status.stdout).toMatch(/^\s*M README\.md$/m);
		});

		test("git diff shows content change from echo overwrite", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.exec("echo 'replaced' > /repo/README.md");

			const diff = await bash.exec("git diff");
			expect(diff.stdout).toContain("-# My Project");
			expect(diff.stdout).toContain("+replaced");
		});

		test("creating a brand new file with echo shows untracked", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.exec("echo 'hello world' > /repo/new-file.txt");

			const status = await bash.exec("git status");
			expect(status.stdout).toContain("Untracked files:");
			expect(status.stdout).toContain("new-file.txt");
		});

		test("modifying a file then restoring it shows clean status", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.exec("echo 'changed' > /repo/README.md");
			const dirty = await bash.exec("git status -s");
			expect(dirty.stdout).toContain("M");

			await bash.exec("git restore README.md");
			const clean = await bash.exec("git status -s");
			expect(clean.stdout.trim()).not.toContain("README.md");
		});
	});

	// ── Shell mkdir + new files in new directories ───────────────────

	describe("creating directories and files with shell commands", () => {
		test("new directory with files shows as untracked", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.exec("mkdir -p /repo/lib/utils");
			await bash.exec("echo 'export {}' > /repo/lib/utils/helpers.ts");

			const status = await bash.exec("git status");
			expect(status.stdout).toContain("Untracked files:");
			expect(status.stdout).toContain("lib/");
		});

		test("deeply nested new file can be added and committed", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.exec("mkdir -p /repo/a/b/c/d");
			await bash.exec("echo 'deep' > /repo/a/b/c/d/deep.txt");
			await bash.exec("git add .");
			const commit = await bash.exec('git commit -m "add deep file"');
			expect(commit.exitCode).toBe(0);

			const status = await bash.exec("git status");
			expect(status.stdout).toContain("nothing to commit");
			expect(await readFile(bash.fs, "/repo/a/b/c/d/deep.txt")).toBe("deep\n");
		});

		test("empty directories are invisible to git", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.exec("mkdir -p /repo/empty-dir");

			const status = await bash.exec("git status");
			expect(status.stdout).toContain("nothing to commit");
		});
	});

	// ── Mixed shell + git operations ─────────────────────────────────

	describe("mixed shell and git operations", () => {
		test("shell rm + shell create new file + git add . + commit", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.exec("rm /repo/README.md");
			await bash.exec("echo 'new readme' > /repo/NEW_README.md");
			await bash.exec("git add .");

			const status = await bash.exec("git status");
			expect(status.stdout).toContain("Changes to be committed:");
			expect(status.stdout).toContain("README.md");
			expect(status.stdout).toContain("NEW_README.md");

			const commit = await bash.exec('git commit -m "swap readme"');
			expect(commit.exitCode).toBe(0);

			const clean = await bash.exec("git status");
			expect(clean.stdout).toContain("nothing to commit");
		});

		test("shell-modify file, stage, then shell-modify again shows both staged and unstaged", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.exec("echo 'first change' > /repo/README.md");
			await bash.exec("git add README.md");
			await bash.exec("echo 'second change' > /repo/README.md");

			const status = await bash.exec("git status");
			expect(status.stdout).toContain("Changes to be committed:");
			expect(status.stdout).toContain("Changes not staged for commit:");
		});

		test("git diff --cached shows staged change, git diff shows unstaged change", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.exec("echo 'staged version' > /repo/README.md");
			await bash.exec("git add README.md");
			await bash.exec("echo 'working version' > /repo/README.md");

			const cached = await bash.exec("git diff --cached");
			expect(cached.stdout).toContain("+staged version");

			const unstaged = await bash.exec("git diff");
			expect(unstaged.stdout).toContain("-staged version");
			expect(unstaged.stdout).toContain("+working version");
		});

		test("commit -a picks up shell modifications without explicit add", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.exec("echo 'auto-staged' > /repo/README.md");

			const commit = await bash.exec('git commit -a -m "auto-add modified"');
			expect(commit.exitCode).toBe(0);

			const status = await bash.exec("git status");
			expect(status.stdout).toContain("nothing to commit");
		});

		test("commit -a does not pick up untracked files", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.exec("echo 'brand new' > /repo/untracked.txt");
			await bash.exec("echo 'modified' > /repo/README.md");

			await bash.exec('git commit -a -m "only tracked"');

			const status = await bash.exec("git status");
			expect(status.stdout).toContain("Untracked files:");
			expect(status.stdout).toContain("untracked.txt");
			expect(status.stdout).not.toContain("README.md");
		});
	});

	// ── Shell operations during ongoing git operations ───────────────

	describe("shell file ops during merge conflicts", () => {
		test("manually resolving conflict with echo then committing", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.exec("git checkout -b feature");
			await bash.exec("echo 'feature content' > /repo/README.md");
			await bash.exec("git add .");
			await bash.exec('git commit -m "feature change"');

			await bash.exec("git checkout main");
			await bash.exec("echo 'main content' > /repo/README.md");
			await bash.exec("git add .");
			await bash.exec('git commit -m "main change"');

			const merge = await bash.exec("git merge feature");
			expect(merge.exitCode).not.toBe(0);

			// Resolve by overwriting with echo
			await bash.exec("echo 'resolved content' > /repo/README.md");
			await bash.exec("git add README.md");
			const commit = await bash.exec('git commit -m "merge resolved"');
			expect(commit.exitCode).toBe(0);

			expect(await readFile(bash.fs, "/repo/README.md")).toBe("resolved content\n");
		});
	});

	// ── Shell rm of directories ──────────────────────────────────────

	describe("shell rm -rf of tracked directories", () => {
		test("removing entire tracked directory shows all files as deleted", async () => {
			const bash = createTestBash({ files: NESTED_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.exec("rm -rf /repo/src");

			const status = await bash.exec("git status");
			expect(status.stdout).toContain("deleted:");
			expect(status.stdout).toContain("src/index.ts");
			expect(status.stdout).toContain("src/lib/math.ts");
			expect(status.stdout).toContain("src/lib/string.ts");
		});

		test("git checkout restores individual shell-deleted files from a directory", async () => {
			const bash = createTestBash({ files: NESTED_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.exec("rm -rf /repo/src");
			expect(await pathExists(bash.fs, "/repo/src/index.ts")).toBe(false);

			await bash.exec("git checkout -- src/index.ts src/lib/math.ts src/lib/string.ts");
			expect(await pathExists(bash.fs, "/repo/src/index.ts")).toBe(true);
			expect(await pathExists(bash.fs, "/repo/src/lib/math.ts")).toBe(true);
			expect(await readFile(bash.fs, "/repo/src/lib/math.ts")).toBe(
				"export const add = (a: number, b: number) => a + b;",
			);
		});

		test("git checkout -- src/ restores entire shell-deleted directory", async () => {
			const bash = createTestBash({ files: NESTED_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.exec("rm -rf /repo/src");
			expect(await pathExists(bash.fs, "/repo/src/index.ts")).toBe(false);

			const result = await bash.exec("git checkout -- src/");
			expect(result.exitCode).toBe(0);
			expect(await pathExists(bash.fs, "/repo/src/index.ts")).toBe(true);
			expect(await pathExists(bash.fs, "/repo/src/lib/math.ts")).toBe(true);
			expect(await pathExists(bash.fs, "/repo/src/lib/string.ts")).toBe(true);
		});

		test("git checkout -- . restores all shell-deleted files", async () => {
			const bash = createTestBash({ files: NESTED_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.exec("rm -rf /repo/src");
			await bash.exec("rm /repo/README.md");

			const result = await bash.exec("git checkout -- .");
			expect(result.exitCode).toBe(0);
			expect(await pathExists(bash.fs, "/repo/README.md")).toBe(true);
			expect(await pathExists(bash.fs, "/repo/src/index.ts")).toBe(true);
			expect(await pathExists(bash.fs, "/repo/src/lib/math.ts")).toBe(true);
		});

		test("git restore restores shell-deleted directory contents", async () => {
			const bash = createTestBash({ files: NESTED_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.exec("rm -rf /repo/src");
			expect(await pathExists(bash.fs, "/repo/src/index.ts")).toBe(false);

			await bash.exec("git restore src/index.ts src/lib/math.ts src/lib/string.ts");
			expect(await pathExists(bash.fs, "/repo/src/index.ts")).toBe(true);
			expect(await pathExists(bash.fs, "/repo/src/lib/math.ts")).toBe(true);
		});

		test("git reset --hard restores entire shell-deleted directory", async () => {
			const bash = createTestBash({ files: NESTED_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.exec("rm -rf /repo/src");
			await bash.exec("git reset --hard HEAD");

			expect(await pathExists(bash.fs, "/repo/src/index.ts")).toBe(true);
			expect(await pathExists(bash.fs, "/repo/src/lib/math.ts")).toBe(true);
			expect(await readFile(bash.fs, "/repo/src/lib/math.ts")).toBe(
				"export const add = (a: number, b: number) => a + b;",
			);
		});
	});

	// ── Replacing tracked file with directory and vice versa ─────────

	describe("file/directory type swaps", () => {
		test("replacing a tracked file with a directory of the same name", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.exec("rm /repo/README.md");
			await bash.exec("mkdir -p /repo/README.md");
			await bash.exec("echo 'inside' > /repo/README.md/file.txt");

			const status = await bash.exec("git status");
			expect(status.stdout).toContain("deleted:");
			expect(status.stdout).toContain("README.md");
			expect(status.stdout).toContain("Untracked files:");
			expect(status.stdout).toContain("README.md/");
		});

		test("shell-create file where a tracked directory existed", async () => {
			const bash = createTestBash({ files: NESTED_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.exec("rm -rf /repo/docs");
			await bash.exec("echo 'flat docs' > /repo/docs");

			const status = await bash.exec("git status");
			expect(status.stdout).toContain("deleted:");
			expect(status.stdout).toContain("docs/guide.md");
		});
	});

	// ── Porcelain output consistency ─────────────────────────────────

	describe("porcelain output for shell-caused changes", () => {
		test("--porcelain output for shell rm", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.exec("rm /repo/README.md");

			const status = await bash.exec("git status --porcelain");
			expect(status.stdout).toContain(" D README.md");
		});

		test("--porcelain output for shell mv (delete + untracked)", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.exec("mv /repo/README.md /repo/DOCS.md");

			const status = await bash.exec("git status --porcelain");
			expect(status.stdout).toContain(" D README.md");
			expect(status.stdout).toContain("?? DOCS.md");
		});

		test("--porcelain output for shell content edit", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.exec("echo 'changed' > /repo/README.md");

			const status = await bash.exec("git status --porcelain");
			expect(status.stdout).toContain(" M README.md");
		});

		test("--porcelain shows staged + unstaged for double edit", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.exec("echo 'v1' > /repo/README.md");
			await bash.exec("git add README.md");
			await bash.exec("echo 'v2' > /repo/README.md");

			const status = await bash.exec("git status --porcelain");
			expect(status.stdout).toMatch(/^MM README\.md$/m);
		});
	});

	// ── git reset after shell operations ─────────────────────────────

	describe("git reset interactions with shell ops", () => {
		test("git reset HEAD after staging a shell deletion unstages it", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.exec("rm /repo/README.md");
			await bash.exec("git add README.md");

			const staged = await bash.exec("git status --porcelain");
			expect(staged.stdout).toMatch(/^D /m);

			await bash.exec("git reset HEAD -- README.md");

			const unstaged = await bash.exec("git status --porcelain");
			expect(unstaged.stdout).toMatch(/^ D/m);
		});

		test("git reset --hard restores all shell-deleted and shell-modified files", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.exec("rm /repo/README.md");
			await bash.exec("echo 'changed' > /repo/src/main.ts");
			await bash.exec("echo 'new' > /repo/untracked.txt");

			await bash.exec("git reset --hard HEAD");

			expect(await readFile(bash.fs, "/repo/README.md")).toBe("# My Project");
			expect(await readFile(bash.fs, "/repo/src/main.ts")).toBe('console.log("hello world");');
			// Untracked files survive a hard reset
			expect(await pathExists(bash.fs, "/repo/untracked.txt")).toBe(true);

			const status = await bash.exec("git status");
			expect(status.stdout).toContain("Untracked files:");
			expect(status.stdout).toContain("untracked.txt");
			expect(status.stdout).not.toContain("deleted:");
			expect(status.stdout).not.toContain("modified:");
		});
	});

	// ── git clean for shell-created files ────────────────────────────

	describe("git clean for shell-created files", () => {
		test("git clean -f removes shell-created untracked files", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.exec("echo 'junk' > /repo/junk.txt");
			await bash.exec("echo 'tmp' > /repo/tmp.log");

			const clean = await bash.exec("git clean -f");
			expect(clean.exitCode).toBe(0);

			expect(await pathExists(bash.fs, "/repo/junk.txt")).toBe(false);
			expect(await pathExists(bash.fs, "/repo/tmp.log")).toBe(false);

			const status = await bash.exec("git status");
			expect(status.stdout).toContain("nothing to commit");
		});

		test("git clean -fd removes shell-created directories", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.exec("mkdir -p /repo/build/dist");
			await bash.exec("echo 'out' > /repo/build/dist/out.js");

			const clean = await bash.exec("git clean -fd");
			expect(clean.exitCode).toBe(0);
			expect(await pathExists(bash.fs, "/repo/build")).toBe(false);
		});
	});

	// ── Overwriting tracked content then switching branches ──────────

	describe("branch switching with dirty shell modifications", () => {
		test("checkout blocks when shell modification would be overwritten", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.exec("git checkout -b feature");
			await bash.exec("echo 'feature line' > /repo/README.md");
			await bash.exec("git add .");
			await bash.exec('git commit -m "feature"');

			await bash.exec("git checkout main");

			// Now make a dirty modification on main
			await bash.exec("echo 'dirty local' > /repo/README.md");

			// Trying to switch to feature should block (would overwrite)
			const checkout = await bash.exec("git checkout feature");
			expect(checkout.exitCode).not.toBe(0);
			expect(checkout.stderr).toContain("overwritten");
		});

		test("checkout allows switch when shell modification does not conflict", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.exec("git checkout -b feature");
			await bash.exec("echo 'feature file' > /repo/feature.txt");
			await bash.exec("git add .");
			await bash.exec('git commit -m "feature"');

			await bash.exec("git checkout main");
			// Modify a file that feature branch doesn't touch
			await bash.exec("echo 'local edit' > /repo/src/util.ts");

			const checkout = await bash.exec("git checkout feature");
			expect(checkout.exitCode).toBe(0);
			// The dirty modification should carry over
			expect(await readFile(bash.fs, "/repo/src/util.ts")).toBe("local edit\n");
		});
	});
});
