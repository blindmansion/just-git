import { describe, expect, test } from "bun:test";
import { EMPTY_REPO, TEST_ENV_NAMED as TEST_ENV, envAt } from "../fixtures";
import { createTestBash, readFile } from "../util";

describe("git merge", () => {
	// ── Error cases ──────────────────────────────────────────────────

	describe("error cases", () => {
		test("outside a git repo", async () => {
			const bash = createTestBash({ files: EMPTY_REPO });
			const result = await bash.exec("git merge feature");
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("not a git repository");
		});

		test("no argument", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			const result = await bash.exec("git merge");
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("you must specify a branch");
		});

		test("invalid branch name", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			const result = await bash.exec("git merge nonexistent");
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("not something we can merge");
		});

		test("no commits yet", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			const result = await bash.exec("git merge feature");
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("does not have any commits yet");
		});
	});

	// ── Already up to date ──────────────────────────────────────────

	describe("already up to date", () => {
		test("merging an ancestor is already up to date", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: envAt("100") });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.exec("git branch feature");

			// Add more commits on main
			await bash.fs.writeFile("/repo/file2.txt", "more");
			await bash.exec("git add file2.txt");
			await bash.exec('git commit -m "second"');

			// feature is behind main — merging feature into main is already up to date
			const result = await bash.exec("git merge feature");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Already up to date");
		});
	});

	// ── Fast-forward merge ──────────────────────────────────────────

	describe("fast-forward", () => {
		test("fast-forwards when current is behind", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: envAt("100") });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.exec("git branch feature");

			// Add commits on feature
			await bash.exec("git checkout feature");
			await bash.fs.writeFile("/repo/feature-file.txt", "feature work\n");
			await bash.exec("git add feature-file.txt");
			await bash.exec('git commit -m "feature work"');

			// Switch back to main and merge
			await bash.exec("git checkout main");
			const result = await bash.exec("git merge feature");

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Fast-forward");

			// Working tree should have the feature file
			const featureContent = await readFile(bash.fs, "/repo/feature-file.txt");
			expect(featureContent).toBe("feature work\n");

			// main should now point to the same commit as feature
			const mainRef = await readFile(bash.fs, "/repo/.git/refs/heads/main");
			const featureRef = await readFile(bash.fs, "/repo/.git/refs/heads/feature");
			expect(mainRef).toBe(featureRef);
		});

		test("--no-ff creates merge commit even when fast-forward is possible", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: envAt("100") });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.exec("git branch feature");

			await bash.exec("git checkout feature");
			await bash.fs.writeFile("/repo/feature-file.txt", "feature\n");
			await bash.exec("git add feature-file.txt");
			await bash.exec('git commit -m "feature"');

			await bash.exec("git checkout main");
			const result = await bash.exec("git merge --no-ff feature");

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("ort");

			// Should have created a merge commit (main and feature are different)
			const mainRef = (await readFile(bash.fs, "/repo/.git/refs/heads/main"))?.trim();
			const featureRef = (await readFile(bash.fs, "/repo/.git/refs/heads/feature"))?.trim();
			expect(mainRef).not.toBe(featureRef);

			// Verify the merge commit has two parents by checking git log
			const log = await bash.exec("git log --oneline");
			expect(log.stdout).toContain("Merge branch");
		});
	});

	// ── Three-way merge (clean) ─────────────────────────────────────

	describe("three-way merge (clean)", () => {
		test("merges non-overlapping changes cleanly", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: envAt("100") });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.exec("git branch feature");

			// Add file on main
			await bash.fs.writeFile("/repo/main-file.txt", "main content\n");
			await bash.exec("git add main-file.txt");
			await bash.exec('git commit -m "main adds file"');

			// Add file on feature
			await bash.exec("git checkout feature");
			await bash.fs.writeFile("/repo/feature-file.txt", "feature content\n");
			await bash.exec("git add feature-file.txt");
			await bash.exec('git commit -m "feature adds file"');

			// Merge feature into main
			await bash.exec("git checkout main");
			const result = await bash.exec("git merge feature");

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("ort");

			// Both files should exist
			expect(await readFile(bash.fs, "/repo/main-file.txt")).toBe("main content\n");
			expect(await readFile(bash.fs, "/repo/feature-file.txt")).toBe("feature content\n");

			// Should be a merge commit with two parents
			const log = await bash.exec("git log --oneline");
			expect(log.stdout).toContain("Merge branch");
		});

		test("merges non-overlapping edits to the same file", async () => {
			const bash = createTestBash({
				files: {
					"/repo/file.txt": "line1\nline2\nline3\nline4\nline5\n",
				},
				env: envAt("100"),
			});
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.exec("git branch feature");

			// Main changes line 1
			await bash.fs.writeFile("/repo/file.txt", "MAIN\nline2\nline3\nline4\nline5\n");
			await bash.exec("git add file.txt");
			await bash.exec('git commit -m "main edits"');

			// Feature changes line 5
			await bash.exec("git checkout feature");
			await bash.fs.writeFile("/repo/file.txt", "line1\nline2\nline3\nline4\nFEATURE\n");
			await bash.exec("git add file.txt");
			await bash.exec('git commit -m "feature edits"');

			await bash.exec("git checkout main");
			const result = await bash.exec("git merge feature");

			expect(result.exitCode).toBe(0);

			// Result should have both edits
			const content = await readFile(bash.fs, "/repo/file.txt");
			expect(content).toContain("MAIN");
			expect(content).toContain("FEATURE");
		});
	});

	// ── Three-way merge (conflicts) ─────────────────────────────────

	describe("three-way merge (conflicts)", () => {
		test("detects content conflict and writes markers", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: envAt("100") });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.exec("git branch feature");

			// Modify README on main
			await bash.fs.writeFile("/repo/README.md", "# Main Version\n");
			await bash.exec("git add README.md");
			await bash.exec('git commit -m "main changes"');

			// Modify README on feature differently
			await bash.exec("git checkout feature");
			await bash.fs.writeFile("/repo/README.md", "# Feature Version\n");
			await bash.exec("git add README.md");
			await bash.exec('git commit -m "feature changes"');

			await bash.exec("git checkout main");
			const result = await bash.exec("git merge feature");

			expect(result.exitCode).toBe(1);
			expect(result.stdout).toContain("CONFLICT");
			expect(result.stdout).toContain("Automatic merge failed");

			// Working tree should have conflict markers
			const content = await readFile(bash.fs, "/repo/README.md");
			expect(content).toContain("<<<<<<<");
			expect(content).toContain("=======");
			expect(content).toContain(">>>>>>>");

			// MERGE_HEAD should exist
			const mergeHead = await readFile(bash.fs, "/repo/.git/MERGE_HEAD");
			expect(mergeHead).toBeDefined();
			expect(mergeHead?.trim()).toMatch(/^[0-9a-f]{40}$/);

			// ORIG_HEAD should exist
			const origHead = await readFile(bash.fs, "/repo/.git/ORIG_HEAD");
			expect(origHead).toBeDefined();

			// MERGE_MSG should exist
			const mergeMsg = await readFile(bash.fs, "/repo/.git/MERGE_MSG");
			expect(mergeMsg).toContain("Merge branch");
		});

		test("merge in progress blocks another merge", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: envAt("100") });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.exec("git branch feature");

			await bash.fs.writeFile("/repo/README.md", "# Main\n");
			await bash.exec("git add README.md");
			await bash.exec('git commit -m "main"');

			await bash.exec("git checkout feature");
			await bash.fs.writeFile("/repo/README.md", "# Feature\n");
			await bash.exec("git add README.md");
			await bash.exec('git commit -m "feature"');

			await bash.exec("git checkout main");
			await bash.exec("git merge feature"); // conflicts

			// Try another merge
			const result = await bash.exec("git merge feature");
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("unmerged files");
		});
	});

	// ── --abort ──────────────────────────────────────────────────────

	describe("--abort", () => {
		test("restores pre-merge state", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: envAt("100") });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.exec("git branch feature");

			await bash.fs.writeFile("/repo/README.md", "# Main\n");
			await bash.exec("git add README.md");
			await bash.exec('git commit -m "main"');

			const preMainRef = (await readFile(bash.fs, "/repo/.git/refs/heads/main"))?.trim();

			await bash.exec("git checkout feature");
			await bash.fs.writeFile("/repo/README.md", "# Feature\n");
			await bash.exec("git add README.md");
			await bash.exec('git commit -m "feature"');

			await bash.exec("git checkout main");
			await bash.exec("git merge feature"); // conflicts

			// Abort
			const result = await bash.exec("git merge --abort");
			expect(result.exitCode).toBe(0);

			// HEAD should be back to pre-merge
			const mainRef = (await readFile(bash.fs, "/repo/.git/refs/heads/main"))?.trim();
			expect(mainRef).toBe(preMainRef);

			// Working tree should be restored
			const content = await readFile(bash.fs, "/repo/README.md");
			expect(content).toBe("# Main\n");
			expect(content).not.toContain("<<<<<<<");

			// Merge state files should be cleaned up
			expect(await bash.fs.exists("/repo/.git/MERGE_HEAD")).toBe(false);
			expect(await bash.fs.exists("/repo/.git/ORIG_HEAD")).toBe(false);
			expect(await bash.fs.exists("/repo/.git/MERGE_MSG")).toBe(false);
		});

		test("errors when no merge in progress", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			const result = await bash.exec("git merge --abort");
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("no merge to abort");
		});
	});

	// ── Conflict resolution flow ────────────────────────────────────

	describe("conflict resolution", () => {
		test("resolve conflict then commit with -m creates merge commit", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: envAt("100") });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.exec("git branch feature");

			await bash.fs.writeFile("/repo/README.md", "# Main\n");
			await bash.exec("git add README.md");
			await bash.exec('git commit -m "main"');

			await bash.exec("git checkout feature");
			await bash.fs.writeFile("/repo/README.md", "# Feature\n");
			await bash.exec("git add README.md");
			await bash.exec('git commit -m "feature"');

			await bash.exec("git checkout main");
			await bash.exec("git merge feature"); // conflicts

			// Resolve: write resolved content and add
			await bash.fs.writeFile("/repo/README.md", "# Resolved\n");
			await bash.exec("git add README.md");

			// Commit with -m should work (creates merge commit via commit's MERGE_HEAD awareness)
			const commitResult = await bash.exec('git commit -m "resolved merge"');
			expect(commitResult.exitCode).toBe(0);
		});
	});
});
