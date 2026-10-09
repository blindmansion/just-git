import { describe, expect, test } from "bun:test";
import { BASIC_REPO, EMPTY_REPO, TEST_ENV_NAMED as TEST_ENV } from "../fixtures";
import {
	createTestBash,
	permissionBits,
	quickExec,
	readFile,
	runScenario,
	setupClonePair,
	setupExecBitRepo,
} from "../util";

describe("git switch", () => {
	describe("errors", () => {
		test("fails outside a git repo", async () => {
			const result = await quickExec("git switch main", {
				files: EMPTY_REPO,
			});
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("not a git repository");
		});

		test("fails with no arguments", async () => {
			const { results } = await runScenario(["git init", "git switch"], {
				files: EMPTY_REPO,
				env: TEST_ENV,
			});
			expect(results[1].exitCode).toBe(128);
			expect(results[1].stderr).toContain("missing branch or commit argument");
		});

		test("fails for invalid reference", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "init"', "git switch nonexistent"],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			expect(results[3].exitCode).toBe(128);
			expect(results[3].stderr).toContain("invalid reference: nonexistent");
		});
	});

	describe("switch to existing branch", () => {
		test("switches HEAD to the target branch", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');
			await bash.exec("git branch feature");

			const result = await bash.exec("git switch feature");
			expect(result.exitCode).toBe(0);
			expect(result.stderr).toContain("Switched to branch 'feature'");

			const head = await readFile(bash.fs, "/repo/.git/HEAD");
			expect(head?.trim()).toBe("ref: refs/heads/feature");
		});

		test("already on the same branch", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "first"', "git switch main"],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			expect(results[3].exitCode).toBe(0);
			expect(results[3].stderr).toContain("Already on 'main'");
		});

		test("updates working tree files", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');
			await bash.exec("git switch -c feature");

			await bash.fs.writeFile("/repo/feature.txt", "feature content");
			await bash.exec("git add feature.txt");
			await bash.exec('git commit -m "add feature file"');

			await bash.exec("git switch main");
			const exists = await bash.fs.exists("/repo/feature.txt");
			expect(exists).toBe(false);

			await bash.exec("git switch feature");
			const content = await readFile(bash.fs, "/repo/feature.txt");
			expect(content).toBe("feature content");
		});
	});

	describe("create branch (-c)", () => {
		test("creates new branch and switches to it", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');

			const result = await bash.exec("git switch -c feature");
			expect(result.exitCode).toBe(0);
			expect(result.stderr).toContain("Switched to a new branch 'feature'");

			const head = await readFile(bash.fs, "/repo/.git/HEAD");
			expect(head?.trim()).toBe("ref: refs/heads/feature");
		});

		test("fails when branch already exists", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "first"', "git switch -c main"],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			expect(results[3].exitCode).toBe(128);
			expect(results[3].stderr).toContain("a branch named 'main' already exists");
		});

		test("creates branch from start-point", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');
			await bash.exec("git switch -c feature");
			await bash.fs.writeFile("/repo/feature.txt", "feature");
			await bash.exec("git add feature.txt");
			await bash.exec('git commit -m "feature"');

			// Create new branch from main (should not have feature.txt)
			const result = await bash.exec("git switch -c new-branch -- main");
			expect(result.exitCode).toBe(0);
			expect(result.stderr).toContain("Switched to a new branch 'new-branch'");
			const exists = await bash.fs.exists("/repo/feature.txt");
			expect(exists).toBe(false);
		});

		test("works on empty repo (no commits)", async () => {
			const { results } = await runScenario(["git init", "git switch -c feature"], {
				files: EMPTY_REPO,
				env: TEST_ENV,
			});
			expect(results[1].exitCode).toBe(0);
			expect(results[1].stderr).toContain("Switched to a new branch 'feature'");
		});
	});

	describe("force create branch (-C)", () => {
		test("resets existing branch", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');
			await bash.exec("git switch -c feature");
			await bash.fs.writeFile("/repo/extra.txt", "extra");
			await bash.exec("git add extra.txt");
			await bash.exec('git commit -m "second"');

			// -C should reset 'feature' to main's HEAD
			await bash.exec("git switch main");
			const result = await bash.exec("git switch -C feature");
			expect(result.exitCode).toBe(0);
			expect(result.stderr).toContain("Switched to and reset branch 'feature'");
		});

		test("creates new branch if it does not exist", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');

			const result = await bash.exec("git switch -C newbranch");
			expect(result.exitCode).toBe(0);
			expect(result.stderr).toContain("Switched to a new branch 'newbranch'");
		});
	});

	describe("detach (--detach / -d)", () => {
		test("detaches HEAD at current commit", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');

			const result = await bash.exec("git switch --detach HEAD");
			expect(result.exitCode).toBe(0);
			expect(result.stderr).toContain("HEAD is now at");
		});

		test("detaches HEAD at specific commit", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');
			await bash.fs.writeFile("/repo/file2.txt", "two");
			await bash.exec("git add file2.txt");
			await bash.exec('git commit -m "second"');

			const result = await bash.exec("git switch -d HEAD~1");
			expect(result.exitCode).toBe(0);
			expect(result.stderr).toContain("HEAD is now at");
		});

		test("does not detach without --detach flag", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');

			// Using a commit hash without --detach should fail
			const log = await bash.exec("git rev-parse HEAD");
			const hash = log.stdout.trim();
			const result = await bash.exec(`git switch ${hash}`);
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("invalid reference");
		});
	});

	describe("orphan (--orphan)", () => {
		test("creates orphan branch and clears index", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');

			const result = await bash.exec("git switch --orphan orphan-branch");
			expect(result.exitCode).toBe(0);
			expect(result.stderr).toContain("Switched to a new branch 'orphan-branch'");

			const head = await readFile(bash.fs, "/repo/.git/HEAD");
			expect(head?.trim()).toBe("ref: refs/heads/orphan-branch");

			// Index should be cleared (unlike checkout --orphan)
			const lsFiles = await bash.exec("git ls-files");
			expect(lsFiles.stdout.trim()).toBe("");

			// Tracked files should be removed from worktree
			const exists = await bash.fs.exists("/repo/README.md");
			expect(exists).toBe(false);
		});

		test("fails if branch already exists", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "first"', "git switch --orphan main"],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			expect(results[3].exitCode).toBe(128);
			expect(results[3].stderr).toContain("a branch named 'main' already exists");
		});
	});

	describe("incompatible flags", () => {
		test("--orphan and -c are incompatible", async () => {
			const { results } = await runScenario(["git init", "git switch --orphan foo -c bar"], {
				files: EMPTY_REPO,
				env: TEST_ENV,
			});
			expect(results[1].exitCode).toBe(128);
			expect(results[1].stderr).toContain("incompatible");
		});

		test("--detach and -c are incompatible", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "first"', "git switch --detach -c test"],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			expect(results[3].exitCode).toBe(128);
			expect(results[3].stderr).toContain("incompatible");
		});
	});

	describe("previous branch shorthand", () => {
		test("fails with git-compatible message when no previous branch exists", async () => {
			const { results } = await runScenario(["git init", "git switch -"], {
				files: EMPTY_REPO,
				env: TEST_ENV,
			});
			expect(results[1].exitCode).toBe(128);
			expect(results[1].stderr).toBe("fatal: invalid reference: @{-1}\n");
		});

		test("resolves @{-1} before checking rebase state", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.fs.mkdir("/repo/.git/rebase-merge", { recursive: true });

			const result = await bash.exec("git switch -");
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toBe("fatal: invalid reference: @{-1}\n");
		});

		test("fails when @{-1} points to a detached commit", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');
			await bash.exec("git switch -c feature");
			await bash.exec("git switch --detach HEAD");
			const detachedHash = (await bash.exec("git rev-parse HEAD")).stdout.trim();
			await bash.exec("git switch feature");

			const result = await bash.exec("git switch -");
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toBe(
				`fatal: a branch is expected, got commit '${detachedHash}'\n` +
					"hint: If you want to detach HEAD at the commit, try again with the --detach option.\n",
			);
		});
	});

	describe("branch.autoSetupMerge with -c", () => {
		test("auto-sets tracking when creating from remote tracking ref", async () => {
			const bash = await setupClonePair();

			await bash.exec(
				"cd /remote && git checkout -b feature && echo feat > feat.txt && git add . && git commit -m feat",
			);
			await bash.exec("cd /local && git fetch");

			const result = await bash.exec("git switch -c my-feature origin/feature", {
				cwd: "/local",
			});
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("set up to track");

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

			const result = await bash.exec("git switch -c my-feature origin/feature", {
				cwd: "/local",
			});
			expect(result.exitCode).toBe(0);
			expect(result.stdout).not.toContain("set up to track");
		});
	});

	describe("checkout.defaultRemote", () => {
		test("disambiguates when multiple remotes have the branch", async () => {
			const bash = await setupClonePair();

			// Create a feature branch in the original remote
			await bash.exec(
				"cd /remote && git checkout -b feature && echo feat > feat.txt && git add . && git commit -m feat",
			);

			// Create a second remote with the same branch
			await bash.exec("cd / && git clone /remote /remote2");
			await bash.exec("cd /local && git remote add other /remote2");

			// Fetch both remotes
			await bash.exec("cd /local && git fetch origin && git fetch other");

			// Without config, DWIM fails (multiple candidates)
			const fail = await bash.exec("git switch feature", { cwd: "/local" });
			expect(fail.exitCode).toBe(128);

			// Set checkout.defaultRemote to prefer origin
			await bash.exec("cd /local && git config set checkout.defaultRemote origin");

			const result = await bash.exec("git switch feature", { cwd: "/local" });
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("set up to track");
			expect(result.stdout).toContain("origin/feature");
		});

		test("switch --guess includes checkout summary before tracking message", async () => {
			const bash = await setupClonePair();

			await bash.exec(
				"cd /remote && git checkout -b feature && echo feat > feat.txt && git add . && git commit -m feat",
			);
			await bash.exec(
				"cd /local && git fetch origin refs/heads/feature:refs/remotes/origin/feature",
			);
			await bash.exec("cd /local && echo local > local.txt && git add local.txt");

			const result = await bash.exec("git switch --guess feature", { cwd: "/local" });
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("A\tlocal.txt");
			expect(result.stdout).toContain("branch 'feature' set up to track 'origin/feature'.");
		});
	});

	describe("--quiet", () => {
		async function setupWithFeature() {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');
			await bash.exec("git branch feature");
			return bash;
		}

		test("-q and --quiet silence branch switch output", async () => {
			const bash = await setupWithFeature();
			await bash.exec("echo changed > README.md");

			const q = await bash.exec("git switch -q feature");
			expect(q).toMatchObject({ stdout: "", stderr: "", exitCode: 0 });
			expect((await readFile(bash.fs, "/repo/.git/HEAD"))?.trim()).toBe("ref: refs/heads/feature");

			const quiet = await bash.exec("git switch --quiet main");
			expect(quiet).toMatchObject({ stdout: "", stderr: "", exitCode: 0 });
			expect((await readFile(bash.fs, "/repo/.git/HEAD"))?.trim()).toBe("ref: refs/heads/main");

			const already = await bash.exec("git switch -q main");
			expect(already).toMatchObject({ stdout: "", stderr: "", exitCode: 0 });
		});

		test("--no-quiet after -q restores output", async () => {
			const bash = await setupWithFeature();
			await bash.exec("echo changed > README.md");

			const result = await bash.exec("git switch -q --no-quiet feature");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toBe("M\tREADME.md\n");
			expect(result.stderr).toBe("Switched to branch 'feature'\n");
		});

		test("silences -c, -C, --detach and --orphan", async () => {
			const bash = await setupWithFeature();
			const hash = (await bash.exec("git rev-parse HEAD")).stdout.trim();

			const c = await bash.exec("git switch -q -c topic");
			expect(c).toMatchObject({ stdout: "", stderr: "", exitCode: 0 });
			expect((await readFile(bash.fs, "/repo/.git/HEAD"))?.trim()).toBe("ref: refs/heads/topic");

			const C = await bash.exec("git switch -q -C feature main");
			expect(C).toMatchObject({ stdout: "", stderr: "", exitCode: 0 });
			expect((await readFile(bash.fs, "/repo/.git/HEAD"))?.trim()).toBe("ref: refs/heads/feature");

			const detach = await bash.exec("git switch -q --detach main");
			expect(detach).toMatchObject({ stdout: "", stderr: "", exitCode: 0 });
			expect((await readFile(bash.fs, "/repo/.git/HEAD"))?.trim()).toBe(hash);

			const orphan = await bash.exec("git switch -q --orphan fresh");
			expect(orphan).toMatchObject({ stdout: "", stderr: "", exitCode: 0 });
			expect((await readFile(bash.fs, "/repo/.git/HEAD"))?.trim()).toBe("ref: refs/heads/fresh");
		});

		test("silences orphaned-commit warning when leaving detached HEAD", async () => {
			const bash = await setupWithFeature();
			await bash.exec("git switch -q --detach");
			await bash.exec("echo lost > lost.txt");
			await bash.exec("git add lost.txt");
			await bash.exec('git commit -m "lost"');

			const result = await bash.exec("git switch -q main");
			expect(result).toMatchObject({ stdout: "", stderr: "", exitCode: 0 });
			expect((await readFile(bash.fs, "/repo/.git/HEAD"))?.trim()).toBe("ref: refs/heads/main");
		});

		test("silences tracking setup and still configures upstream", async () => {
			const bash = await setupClonePair();
			await bash.exec(
				"cd /remote && git checkout -b feature && echo feat > feat.txt && git add . && git commit -m feat",
			);
			await bash.exec("cd /local && git fetch");

			const result = await bash.exec("git switch -q feature", { cwd: "/local" });
			expect(result).toMatchObject({ stdout: "", stderr: "", exitCode: 0 });
			const merge = await bash.exec("git config get branch.feature.merge", { cwd: "/local" });
			expect(merge.stdout).toBe("refs/heads/feature\n");

			const created = await bash.exec("git switch -q -c t2 origin/feature", { cwd: "/local" });
			expect(created).toMatchObject({ stdout: "", stderr: "", exitCode: 0 });
			const merge2 = await bash.exec("git config get branch.t2.merge", { cwd: "/local" });
			expect(merge2.stdout).toBe("refs/heads/feature\n");
		});

		test("errors still print", async () => {
			const bash = await setupWithFeature();

			const missing = await bash.exec("git switch -q nope");
			expect(missing.exitCode).toBe(128);
			expect(missing.stdout).toBe("");
			expect(missing.stderr).toBe("fatal: invalid reference: nope\n");

			const exists = await bash.exec("git switch -q -c main");
			expect(exists.exitCode).toBe(128);
			expect(exists.stderr).toBe("fatal: a branch named 'main' already exists\n");
		});
	});
});

