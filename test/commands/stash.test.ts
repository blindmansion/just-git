import { describe, expect, test } from "bun:test";
import { EMPTY_REPO, TEST_ENV_NAMED as TEST_ENV } from "../fixtures";
import { createTestBash, readFile } from "../util";

describe("git stash", () => {
	// ── Error cases ──────────────────────────────────────────────────

	describe("error cases", () => {
		test("outside a git repo", async () => {
			const bash = createTestBash({ files: EMPTY_REPO });
			const result = await bash.exec("git stash");
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("not a git repository");
		});

		test("no local changes to save", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			const result = await bash.exec("git stash");
			// Real git exits 0 even when there's nothing to save
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("No local changes to save");
		});

		test("no commits yet", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");

			const result = await bash.exec("git stash");
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("You do not have the initial commit yet");
		});

		test("unknown subcommand", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");

			const result = await bash.exec("git stash foo");
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("Unexpected argument");
		});
	});

	// ── Push ─────────────────────────────────────────────────────────

	describe("push", () => {
		test("stash unstaged changes", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			// Modify a file
			await bash.exec('echo "modified" > /repo/README.md');

			const result = await bash.exec("git stash");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Saved working directory and index state");
			expect(result.stdout).toContain("WIP on main");

			// Working tree should be restored to HEAD
			const content = await readFile(bash.fs, "/repo/README.md");
			expect(content).toBe("# My Project");
		});

		test("stash staged changes", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			// Create and stage a new file
			await bash.exec('echo "new file" > /repo/new.txt');
			await bash.exec("git add new.txt");

			const result = await bash.exec("git stash");
			expect(result.exitCode).toBe(0);

			// New file should be gone from working tree
			const exists = await bash.fs.exists("/repo/new.txt");
			expect(exists).toBe(false);

			// Status should be clean
			const status = await bash.exec("git status");
			expect(status.stdout).toContain("nothing to commit");
		});

		test("stash with custom message", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.exec('echo "modified" > /repo/README.md');

			const result = await bash.exec('git stash push -m "my changes"');
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("my changes");
		});

		test("stash deleted file", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			// Delete a tracked file
			await bash.exec("rm /repo/README.md");

			const result = await bash.exec("git stash");
			expect(result.exitCode).toBe(0);

			// File should be restored
			const content = await readFile(bash.fs, "/repo/README.md");
			expect(content).toBe("# My Project");
		});
	});

	// ── Pop ──────────────────────────────────────────────────────────

	describe("pop", () => {
		test("pop restores changes and removes stash", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			// Modify and stash
			await bash.exec('echo "modified" > /repo/README.md');
			await bash.exec("git stash");

			// Verify clean state
			const content1 = await readFile(bash.fs, "/repo/README.md");
			expect(content1).toBe("# My Project");

			// Pop
			const result = await bash.exec("git stash pop");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Dropped refs/stash@{0}");

			// Verify changes restored
			const content2 = await readFile(bash.fs, "/repo/README.md");
			expect(content2).toBe("modified\n");

			// Verify stash list is empty
			const list = await bash.exec("git stash list");
			expect(list.stdout).toBe("");
		});

		test("pop invalid stash reference", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			const result = await bash.exec("git stash pop");
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("is not a valid reference");
		});
	});

	// ── Apply ────────────────────────────────────────────────────────

	describe("apply", () => {
		test("apply restores changes but keeps stash", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.exec('echo "modified" > /repo/README.md');
			await bash.exec("git stash");

			const result = await bash.exec("git stash apply");
			expect(result.exitCode).toBe(0);

			// Changes should be restored
			const content = await readFile(bash.fs, "/repo/README.md");
			expect(content).toBe("modified\n");

			// Stash should still exist
			const list = await bash.exec("git stash list");
			expect(list.stdout).toContain("stash@{0}");
		});
	});

	// ── List ─────────────────────────────────────────────────────────

	describe("list", () => {
		test("empty stash list", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			const result = await bash.exec("git stash list");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toBe("");
		});

		test("list multiple stashes", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			// Create first stash
			await bash.exec('echo "change 1" > /repo/README.md');
			await bash.exec('git stash push -m "first stash"');

			// Create second stash
			await bash.exec('echo "change 2" > /repo/README.md');
			await bash.exec('git stash push -m "second stash"');

			const result = await bash.exec("git stash list");
			expect(result.exitCode).toBe(0);

			const lines = result.stdout.trim().split("\n");
			expect(lines).toHaveLength(2);
			expect(lines[0]).toContain("stash@{0}");
			expect(lines[0]).toContain("second stash");
			expect(lines[1]).toContain("stash@{1}");
			expect(lines[1]).toContain("first stash");
		});
	});

	// ── Drop ─────────────────────────────────────────────────────────

	describe("drop", () => {
		test("drop most recent stash", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.exec('echo "change 1" > /repo/README.md');
			await bash.exec('git stash push -m "first stash"');

			await bash.exec('echo "change 2" > /repo/README.md');
			await bash.exec('git stash push -m "second stash"');

			const result = await bash.exec("git stash drop");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Dropped refs/stash@{0}");

			// Only first stash should remain, now at index 0
			const list = await bash.exec("git stash list");
			const lines = list.stdout.trim().split("\n");
			expect(lines).toHaveLength(1);
			expect(lines[0]).toContain("stash@{0}");
			expect(lines[0]).toContain("first stash");
		});

		test("drop specific stash by index", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.exec('echo "change 1" > /repo/README.md');
			await bash.exec('git stash push -m "first stash"');

			await bash.exec('echo "change 2" > /repo/README.md');
			await bash.exec('git stash push -m "second stash"');

			const result = await bash.exec("git stash drop 1");
			expect(result.exitCode).toBe(0);

			// Only second stash should remain at index 0
			const list = await bash.exec("git stash list");
			const lines = list.stdout.trim().split("\n");
			expect(lines).toHaveLength(1);
			expect(lines[0]).toContain("stash@{0}");
			expect(lines[0]).toContain("second stash");
		});

		test("drop nonexistent stash", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			const result = await bash.exec("git stash drop");
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("is not a valid reference");
		});
	});

	// ── Show ─────────────────────────────────────────────────────────

	describe("show", () => {
		test("show stash diff", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.exec('echo "modified content" > /repo/README.md');
			await bash.exec("git stash");

			const result = await bash.exec("git stash show");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("diff --git");
			expect(result.stdout).toContain("README.md");
			expect(result.stdout).toContain("+modified content");
			expect(result.stdout).toContain("-# My Project");
		});

		test("show nonexistent stash", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			const result = await bash.exec("git stash show");
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("is not a valid reference");
		});
	});

	// ── Clear ────────────────────────────────────────────────────────

	describe("clear", () => {
		test("clear all stashes", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.exec('echo "change 1" > /repo/README.md');
			await bash.exec('git stash push -m "first"');

			await bash.exec('echo "change 2" > /repo/README.md');
			await bash.exec('git stash push -m "second"');

			const result = await bash.exec("git stash clear");
			expect(result.exitCode).toBe(0);

			const list = await bash.exec("git stash list");
			expect(list.stdout).toBe("");
		});

		test("clear empty stash list is a no-op", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			const result = await bash.exec("git stash clear");
			expect(result.exitCode).toBe(0);
		});
	});

	// ── Integration ──────────────────────────────────────────────────

	describe("integration", () => {
		test("stash and pop preserves multiple file changes", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			// Make changes to multiple files
			await bash.exec('echo "modified readme" > /repo/README.md');
			await bash.exec('echo "new file" > /repo/new.txt');
			await bash.exec("git add new.txt");

			// Stash
			await bash.exec("git stash");

			// Verify clean
			expect(await bash.fs.exists("/repo/new.txt")).toBe(false);
			expect(await readFile(bash.fs, "/repo/README.md")).toBe("# My Project");

			// Pop
			await bash.exec("git stash pop");

			// Verify all changes restored
			expect(await readFile(bash.fs, "/repo/README.md")).toBe("modified readme\n");
			// Note: new.txt was staged+tracked, so stash captures it in the
			// working tree tree and restores it on pop
			expect(await readFile(bash.fs, "/repo/new.txt")).toBe("new file\n");
		});

		test("multiple stashes work correctly as a stack", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			// First stash
			await bash.exec('echo "first change" > /repo/README.md');
			await bash.exec('git stash push -m "first"');

			// Second stash
			await bash.exec('echo "second change" > /repo/README.md');
			await bash.exec('git stash push -m "second"');

			// Pop most recent (second)
			await bash.exec("git stash pop");
			expect(await readFile(bash.fs, "/repo/README.md")).toBe("second change\n");

			// Reset working tree and index back to HEAD
			await bash.exec("git reset --hard HEAD");

			// Pop next (first, now at index 0)
			await bash.exec("git stash pop");
			expect(await readFile(bash.fs, "/repo/README.md")).toBe("first change\n");
		});

		test("stash on one branch, pop on another", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			// Modify and stash on main
			await bash.exec('echo "stashed changes" > /repo/README.md');
			await bash.exec("git stash");

			// Create and switch to a new branch
			await bash.exec("git checkout -b feature");

			// Pop the stash
			const result = await bash.exec("git stash pop");
			expect(result.exitCode).toBe(0);

			// Changes should be applied on the feature branch
			expect(await readFile(bash.fs, "/repo/README.md")).toBe("stashed changes\n");
		});

		test("stash preserves deleted files on pop", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			// Delete a file and stash
			await bash.exec("rm /repo/README.md");
			await bash.exec("git stash");

			// File should be back
			expect(await bash.fs.exists("/repo/README.md")).toBe(true);

			// Pop should re-delete it
			await bash.exec("git stash pop");
			expect(await bash.fs.exists("/repo/README.md")).toBe(false);
		});

		test("pop specific stash by index", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.exec('echo "first" > /repo/README.md');
			await bash.exec('git stash push -m "first"');

			await bash.exec('echo "second" > /repo/README.md');
			await bash.exec('git stash push -m "second"');

			// Pop the older stash (index 1)
			const result = await bash.exec("git stash pop 1");
			expect(result.exitCode).toBe(0);
			expect(await readFile(bash.fs, "/repo/README.md")).toBe("first\n");

			// Only the newer stash should remain at index 0
			const list = await bash.exec("git stash list");
			const lines = list.stdout.trim().split("\n");
			expect(lines).toHaveLength(1);
			expect(lines[0]).toContain("second");
		});
	});

	// ── Include untracked (-u) ──────────────────────────────────────

	describe("include-untracked", () => {
		test("stash -u saves and removes untracked files", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			// Create an untracked file
			await bash.exec('echo "untracked content" > /repo/untracked.txt');

			const result = await bash.exec("git stash push -u");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Saved working directory and index state");

			// Untracked file should be deleted from worktree
			expect(await bash.fs.exists("/repo/untracked.txt")).toBe(false);

			// Status should be clean
			const status = await bash.exec("git status");
			expect(status.stdout).toContain("nothing to commit");
		});

		test("stash pop restores untracked files from -u stash", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.exec('echo "untracked" > /repo/untracked.txt');
			await bash.exec("git stash push -u");

			const result = await bash.exec("git stash pop");
			expect(result.exitCode).toBe(0);

			// Untracked file should be restored
			expect(await readFile(bash.fs, "/repo/untracked.txt")).toBe("untracked\n");
		});

		test("stash -u with both tracked and untracked changes", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			// Modify a tracked file and create an untracked one
			await bash.exec('echo "modified" > /repo/README.md');
			await bash.exec('echo "new file" > /repo/new.txt');

			const result = await bash.exec('git stash push -u -m "both"');
			expect(result.exitCode).toBe(0);

			// Both should be gone
			expect(await readFile(bash.fs, "/repo/README.md")).toBe("# My Project");
			expect(await bash.fs.exists("/repo/new.txt")).toBe(false);

			// Pop restores both
			await bash.exec("git stash pop");
			expect(await readFile(bash.fs, "/repo/README.md")).toBe("modified\n");
			expect(await readFile(bash.fs, "/repo/new.txt")).toBe("new file\n");
		});

		test("stash -u with only untracked changes", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			// Only untracked file — no tracked changes
			await bash.exec('echo "brand new" > /repo/fresh.txt');

			const result = await bash.exec("git stash push -u");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Saved working directory and index state");
			expect(await bash.fs.exists("/repo/fresh.txt")).toBe(false);

			// Pop restores it
			const pop = await bash.exec("git stash pop");
			expect(pop.exitCode).toBe(0);
			expect(await readFile(bash.fs, "/repo/fresh.txt")).toBe("brand new\n");
		});

		test("stash pop fails when untracked file already exists", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.exec('echo "original" > /repo/conflict.txt');
			await bash.exec("git stash push -u");

			// Re-create the file before pop
			await bash.exec('echo "different" > /repo/conflict.txt');

			const result = await bash.exec("git stash pop");
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("already exists, no checkout");
			expect(result.stderr).toContain("conflict.txt");

			// File on disk should be unchanged
			expect(await readFile(bash.fs, "/repo/conflict.txt")).toBe("different\n");

			// Stash should still exist (pop failed)
			const list = await bash.exec("git stash list");
			expect(list.stdout).toContain("stash@{0}");
		});

		test("stash -u does not include gitignored files", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			// Set up .gitignore and create both ignored and untracked files
			await bash.exec('echo "*.log" > /repo/.gitignore');
			await bash.exec("git add .gitignore");
			await bash.exec('git commit -m "add gitignore"');

			await bash.exec('echo "debug output" > /repo/debug.log');
			await bash.exec('echo "untracked" > /repo/untracked.txt');

			const result = await bash.exec("git stash push -u");
			expect(result.exitCode).toBe(0);

			// Ignored file should still be on disk
			expect(await bash.fs.exists("/repo/debug.log")).toBe(true);
			// Untracked non-ignored file should be gone
			expect(await bash.fs.exists("/repo/untracked.txt")).toBe(false);
		});

		test("stash -u in subdirectory cleans empty parent dirs", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.exec("mkdir -p /repo/deep/nested/dir");
			await bash.exec('echo "deep file" > /repo/deep/nested/dir/file.txt');

			const result = await bash.exec("git stash push -u");
			expect(result.exitCode).toBe(0);

			// File and empty parent directories should be cleaned up
			expect(await bash.fs.exists("/repo/deep/nested/dir/file.txt")).toBe(false);
			expect(await bash.fs.exists("/repo/deep")).toBe(false);
		});

		test("stash show on -u stash shows tracked diffs only", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.exec('echo "modified" > /repo/README.md');
			await bash.exec('echo "untracked" > /repo/new.txt');
			await bash.exec("git stash push -u");

			const result = await bash.exec("git stash show");
			expect(result.exitCode).toBe(0);
			// Should show the tracked file diff
			expect(result.stdout).toContain("README.md");
			// Untracked files are in the 3rd parent, not in the main stash tree
			expect(result.stdout).not.toContain("new.txt");
		});

		test("without -u, untracked files are left behind", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.exec('echo "modified" > /repo/README.md');
			await bash.exec('echo "untracked" > /repo/untracked.txt');

			await bash.exec("git stash push");

			// Tracked file is restored, untracked file stays
			expect(await readFile(bash.fs, "/repo/README.md")).toBe("# My Project");
			expect(await bash.fs.exists("/repo/untracked.txt")).toBe(true);
		});

		test("stash apply restores untracked files without dropping stash", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.exec('echo "untracked" > /repo/ut.txt');
			await bash.exec("git stash push -u");

			const result = await bash.exec("git stash apply");
			expect(result.exitCode).toBe(0);

			// File should be restored
			expect(await readFile(bash.fs, "/repo/ut.txt")).toBe("untracked\n");

			// Stash should still exist
			const list = await bash.exec("git stash list");
			expect(list.stdout).toContain("stash@{0}");
		});
	});
});
