import { describe, expect, test } from "bun:test";
import { EMPTY_REPO, TEST_ENV_NAMED as TEST_ENV, envAt } from "../fixtures";
import { createTestBash, pathExists, readFile } from "../util";

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

		test("uses merge.renameLimit and warns once when inexact detection is skipped", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: envAt("100") });
			await bash.exec("git init");
			await bash.fs.writeFile("/repo/old-a.txt", "old a\n");
			await bash.fs.writeFile("/repo/old-b.txt", "old b\n");
			await bash.exec("git add . && git commit -m 'initial'");
			await bash.exec("git branch feature");

			await bash.fs.writeFile("/repo/main.txt", "main\n");
			await bash.exec("git add . && git commit -m 'main'");

			await bash.exec("git checkout feature");
			await bash.exec("rm old-a.txt old-b.txt");
			await bash.fs.writeFile("/repo/new-a.txt", "new a\n");
			await bash.fs.writeFile("/repo/new-b.txt", "new b\n");
			await bash.exec("git add -A && git commit -m 'feature'");

			await bash.exec("git checkout main");
			await bash.exec("git config diff.renameLimit 10");
			await bash.exec("git config merge.renameLimit 1");
			const result = await bash.exec("git merge feature");

			expect(result.exitCode).toBe(0);
			expect(result.stderr).toBe(
				"warning: exhaustive rename detection was skipped due to too many files.\n" +
					"warning: you may want to set your merge.renameLimit variable to at least 2 and retry the command.\n",
			);
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

	describe("squash merges", () => {
		test("merge --squash -m still writes generated SQUASH_MSG", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: envAt("100") });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.exec("git branch feature");

			await bash.exec("git checkout feature");
			await bash.fs.writeFile("/repo/feature.txt", "feature content\n");
			await bash.exec("git add feature.txt");
			await bash.exec('git commit -m "feature work"');

			await bash.exec("git checkout main");
			const result = await bash.exec('git merge --squash -m "custom squash title" feature');

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Squash commit -- not updating HEAD");

			const squashMsg = await readFile(bash.fs, "/repo/.git/SQUASH_MSG");
			expect(squashMsg).toContain("Squashed commit of the following:");
			expect(squashMsg).toContain("commit ");
			expect(squashMsg).toContain("feature work");
			expect(squashMsg).not.toContain("custom squash title");
		});

		test("rejects --squash and --no-ff before merge analysis", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: envAt("100") });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.exec("git branch feature");

			await bash.exec("git checkout feature");
			await bash.fs.writeFile("/repo/feature.txt", "feature content\n");
			await bash.exec("git add feature.txt");
			await bash.exec('git commit -m "feature work"');

			await bash.exec("git checkout main");
			const result = await bash.exec("git merge --squash --no-ff feature");
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toBe(
				"fatal: options '--squash' and '--no-ff.' cannot be used together\n",
			);
		});

		test("rejects --squash with merge.ff=false before resolving branch", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: envAt("100") });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.exec("git config merge.ff false");

			// Branch does not exist: git validates the --squash/implicit --no-ff
			// conflict before resolving the branch, so exit is 128 (not the
			// "not something we can merge" ref-resolution error, exit 1).
			const result = await bash.exec("git merge --squash nonexistent-branch");
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toBe(
				"fatal: options '--squash' and '--no-ff.' cannot be used together\n",
			);
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

	// ── merge.ff config ──────────────────────────────────────────────

	describe("merge.ff config", () => {
		test("merge.ff=false forces merge commit on fast-forward", async () => {
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
			await bash.exec("git config merge.ff false");
			const result = await bash.exec("git merge feature");

			expect(result.exitCode).toBe(0);
			// Should NOT fast-forward — should create a merge commit
			expect(result.stdout).not.toContain("Fast-forward");
			const log = await bash.exec("git log --oneline");
			expect(log.stdout).toContain("Merge branch");
		});

		test("merge.ff=only rejects non-fast-forward merge", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: envAt("100") });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.exec("git branch feature");

			// Diverge both branches
			await bash.fs.writeFile("/repo/main-file.txt", "main\n");
			await bash.exec("git add main-file.txt");
			await bash.exec('git commit -m "main"');

			await bash.exec("git checkout feature");
			await bash.fs.writeFile("/repo/feature-file.txt", "feature\n");
			await bash.exec("git add feature-file.txt");
			await bash.exec('git commit -m "feature"');

			await bash.exec("git checkout main");
			await bash.exec("git config merge.ff only");
			const result = await bash.exec("git merge feature");

			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("Not possible to fast-forward");
		});

		test("merge.ff=only allows fast-forward merge", async () => {
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
			await bash.exec("git config merge.ff only");
			const result = await bash.exec("git merge feature");

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Fast-forward");
		});

		test("--no-ff overrides merge.ff=only", async () => {
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
			await bash.exec("git config merge.ff only");
			const result = await bash.exec("git merge --no-ff feature");

			expect(result.exitCode).toBe(0);
			expect(result.stdout).not.toContain("Fast-forward");
			const log = await bash.exec("git log --oneline");
			expect(log.stdout).toContain("Merge branch");
		});

		test("--ff-only overrides merge.ff=false", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: envAt("100") });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.exec("git branch feature");

			// Diverge branches
			await bash.fs.writeFile("/repo/main-file.txt", "main\n");
			await bash.exec("git add main-file.txt");
			await bash.exec('git commit -m "main"');

			await bash.exec("git checkout feature");
			await bash.fs.writeFile("/repo/feature-file.txt", "feature\n");
			await bash.exec("git add feature-file.txt");
			await bash.exec('git commit -m "feature"');

			await bash.exec("git checkout main");
			await bash.exec("git config merge.ff false");
			const result = await bash.exec("git merge --ff-only feature");

			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("Not possible to fast-forward");
		});
	});

	// ── merge.conflictStyle ─────────────────────────────────────────

	describe("merge.conflictStyle", () => {
		test("diff3 includes base section in conflict markers", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: envAt("100") });
			await bash.exec("git init");
			await bash.fs.writeFile("/repo/file.txt", "line1\noriginal\nline3\n");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.exec("git branch feature");

			await bash.fs.writeFile("/repo/file.txt", "line1\nours\nline3\n");
			await bash.exec("git add file.txt");
			await bash.exec('git commit -m "main"');

			await bash.exec("git checkout feature");
			await bash.fs.writeFile("/repo/file.txt", "line1\ntheirs\nline3\n");
			await bash.exec("git add file.txt");
			await bash.exec('git commit -m "feature"');

			await bash.exec("git checkout main");
			await bash.exec("git config merge.conflictStyle diff3");
			const result = await bash.exec("git merge feature");

			expect(result.exitCode).toBe(1);
			const content = await readFile(bash.fs, "/repo/file.txt");
			expect(content).toContain("<<<<<<< HEAD");
			expect(content).toContain("|||||||");
			expect(content).toContain("original");
			expect(content).toContain("=======");
			expect(content).toContain(">>>>>>> feature");
		});

		test("default merge style has no ||||||| markers", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: envAt("100") });
			await bash.exec("git init");
			await bash.fs.writeFile("/repo/file.txt", "line1\noriginal\nline3\n");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.exec("git branch feature");

			await bash.fs.writeFile("/repo/file.txt", "line1\nours\nline3\n");
			await bash.exec("git add file.txt");
			await bash.exec('git commit -m "main"');

			await bash.exec("git checkout feature");
			await bash.fs.writeFile("/repo/file.txt", "line1\ntheirs\nline3\n");
			await bash.exec("git add file.txt");
			await bash.exec('git commit -m "feature"');

			await bash.exec("git checkout main");
			const result = await bash.exec("git merge feature");

			expect(result.exitCode).toBe(1);
			const content = await readFile(bash.fs, "/repo/file.txt");
			expect(content).toContain("<<<<<<<");
			expect(content).not.toContain("|||||||");
		});

		test("diff3 works with cherry-pick", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: envAt("100") });
			await bash.exec("git init");
			await bash.fs.writeFile("/repo/file.txt", "line1\noriginal\nline3\n");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.exec("git branch feature");

			await bash.exec("git checkout feature");
			await bash.fs.writeFile("/repo/file.txt", "line1\nfeature\nline3\n");
			await bash.exec("git add file.txt");
			await bash.exec('git commit -m "feature change"');

			await bash.exec("git checkout main");
			await bash.fs.writeFile("/repo/file.txt", "line1\nmain\nline3\n");
			await bash.exec("git add file.txt");
			await bash.exec('git commit -m "main change"');

			await bash.exec("git config merge.conflictStyle diff3");
			const result = await bash.exec("git cherry-pick feature");

			expect(result.exitCode).toBe(1);
			const content = await readFile(bash.fs, "/repo/file.txt");
			expect(content).toContain("|||||||");
			expect(content).toContain("original");
		});

		test("diff3 works with revert", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: envAt("100") });
			await bash.exec("git init");
			await bash.fs.writeFile("/repo/file.txt", "line1\noriginal\nline3\n");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.fs.writeFile("/repo/file.txt", "line1\nchanged\nline3\n");
			await bash.exec("git add file.txt");
			await bash.exec('git commit -m "change"');

			await bash.fs.writeFile("/repo/file.txt", "line1\nmodified-further\nline3\n");
			await bash.exec("git add file.txt");
			await bash.exec('git commit -m "further"');

			await bash.exec("git config merge.conflictStyle diff3");
			const result = await bash.exec("git revert HEAD~1");

			expect(result.exitCode).toBe(1);
			const content = await readFile(bash.fs, "/repo/file.txt");
			expect(content).toContain("|||||||");
		});
	});

	describe("--quiet", () => {
		/**
		 * main:     init -- M (main.txt)
		 * ff:       init -- F (ff.txt)          (fast-forwardable from init)
		 * side:     init -- S (README.md edit)  (clean three-way from M)
		 * conflict: init -- C (main.txt)        (conflicts with M)
		 */
		async function setup() {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.exec("git checkout -b ff");
			await bash.fs.writeFile("/repo/ff.txt", "ff");
			await bash.exec("git add ff.txt");
			await bash.exec('git commit -m "ff"');
			await bash.exec("git checkout -b side main");
			await bash.fs.writeFile("/repo/README.md", "side");
			await bash.exec('git commit -am "side"');
			await bash.exec("git checkout -b conflict main");
			await bash.fs.writeFile("/repo/main.txt", "conflict");
			await bash.exec("git add main.txt");
			await bash.exec('git commit -m "conflict"');
			await bash.exec("git checkout main");
			return bash;
		}

		test("-q silences fast-forward and already-up-to-date", async () => {
			const bash = await setup();
			const ffHash = (await bash.exec("git rev-parse ff")).stdout;
			const ff = await bash.exec("git merge -q ff");
			expect(ff).toMatchObject({ stdout: "", stderr: "", exitCode: 0 });
			expect((await bash.exec("git rev-parse HEAD")).stdout).toBe(ffHash);
			expect(await readFile(bash.fs, "/repo/ff.txt")).toBe("ff");

			const again = await bash.exec("git merge --quiet ff");
			expect(again).toMatchObject({ stdout: "", stderr: "", exitCode: 0 });
		});

		test("--no-quiet after -q restores output", async () => {
			const bash = await setup();
			const result = await bash.exec("git merge -q --no-quiet ff");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toMatch(/^Updating [0-9a-f]+\.\.[0-9a-f]+\nFast-forward\n/);
		});

		test("-q silences a clean three-way merge", async () => {
			const bash = await setup();
			await bash.fs.writeFile("/repo/main.txt", "main");
			await bash.exec("git add main.txt");
			await bash.exec('git commit -m "main"');

			const result = await bash.exec("git merge -q side");
			expect(result).toMatchObject({ stdout: "", stderr: "", exitCode: 0 });
			expect((await bash.exec("git log -1 --format=%s")).stdout).toBe("Merge branch 'side'\n");
			expect(await readFile(bash.fs, "/repo/README.md")).toBe("side");
		});

		test("-q still prints conflicts", async () => {
			const bash = await setup();
			await bash.fs.writeFile("/repo/main.txt", "main");
			await bash.exec("git add main.txt");
			await bash.exec('git commit -m "main"');

			const result = await bash.exec("git merge -q conflict");
			expect(result.exitCode).toBe(1);
			expect(result.stdout).toBe(
				"Auto-merging main.txt\n" +
					"CONFLICT (add/add): Merge conflict in main.txt\n" +
					"Automatic merge failed; fix conflicts and then commit the result.\n",
			);
			expect(await pathExists(bash.fs, "/repo/.git/MERGE_HEAD")).toBe(true);
		});

		test("-q still prints errors", async () => {
			const bash = await setup();
			await bash.fs.writeFile("/repo/ff.txt", "untracked");
			const result = await bash.exec("git merge -q ff");
			expect(result.exitCode).not.toBe(0);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain(
				"error: The following untracked working tree files would be overwritten by merge:\n\tff.txt\n",
			);

			const bad = await bash.exec("git merge -q nope");
			expect(bad.exitCode).toBe(1);
			expect(bad.stderr).toBe("merge: nope - not something we can merge\n");
		});

		test("--squash -q keeps the squash notice", async () => {
			const bash = await setup();
			const ff = await bash.exec("git merge -q --squash ff");
			expect(ff).toMatchObject({
				stdout: "Squash commit -- not updating HEAD\n",
				stderr: "",
				exitCode: 0,
			});
			await bash.exec("git reset --hard");

			await bash.fs.writeFile("/repo/main.txt", "main");
			await bash.exec("git add main.txt");
			await bash.exec('git commit -m "main"');
			const threeWay = await bash.exec("git merge -q --squash side");
			expect(threeWay).toMatchObject({
				stdout: "Squash commit -- not updating HEAD\n",
				stderr: "Automatic merge went well; stopped before committing as requested\n",
				exitCode: 0,
			});
		});

		test("--abort/--continue reject -q before checking merge state", async () => {
			const bash = await setup();
			const noMerge = await bash.exec("git merge --abort -q");
			expect(noMerge.exitCode).toBe(129);
			expect(noMerge.stderr).toStartWith(
				"fatal: --abort expects no arguments\n\nusage: git merge [<options>] [<commit>...]\n",
			);

			await bash.fs.writeFile("/repo/main.txt", "main");
			await bash.exec("git add main.txt");
			await bash.exec('git commit -m "main"');
			expect((await bash.exec("git merge conflict")).exitCode).toBe(1);
			const abort = await bash.exec("git merge -q --abort");
			expect(abort.exitCode).toBe(129);
			expect(abort.stderr).toStartWith("fatal: --abort expects no arguments\n");
			const cont = await bash.exec("git merge --continue --quiet");
			expect(cont.exitCode).toBe(129);
			expect(cont.stderr).toStartWith("fatal: --continue expects no arguments\n");
			expect(await pathExists(bash.fs, "/repo/.git/MERGE_HEAD")).toBe(true);

			const unresolved = await bash.exec("git merge --continue");
			expect(unresolved.exitCode).toBe(128);
			expect(unresolved.stdout).toBe("U\tmain.txt\n");
		});
	});

	// ── File modes ──────────────────────────────────────────────────

	describe("file modes", () => {
		// Each commit sets its own modes: checkout does not rewrite permission
		// bits here, so a branch switch can leave the previous branch's mode behind.
		async function modeRepo(script: string) {
			const bash = createTestBash({ files: EMPTY_REPO, env: envAt("100") });
			const setup = await bash.exec(
				`c() { git add -A && git commit -qm "$1"; }\ngit init -q -b main\n${script}`,
			);
			expect(setup.exitCode).toBe(0);
			return bash;
		}

		test("takes theirs' mode-only change", async () => {
			const bash = await modeRepo(`
printf "a\\n" > f; chmod 644 f; c base
git checkout -q -b theirs; chmod 755 f; c theirs
git checkout -q main; chmod 644 f; echo o > o; c ours`);

			const result = await bash.exec("git merge -m merge theirs");
			expect(result).toMatchObject({
				exitCode: 0,
				stderr: "",
				stdout:
					"Merge made by the 'ort' strategy.\n" +
					" f | 0\n" +
					" 1 file changed, 0 insertions(+), 0 deletions(-)\n" +
					" mode change 100644 => 100755 f\n",
			});
			expect((await bash.exec("git ls-files -s f")).stdout).toBe(
				"100755 78981922613b2afb6025042ff6bd878ac1994e85 0\tf\n",
			);
		});

		test("keeps ours' mode change when theirs changes the content", async () => {
			const bash = await modeRepo(`
printf "1\\n2\\n" > f; chmod 644 f; c base
git checkout -q -b theirs; printf "1\\nT\\n" > f; c theirs
git checkout -q main; chmod 755 f; c ours`);

			const result = await bash.exec("git merge -m merge theirs");
			expect(result).toMatchObject({
				exitCode: 0,
				stderr: "",
				stdout:
					"Merge made by the 'ort' strategy.\n" +
					" f | 2 +-\n" +
					" 1 file changed, 1 insertion(+), 1 deletion(-)\n",
			});
			expect((await bash.exec("git ls-files -s f")).stdout).toBe(
				"100755 3f5a8cf24dd26339d0bd4f5873c9a8766e5660bd 0\tf\n",
			);
		});

		test("keeps theirs' mode change in a clean content merge", async () => {
			const bash = await modeRepo(`
printf "1\\n2\\n3\\n4\\n5\\n" > f; chmod 644 f; c base
git checkout -q -b theirs; printf "1\\n2\\n3\\n4\\nT\\n" > f; chmod 755 f; c theirs
git checkout -q main; printf "O\\n2\\n3\\n4\\n5\\n" > f; chmod 644 f; c ours`);

			const result = await bash.exec("git merge -m merge theirs");
			expect(result).toMatchObject({
				exitCode: 0,
				stderr: "",
				stdout:
					"Auto-merging f\n" +
					"Merge made by the 'ort' strategy.\n" +
					" f | 2 +-\n" +
					" 1 file changed, 1 insertion(+), 1 deletion(-)\n" +
					" mode change 100644 => 100755 f\n",
			});
			expect((await bash.exec("git ls-files -s f")).stdout).toBe(
				"100755 9d8d2f23dd74ac4621ad6af8f309ae779b7d4323 0\tf\n",
			);
		});

		test("conflicted merge keeps each side's mode in its stage and applies theirs' mode-only change", async () => {
			const bash = await modeRepo(`
printf "1\\n2\\n" > f; echo k > m; chmod 644 f m; c base
git checkout -q -b theirs; printf "T\\n2\\n" > f; chmod 755 f m; c theirs
git checkout -q main; printf "O\\n2\\n" > f; chmod 644 f m; c ours`);

			const result = await bash.exec("git merge -m merge theirs");
			expect(result).toMatchObject({
				exitCode: 1,
				stderr: "",
				stdout:
					"Auto-merging f\n" +
					"CONFLICT (content): Merge conflict in f\n" +
					"Automatic merge failed; fix conflicts and then commit the result.\n",
			});
			expect((await bash.exec("git ls-files -s f m")).stdout).toBe(
				"100644 1191247b6d9a206f6ba3d8ac79e26d041dd86941 1\tf\n" +
					"100644 7fae8bc2659a610af0b10ee31e213f52278a63ac 2\tf\n" +
					"100755 14fcbf669fee1a6e95015dd492056cc9bb527afa 3\tf\n" +
					"100755 b68fde2a051d9af2fe3ff4c96c0898e5a3212e4d 0\tm\n",
			);
		});

		test("both sides making the same mode change keep it", async () => {
			const bash = await modeRepo(`
printf "a\\n" > f; chmod 644 f; c base
git checkout -q -b theirs; chmod 755 f; echo t > t; c theirs
git checkout -q main; chmod 755 f; echo o > o; c ours`);

			const result = await bash.exec("git merge -m merge theirs");
			expect(result).toMatchObject({
				exitCode: 0,
				stderr: "",
				stdout:
					"Merge made by the 'ort' strategy.\n" +
					" t | 1 +\n" +
					" 1 file changed, 1 insertion(+)\n" +
					" create mode 100644 t\n",
			});
			expect((await bash.exec("git ls-files -s f")).stdout).toBe(
				"100755 78981922613b2afb6025042ff6bd878ac1994e85 0\tf\n",
			);
		});

		test("add/add with different modes conflicts even when the content matches", async () => {
			const bash = await modeRepo(`
echo x > x; c base
git checkout -q -b theirs; echo a > f; chmod 755 f; c theirs
git checkout -q main; rm -f f; echo a > f; chmod 644 f; c ours`);

			const result = await bash.exec("git merge -m merge theirs");
			expect(result).toMatchObject({
				exitCode: 1,
				stderr: "",
				stdout:
					"CONFLICT (add/add): Merge conflict in f\n" +
					"Automatic merge failed; fix conflicts and then commit the result.\n",
			});
			expect((await bash.exec("git ls-files -s f")).stdout).toBe(
				"100644 78981922613b2afb6025042ff6bd878ac1994e85 2\tf\n" +
					"100755 78981922613b2afb6025042ff6bd878ac1994e85 3\tf\n",
			);
			expect(await readFile(bash.fs, "/repo/f")).toBe("a\n");
		});

		test("takes theirs' mode change to a file ours renamed", async () => {
			const bash = await modeRepo(`
printf "1\\n2\\n3\\n4\\n5\\n6\\n7\\n8\\n" > f; chmod 644 f; c base
git checkout -q -b theirs; chmod 755 f; c theirs
git checkout -q main; chmod 644 f; git mv f g; c ours`);

			const result = await bash.exec("git merge -m merge theirs");
			expect(result).toMatchObject({
				exitCode: 0,
				stderr: "",
				stdout:
					"Merge made by the 'ort' strategy.\n" +
					" g | 0\n" +
					" 1 file changed, 0 insertions(+), 0 deletions(-)\n" +
					" mode change 100644 => 100755 g\n",
			});
			expect((await bash.exec("git ls-files -s f g")).stdout).toBe(
				"100755 535d2b01d3397c2228490875defc92370602ca46 0\tg\n",
			);
		});

		test("rename/rename gives both new paths the merged mode", async () => {
			const bash = await modeRepo(`
printf "1\\n2\\n3\\n4\\n5\\n6\\n7\\n8\\n" > f; chmod 644 f; c base
git checkout -q -b theirs; git mv f h; chmod 755 h; c theirs
git checkout -q main; rm -f h; git checkout -q -- f; chmod 644 f; git mv f g; c ours`);

			const result = await bash.exec("git merge -m merge theirs");
			expect(result.exitCode).toBe(1);
			expect(result.stdout).toBe(
				"CONFLICT (rename/rename): f renamed to g in HEAD and to h in theirs.\n" +
					"Automatic merge failed; fix conflicts and then commit the result.\n",
			);
			expect((await bash.exec("git ls-files -s f g h")).stdout).toBe(
				"100644 535d2b01d3397c2228490875defc92370602ca46 1\tf\n" +
					"100755 535d2b01d3397c2228490875defc92370602ca46 2\tg\n" +
					"100755 535d2b01d3397c2228490875defc92370602ca46 3\th\n",
			);
		});

		test("fast-forward summary prints a mode change line", async () => {
			const bash = await modeRepo(`
printf "a\\n" > f; chmod 644 f; c base
git checkout -q -b theirs; chmod 755 f; c theirs
git checkout -q main`);

			const result = await bash.exec("git merge theirs");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toEndWith(
				"Fast-forward\n" +
					" f | 0\n" +
					" 1 file changed, 0 insertions(+), 0 deletions(-)\n" +
					" mode change 100644 => 100755 f\n",
			);
		});
	});
});
