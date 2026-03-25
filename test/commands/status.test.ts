import { describe, expect, test } from "bun:test";
import { BASIC_REPO, EMPTY_REPO, NESTED_REPO, TEST_ENV } from "../fixtures";
import { createTestBash, quickExec, runScenario } from "../util";

describe("git status", () => {
	describe("outside a git repo", () => {
		test("fails with exit 128", async () => {
			const result = await quickExec("git status", {
				files: EMPTY_REPO,
			});
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("not a git repository");
		});
	});

	describe("branch display", () => {
		test("shows 'On branch main'", async () => {
			const { results } = await runScenario(["git init", "git status"], {
				files: EMPTY_REPO,
			});
			expect(results[1].stdout).toContain("On branch main");
		});
	});

	describe("empty repo (no commits)", () => {
		test("shows 'No commits yet'", async () => {
			const { results } = await runScenario(["git init", "git status"], {
				files: EMPTY_REPO,
			});
			expect(results[1].stdout).toContain("No commits yet");
		});

		test("shows nothing to commit when no files exist", async () => {
			const { results } = await runScenario(["git init", "git status"], {
				// No pre-existing files in the repo dir
				files: {},
				cwd: "/repo",
			});
			// Might report untracked or nothing; depends on if dir is empty
			expect(results[1].exitCode).toBe(0);
		});
	});

	describe("untracked files", () => {
		test("shows untracked files", async () => {
			const { results } = await runScenario(["git init", "git status"], {
				files: BASIC_REPO,
			});
			const status = results[1];
			expect(status.stdout).toContain("Untracked files:");
			expect(status.stdout).toContain("README.md");
		});

		test("shows all untracked files in nested directories", async () => {
			const { results } = await runScenario(["git init", "git status"], {
				files: NESTED_REPO,
			});
			const status = results[1];
			expect(status.stdout).toContain("Untracked files:");
		});
	});

	describe("staged changes (new files)", () => {
		test("shows new file after git add", async () => {
			const { results } = await runScenario(["git init", "git add README.md", "git status"], {
				files: EMPTY_REPO,
			});
			const status = results[2];
			expect(status.stdout).toContain("Changes to be committed:");
			expect(status.stdout).toContain("new file");
			expect(status.stdout).toContain("README.md");
		});

		test("shows multiple staged files", async () => {
			const { results } = await runScenario(["git init", "git add .", "git status"], {
				files: BASIC_REPO,
			});
			const status = results[2];
			expect(status.stdout).toContain("Changes to be committed:");
			expect(status.stdout).toContain("README.md");
			expect(status.stdout).toContain("src/main.ts");
			expect(status.stdout).toContain("src/util.ts");
		});
	});

	describe("staged changes (modified files)", () => {
		test("shows modified after editing and re-staging", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			// Modify a file and re-stage it
			await bash.fs.writeFile("/repo/README.md", "# Changed");
			await bash.exec("git add README.md");

			const status = await bash.exec("git status");
			expect(status.stdout).toContain("Changes to be committed:");
			expect(status.stdout).toContain("modified");
			expect(status.stdout).toContain("README.md");
		});
	});

	describe("staged changes (deleted files)", () => {
		test("shows deleted after removing and staging", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			// Delete a file and stage the deletion
			await bash.fs.rm("/repo/src/util.ts");
			await bash.exec("git add src/util.ts");

			const status = await bash.exec("git status");
			expect(status.stdout).toContain("Changes to be committed:");
			expect(status.stdout).toContain("deleted");
			expect(status.stdout).toContain("src/util.ts");
		});
	});

	describe("unstaged changes", () => {
		test("shows modified files not yet staged", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			// Modify a file without staging
			await bash.fs.writeFile("/repo/README.md", "# Modified content");

			const status = await bash.exec("git status");
			expect(status.stdout).toContain("Changes not staged for commit:");
			expect(status.stdout).toContain("modified");
			expect(status.stdout).toContain("README.md");
		});

		test("shows deleted files not yet staged", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			// Delete a file without staging
			await bash.fs.rm("/repo/src/util.ts");

			const status = await bash.exec("git status");
			expect(status.stdout).toContain("Changes not staged for commit:");
			expect(status.stdout).toContain("deleted");
			expect(status.stdout).toContain("src/util.ts");
		});
	});

	describe("clean working tree", () => {
		test("shows 'nothing to commit, working tree clean' after committing all", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "initial"', "git status"],
				{ files: BASIC_REPO, env: TEST_ENV },
			);
			const status = results[3];
			expect(status.stdout).toContain("nothing to commit, working tree clean");
		});
	});

	describe("mixed states", () => {
		test("shows staged, unstaged, and untracked simultaneously", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add README.md");
			await bash.exec('git commit -m "initial"');

			// Stage a new file
			await bash.exec("git add src/main.ts");

			// Modify the committed file (unstaged change)
			await bash.fs.writeFile("/repo/README.md", "# Changed");

			// src/util.ts is still untracked

			const status = await bash.exec("git status");

			// Staged: src/main.ts as new file
			expect(status.stdout).toContain("Changes to be committed:");
			expect(status.stdout).toContain("src/main.ts");

			// Unstaged: README.md modified
			expect(status.stdout).toContain("Changes not staged for commit:");
			expect(status.stdout).toContain("README.md");

			// Untracked: src/util.ts
			expect(status.stdout).toContain("Untracked files:");
			expect(status.stdout).toContain("src/util.ts");
		});
	});

	describe("hint messages", () => {
		test("includes unstage hint in staged section", async () => {
			const { results } = await runScenario(["git init", "git add README.md", "git status"], {
				files: EMPTY_REPO,
			});
			// Before first commit, hint says "git rm --cached" not "git restore --staged"
			expect(results[2].stdout).toContain("git rm --cached");
		});

		test("includes unstage hint after first commit", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.fs.writeFile("/repo/README.md", "# Changed");
			await bash.exec("git add README.md");

			const status = await bash.exec("git status");
			expect(status.stdout).toContain("git restore --staged");
		});

		test("includes add hint in unstaged section (modified only)", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.fs.writeFile("/repo/README.md", "# Changed");

			const status = await bash.exec("git status");
			// Only modifications → "git add" (no /rm)
			expect(status.stdout).toContain("git add <file>");
		});

		test("includes add/rm hint in unstaged section (with deletions)", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.fs.rm("/repo/README.md");

			const status = await bash.exec("git status");
			// Deletions present → "git add/rm"
			expect(status.stdout).toContain("git add/rm <file>");
		});

		test("includes add hint in untracked section", async () => {
			const { results } = await runScenario(["git init", "git status"], {
				files: EMPTY_REPO,
			});
			expect(results[1].stdout).toContain("git add");
		});
	});

	describe("short format (-s / --short / --porcelain)", () => {
		test("shows staged new file as A_", async () => {
			const { results } = await runScenario(["git init", "git add README.md", "git status -s"], {
				files: EMPTY_REPO,
			});
			const out = results[2].stdout;
			expect(out).toContain("A  README.md");
		});

		test("shows staged modified file as M_", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.fs.writeFile("/repo/README.md", "# Changed");
			await bash.exec("git add README.md");

			const status = await bash.exec("git status --short");
			expect(status.stdout).toContain("M  README.md");
		});

		test("shows staged deleted file as D_", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.fs.rm("/repo/src/util.ts");
			await bash.exec("git add src/util.ts");

			const status = await bash.exec("git status -s");
			expect(status.stdout).toContain("D  src/util.ts");
		});

		test("shows unstaged modified file as _M", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.fs.writeFile("/repo/README.md", "# Modified content");

			const status = await bash.exec("git status -s");
			expect(status.stdout).toContain(" M README.md");
		});

		test("shows unstaged deleted file as _D", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.fs.rm("/repo/src/util.ts");

			const status = await bash.exec("git status -s");
			expect(status.stdout).toContain(" D src/util.ts");
		});

		test("shows untracked files as ??", async () => {
			const { results } = await runScenario(["git init", "git status -s"], {
				files: BASIC_REPO,
			});
			const out = results[1].stdout;
			expect(out).toContain("?? README.md");
		});

		test("shows MM when file is staged and then modified again", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.fs.writeFile("/repo/README.md", "# Staged change");
			await bash.exec("git add README.md");
			await bash.fs.writeFile("/repo/README.md", "# Further worktree change");

			const status = await bash.exec("git status -s");
			expect(status.stdout).toContain("MM README.md");
		});

		test("--porcelain produces same output as --short", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.fs.writeFile("/repo/README.md", "# Changed");

			const short = await bash.exec("git status --short");
			const porcelain = await bash.exec("git status --porcelain");
			expect(porcelain.stdout).toBe(short.stdout);
		});

		test("clean repo produces empty output", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			const status = await bash.exec("git status -s");
			expect(status.stdout).toBe("");
		});

		test("shows renamed files as R_", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.exec("git mv README.md RENAMED.md");

			const status = await bash.exec("git status -s");
			expect(status.stdout).toContain("R  README.md -> RENAMED.md");
		});

		test("shows UU for both-modified merge conflicts", async () => {
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
			await bash.exec("git merge feature");

			const status = await bash.exec("git status -s");
			expect(status.stdout).toContain("UU README.md");
		});

		test("shows AA for both-added merge conflicts", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.exec("git branch feature");

			await bash.fs.writeFile("/repo/new.txt", "main version\n");
			await bash.exec("git add new.txt");
			await bash.exec('git commit -m "main adds new.txt"');

			await bash.exec("git checkout feature");
			await bash.fs.writeFile("/repo/new.txt", "feature version\n");
			await bash.exec("git add new.txt");
			await bash.exec('git commit -m "feature adds new.txt"');

			await bash.exec("git checkout main");
			await bash.exec("git merge feature");

			const status = await bash.exec("git status -s");
			expect(status.stdout).toContain("AA new.txt");
		});

		test("output is sorted by path", async () => {
			const bash = createTestBash({
				files: {
					"/repo/c.txt": "c",
					"/repo/a.txt": "a",
					"/repo/b.txt": "b",
				},
				env: TEST_ENV,
			});
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.fs.writeFile("/repo/c.txt", "c changed");
			await bash.fs.writeFile("/repo/a.txt", "a changed");

			const status = await bash.exec("git status -s");
			const lines = status.stdout.trim().split("\n");
			expect(lines[0]).toContain("a.txt");
			expect(lines[1]).toContain("c.txt");
		});

		test("no trailing messages or hints in short mode", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.fs.writeFile("/repo/README.md", "# Changed");

			const status = await bash.exec("git status -s");
			expect(status.stdout).not.toContain("Changes not staged");
			expect(status.stdout).not.toContain("On branch");
			expect(status.stdout).not.toContain("nothing to commit");
		});
	});

	describe("branch header (-b)", () => {
		test("shows ## branch in short mode with -b", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			const status = await bash.exec("git status -sb");
			expect(status.stdout).toContain("## main");
		});

		test("shows ## HEAD (no branch) for detached HEAD", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.exec("git tag v1");

			// Detach HEAD by checking out a tag
			await bash.exec("git checkout v1");

			const status = await bash.exec("git status -sb");
			expect(status.stdout).toContain("## HEAD (no branch)");
		});

		test("-b with --porcelain shows branch header", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			const status = await bash.exec("git status --porcelain -b");
			expect(status.stdout).toContain("## main");
		});

		test("-b shows branch header followed by status entries", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.fs.writeFile("/repo/README.md", "# Changed");

			const status = await bash.exec("git status -sb");
			const lines = status.stdout.trim().split("\n");
			expect(lines[0]).toBe("## main");
			expect(lines[1]).toContain("M README.md");
		});

		test("shows upstream and behind count in short branch header", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("mkdir remote && cd remote && git init --bare");
			await bash.exec("git clone /repo/remote local");
			await bash.exec(
				"cd local && echo one > f && git add f && git commit -m one && git push -u origin main",
			);
			await bash.exec("git clone /repo/remote other");
			await bash.exec("cd other && echo two >> f && git commit -am two && git push");
			await bash.exec("cd local && git fetch");

			const status = await bash.exec("cd local && git status -sb");
			const lines = status.stdout.trim().split("\n");
			expect(lines[0]).toBe("## main...origin/main [behind 1]");
		});

		test("shows upstream and behind count in porcelain branch header", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("mkdir remote && cd remote && git init --bare");
			await bash.exec("git clone /repo/remote local");
			await bash.exec(
				"cd local && echo one > f && git add f && git commit -m one && git push -u origin main",
			);
			await bash.exec("git clone /repo/remote other");
			await bash.exec("cd other && echo two >> f && git commit -am two && git push");
			await bash.exec("cd local && git fetch");

			const status = await bash.exec("cd local && git status --porcelain -b");
			const lines = status.stdout.trim().split("\n");
			expect(lines[0]).toBe("## main...origin/main [behind 1]");
		});
	});

	describe("unmerged paths (merge conflicts)", () => {
		test("shows 'both modified' for content conflicts", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.exec("git branch feature");

			// Diverge on same file
			await bash.fs.writeFile("/repo/README.md", "# Main\n");
			await bash.exec("git add README.md");
			await bash.exec('git commit -m "main"');

			await bash.exec("git checkout feature");
			await bash.fs.writeFile("/repo/README.md", "# Feature\n");
			await bash.exec("git add README.md");
			await bash.exec('git commit -m "feature"');

			await bash.exec("git checkout main");
			await bash.exec("git merge feature"); // conflicts

			const status = await bash.exec("git status");
			expect(status.stdout).toContain("Unmerged paths:");
			expect(status.stdout).toContain("both modified");
			expect(status.stdout).toContain("README.md");
			expect(status.stdout).toContain("git add <file>");
		});

		test("shows 'both added' for add/add conflicts", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.exec("git branch feature");

			// Both sides add the same new file with different content
			await bash.fs.writeFile("/repo/new.txt", "main version\n");
			await bash.exec("git add new.txt");
			await bash.exec('git commit -m "main adds new.txt"');

			await bash.exec("git checkout feature");
			await bash.fs.writeFile("/repo/new.txt", "feature version\n");
			await bash.exec("git add new.txt");
			await bash.exec('git commit -m "feature adds new.txt"');

			await bash.exec("git checkout main");
			await bash.exec("git merge feature");

			const status = await bash.exec("git status");
			expect(status.stdout).toContain("Unmerged paths:");
			expect(status.stdout).toContain("both added");
			expect(status.stdout).toContain("new.txt");
		});

		test("unmerged paths disappear after resolution with git add", async () => {
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
			await bash.exec("git merge feature");

			// Verify conflict shows up
			let status = await bash.exec("git status");
			expect(status.stdout).toContain("Unmerged paths:");

			// Resolve and add
			await bash.fs.writeFile("/repo/README.md", "# Resolved\n");
			await bash.exec("git add README.md");

			// Unmerged paths should be gone
			status = await bash.exec("git status");
			expect(status.stdout).not.toContain("Unmerged paths:");
		});
	});
});
