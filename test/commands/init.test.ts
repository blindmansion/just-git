import { describe, expect, test } from "bun:test";
import { Bash } from "just-bash";
import { createGit } from "../../src/index.ts";
import { BASIC_REPO, EMPTY_REPO, TEST_ENV } from "../fixtures";
import { createTestBash, isDirectory, isFile, quickExec, readFile } from "../util";

describe("git init", () => {
	test("exits 0", async () => {
		const result = await quickExec("git init", { files: EMPTY_REPO });
		expect(result.exitCode).toBe(0);
	});

	test("prints initialization message on stdout", async () => {
		const result = await quickExec("git init", { files: EMPTY_REPO });
		expect(result.stdout).toContain("Initialized");
		expect(result.stderr).toBe("");
	});

	test("creates .git directory", async () => {
		const bash = createTestBash({ files: EMPTY_REPO });
		await bash.exec("git init");
		expect(await isDirectory(bash.fs, "/repo/.git")).toBe(true);
	});

	test("creates .git/HEAD pointing to refs/heads/main", async () => {
		const bash = createTestBash({ files: EMPTY_REPO });
		await bash.exec("git init");
		const head = await readFile(bash.fs, "/repo/.git/HEAD");
		expect(head).toBeDefined();
		expect(head?.trim()).toBe("ref: refs/heads/main");
	});

	test("creates .git/objects directory", async () => {
		const bash = createTestBash({ files: EMPTY_REPO });
		await bash.exec("git init");
		expect(await isDirectory(bash.fs, "/repo/.git/objects")).toBe(true);
	});

	test("creates .git/refs/heads directory", async () => {
		const bash = createTestBash({ files: EMPTY_REPO });
		await bash.exec("git init");
		expect(await isDirectory(bash.fs, "/repo/.git/refs/heads")).toBe(true);
	});

	test("creates .git/refs/tags directory", async () => {
		const bash = createTestBash({ files: EMPTY_REPO });
		await bash.exec("git init");
		expect(await isDirectory(bash.fs, "/repo/.git/refs/tags")).toBe(true);
	});

	test("creates .git/config", async () => {
		const bash = createTestBash({ files: EMPTY_REPO });
		await bash.exec("git init");
		expect(await isFile(bash.fs, "/repo/.git/config")).toBe(true);

		const config = await readFile(bash.fs, "/repo/.git/config");
		expect(config).toContain("[core]");
		expect(config).toContain("bare = false");
	});

	test("does not disturb existing files", async () => {
		const bash = createTestBash({ files: BASIC_REPO });
		await bash.exec("git init");
		expect(await readFile(bash.fs, "/repo/README.md")).toBe("# My Project");
		expect(await readFile(bash.fs, "/repo/src/main.ts")).toBe('console.log("hello world");');
	});

	describe("with directory argument", () => {
		test("creates the target directory if it doesn't exist", async () => {
			const bash = createTestBash({ files: EMPTY_REPO });
			await bash.exec("git init my-project");
			expect(await isDirectory(bash.fs, "/repo/my-project")).toBe(true);
		});

		test("initializes a repo inside the target directory", async () => {
			const bash = createTestBash({ files: EMPTY_REPO });
			await bash.exec("git init my-project");
			expect(await isDirectory(bash.fs, "/repo/my-project/.git")).toBe(true);
			expect(await isFile(bash.fs, "/repo/my-project/.git/HEAD")).toBe(true);
			expect(await isDirectory(bash.fs, "/repo/my-project/.git/objects")).toBe(true);
			expect(await isDirectory(bash.fs, "/repo/my-project/.git/refs/heads")).toBe(true);
		});
	});

	describe("-b / --initial-branch", () => {
		test("-b sets the initial branch name", async () => {
			const bash = createTestBash({ files: EMPTY_REPO });
			await bash.exec("git init -b develop");
			const head = await readFile(bash.fs, "/repo/.git/HEAD");
			expect(head?.trim()).toBe("ref: refs/heads/develop");
		});

		test("--initial-branch sets the initial branch name", async () => {
			const bash = createTestBash({ files: EMPTY_REPO });
			await bash.exec("git init --initial-branch trunk");
			const head = await readFile(bash.fs, "/repo/.git/HEAD");
			expect(head?.trim()).toBe("ref: refs/heads/trunk");
		});
	});

	describe("reinit (existing .git)", () => {
		test("prints 'Reinitialized' instead of 'Initialized empty'", async () => {
			const bash = createTestBash({ files: EMPTY_REPO });
			await bash.exec("git init");
			const r = await bash.exec("git init");
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toContain("Reinitialized existing Git repository");
			expect(r.stdout).not.toContain("Initialized empty");
		});

		test("preserves HEAD on plain reinit", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');
			const headBefore = await readFile(bash.fs, "/repo/.git/HEAD");

			await bash.exec("git init");

			const headAfter = await readFile(bash.fs, "/repo/.git/HEAD");
			expect(headAfter).toBe(headBefore);
		});

		test("ignores --initial-branch on reinit and warns", async () => {
			const bash = createTestBash({ files: EMPTY_REPO });
			await bash.exec("git init -b main");
			const r = await bash.exec("git init -b other");
			expect(r.exitCode).toBe(0);
			expect(r.stderr).toContain("re-init: ignored --initial-branch=other");

			const head = await readFile(bash.fs, "/repo/.git/HEAD");
			expect(head?.trim()).toBe("ref: refs/heads/main");
		});

		test("preserves config (remotes, user settings) on reinit", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git remote add origin https://example.com/repo.git");
			await bash.exec("git config user.name Custom");

			await bash.exec("git init");

			const r = await bash.exec("git config --list");
			expect(r.stdout).toContain("remote.origin.url=https://example.com/repo.git");
			expect(r.stdout).toContain("user.name=Custom");
		});

		test("preserves objects and refs on reinit", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');
			const logBefore = await bash.exec("git log --oneline");

			await bash.exec("git init");

			const logAfter = await bash.exec("git log --oneline");
			expect(logAfter.stdout).toBe(logBefore.stdout);
			expect(logAfter.exitCode).toBe(0);
		});

		test("preserves HEAD when reiniting with -b after commits exist", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init -b main");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');

			await bash.exec("git init -b other");

			const head = await readFile(bash.fs, "/repo/.git/HEAD");
			expect(head?.trim()).toBe("ref: refs/heads/main");

			const log = await bash.exec("git log --oneline");
			expect(log.exitCode).toBe(0);
			expect(log.stdout).toContain("first");
		});

		test("reinit with directory argument on existing repo", async () => {
			const bash = createTestBash({ files: EMPTY_REPO });
			await bash.exec("git init my-project");
			const r = await bash.exec("git init my-project");
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toContain("Reinitialized existing Git repository");
		});
	});

	describe("init.defaultBranch config override", () => {
		test("uses init.defaultBranch from config defaults when -b is not specified", async () => {
			const git = createGit({
				config: { defaults: { "init.defaultBranch": "develop" } },
			});
			const bash = new Bash({ cwd: "/repo", customCommands: [git] });
			await bash.exec("git init");
			const head = await bash.readFile("/repo/.git/HEAD");
			expect(head.trim()).toBe("ref: refs/heads/develop");
		});

		test("-b flag takes precedence over init.defaultBranch config default", async () => {
			const git = createGit({
				config: { defaults: { "init.defaultBranch": "develop" } },
			});
			const bash = new Bash({ cwd: "/repo", customCommands: [git] });
			await bash.exec("git init -b trunk");
			const head = await bash.readFile("/repo/.git/HEAD");
			expect(head.trim()).toBe("ref: refs/heads/trunk");
		});

		test("init.defaultBranch from locked config overrides", async () => {
			const git = createGit({
				config: { locked: { "init.defaultBranch": "locked-branch" } },
			});
			const bash = new Bash({ cwd: "/repo", customCommands: [git] });
			await bash.exec("git init");
			const head = await bash.readFile("/repo/.git/HEAD");
			expect(head.trim()).toBe("ref: refs/heads/locked-branch");
		});

		test("defaults to main when no config override is set", async () => {
			const git = createGit();
			const bash = new Bash({ cwd: "/repo", customCommands: [git] });
			await bash.exec("git init");
			const head = await bash.readFile("/repo/.git/HEAD");
			expect(head.trim()).toBe("ref: refs/heads/main");
		});
	});

	describe("--bare", () => {
		test("creates a bare repository", async () => {
			const bash = createTestBash({ files: EMPTY_REPO });
			await bash.exec("git init --bare");
			// In bare mode, the git structure is directly in the cwd
			expect(await isFile(bash.fs, "/repo/HEAD")).toBe(true);
			expect(await isDirectory(bash.fs, "/repo/objects")).toBe(true);
			expect(await isDirectory(bash.fs, "/repo/refs/heads")).toBe(true);

			const config = await readFile(bash.fs, "/repo/config");
			expect(config).toContain("bare = true");
		});

		test("prints bare in initialization message on stdout", async () => {
			const result = await quickExec("git init --bare", { files: EMPTY_REPO });
			expect(result.stdout).toContain("bare");
			expect(result.stderr).toBe("");
		});
	});
});