describe("git switch: executable bit", () => {
	test("switch flips the bit to match the branch", async () => {
		const bash = await setupExecBitRepo();
		expect((await bash.exec("git switch plain")).exitCode).toBe(0);
		expect(await permissionBits(bash.fs, "/repo/run.sh")).toBe(0o644);
		expect((await bash.exec("git status --short")).stdout).toBe("");
		expect((await bash.exec("git switch main")).exitCode).toBe(0);
		expect(await permissionBits(bash.fs, "/repo/run.sh")).toBe(0o755);
		expect((await bash.exec("git status --short")).stdout).toBe("");
	});

	test("switch refuses to overwrite a local mode-only change", async () => {
		const bash = await setupExecBitRepo();
		await bash.exec("git switch -c content && echo more >> run.sh && git commit -qam content");
		await bash.exec("git switch -q main && chmod 644 run.sh");
		const refused =
			"error: Your local changes to the following files would be overwritten by checkout:\n\trun.sh\nPlease commit your changes or stash them before you switch branches.\nAborting\n";

		for (const target of ["plain", "content"]) {
			const result = await bash.exec(`git switch ${target}`);
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toBe(refused);
			expect(await permissionBits(bash.fs, "/repo/run.sh")).toBe(0o644);
			expect((await bash.exec("git status --short")).stdout).toBe(" M run.sh\n");
			expect((await bash.exec("git branch --show-current")).stdout).toBe("main\n");
		}
	});
});
