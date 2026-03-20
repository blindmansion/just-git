import { describe, expect, test } from "bun:test";
import { InMemoryFs } from "just-bash";
import { createGit, type ConfigOverrides } from "../src";
import { tokenizeCommand } from "../src/git";
import { TEST_ENV } from "./fixtures";

// ── tokenizeCommand ─────────────────────────────────────────────────

describe("tokenizeCommand", () => {
	test("simple whitespace splitting", () => {
		expect(tokenizeCommand("init")).toEqual(["init"]);
		expect(tokenizeCommand("add .")).toEqual(["add", "."]);
		expect(tokenizeCommand("log --oneline -n 5")).toEqual(["log", "--oneline", "-n", "5"]);
	});

	test("strips leading 'git'", () => {
		expect(tokenizeCommand("git init")).toEqual(["init"]);
		expect(tokenizeCommand("git add .")).toEqual(["add", "."]);
		expect(tokenizeCommand("git commit -m 'hello'")).toEqual(["commit", "-m", "hello"]);
	});

	test("double-quoted strings", () => {
		expect(tokenizeCommand('commit -m "initial commit"')).toEqual([
			"commit",
			"-m",
			"initial commit",
		]);
	});

	test("single-quoted strings", () => {
		expect(tokenizeCommand("commit -m 'initial commit'")).toEqual([
			"commit",
			"-m",
			"initial commit",
		]);
	});

	test("backslash escapes inside double quotes", () => {
		expect(tokenizeCommand('commit -m "say \\"hello\\""')).toEqual(["commit", "-m", 'say "hello"']);
	});

	test("single quotes preserve backslashes literally", () => {
		expect(tokenizeCommand("commit -m 'no\\escape'")).toEqual(["commit", "-m", "no\\escape"]);
	});

	test("multiple spaces between tokens", () => {
		expect(tokenizeCommand("log   --oneline")).toEqual(["log", "--oneline"]);
	});

	test("empty string", () => {
		expect(tokenizeCommand("")).toEqual([]);
	});

	test("only 'git'", () => {
		expect(tokenizeCommand("git")).toEqual([]);
	});

	test("tabs as whitespace", () => {
		expect(tokenizeCommand("add\t.")).toEqual(["add", "."]);
	});

	test("adjacent quoted and unquoted segments", () => {
		expect(tokenizeCommand('--author="Alice Smith"')).toEqual(["--author=Alice Smith"]);
	});
});

// ── Git.exec ────────────────────────────────────────────────────────

describe("Git.exec", () => {
	test("runs a command from a string", async () => {
		const git = createGit({ identity: { name: "Test", email: "test@test.com" } });
		const fs = new InMemoryFs();
		const result = await git.exec("git init", { fs, cwd: "/repo" });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Initialized");
	});

	test("works without 'git' prefix", async () => {
		const git = createGit({ identity: { name: "Test", email: "test@test.com" } });
		const fs = new InMemoryFs();
		const result = await git.exec("init", { fs, cwd: "/repo" });
		expect(result.exitCode).toBe(0);
	});

	test("passes env through", async () => {
		const git = createGit();
		const fs = new InMemoryFs();
		await fs.writeFile("/repo/file.txt", "hello");
		await git.exec("init", { fs, cwd: "/repo" });
		await git.exec("add .", { fs, cwd: "/repo" });
		const result = await git.exec('commit -m "test"', {
			fs,
			cwd: "/repo",
			env: TEST_ENV,
		});
		expect(result.exitCode).toBe(0);
	});

	test("handles quoted commit messages", async () => {
		const git = createGit();
		const fs = new InMemoryFs();
		await fs.writeFile("/repo/file.txt", "hello");
		await git.exec("init", { fs, cwd: "/repo" });
		await git.exec("add .", { fs, cwd: "/repo" });
		await git.exec('commit -m "my multi-word message"', {
			fs,
			cwd: "/repo",
			env: TEST_ENV,
		});
		const log = await git.exec("log --oneline", { fs, cwd: "/repo" });
		expect(log.stdout).toContain("my multi-word message");
	});

	test("defaults env to empty map when omitted", async () => {
		const git = createGit({ identity: { name: "Test", email: "test@test.com" } });
		const fs = new InMemoryFs();
		await fs.writeFile("/repo/file.txt", "hello");
		await git.exec("init", { fs, cwd: "/repo" });
		await git.exec("add .", { fs, cwd: "/repo" });
		const result = await git.exec('commit -m "test"', { fs, cwd: "/repo" });
		expect(result.exitCode).toBe(0);
	});

	test("respects disabled commands", async () => {
		const git = createGit({
			identity: { name: "Test", email: "test@test.com" },
			disabled: ["push"],
		});
		const fs = new InMemoryFs();
		await git.exec("init", { fs, cwd: "/repo" });
		const result = await git.exec("push", { fs, cwd: "/repo" });
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("not available");
	});

	test("fires hooks", async () => {
		const commands: string[] = [];
		const git = createGit({
			identity: { name: "Test", email: "test@test.com" },
			hooks: {
				afterCommand: ({ command }) => {
					commands.push(command);
				},
			},
		});
		const fs = new InMemoryFs();
		await git.exec("init", { fs, cwd: "/repo" });
		expect(commands).toContain("init");
	});
});

// ── Config overrides ────────────────────────────────────────────────

