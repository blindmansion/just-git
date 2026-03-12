import { describe, expect, test } from "bun:test";
import { TEST_ENV } from "./fixtures";
import { createTestBash, pathExists } from "./util";

// ── Helpers ─────────────────────────────────────────────────────────

/** Create a bash instance with a committed regular file and set up a symlink. */
async function initWithSymlink() {
	const bash = createTestBash({
		files: { "/repo/target.txt": "hello world\n" },
		env: TEST_ENV,
	});
	await bash.exec("git init");
	await bash.exec("git add .");
	await bash.exec('git commit -m "initial"');

	// Create a symlink in the worktree
	await bash.fs.symlink("target.txt", "/repo/link.txt");
	return bash;
}

// ── git add / staging ───────────────────────────────────────────────

describe("symlink: git add", () => {
	test("stages a symlink with mode 120000 and blob = target path", async () => {
		const bash = await initWithSymlink();
		const result = await bash.exec("git add link.txt");
		expect(result.exitCode).toBe(0);

		// ls-files -s shows the staged entry with mode 120000
		const ls = await bash.exec("git ls-files -s");
		expect(ls.exitCode).toBe(0);
		const linkLine = ls.stdout.split("\n").find((l) => l.includes("link.txt"));
		expect(linkLine).toBeDefined();
		expect(linkLine).toContain("120000");
	});

	test("blob content is the symlink target, not the target file content", async () => {
		const bash = await initWithSymlink();
		await bash.exec("git add link.txt");

		// Show the blob content for the staged symlink
		const ls = await bash.exec("git ls-files -s");
		const linkLine = ls.stdout.split("\n").find((l) => l.includes("link.txt"));
		const hash = linkLine!.split(/\s+/)[1]!;

		const show = await bash.exec(`git show ${hash}`);
		expect(show.exitCode).toBe(0);
		// Blob content should be "target.txt", not "hello world\n"
		expect(show.stdout).toBe("target.txt");
	});
});

// ── git status ──────────────────────────────────────────────────────

describe("symlink: git status", () => {
	test("shows symlink as untracked", async () => {
		const bash = await initWithSymlink();
		const result = await bash.exec("git status");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("link.txt");
	});

	test("shows staged symlink as new file", async () => {
		const bash = await initWithSymlink();
		await bash.exec("git add link.txt");
		const result = await bash.exec("git status");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("new file:");
		expect(result.stdout).toContain("link.txt");
	});

	test("detects modified symlink target", async () => {
		const bash = await initWithSymlink();
		await bash.exec("git add link.txt");
		await bash.exec('git commit -m "add symlink"');

		// Change the symlink target — must create target so symlink isn't broken
		await bash.fs.writeFile("/repo/other.txt", "other");
		await bash.fs.rm("/repo/link.txt");
		await bash.fs.symlink("other.txt", "/repo/link.txt");

		const result = await bash.exec("git status");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("modified:");
		expect(result.stdout).toContain("link.txt");
	});
});

// ── git commit ──────────────────────────────────────────────────────

describe("symlink: git commit", () => {
	test("commit preserves symlink mode in tree", async () => {
		const bash = await initWithSymlink();
		await bash.exec("git add link.txt");
		const commitResult = await bash.exec('git commit -m "add symlink"');
		expect(commitResult.exitCode).toBe(0);

		// Show the tree entry — should be mode 120000
		const ls = await bash.exec("git ls-files -s");
		const linkLine = ls.stdout.split("\n").find((l) => l.includes("link.txt"));
		expect(linkLine).toContain("120000");
	});
});

// ── git checkout ────────────────────────────────────────────────────

