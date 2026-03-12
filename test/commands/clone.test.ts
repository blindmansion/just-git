import { describe, expect, test } from "bun:test";
import { TEST_ENV as ENV } from "../fixtures";
import { createTestBash, isDirectory, pathExists, readFile } from "../util";

async function setupSource(files: Record<string, string> = {}) {
	const bash = createTestBash({
		files: { "/src/README.md": "# Hello", ...files },
		env: ENV,
		cwd: "/src",
	});
	await bash.exec("git init");
	await bash.exec("git add .");
	await bash.exec('git commit -m "initial"');
	return bash;
}

// ── Basic clone ──────────────────────────────────────────────────────

describe("git clone", () => {
	test("clones into named directory", async () => {
		const bash = await setupSource();
		const result = await bash.exec("git clone /src /dest", { cwd: "/" });
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain("Cloning into");

		// Working tree should have the file
		expect(await readFile(bash.fs, "/dest/README.md")).toBe("# Hello");
	});

	test("clones into auto-named directory", async () => {
		const bash = await setupSource();
		await bash.exec("mkdir -p /work");
		const result = await bash.exec("git clone /src", { cwd: "/work" });
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain("Cloning into");
		expect(await readFile(bash.fs, "/work/src/README.md")).toBe("# Hello");
	});

	test("auto-names from path", async () => {
		const bash = createTestBash({
			files: { "/repos/myproject/README.md": "hello" },
			env: ENV,
			cwd: "/repos/myproject",
		});
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "init"');
		await bash.exec("mkdir -p /work");
		const result = await bash.exec("cd /work && git clone /repos/myproject");
		expect(result.exitCode).toBe(0);
		expect(await readFile(bash.fs, "/work/myproject/README.md")).toBe("hello");
	});

	test("creates .git directory in clone", async () => {
		const bash = await setupSource();
		await bash.exec("git clone /src /clone", { cwd: "/" });
		expect(await isDirectory(bash.fs, "/clone/.git")).toBe(true);
		expect(await pathExists(bash.fs, "/clone/.git/HEAD")).toBe(true);
	});

	test("sets up origin remote", async () => {
		const bash = await setupSource();
		await bash.exec("git clone /src /clone", { cwd: "/" });

		// Check remote config
		const result = await bash.exec("cd /clone && git remote -v");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("origin");
		expect(result.stdout).toContain("/src");
	});

	test("creates remote tracking refs", async () => {
		const bash = await setupSource();
		await bash.exec("git clone /src /clone", { cwd: "/" });

		expect(await pathExists(bash.fs, "/clone/.git/refs/remotes/origin/main")).toBe(true);
	});

	test("creates local branch matching HEAD", async () => {
		const bash = await setupSource();
		await bash.exec("git clone /src /clone", { cwd: "/" });

		// HEAD should be symbolic ref to refs/heads/main
		const head = await readFile(bash.fs, "/clone/.git/HEAD");
		expect(head?.trim()).toBe("ref: refs/heads/main");

		// Local branch should exist
		expect(await pathExists(bash.fs, "/clone/.git/refs/heads/main")).toBe(true);
	});

	test("checks out working tree", async () => {
		const bash = await setupSource({
			"/src/README.md": "# Hello",
			"/src/src/main.ts": "console.log('hi');",
			"/src/src/util.ts": "export const x = 1;",
		});
		await bash.exec("git clone /src /clone", { cwd: "/" });

		expect(await readFile(bash.fs, "/clone/README.md")).toBe("# Hello");
		expect(await readFile(bash.fs, "/clone/src/main.ts")).toBe("console.log('hi');");
		expect(await readFile(bash.fs, "/clone/src/util.ts")).toBe("export const x = 1;");
	});

	test("populates index after checkout", async () => {
		const bash = await setupSource();
		await bash.exec("git clone /src /clone", { cwd: "/" });

		// git status should show clean
		const result = await bash.exec("git status", { cwd: "/clone" });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).not.toContain("Untracked");
		expect(result.stdout).not.toContain("modified");
	});

	// ── Multiple branches ─────────────────────────────────────────────

	test("clones all branches as remote tracking refs", async () => {
		const bash = await setupSource();
		await bash.exec(
			"cd /src && git checkout -b feature && echo 'feat' > feat.txt && git add . && git commit -m 'feature'",
		);
		await bash.exec("cd /src && git checkout main");

		await bash.exec("git clone /src /clone", { cwd: "/" });

		expect(await pathExists(bash.fs, "/clone/.git/refs/remotes/origin/main")).toBe(true);
		expect(await pathExists(bash.fs, "/clone/.git/refs/remotes/origin/feature")).toBe(true);
	});

	test("does not create local branches for non-HEAD remotes", async () => {
		const bash = await setupSource();
		await bash.exec(
			"cd /src && git checkout -b feature && echo 'feat' > feat.txt && git add . && git commit -m 'feature'",
		);
		await bash.exec("cd /src && git checkout main");

		await bash.exec("git clone /src /clone", { cwd: "/" });

		// Only main should be a local branch
		expect(await pathExists(bash.fs, "/clone/.git/refs/heads/main")).toBe(true);
		expect(await pathExists(bash.fs, "/clone/.git/refs/heads/feature")).toBe(false);
	});

	// ── Clone with -b ─────────────────────────────────────────────────

	test("-b checks out specified branch", async () => {
		const bash = await setupSource();
		await bash.exec(
			"cd /src && git checkout -b feature && echo 'feat' > feat.txt && git add . && git commit -m 'feature'",
		);
		await bash.exec("cd /src && git checkout main");

		await bash.exec("git clone -b feature /src /clone", { cwd: "/" });

		const head = await readFile(bash.fs, "/clone/.git/HEAD");
		expect(head?.trim()).toBe("ref: refs/heads/feature");
		expect(await readFile(bash.fs, "/clone/feat.txt")).toBe("feat\n");
	});

	test("-b with nonexistent branch fails", async () => {
		const bash = await setupSource();
		const result = await bash.exec("git clone -b nonexistent /src /clone", {
			cwd: "/",
		});
		expect(result.exitCode).toBe(128);
		expect(result.stderr).toContain("not found");
	});

	// ── Bare clone ────────────────────────────────────────────────────

	test("--bare creates bare repository", async () => {
		const bash = await setupSource();
		const result = await bash.exec("git clone --bare /src /clone.git", {
			cwd: "/",
		});
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain("bare repository");

		// Bare repo has no .git subdirectory — objects dir is at root
		expect(await isDirectory(bash.fs, "/clone.git/objects")).toBe(true);
		expect(await pathExists(bash.fs, "/clone.git/HEAD")).toBe(true);

		// No working tree files
		expect(await pathExists(bash.fs, "/clone.git/README.md")).toBe(false);
	});

	// ── Tags ──────────────────────────────────────────────────────────

	test("clones tags", async () => {
		const bash = await setupSource();
		await bash.exec("cd /src && git tag v1.0");

		await bash.exec("git clone /src /clone", { cwd: "/" });

		expect(await pathExists(bash.fs, "/clone/.git/refs/tags/v1.0")).toBe(true);
	});

	// ── Error cases ───────────────────────────────────────────────────

	test("fails if source doesn't exist", async () => {
		const bash = createTestBash({ env: ENV });
		const result = await bash.exec("git clone /nonexistent /dest");
		expect(result.exitCode).toBe(128);
		expect(result.stderr).toContain("does not exist");
	});

	test("fails if no repository argument", async () => {
		const bash = createTestBash({ env: ENV });
		const result = await bash.exec("git clone");
		expect(result.exitCode).not.toBe(0);
	});

	test("fails if destination is non-empty", async () => {
		const bash = await setupSource({
			"/dest/existing.txt": "stuff",
		});
		const result = await bash.exec("git clone /src /dest", { cwd: "/" });
		expect(result.exitCode).toBe(128);
		expect(result.stderr).toContain("already exists");
	});

	// ── Clone preserves commit history ────────────────────────────────

	test("preserves commit history", async () => {
		const bash = await setupSource();
		await bash.exec("cd /src && echo 'v2' > README.md && git add . && git commit -m 'second'");

		await bash.exec("git clone /src /clone", { cwd: "/" });

		const result = await bash.exec("git log --oneline", { cwd: "/clone" });
		expect(result.exitCode).toBe(0);
		const lines = result.stdout.trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("second");
		expect(lines[1]).toContain("initial");
	});

	// ── Empty repository ──────────────────────────────────────────────

	test("clones empty repository with warning", async () => {
		const bash = createTestBash({ env: ENV, cwd: "/src" });
		await bash.exec("mkdir -p /src && cd /src && git init");
		const result = await bash.exec("git clone /src /clone", { cwd: "/" });
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain("empty repository");
	});
});