describe("config overrides", () => {
	async function setupRepo(config?: ConfigOverrides) {
		const git = createGit({
			identity: { name: "Test", email: "test@test.com" },
			config,
		});
		const fs = new InMemoryFs();
		await git.exec("init", { fs, cwd: "/repo" });
		return { git, fs };
	}

	describe("defaults", () => {
		test("getConfigValue falls back to default when key is absent", async () => {
			const { git, fs } = await setupRepo({
				defaults: { "merge.ff": "only" },
			});
			const result = await git.exec("config get merge.ff", { fs, cwd: "/repo" });
			expect(result.exitCode).toBe(0);
			expect(result.stdout.trim()).toBe("only");
		});

		test("agent can override a default via git config", async () => {
			const { git, fs } = await setupRepo({
				defaults: { "merge.ff": "only" },
			});
			await git.exec("config set merge.ff false", { fs, cwd: "/repo" });
			const result = await git.exec("config get merge.ff", { fs, cwd: "/repo" });
			expect(result.exitCode).toBe(0);
			expect(result.stdout.trim()).toBe("false");
		});

		test("default applies to command behavior (merge.ff=only blocks non-ff)", async () => {
			const { git, fs } = await setupRepo({
				defaults: { "merge.ff": "only" },
			});
			await fs.writeFile("/repo/file.txt", "base");
			await git.exec("add .", { fs, cwd: "/repo" });
			await git.exec('commit -m "base"', { fs, cwd: "/repo", env: TEST_ENV });
			await git.exec("checkout -b branch", { fs, cwd: "/repo" });
			await fs.writeFile("/repo/file.txt", "branch");
			await git.exec("add .", { fs, cwd: "/repo" });
			await git.exec('commit -m "branch"', { fs, cwd: "/repo", env: TEST_ENV });
			await git.exec("checkout main", { fs, cwd: "/repo" });
			await fs.writeFile("/repo/file.txt", "main");
			await git.exec("add .", { fs, cwd: "/repo" });
			await git.exec('commit -m "main"', { fs, cwd: "/repo", env: TEST_ENV });

			const merge = await git.exec("merge branch", { fs, cwd: "/repo", env: TEST_ENV });
			expect(merge.exitCode).not.toBe(0);
			expect(merge.stderr).toContain("Not possible to fast-forward");
		});
	});

	describe("locked", () => {
		test("locked value wins over git config", async () => {
			const { git, fs } = await setupRepo({
				locked: { "merge.ff": "only" },
			});
			await git.exec("config set merge.ff false", { fs, cwd: "/repo" });
			const result = await git.exec("config get merge.ff", { fs, cwd: "/repo" });
			expect(result.exitCode).toBe(0);
			expect(result.stdout.trim()).toBe("only");
		});

		test("locked value wins over absent config", async () => {
			const { git, fs } = await setupRepo({
				locked: { "push.default": "nothing" },
			});
			const result = await git.exec("config get push.default", { fs, cwd: "/repo" });
			expect(result.exitCode).toBe(0);
			expect(result.stdout.trim()).toBe("nothing");
		});

		test("locked value affects command behavior", async () => {
			const { git, fs } = await setupRepo({
				locked: { "merge.conflictstyle": "diff3" },
			});
			await fs.writeFile("/repo/file.txt", "base");
			await git.exec("add .", { fs, cwd: "/repo" });
			await git.exec('commit -m "base"', { fs, cwd: "/repo", env: TEST_ENV });
			await git.exec("checkout -b branch", { fs, cwd: "/repo" });
			await fs.writeFile("/repo/file.txt", "branch change");
			await git.exec("add .", { fs, cwd: "/repo" });
			await git.exec('commit -m "branch"', { fs, cwd: "/repo", env: TEST_ENV });
			await git.exec("checkout main", { fs, cwd: "/repo" });
			await fs.writeFile("/repo/file.txt", "main change");
			await git.exec("add .", { fs, cwd: "/repo" });
			await git.exec('commit -m "main"', { fs, cwd: "/repo", env: TEST_ENV });

			await git.exec("merge branch", { fs, cwd: "/repo", env: TEST_ENV });
			const content = await fs.readFile("/repo/file.txt");
			expect(content).toContain("|||||||");
		});

		test("agent git config set silently succeeds for locked key", async () => {
			const { git, fs } = await setupRepo({
				locked: { "user.name": "Locked Agent" },
			});
			const set = await git.exec('config set user.name "Other Name"', { fs, cwd: "/repo" });
			expect(set.exitCode).toBe(0);

			const get = await git.exec("config get user.name", { fs, cwd: "/repo" });
			expect(get.stdout.trim()).toBe("Locked Agent");
		});
	});

	describe("locked + defaults together", () => {
		test("locked wins, defaults fill gaps", async () => {
			const { git, fs } = await setupRepo({
				locked: { "merge.ff": "only" },
				defaults: { "push.default": "upstream" },
			});
			const ff = await git.exec("config get merge.ff", { fs, cwd: "/repo" });
			expect(ff.stdout.trim()).toBe("only");

			const pd = await git.exec("config get push.default", { fs, cwd: "/repo" });
			expect(pd.stdout.trim()).toBe("upstream");
		});
	});

	describe("no overrides", () => {
		test("works normally when config option is omitted", async () => {
			const git = createGit({ identity: { name: "Test", email: "test@test.com" } });
			const fs = new InMemoryFs();
			await git.exec("init", { fs, cwd: "/repo" });
			await git.exec("config set core.foo bar", { fs, cwd: "/repo" });
			const result = await git.exec("config get core.foo", { fs, cwd: "/repo" });
			expect(result.stdout.trim()).toBe("bar");
		});
	});
});