describe("symlink: git checkout", () => {
	test("checkout creates a symlink in the worktree", async () => {
		const bash = await initWithSymlink();
		await bash.exec("git add link.txt");
		await bash.exec('git commit -m "add symlink"');

		// Remove the symlink from worktree
		await bash.fs.rm("/repo/link.txt");
		expect(await pathExists(bash.fs, "/repo/link.txt")).toBe(false);

		// Checkout restores it
		await bash.exec("git checkout -- link.txt");

		// It should exist and be a symlink
		const lstat = await bash.fs.lstat("/repo/link.txt");
		expect(lstat.isSymbolicLink).toBe(true);

		// The target should be "target.txt"
		const target = await bash.fs.readlink("/repo/link.txt");
		expect(target).toBe("target.txt");
	});

	test("branch switch restores symlinks correctly", async () => {
		const bash = await initWithSymlink();
		await bash.exec("git add link.txt");
		await bash.exec('git commit -m "add symlink"');

		// Create a branch and remove the symlink
		await bash.exec("git checkout -b no-link");
		await bash.exec("git rm -f link.txt");
		await bash.exec('git commit -m "remove symlink"');

		// Verify it's gone
		const gone = await bash.fs
			.lstat("/repo/link.txt")
			.then(() => false)
			.catch(() => true);
		expect(gone).toBe(true);

		// Switch back — symlink should reappear
		await bash.exec("git checkout main");
		const lstat = await bash.fs.lstat("/repo/link.txt");
		expect(lstat.isSymbolicLink).toBe(true);
		const target = await bash.fs.readlink("/repo/link.txt");
		expect(target).toBe("target.txt");
	});
});

// ── git diff ────────────────────────────────────────────────────────

describe("symlink: git diff", () => {
	test("diff --cached shows symlink addition", async () => {
		const bash = await initWithSymlink();
		await bash.exec("git add link.txt");

		const diff = await bash.exec("git diff --cached");
		expect(diff.exitCode).toBe(0);
		expect(diff.stdout).toContain("new file mode 120000");
		expect(diff.stdout).toContain("link.txt");
	});

	test("unstaged diff shows modified symlink", async () => {
		const bash = await initWithSymlink();
		await bash.exec("git add link.txt");
		await bash.exec('git commit -m "add symlink"');

		// Change symlink target — create the file so the symlink isn't broken
		await bash.fs.writeFile("/repo/other.txt", "other");
		await bash.fs.rm("/repo/link.txt");
		await bash.fs.symlink("other.txt", "/repo/link.txt");

		const diff = await bash.exec("git diff");
		expect(diff.exitCode).toBe(0);
		expect(diff.stdout).toContain("link.txt");
		expect(diff.stdout).toContain("target.txt");
		expect(diff.stdout).toContain("other.txt");
	});
});

// ── walkWorkTree safety ─────────────────────────────────────────────

describe("symlink: walkWorkTree safety", () => {
	test("does not recurse into symlinked directories", async () => {
		const bash = createTestBash({
			files: {
				"/repo/real-dir/file.txt": "content",
			},
			env: TEST_ENV,
		});
		await bash.exec("git init");

		// Create a directory symlink pointing to real-dir
		await bash.fs.symlink("real-dir", "/repo/dir-link");

		// git add . should not traverse into dir-link recursively
		await bash.exec("git add .");
		const ls = await bash.exec("git ls-files -s");

		// Should have real-dir/file.txt and dir-link (the symlink itself)
		const lines = ls.stdout.trim().split("\n").filter(Boolean);
		const paths = lines.map((l) => l.split("\t")[1]);
		expect(paths).toContain("real-dir/file.txt");
		expect(paths).toContain("dir-link");
		// Should NOT have dir-link/file.txt (would mean recursion into symlink)
		expect(paths).not.toContain("dir-link/file.txt");
	});

	test("does not infinite-loop on circular symlink", async () => {
		const bash = createTestBash({
			files: { "/repo/file.txt": "content" },
			env: TEST_ENV,
		});
		await bash.exec("git init");

		// Create a circular symlink (points to parent)
		await bash.fs.symlink("..", "/repo/loop");

		// git status should complete without hanging
		const result = await bash.exec("git status");
		expect(result.exitCode).toBe(0);
	});
});

// ── merge conflicts ─────────────────────────────────────────────────

