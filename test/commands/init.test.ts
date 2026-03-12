import { describe, expect, test } from "bun:test";
import { BASIC_REPO, EMPTY_REPO } from "../fixtures";
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
