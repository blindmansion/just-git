import { describe, expect, test } from "bun:test";
import { createTestBash } from "../util";

const ENV = {
	GIT_AUTHOR_NAME: "Test",
	GIT_AUTHOR_EMAIL: "test@test.com",
	GIT_COMMITTER_NAME: "Test",
	GIT_COMMITTER_EMAIL: "test@test.com",
};

const MULTI_TYPE_REPO = {
	"/repo/README.md": "# Hello",
	"/repo/src/app.ts": "console.log('app');",
	"/repo/src/util.ts": "export const x = 1;",
	"/repo/src/lib/helper.ts": "export function help() {}",
	"/repo/src/style.css": "body { }",
	"/repo/docs/guide.md": "# Guide",
	"/repo/debug.log": "error line",
};

// ── git diff -- <pathspec> ──────────────────────────────────────────

describe("git diff pathspec", () => {
	test("diff -- '*.ts' shows only .ts file changes", async () => {
		const bash = createTestBash({ files: MULTI_TYPE_REPO });
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "initial"', { env: ENV });

		// Modify multiple file types
		await bash.fs.writeFile("/repo/src/app.ts", "console.log('updated');");
		await bash.fs.writeFile("/repo/src/style.css", "body { color: red; }");
		await bash.fs.writeFile("/repo/README.md", "# Updated");

		const result = await bash.exec("git diff -- '*.ts'");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("a/src/app.ts");
		expect(result.stdout).not.toContain("style.css");
		expect(result.stdout).not.toContain("README.md");
	});

	test("diff -- '*.md' filters to markdown files", async () => {
		const bash = createTestBash({ files: MULTI_TYPE_REPO });
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "initial"', { env: ENV });

		await bash.fs.writeFile("/repo/README.md", "# Changed");
		await bash.fs.writeFile("/repo/docs/guide.md", "# Updated Guide");
		await bash.fs.writeFile("/repo/src/app.ts", "// changed");

		const result = await bash.exec("git diff -- '*.md'");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("README.md");
		expect(result.stdout).toContain("docs/guide.md");
		expect(result.stdout).not.toContain("app.ts");
	});

	test("diff --cached -- '*.ts' filters staged changes", async () => {
		const bash = createTestBash({ files: MULTI_TYPE_REPO });
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "initial"', { env: ENV });

		await bash.fs.writeFile("/repo/src/app.ts", "// updated");
		await bash.fs.writeFile("/repo/README.md", "# v2");
		await bash.exec("git add .");

		const result = await bash.exec("git diff --cached -- '*.ts'");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("app.ts");
		expect(result.stdout).not.toContain("README.md");
	});

	test("diff with no matching pathspec produces empty output", async () => {
		const bash = createTestBash({ files: MULTI_TYPE_REPO });
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "initial"', { env: ENV });

		await bash.fs.writeFile("/repo/src/app.ts", "// updated");

		const result = await bash.exec("git diff -- '*.py'");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("");
	});
});

// ── git rm <pathspec> ───────────────────────────────────────────────

describe("git rm pathspec", () => {
	test("rm '*.log' removes matching files from index and worktree", async () => {
		const files = {
			"/repo/debug.log": "log1",
			"/repo/error.log": "log2",
			"/repo/app.ts": "code",
		};
		const bash = createTestBash({ files });
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "initial"', { env: ENV });

		const result = await bash.exec("git rm '*.log'");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("rm 'debug.log'");
		expect(result.stdout).toContain("rm 'error.log'");

		// Files should be gone from worktree
		expect(await bash.fs.exists("/repo/debug.log")).toBe(false);
		expect(await bash.fs.exists("/repo/error.log")).toBe(false);
		// Non-matching file untouched
		expect(await bash.fs.exists("/repo/app.ts")).toBe(true);
	});

	test("rm '*.py' with no matches returns error", async () => {
		const bash = createTestBash({ files: { "/repo/app.ts": "code" } });
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "initial"', { env: ENV });

		const result = await bash.exec("git rm '*.py'");
		expect(result.exitCode).toBe(128);
		expect(result.stderr).toContain("did not match any files");
	});

	test("rm --cached '*.ts' removes from index only", async () => {
		const files = {
			"/repo/a.ts": "one",
			"/repo/b.ts": "two",
			"/repo/c.js": "three",
		};
		const bash = createTestBash({ files });
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "initial"', { env: ENV });

		const result = await bash.exec("git rm --cached '*.ts'");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("rm 'a.ts'");
		expect(result.stdout).toContain("rm 'b.ts'");

		// Files still exist on disk
		expect(await bash.fs.exists("/repo/a.ts")).toBe(true);
		expect(await bash.fs.exists("/repo/b.ts")).toBe(true);
	});
});

