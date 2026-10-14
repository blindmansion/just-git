import { describe, expect, test } from "bun:test";
import { BASIC_REPO, EMPTY_REPO, TEST_ENV_NAMED as TEST_ENV } from "../fixtures";
import { createTestBash, quickExec, readFile, runScenario, setupExecBitRepo } from "../util";

describe("git commit", () => {
	describe("outside a git repo", () => {
		test("fails with exit 128", async () => {
			const result = await quickExec('git commit -m "test"', {
				files: EMPTY_REPO,
			});
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("not a git repository");
		});
	});

	describe("nothing to commit", () => {
		test("errors when index is empty and no prior commits", async () => {
			const { results } = await runScenario(["git init", 'git commit -m "empty"'], {
				files: EMPTY_REPO,
				env: TEST_ENV,
			});
			expect(results[1].exitCode).toBe(1);
			// Full status output — with untracked files present
			expect(results[1].stdout).toContain("nothing added to commit");
		});

		test("errors when tree matches HEAD", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "first"', 'git commit -m "second"'],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			expect(results[3].exitCode).toBe(1);
			expect(results[3].stdout).toContain("nothing to commit");
		});
	});

	describe("multiple -m flags", () => {
		test("joins multiple -m values with double newline", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			const result = await bash.exec('git commit -m "title" -m "body paragraph" -m "footer"');
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("title");

			const log = await bash.exec("git log -1");
			expect(log.stdout).toContain("    title");
			expect(log.stdout).toContain("    body paragraph");
			expect(log.stdout).toContain("    footer");
		});

		test("two -m flags produce title + body", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "subject" -m "details here"');

			const log = await bash.exec("git log --format=%B -1");
			expect(log.stdout).toContain("subject");
			expect(log.stdout).toContain("details here");
			// Separated by blank line
			expect(log.stdout).toContain("subject\n\ndetails here");
		});

		test("single -m still works normally", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "just one message"');

			const log = await bash.exec("git log --format=%s -1");
			expect(log.stdout.trim()).toBe("just one message");
		});

		test("-am with additional -m flags combines correctly", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');
			bash.fs.writeFile("/repo/README.md", "changed\n");

			const result = await bash.exec('git commit -am "title" -m "body"');
			expect(result.exitCode).toBe(0);

			const log = await bash.exec("git log --format=%B -1");
			expect(log.stdout).toContain("title\n\nbody");
		});
	});

	describe("root commit", () => {
		test("exits 0", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "initial commit"'],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			expect(results[2].exitCode).toBe(0);
		});

		test("output contains branch name", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "initial commit"'],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			expect(results[2].stdout).toContain("main");
		});

		test("output contains (root-commit)", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "initial commit"'],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			expect(results[2].stdout).toContain("(root-commit)");
		});

		test("output contains the commit message", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "initial commit"'],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			expect(results[2].stdout).toContain("initial commit");
		});

		test("output contains a short hash", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "initial commit"'],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			// Format: [main (root-commit) <7-char-hash>] initial commit
			const match = results[2].stdout.match(/\[main \(root-commit\) ([a-f0-9]{7})\]/);
			expect(match).not.toBeNull();
		});

		test("advances the branch ref", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			const ref = await readFile(bash.fs, "/repo/.git/refs/heads/main");
			expect(ref).toBeDefined();
			// Should be a 40-char hex hash
			expect(ref?.trim()).toMatch(/^[a-f0-9]{40}$/);
		});
	});

	describe("subsequent commit", () => {
		test("does not include (root-commit) label", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add README.md");
			await bash.exec('git commit -m "first"');

			await bash.exec("git add src/main.ts");
			const result = await bash.exec('git commit -m "second"');

			expect(result.exitCode).toBe(0);
			expect(result.stdout).not.toContain("(root-commit)");
			expect(result.stdout).toContain("second");
		});

		test("updates the branch ref to a new hash", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add README.md");
			await bash.exec('git commit -m "first"');

			const firstRef = await readFile(bash.fs, "/repo/.git/refs/heads/main");

			await bash.exec("git add src/main.ts");
			await bash.exec('git commit -m "second"');

			const secondRef = await readFile(bash.fs, "/repo/.git/refs/heads/main");
			expect(secondRef).toBeDefined();
			expect(secondRef?.trim()).toMatch(/^[a-f0-9]{40}$/);
			expect(secondRef).not.toBe(firstRef);
		});
	});

	describe("--allow-empty", () => {
		test("creates a commit with no staged changes", async () => {
			const { results } = await runScenario(
				["git init", 'git commit --allow-empty -m "empty commit"'],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			expect(results[1].exitCode).toBe(0);
			expect(results[1].stdout).toContain("empty commit");
		});

		test("creates subsequent empty commits", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "first"', 'git commit --allow-empty -m "empty"'],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			expect(results[3].exitCode).toBe(0);
			expect(results[3].stdout).toContain("empty");
			expect(results[3].stdout).not.toContain("(root-commit)");
		});
	});

	describe("identity from environment", () => {
		test("uses GIT_AUTHOR_NAME and GIT_AUTHOR_EMAIL", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "test"', "git log -n 1"],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			const log = results[3];
			expect(log.stdout).toContain("Test Author");
			expect(log.stdout).toContain("author@test.com");
		});

		test("fails when no identity is configured", async () => {
			const { results } = await runScenario(["git init", "git add .", 'git commit -m "test"'], {
				files: EMPTY_REPO,
			});
			// Should fail because no author identity is available
			expect(results[2].exitCode).not.toBe(0);
		});
	});

	describe("with multiple files", () => {
		test("commits all staged files", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "all files"', "git status"],
				{ files: BASIC_REPO, env: TEST_ENV },
			);
			expect(results[2].exitCode).toBe(0);
			// After committing everything, status should be clean
			const status = results[3];
			expect(status.stdout).toContain("nothing to commit");
		});
	});

	describe("merge commit awareness", () => {
		test("creates merge commit with two parents when MERGE_HEAD exists", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.exec("git branch feature");

			// Diverge: main changes README
			await bash.fs.writeFile("/repo/README.md", "# Main\n");
			await bash.exec("git add README.md");
			await bash.exec('git commit -m "main change"');

			// Feature changes a different file
			await bash.exec("git checkout feature");
			await bash.fs.writeFile("/repo/feature.txt", "feature\n");
			await bash.exec("git add feature.txt");
			await bash.exec('git commit -m "feature change"');

			// Merge on main — should create merge commit automatically (clean merge)
			await bash.exec("git checkout main");
			const mergeResult = await bash.exec("git merge feature");
			expect(mergeResult.exitCode).toBe(0);

			// Verify two parents via git log
			const log = await bash.exec("git log --oneline");
			expect(log.stdout).toContain("Merge branch");
		});

		test("reads MERGE_MSG when -m is not provided during merge resolution", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
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

			// Resolve conflict
			await bash.fs.writeFile("/repo/README.md", "# Resolved\n");
			await bash.exec("git add README.md");

			// Commit without -m — should use MERGE_MSG
			const commitResult = await bash.exec("git commit");
			expect(commitResult.exitCode).toBe(0);
			expect(commitResult.stdout).toContain("Merge branch");
		});

		test("cleans up merge state files after merge commit", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
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

			// Verify merge state files exist
			expect(await bash.fs.exists("/repo/.git/MERGE_HEAD")).toBe(true);
			expect(await bash.fs.exists("/repo/.git/MERGE_MSG")).toBe(true);

			// Resolve and commit
			await bash.fs.writeFile("/repo/README.md", "# Resolved\n");
			await bash.exec("git add README.md");
			await bash.exec('git commit -m "resolved"');

			// Merge state files should be cleaned up
			expect(await bash.fs.exists("/repo/.git/MERGE_HEAD")).toBe(false);
			expect(await bash.fs.exists("/repo/.git/MERGE_MSG")).toBe(false);
			expect(await bash.fs.exists("/repo/.git/ORIG_HEAD")).toBe(false);
		});

		test("rejects commit when there are unresolved conflicts", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
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

			// Try to commit without resolving
			const result = await bash.exec('git commit -m "should fail"');
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("unmerged files");
		});

		test("commit without -m fails when no MERGE_MSG", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			// Try commit without -m and no MERGE_MSG
			const result = await bash.exec("git commit");
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("must provide a commit message");
		});
	});

	describe("--amend", () => {
		test("amends HEAD with a new message", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "original"');

			const result = await bash.exec('git commit --amend -m "amended"');
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("amended");

			const log = await bash.exec("git log --oneline");
			expect(log.stdout).toContain("amended");
			expect(log.stdout).not.toContain("original");
		});

		test("preserves old message when no -m is provided", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "keep this"');

			// Stage a new file, then amend without -m
			await bash.fs.writeFile("/repo/extra.txt", "extra\n");
			await bash.exec("git add extra.txt");
			const result = await bash.exec("git commit --amend --no-edit");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("keep this");
		});

		test("changes commit hash but keeps same parent", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add README.md");
			await bash.exec('git commit -m "first"');

			await bash.exec("git add src/main.ts");
			await bash.exec('git commit -m "second"');

			const secondRef = (await readFile(bash.fs, "/repo/.git/refs/heads/main"))?.trim();

			const result = await bash.exec('git commit --amend -m "second amended"');
			expect(result.exitCode).toBe(0);

			const amendedRef = (await readFile(bash.fs, "/repo/.git/refs/heads/main"))?.trim();
			// Hash changed from second commit
			expect(amendedRef).not.toBe(secondRef);
			// But the parent should still be the first commit
			const log = await bash.exec("git log --oneline");
			const lines = log.stdout.trim().split("\n");
			expect(lines).toHaveLength(2);
			expect(lines[0]).toContain("second amended");
			expect(lines[1]).toContain("first");
		});

		test("includes newly staged changes", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			// Add a new file and amend
			await bash.fs.writeFile("/repo/new.txt", "new content\n");
			await bash.exec("git add new.txt");
			const result = await bash.exec('git commit --amend -m "with new file"');
			expect(result.exitCode).toBe(0);

			// Status should be clean
			const status = await bash.exec("git status");
			expect(status.stdout).toContain("nothing to commit");

			// Only one commit in history
			const log = await bash.exec("git log --oneline");
			const lines = log.stdout.trim().split("\n");
			expect(lines).toHaveLength(1);
			expect(lines[0]).toContain("with new file");
		});

		test("errors with no HEAD", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");

			const result = await bash.exec('git commit --amend -m "nope"');
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("nothing yet to amend");
		});

		test("errors during a merge", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
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

			// Resolve conflict
			await bash.fs.writeFile("/repo/README.md", "# Resolved\n");
			await bash.exec("git add README.md");

			const result = await bash.exec('git commit --amend -m "bad"');
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("You are in the middle of a merge -- cannot amend");
		});

		test("preserves original author when env vars are absent", async () => {
			const originalEnv = {
				...TEST_ENV,
				GIT_AUTHOR_NAME: "Original Author",
				GIT_AUTHOR_EMAIL: "original@test.com",
			};
			const bash = createTestBash({
				files: EMPTY_REPO,
				env: originalEnv,
			});
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "by original"');

			// Amend WITHOUT author env vars — should preserve original
			const noAuthorEnv = {
				GIT_COMMITTER_NAME: "Test",
				GIT_COMMITTER_EMAIL: "test@test.com",
				GIT_COMMITTER_DATE: "1000000000",
			};
			await bash.exec('git commit --amend -m "amended"', {
				env: noAuthorEnv,
			});
			const log = await bash.exec("git log -n 1");
			expect(log.stdout).toContain("Original Author");
			expect(log.stdout).toContain("original@test.com");
		});

		test("preserves original author even when env vars differ", async () => {
			const originalEnv = {
				...TEST_ENV,
				GIT_AUTHOR_NAME: "Original Author",
				GIT_AUTHOR_EMAIL: "original@test.com",
			};
			const bash = createTestBash({
				files: EMPTY_REPO,
				env: originalEnv,
			});
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "by original"');

			// Amend WITH different author env vars — real git still preserves original
			const newEnv = {
				...TEST_ENV,
				GIT_AUTHOR_NAME: "New Author",
				GIT_AUTHOR_EMAIL: "new@test.com",
			};
			await bash.exec('git commit --amend -m "amended"', { env: newEnv });
			const log = await bash.exec("git log -n 1");
			expect(log.stdout).toContain("Original Author");
			expect(log.stdout).toContain("original@test.com");
		});
	});

	describe("-a (auto-stage)", () => {
		test("auto-stages modified tracked files", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			// Modify a tracked file without explicit git add
			await bash.fs.writeFile("/repo/README.md", "# Updated\n");
			const result = await bash.exec('git commit -a -m "auto-staged"');
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("auto-staged");

			// Status should be clean
			const status = await bash.exec("git status");
			expect(status.stdout).toContain("nothing to commit");
		});

		test("auto-stages deleted tracked files", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			// Delete a tracked file without explicit git rm
			await bash.fs.rm("/repo/README.md");
			const result = await bash.exec('git commit -a -m "deleted"');
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("deleted");
		});

		test("does NOT auto-stage untracked files", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			// Create a new untracked file
			await bash.fs.writeFile("/repo/untracked.txt", "hello\n");
			const result = await bash.exec('git commit -a -m "should be empty"');
			// Should fail — nothing to commit (untracked not staged)
			expect(result.exitCode).toBe(1);
			// Full status output with untracked files listed
			expect(result.stdout).toContain("nothing added to commit");
			expect(result.stdout).toContain("untracked.txt");
		});

		test("works with --amend", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			// Modify a tracked file, then amend with -a
			await bash.fs.writeFile("/repo/README.md", "# Amended\n");
			const result = await bash.exec('git commit -a --amend -m "initial amended"');
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("initial amended");

			// Only one commit
			const log = await bash.exec("git log --oneline");
			const lines = log.stdout.trim().split("\n");
			expect(lines).toHaveLength(1);

			// Status clean
			const status = await bash.exec("git status");
			expect(status.stdout).toContain("nothing to commit");
		});
	});

	describe("commit -F (message from file)", () => {
		test("reads commit message from a file", async () => {
			const { results } = await runScenario(
				["git init", "git add .", "git commit -F /repo/msg.txt"],
				{
					files: {
						...EMPTY_REPO,
						"/repo/msg.txt": "commit from file\n",
					},
					env: TEST_ENV,
				},
			);
			expect(results[2].exitCode).toBe(0);
			expect(results[2].stdout).toContain("commit from file");
		});

		test("reads commit message from stdin with -F -", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'echo "commit from stdin" | git commit -F -'],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			expect(results[2].exitCode).toBe(0);
			expect(results[2].stdout).toContain("commit from stdin");
		});

		test("supports multiline message from file", async () => {
			const { results } = await runScenario(
				["git init", "git add .", "git commit -F /repo/msg.txt", "git log -1 --format=%B"],
				{
					files: {
						...EMPTY_REPO,
						"/repo/msg.txt": "first line\n\nsecond paragraph\n",
					},
					env: TEST_ENV,
				},
			);
			expect(results[2].exitCode).toBe(0);
			const logBody = results[3].stdout;
			expect(logBody).toContain("first line");
			expect(logBody).toContain("second paragraph");
		});

		test("-m and -F cannot be used together", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "inline" -F /repo/msg.txt'],
				{
					files: {
						...EMPTY_REPO,
						"/repo/msg.txt": "from file\n",
					},
					env: TEST_ENV,
				},
			);
			expect(results[2].exitCode).toBe(128);
			expect(results[2].stderr).toContain("options '-m' and '-F' cannot be used together");
		});

		test("fails when file does not exist", async () => {
			const { results } = await runScenario(
				["git init", "git add .", "git commit -F /repo/nonexistent.txt"],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			expect(results[2].exitCode).toBe(128);
			expect(results[2].stderr).toContain("could not read log file");
			expect(results[2].stderr).toContain("No such file or directory");
		});

		test("aborts on empty message file", async () => {
			const { results } = await runScenario(
				["git init", "git add .", "git commit -F /repo/msg.txt"],
				{
					files: {
						...EMPTY_REPO,
						"/repo/msg.txt": "",
					},
					env: TEST_ENV,
				},
			);
			expect(results[2].exitCode).toBe(1);
			expect(results[2].stdout).toContain("Aborting commit due to empty commit message");
		});

		test("strips comment lines from file message", async () => {
			const { results } = await runScenario(
				["git init", "git add .", "git commit -F /repo/msg.txt", "git log -1 --format=%B"],
				{
					files: {
						...EMPTY_REPO,
						"/repo/msg.txt": "real message\n# this is a comment\n# so is this\n",
					},
					env: TEST_ENV,
				},
			);
			expect(results[2].exitCode).toBe(0);
			const logBody = results[3].stdout;
			expect(logBody).toContain("real message");
			expect(logBody).not.toContain("this is a comment");
		});

		test("works with --amend", async () => {
			const { results } = await runScenario(
				[
					"git init",
					"git add .",
					'git commit -m "original"',
					"git commit --amend -F /repo/msg.txt",
					"git log -1 --format=%B",
				],
				{
					files: {
						...EMPTY_REPO,
						"/repo/msg.txt": "amended from file\n",
					},
					env: TEST_ENV,
				},
			);
			expect(results[3].exitCode).toBe(0);
			expect(results[4].stdout).toContain("amended from file");
			expect(results[4].stdout).not.toContain("original");
		});

		test("resolves relative path from cwd", async () => {
			const { results } = await runScenario(["git init", "git add .", "git commit -F msg.txt"], {
				files: {
					...EMPTY_REPO,
					"/repo/msg.txt": "relative path message\n",
				},
				env: TEST_ENV,
			});
			expect(results[2].exitCode).toBe(0);
			expect(results[2].stdout).toContain("relative path message");
		});
	});

	describe("--quiet", () => {
		test("-q and -qm commit without printing the summary", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add README.md");
			const first = await bash.exec('git commit -q -m "first"');
			expect(first.exitCode).toBe(0);
			expect(first.stdout).toBe("");
			expect(first.stderr).toBe("");

			await bash.exec("git add src/main.ts");
			const second = await bash.exec('git commit -qm "second"');
			expect(second.exitCode).toBe(0);
			expect(second.stdout).toBe("");
			expect(second.stderr).toBe("");
			expect((await bash.exec("git log --format=%s -2")).stdout).toContain("second\nfirst");
		});

		test("-q and --quiet suppress the commit summary", async () => {
			const { results, bash } = await runScenario(
				[
					"git init",
					"git add .",
					'git commit -q -m "first"',
					"echo change >> README.md",
					'git commit --quiet -am "second"',
					"git log --format=%s",
				],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			for (const i of [2, 4]) {
				expect(results[i]).toMatchObject({ stdout: "", stderr: "", exitCode: 0 });
			}
			expect(results[5].stdout).toBe("second\nfirst\n");
			const status = await bash.exec("git status --porcelain");
			expect(status.stdout).toBe("");
		});

		test("combined short flags -qam", async () => {
			const { results } = await runScenario(
				[
					"git init",
					"git add .",
					"git commit -qm first",
					"echo x >> README.md",
					"git commit -qam two",
				],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			expect(results[4]).toMatchObject({ stdout: "", stderr: "", exitCode: 0 });
		});

		test("--no-quiet after -q restores the summary", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -q --no-quiet -m "first"'],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			expect(results[2].exitCode).toBe(0);
			expect(results[2].stdout).toMatch(/^\[main \(root-commit\) [0-9a-f]{7}\] first\n/);
		});

		test("--amend -q is silent", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "first"', 'git commit -q --amend -m "amended"'],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			expect(results[3]).toMatchObject({ stdout: "", stderr: "", exitCode: 0 });
		});

		test("nothing to commit still prints status", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "first"', 'git commit -q -m "again"'],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			expect(results[3].exitCode).toBe(1);
			expect(results[3].stdout).toBe("On branch main\nnothing to commit, working tree clean\n");
		});

		test("unmerged files error still prints", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');
			await bash.exec("git checkout -b side");
			await bash.fs.writeFile("/repo/README.md", "side");
			await bash.exec('git commit -am "side"');
			await bash.exec("git checkout main");
			await bash.fs.writeFile("/repo/README.md", "main");
			await bash.exec('git commit -am "main"');
			await bash.exec("git merge side");

			const result = await bash.exec('git commit -q -m "merge"');
			expect(result.exitCode).toBe(128);
			expect(result.stdout).toBe("U\tREADME.md\n");
			expect(result.stderr).toContain(
				"error: Committing is not possible because you have unmerged files.",
			);
		});
	});
});

describe("git commit: executable bit", () => {
	test("commit after checkout records no mode change", async () => {
		const bash = await setupExecBitRepo();
		await bash.exec("rm run.sh && git checkout -- run.sh && git add -A");
		const result = await bash.exec("git commit -m noop");
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toBe("On branch main\nnothing to commit, working tree clean\n");
	});
});

describe("git commit: staged mode-only change", () => {
	test("commits when only the mode differs from HEAD", async () => {
		const bash = await setupExecBitRepo();
		const before = (await bash.exec("git rev-parse HEAD")).stdout;
		await bash.exec("chmod 644 run.sh && git add run.sh");

		const result = await bash.exec("git commit -m mode");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toMatch(/^\[main [0-9a-f]+\] mode\n/);
		expect((await bash.exec("git rev-parse HEAD")).stdout).not.toBe(before);
		expect((await bash.exec("git status --short")).stdout).toBe("");
		expect((await bash.exec("git diff HEAD~1 HEAD")).stdout).toBe(
			"diff --git a/run.sh b/run.sh\nold mode 100755\nnew mode 100644\n",
		);
	});
});