describe("symlink: merge conflicts", () => {
	test("conflicting symlink changes produce a conflict", async () => {
		const bash = createTestBash({
			files: {
				"/repo/file.txt": "content",
				"/repo/other-target": "other",
			},
			env: TEST_ENV,
		});
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "initial"');

		// Create branch "other" at initial commit before adding symlink
		await bash.exec("git branch other");

		// Create a symlink on main
		await bash.fs.symlink("file.txt", "/repo/link");
		await bash.exec("git add link");
		await bash.exec('git commit -m "add symlink on main"');

		// Switch to other, create different symlink
		await bash.exec("git checkout other");
		await bash.fs.symlink("other-target", "/repo/link");
		await bash.exec("git add link");
		await bash.exec('git commit -m "add different symlink on other"');

		// Merge should conflict (add/add)
		const merge = await bash.exec("git merge main");
		expect(merge.exitCode).not.toBe(0);
		expect(merge.stdout + merge.stderr).toContain("CONFLICT");
	});

	test("non-conflicting symlink merge (only one side changed) resolves cleanly", async () => {
		const bash = createTestBash({
			files: { "/repo/file.txt": "content" },
			env: TEST_ENV,
		});
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "initial"');

		// Create branch "other" at initial commit
		await bash.exec("git branch other");

		// Add symlink on main
		await bash.fs.symlink("file.txt", "/repo/link");
		await bash.exec("git add link");
		await bash.exec('git commit -m "add symlink on main"');

		// Switch to other, add a different file (no conflict)
		await bash.exec("git checkout other");
		await bash.fs.writeFile("/repo/other.txt", "other content");
		await bash.exec("git add other.txt");
		await bash.exec('git commit -m "add other file"');

		// Merge should succeed — symlink is only added on main side
		const merge = await bash.exec("git merge main");
		expect(merge.exitCode).toBe(0);

		// The symlink should be present after merge
		const lstat = await bash.fs.lstat("/repo/link");
		expect(lstat.isSymbolicLink).toBe(true);
	});
});

// ── git rm ──────────────────────────────────────────────────────────

describe("symlink: git rm", () => {
	test("removes a tracked symlink", async () => {
		const bash = await initWithSymlink();
		await bash.exec("git add link.txt");
		await bash.exec('git commit -m "add symlink"');

		const rm = await bash.exec("git rm link.txt");
		expect(rm.exitCode).toBe(0);
		expect(await pathExists(bash.fs, "/repo/link.txt")).toBe(false);

		const ls = await bash.exec("git ls-files");
		expect(ls.stdout).not.toContain("link.txt");
	});
});

// ── git restore ─────────────────────────────────────────────────────

describe("symlink: git restore", () => {
	test("restores a deleted symlink from index", async () => {
		const bash = await initWithSymlink();
		await bash.exec("git add link.txt");
		await bash.exec('git commit -m "add symlink"');

		// Delete it
		await bash.fs.rm("/repo/link.txt");
		expect(await pathExists(bash.fs, "/repo/link.txt")).toBe(false);

		// Restore
		const restore = await bash.exec("git restore link.txt");
		expect(restore.exitCode).toBe(0);

		const lstat = await bash.fs.lstat("/repo/link.txt");
		expect(lstat.isSymbolicLink).toBe(true);
		const target = await bash.fs.readlink("/repo/link.txt");
		expect(target).toBe("target.txt");
	});
});

// ── git reset --hard ────────────────────────────────────────────────

describe("symlink: git reset --hard", () => {
	test("resets worktree symlink to committed state", async () => {
		const bash = await initWithSymlink();
		await bash.exec("git add link.txt");
		await bash.exec('git commit -m "add symlink"');

		// Modify the symlink — create target so it's not broken
		await bash.fs.writeFile("/repo/changed.txt", "changed");
		await bash.fs.rm("/repo/link.txt");
		await bash.fs.symlink("changed.txt", "/repo/link.txt");

		const reset = await bash.exec("git reset --hard");
		expect(reset.exitCode).toBe(0);

		const target = await bash.fs.readlink("/repo/link.txt");
		expect(target).toBe("target.txt");
	});
});
