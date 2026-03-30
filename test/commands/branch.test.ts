import { describe, expect, test } from "bun:test";
import { EMPTY_REPO, TEST_ENV_NAMED as TEST_ENV } from "../fixtures";
import { createTestBash, quickExec, readFile, runScenario, setupClonePair } from "../util";

describe("git branch", () => {
	describe("outside a git repo", () => {
		test("fails with exit 128", async () => {
			const result = await quickExec("git branch", {
				files: EMPTY_REPO,
			});
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("not a git repository");
		});
	});

	describe("list branches", () => {
		test("empty output when no commits", async () => {
			const { results } = await runScenario(["git init", "git branch"], {
				files: EMPTY_REPO,
				env: TEST_ENV,
			});
			expect(results[1].exitCode).toBe(0);
			expect(results[1].stdout).toBe("");
		});

		test("shows main branch with * marker", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "first"', "git branch"],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			expect(results[3].exitCode).toBe(0);
			expect(results[3].stdout).toContain("* main");
		});

		test("shows multiple branches sorted alphabetically", async () => {
			const { results } = await runScenario(
				[
					"git init",
					"git add .",
					'git commit -m "first"',
					"git branch feature",
					"git branch alpha",
					"git branch",
				],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			const output = results[5].stdout;
			expect(output).toContain("  alpha");
			expect(output).toContain("  feature");
			expect(output).toContain("* main");
			// alpha should come before feature and main
			const lines = output.trim().split("\n");
			expect(lines[0]).toContain("alpha");
			expect(lines[1]).toContain("feature");
			expect(lines[2]).toContain("main");
		});
	});

	describe("create branch", () => {
		test("creates a new branch at HEAD", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');

			const result = await bash.exec("git branch feature");
			expect(result.exitCode).toBe(0);

			// Verify the ref was created
			const ref = await readFile(bash.fs, "/repo/.git/refs/heads/feature");
			expect(ref?.trim()).toMatch(/^[a-f0-9]{40}$/);
		});

		test("new branch points to same commit as HEAD", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');

			await bash.exec("git branch feature");

			const mainRef = await readFile(bash.fs, "/repo/.git/refs/heads/main");
			const featureRef = await readFile(bash.fs, "/repo/.git/refs/heads/feature");
			expect(featureRef?.trim()).toBe(mainRef?.trim());
		});

		test("fails when no commits exist", async () => {
			const { results } = await runScenario(["git init", "git branch feature"], {
				files: EMPTY_REPO,
				env: TEST_ENV,
			});
			expect(results[1].exitCode).toBe(128);
			expect(results[1].stderr).toContain("Not a valid object name");
		});

		test("fails when branch already exists", async () => {
			const { results } = await runScenario(
				[
					"git init",
					"git add .",
					'git commit -m "first"',
					"git branch feature",
					"git branch feature",
				],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			expect(results[4].exitCode).toBe(128);
			expect(results[4].stderr).toContain("already exists");
		});
	});

	describe("rename branch (-m)", () => {
		test("renames current branch with one arg", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');

			const result = await bash.exec("git branch -m renamed");
			expect(result.exitCode).toBe(0);

			const listing = await bash.exec("git branch");
			expect(listing.stdout).toContain("* renamed");
			expect(listing.stdout).not.toContain("main");
		});

		test("renames a different branch with two args", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');
			await bash.exec("git branch feature");

			const result = await bash.exec("git branch -m feature new-feature");
			expect(result.exitCode).toBe(0);

			const listing = await bash.exec("git branch");
			expect(listing.stdout).toContain("* main");
			expect(listing.stdout).toContain("  new-feature");
			expect(listing.stdout).not.toMatch(/^\s+feature$/m);
		});

		test("updates HEAD when renaming current branch", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');

			await bash.exec("git branch -m renamed");
			const headContent = await readFile(bash.fs, "/repo/.git/HEAD");
			expect(headContent?.trim()).toBe("ref: refs/heads/renamed");
		});

		test("does not update HEAD when renaming non-current branch", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');
			await bash.exec("git branch feature");

			await bash.exec("git branch -m feature new-feature");
			const headContent = await readFile(bash.fs, "/repo/.git/HEAD");
			expect(headContent?.trim()).toBe("ref: refs/heads/main");
		});

		test("moves reflog to new name", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');

			// Manually create a reflog entry for the branch
			await bash.fs.mkdir("/repo/.git/logs/refs/heads", {
				recursive: true,
			});
			const hash = (await readFile(bash.fs, "/repo/.git/refs/heads/main"))?.trim();
			await bash.fs.writeFile(
				"/repo/.git/logs/refs/heads/main",
				`0000000000000000000000000000000000000000 ${hash} Test <test@test.com> 1000000000 +0000\tbranch: Created from HEAD\n`,
			);

			await bash.exec("git branch -m renamed");
			const oldReflog = await readFile(bash.fs, "/repo/.git/logs/refs/heads/main");
			const newReflog = await readFile(bash.fs, "/repo/.git/logs/refs/heads/renamed");
			expect(oldReflog).toBeUndefined();
			expect(newReflog).toBeDefined();
			expect(newReflog).toContain("Created from HEAD");
		});

		test("moves tracking config to new name", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');
			await bash.exec("git config set branch.main.remote origin");
			await bash.exec("git config set branch.main.merge refs/heads/main");

			await bash.exec("git branch -m renamed");
			const config = await readFile(bash.fs, "/repo/.git/config");
			expect(config).toContain('[branch "renamed"]');
			expect(config).not.toContain('[branch "main"]');
		});

		test("fails when target name already exists", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');
			await bash.exec("git branch feature");

			const result = await bash.exec("git branch -m feature");
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("already exists");
		});

		test("fails when source branch does not exist", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');

			const result = await bash.exec("git branch -m nonexistent new-name");
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("no branch named 'nonexistent'");
		});

		test("fails with no args", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');

			const result = await bash.exec("git branch -m");
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("branch name required");
		});
	});

	describe("remote listing (-r)", () => {
		test("lists remote-tracking branches", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');

			// Manually create remote tracking refs
			const headHash = (await readFile(bash.fs, "/repo/.git/refs/heads/main"))?.trim();
			await bash.fs.mkdir("/repo/.git/refs/remotes/origin", {
				recursive: true,
			});
			await bash.fs.writeFile("/repo/.git/refs/remotes/origin/main", `${headHash}\n`);
			await bash.fs.writeFile("/repo/.git/refs/remotes/origin/feature", `${headHash}\n`);

			const result = await bash.exec("git branch -r");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("origin/feature");
			expect(result.stdout).toContain("origin/main");
			expect(result.stdout).not.toContain("* ");
		});

		test("empty when no remotes", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');

			const result = await bash.exec("git branch -r");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toBe("");
		});

		test("does not show local branches", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');
			await bash.exec("git branch feature");

			const headHash = (await readFile(bash.fs, "/repo/.git/refs/heads/main"))?.trim();
			await bash.fs.mkdir("/repo/.git/refs/remotes/origin", {
				recursive: true,
			});
			await bash.fs.writeFile("/repo/.git/refs/remotes/origin/main", `${headHash}\n`);

			const result = await bash.exec("git branch -r");
			const lines = result.stdout.trim().split("\n");
			expect(lines.every((l: string) => l.includes("origin/"))).toBe(true);
			expect(result.stdout).not.toContain("feature");
			expect(result.stdout).toContain("origin/main");
		});
	});

	describe("all listing (-a)", () => {
		test("shows both local and remote branches", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');
			await bash.exec("git branch feature");

			const headHash = (await readFile(bash.fs, "/repo/.git/refs/heads/main"))?.trim();
			await bash.fs.mkdir("/repo/.git/refs/remotes/origin", {
				recursive: true,
			});
			await bash.fs.writeFile("/repo/.git/refs/remotes/origin/main", `${headHash}\n`);

			const result = await bash.exec("git branch -a");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("* main");
			expect(result.stdout).toContain("  feature");
			expect(result.stdout).toContain("  remotes/origin/main");
		});

		test("remote branches have remotes/ prefix", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');

			const headHash = (await readFile(bash.fs, "/repo/.git/refs/heads/main"))?.trim();
			await bash.fs.mkdir("/repo/.git/refs/remotes/origin", {
				recursive: true,
			});
			await bash.fs.writeFile("/repo/.git/refs/remotes/origin/main", `${headHash}\n`);

			const result = await bash.exec("git branch -a");
			const lines = result.stdout.trim().split("\n");
			const remoteLine = lines.find((l: string) => l.includes("origin/main"));
			expect(remoteLine).toContain("remotes/origin/main");
		});
	});

	describe("set upstream (-u)", () => {
		test("sets tracking config for current branch", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');

			const headHash = (await readFile(bash.fs, "/repo/.git/refs/heads/main"))?.trim();
			await bash.fs.mkdir("/repo/.git/refs/remotes/origin", {
				recursive: true,
			});
			await bash.fs.writeFile("/repo/.git/refs/remotes/origin/main", `${headHash}\n`);

			const result = await bash.exec("git branch --set-upstream-to=origin/main");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("branch 'main' set up to track 'origin/main'");

			const config = await readFile(bash.fs, "/repo/.git/config");
			expect(config).toContain('[branch "main"]');
			expect(config).toContain("remote = origin");
			expect(config).toContain("merge = refs/heads/main");
		});

		test("sets tracking config for named branch", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');
			await bash.exec("git branch feature");

			const headHash = (await readFile(bash.fs, "/repo/.git/refs/heads/main"))?.trim();
			await bash.fs.mkdir("/repo/.git/refs/remotes/origin", {
				recursive: true,
			});
			await bash.fs.writeFile("/repo/.git/refs/remotes/origin/main", `${headHash}\n`);

			const result = await bash.exec("git branch -u origin/main feature");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("branch 'feature' set up to track 'origin/main'");
		});

		test("fails when upstream does not exist", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');

			const result = await bash.exec("git branch --set-upstream-to=origin/nonexistent");
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("does not exist");
			expect(result.stderr).toContain('run "git fetch" to retrieve it');
			expect(result.stderr).toContain('"git push -u" to set the upstream config');
		});

		test("fails when branch does not exist", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');

			const headHash = (await readFile(bash.fs, "/repo/.git/refs/heads/main"))?.trim();
			await bash.fs.mkdir("/repo/.git/refs/remotes/origin", {
				recursive: true,
			});
			await bash.fs.writeFile("/repo/.git/refs/remotes/origin/main", `${headHash}\n`);

			const result = await bash.exec("git branch -u origin/main nonexistent");
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("does not exist");
		});
	});

	describe("verbose (-v, -vv)", () => {
		test("-v shows hash and commit subject", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial commit"');
			await bash.exec("git branch feature");

			const result = await bash.exec("git branch -v");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toMatch(/\* main\s+[a-f0-9]{7} initial commit/);
			expect(result.stdout).toMatch(/feature\s+[a-f0-9]{7} initial commit/);
		});

		test("-v aligns columns", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');
			await bash.exec("git branch short");
			await bash.exec("git branch longername");

			const result = await bash.exec("git branch -v");
			const lines = result.stdout.replace(/\n$/, "").split("\n");
			const hashPositions = lines.map((l: string) => {
				const match = l.match(/[a-f0-9]{7}/);
				return match ? l.indexOf(match[0]) : -1;
			});
			expect(hashPositions.every((p: number) => p === hashPositions[0])).toBe(true);
		});

		test("-vv shows tracking info when configured", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');

			const headHash = (await readFile(bash.fs, "/repo/.git/refs/heads/main"))?.trim();
			await bash.fs.mkdir("/repo/.git/refs/remotes/origin", {
				recursive: true,
			});
			await bash.fs.writeFile("/repo/.git/refs/remotes/origin/main", `${headHash}\n`);
			await bash.exec("git branch --set-upstream-to=origin/main");

			const result = await bash.exec("git branch -vv");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("[origin/main]");
		});

		test("-vv shows ahead count", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');

			const headHash = (await readFile(bash.fs, "/repo/.git/refs/heads/main"))?.trim();
			await bash.fs.mkdir("/repo/.git/refs/remotes/origin", {
				recursive: true,
			});
			await bash.fs.writeFile("/repo/.git/refs/remotes/origin/main", `${headHash}\n`);
			await bash.exec("git branch --set-upstream-to=origin/main");

			// Make a local commit so we're ahead
			await bash.fs.writeFile("/repo/new.txt", "new\n");
			await bash.exec("git add .");
			await bash.exec('git commit -m "ahead commit"');

			const result = await bash.exec("git branch -vv");
			expect(result.stdout).toContain("[origin/main: ahead 1]");
		});

		test("-vv shows behind count", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');

			// Make a second commit
			await bash.fs.writeFile("/repo/second.txt", "two\n");
			await bash.exec("git add .");
			await bash.exec('git commit -m "second"');

			const secondHash = (await readFile(bash.fs, "/repo/.git/refs/heads/main"))?.trim();

			// Set up remote tracking at second commit
			await bash.fs.mkdir("/repo/.git/refs/remotes/origin", {
				recursive: true,
			});
			await bash.fs.writeFile("/repo/.git/refs/remotes/origin/main", `${secondHash}\n`);

			// Reset local to first commit (behind upstream)
			await bash.exec("git reset --hard HEAD~1");
			await bash.exec("git branch --set-upstream-to=origin/main");

			const result = await bash.exec("git branch -vv");
			expect(result.stdout).toContain("[origin/main: behind 1]");
		});

		test("-vv shows gone when upstream ref is deleted", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');

			// Set up tracking config pointing to a remote that doesn't exist
			await bash.exec("git config set branch.main.remote origin");
			await bash.exec("git config set branch.main.merge refs/heads/main");

			const result = await bash.exec("git branch -vv");
			expect(result.stdout).toContain("[origin/main: gone]");
		});

		test("-vv omits tracking info for branches without upstream", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');
			await bash.exec("git branch feature");

			const result = await bash.exec("git branch -vv");
			const featureLine = result.stdout
				.trim()
				.split("\n")
				.find((l: string) => l.includes("feature"));
			expect(featureLine).not.toContain("[");
		});

		test("-v with -r shows remote branches", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			const headHash = (await readFile(bash.fs, "/repo/.git/refs/heads/main"))?.trim();
			await bash.fs.mkdir("/repo/.git/refs/remotes/origin", {
				recursive: true,
			});
			await bash.fs.writeFile("/repo/.git/refs/remotes/origin/main", `${headHash}\n`);

			const result = await bash.exec("git branch -rv");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toMatch(/origin\/main\s+[a-f0-9]{7} initial/);
			expect(result.stdout).not.toContain("* main");
		});
	});

	describe("delete branch", () => {
		test("deletes an existing branch", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');
			await bash.exec("git branch feature");

			const result = await bash.exec("git branch -d feature");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Deleted branch feature");

			// Verify the ref was removed
			const ref = await readFile(bash.fs, "/repo/.git/refs/heads/feature");
			expect(ref).toBeUndefined();
		});

		test("shows the short hash of the deleted branch", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');
			await bash.exec("git branch feature");

			const result = await bash.exec("git branch -d feature");
			// Should contain a 7-char hash
			expect(result.stdout).toMatch(/was [a-f0-9]{7}/);
		});

		test("fails when branch does not exist", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "first"', "git branch -d nonexistent"],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			expect(results[3].exitCode).toBe(1);
			expect(results[3].stderr).toContain("not found");
		});

		test("fails when trying to delete current branch", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "first"', "git branch -d main"],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			expect(results[3].exitCode).toBe(1);
			expect(results[3].stderr).toContain("cannot delete branch");
		});

		test("fails when no branch name given", async () => {
			const { results } = await runScenario(["git init", "git branch -d"], {
				files: EMPTY_REPO,
				env: TEST_ENV,
			});
			expect(results[1].exitCode).toBe(128);
			expect(results[1].stderr).toContain("branch name required");
		});

		test("fails when branch is not fully merged into HEAD", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');

			// Create feature branch, switch to it, make a commit
			await bash.exec("git checkout -b feature");
			await bash.fs.writeFile("/repo/feature.txt", "feature work\n");
			await bash.exec("git add .");
			await bash.exec('git commit -m "feature work"');

			// Switch back to main — feature has an unmerged commit
			await bash.exec("git checkout main");

			const result = await bash.exec("git branch -d feature");
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("not fully merged");
			expect(result.stderr).toContain("git branch -D feature");
			expect(result.stderr).toContain("advice.forceDeleteBranch");

			// Verify branch still exists
			const ref = await readFile(bash.fs, "/repo/.git/refs/heads/feature");
			expect(ref).toBeDefined();
		});

		test("omits delete hint when advice.forceDeleteBranch is false", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');
			await bash.exec("git checkout -b feature");
			await bash.fs.writeFile("/repo/feature.txt", "feature work\n");
			await bash.exec("git add .");
			await bash.exec('git commit -m "feature work"');
			await bash.exec("git checkout main");
			await bash.exec("git config set advice.forceDeleteBranch false");

			const result = await bash.exec("git branch -d feature");
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toBe("error: the branch 'feature' is not fully merged\n");
		});

		test("does not add disable hint when advice.forceDeleteBranch is true", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');
			await bash.exec("git checkout -b feature");
			await bash.fs.writeFile("/repo/feature.txt", "feature work\n");
			await bash.exec("git add .");
			await bash.exec('git commit -m "feature work"');
			await bash.exec("git checkout main");
			await bash.exec("git config set advice.forceDeleteBranch true");

			const result = await bash.exec("git branch -d feature");
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toBe(
				"error: the branch 'feature' is not fully merged\n" +
					"hint: If you are sure you want to delete it, run 'git branch -D feature'\n",
			);
		});

		test("allows deleting a branch that is merged into HEAD", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');

			// Create feature branch, switch to it, make a commit
			await bash.exec("git checkout -b feature");
			await bash.fs.writeFile("/repo/feature.txt", "feature work\n");
			await bash.exec("git add .");
			await bash.exec('git commit -m "feature work"');

			// Switch back to main and merge feature
			await bash.exec("git checkout main");
			await bash.exec("git merge feature");

			// Now feature is fully merged — delete should succeed
			const result = await bash.exec("git branch -d feature");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Deleted branch feature");
		});

		test("-D force deletes an unmerged branch", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');

			// Create feature branch with an unmerged commit
			await bash.exec("git checkout -b feature");
			await bash.fs.writeFile("/repo/feature.txt", "feature work\n");
			await bash.exec("git add .");
			await bash.exec('git commit -m "feature work"');

			await bash.exec("git checkout main");

			// -D should force delete even though it's not merged
			const result = await bash.exec("git branch -D feature");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Deleted branch feature");

			// Verify the ref was removed
			const ref = await readFile(bash.fs, "/repo/.git/refs/heads/feature");
			expect(ref).toBeUndefined();
		});

		test("allows deleting a branch pointing to same commit as HEAD", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');

			// Branch at HEAD — same commit, trivially merged
			await bash.exec("git branch feature");
			const result = await bash.exec("git branch -d feature");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Deleted branch feature");
		});
	});

	describe("branch.autoSetupMerge", () => {
		test("auto-sets tracking when creating from remote tracking ref", async () => {
			const bash = await setupClonePair();

			// Create a new branch in remote and fetch it
			await bash.exec(
				"cd /remote && git checkout -b feature && echo feat > feat.txt && git add . && git commit -m feat",
			);
			await bash.exec("cd /local && git fetch");

			// Create local branch from remote tracking ref
			const result = await bash.exec("git branch my-feature origin/feature", {
				cwd: "/local",
			});
			expect(result.exitCode).toBe(0);
			expect(result.stderr).toContain("set up to track");

			// Verify config
			const config = await readFile(bash.fs, "/local/.git/config");
			expect(config).toContain('branch "my-feature"');
			expect(config).toContain("remote = origin");
			expect(config).toContain("merge = refs/heads/feature");
		});

		test("does not track when branch.autoSetupMerge=false", async () => {
			const bash = await setupClonePair();

			await bash.exec(
				"cd /remote && git checkout -b feature && echo feat > feat.txt && git add . && git commit -m feat",
			);
			await bash.exec("cd /local && git fetch");
			await bash.exec("cd /local && git config set branch.autoSetupMerge false");

			const result = await bash.exec("git branch my-feature origin/feature", {
				cwd: "/local",
			});
			expect(result.exitCode).toBe(0);
			expect(result.stderr).not.toContain("set up to track");
		});

		test("does not track when creating from local ref", async () => {
			const bash = await setupClonePair();

			await bash.exec("cd /local && echo v2 > README.md && git add . && git commit -m update");

			const result = await bash.exec("git branch my-feature main", { cwd: "/local" });
			expect(result.exitCode).toBe(0);
			expect(result.stderr).toBe("");
		});
	});
});