// ── git reset -- <pathspec> ─────────────────────────────────────────

describe("git reset pathspec", () => {
	test("reset -- '*.ts' unstages matching files", async () => {
		const bash = createTestBash({ files: MULTI_TYPE_REPO });
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "initial"', { env: ENV });

		// Modify and stage everything
		await bash.fs.writeFile("/repo/src/app.ts", "// modified");
		await bash.fs.writeFile("/repo/README.md", "# v2");
		await bash.exec("git add .");

		// Unstage only .ts files
		const result = await bash.exec("git reset -- '*.ts'");
		expect(result.exitCode).toBe(0);

		const status = await bash.exec("git status");
		// .ts files should be unstaged (appear as modified in working tree)
		// README.md should still be staged
		expect(status.stdout).toContain("modified:   README.md");
	});

	test("reset -- '*.py' with no matches is a no-op", async () => {
		const bash = createTestBash({ files: MULTI_TYPE_REPO });
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "initial"', { env: ENV });

		// No .py files, but reset doesn't error on unmatched pathspecs
		const result = await bash.exec("git reset -- '*.py'");
		expect(result.exitCode).toBe(0);
	});
});

// ── git checkout -- <pathspec> ──────────────────────────────────────

describe("git checkout pathspec", () => {
	test("checkout -- '*.ts' restores matching files", async () => {
		const bash = createTestBash({ files: MULTI_TYPE_REPO });
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "initial"', { env: ENV });

		// Modify files
		await bash.fs.writeFile("/repo/src/app.ts", "// broken");
		await bash.fs.writeFile("/repo/README.md", "# broken");

		const result = await bash.exec("git checkout -- '*.ts'");
		expect(result.exitCode).toBe(0);

		// .ts file should be restored
		const content = await bash.fs.readFile("/repo/src/app.ts");
		expect(content).toBe("console.log('app');");

		// .md file should still be modified
		const mdContent = await bash.fs.readFile("/repo/README.md");
		expect(mdContent).toBe("# broken");
	});

	test("checkout -- '*.py' with no matches returns error", async () => {
		const bash = createTestBash({ files: MULTI_TYPE_REPO });
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "initial"', { env: ENV });

		const result = await bash.exec("git checkout -- '*.py'");
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("did not match any file(s) known to git");
	});
});

// ── Cross-command pathspec behaviors ────────────────────────────────

describe("pathspec edge cases", () => {
	test("* in default mode matches across directories", async () => {
		const bash = createTestBash({ files: MULTI_TYPE_REPO });
		await bash.exec("git init");

		// *.ts should match files in subdirectories
		const result = await bash.exec("git add '*.ts'");
		expect(result.exitCode).toBe(0);

		const status = await bash.exec("git status");
		expect(status.stdout).toContain("src/app.ts");
		expect(status.stdout).toContain("src/util.ts");
		expect(status.stdout).toContain("src/lib/helper.ts");
	});

	test("literal paths still work alongside globs", async () => {
		const bash = createTestBash({ files: MULTI_TYPE_REPO });
		await bash.exec("git init");

		// Mix literal and glob
		const r1 = await bash.exec("git add README.md");
		expect(r1.exitCode).toBe(0);
		const r2 = await bash.exec("git add '*.ts'");
		expect(r2.exitCode).toBe(0);

		const status = await bash.exec("git status");
		expect(status.stdout).toContain("README.md");
		expect(status.stdout).toContain("src/app.ts");
	});
});
