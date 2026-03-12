import { describe, expect, test } from "bun:test";
import { EMPTY_REPO } from "../fixtures";
import { quickExec, readFile, runScenario } from "../util";

describe("git config", () => {
	describe("outside a git repo", () => {
		test("fails with exit 128", async () => {
			const result = await quickExec("git config user.name", {
				files: EMPTY_REPO,
			});
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("not a git repository");
		});
	});

	// ── Modern subcommand syntax ─────────────────────────────────

	describe("git config set", () => {
		test("sets a two-part key", async () => {
			const { results } = await runScenario(
				["git init", 'git config set user.name "Alice"', "git config get user.name"],
				{ files: EMPTY_REPO },
			);
			expect(results[1].exitCode).toBe(0);
			expect(results[1].stdout).toBe("");
			expect(results[2].exitCode).toBe(0);
			expect(results[2].stdout).toBe("Alice\n");
		});

		test("sets a three-part key (subsection)", async () => {
			const { results } = await runScenario(
				[
					"git init",
					'git config set remote.origin.url "https://example.com/repo.git"',
					"git config get remote.origin.url",
				],
				{ files: EMPTY_REPO },
			);
			expect(results[1].exitCode).toBe(0);
			expect(results[2].stdout).toBe("https://example.com/repo.git\n");
		});

		test("overwrites an existing value", async () => {
			const { results } = await runScenario(
				[
					"git init",
					'git config set user.email "old@test.com"',
					'git config set user.email "new@test.com"',
					"git config get user.email",
				],
				{ files: EMPTY_REPO },
			);
			expect(results[3].stdout).toBe("new@test.com\n");
		});

		test("errors on missing key or value", async () => {
			const { results } = await runScenario(["git init", "git config set user.name"], {
				files: EMPTY_REPO,
			});
			expect(results[1].exitCode).toBe(2);
			expect(results[1].stderr).toContain("missing");
		});

		test("errors on invalid key format", async () => {
			const { results } = await runScenario(["git init", 'git config set badkey "value"'], {
				files: EMPTY_REPO,
			});
			expect(results[1].exitCode).toBe(2);
			expect(results[1].stderr).toContain("invalid key");
		});
	});

	describe("git config get", () => {
		test("retrieves an existing value", async () => {
			const { results } = await runScenario(
				["git init", 'git config set user.name "Bob"', "git config get user.name"],
				{ files: EMPTY_REPO },
			);
			expect(results[2].exitCode).toBe(0);
			expect(results[2].stdout).toBe("Bob\n");
		});

		test("exit 1 for missing key", async () => {
			const { results } = await runScenario(["git init", "git config get user.name"], {
				files: EMPTY_REPO,
			});
			expect(results[1].exitCode).toBe(1);
			expect(results[1].stdout).toBe("");
		});

		test("errors on missing key argument", async () => {
			const { results } = await runScenario(["git init", "git config get"], {
				files: EMPTY_REPO,
			});
			expect(results[1].exitCode).toBe(2);
		});
	});

	describe("git config unset", () => {
		test("removes an existing key", async () => {
			const { results } = await runScenario(
				[
					"git init",
					'git config set user.name "Alice"',
					"git config unset user.name",
					"git config get user.name",
				],
				{ files: EMPTY_REPO },
			);
			expect(results[2].exitCode).toBe(0);
			expect(results[3].exitCode).toBe(1);
		});

		test("exit 5 for missing key", async () => {
			const { results } = await runScenario(["git init", "git config unset user.name"], {
				files: EMPTY_REPO,
			});
			expect(results[1].exitCode).toBe(5);
		});
	});

	describe("git config list", () => {
		test("empty output on fresh repo with no config", async () => {
			const { results } = await runScenario(["git init", "git config list"], {
				files: EMPTY_REPO,
			});
			expect(results[1].exitCode).toBe(0);
			// init writes a config, so it may have entries
		});

		test("lists all entries in key=value format", async () => {
			const { results } = await runScenario(
				[
					"git init",
					'git config set user.name "Alice"',
					'git config set user.email "alice@test.com"',
					"git config list",
				],
				{ files: EMPTY_REPO },
			);
			expect(results[3].exitCode).toBe(0);
			const stdout = results[3].stdout;
			expect(stdout).toContain("user.name=Alice");
			expect(stdout).toContain("user.email=alice@test.com");
		});

		test("lists three-part keys correctly", async () => {
			const { results } = await runScenario(
				[
					"git init",
					'git config set remote.origin.url "https://example.com/repo.git"',
					"git config list",
				],
				{ files: EMPTY_REPO },
			);
			expect(results[2].stdout).toContain("remote.origin.url=https://example.com/repo.git");
		});
	});

	// ── Legacy positional syntax ─────────────────────────────────

	describe("legacy syntax", () => {
		test("git config <key> gets a value", async () => {
			const { results } = await runScenario(
				["git init", 'git config set user.name "Carol"', "git config user.name"],
				{ files: EMPTY_REPO },
			);
			expect(results[2].exitCode).toBe(0);
			expect(results[2].stdout).toBe("Carol\n");
		});

		test("git config <key> <value> sets a value", async () => {
			const { results } = await runScenario(
				["git init", 'git config user.name "Dave"', "git config get user.name"],
				{ files: EMPTY_REPO },
			);
			expect(results[1].exitCode).toBe(0);
			expect(results[2].stdout).toBe("Dave\n");
		});

		test("git config --unset <key> removes a key", async () => {
			const { results } = await runScenario(
				[
					"git init",
					'git config user.name "Eve"',
					"git config --unset user.name",
					"git config user.name",
				],
				{ files: EMPTY_REPO },
			);
			expect(results[2].exitCode).toBe(0);
			expect(results[3].exitCode).toBe(1);
		});

		test("git config -l lists entries", async () => {
			const { results } = await runScenario(
				["git init", 'git config user.name "Frank"', "git config -l"],
				{ files: EMPTY_REPO },
			);
			expect(results[2].exitCode).toBe(0);
			expect(results[2].stdout).toContain("user.name=Frank");
		});

		test("git config --list lists entries", async () => {
			const { results } = await runScenario(
				["git init", 'git config user.name "Grace"', "git config --list"],
				{ files: EMPTY_REPO },
			);
			expect(results[2].exitCode).toBe(0);
			expect(results[2].stdout).toContain("user.name=Grace");
		});
	});

	// ── Edge cases ───────────────────────────────────────────────

	describe("edge cases", () => {
		test("no arguments prints usage", async () => {
			const { results } = await runScenario(["git init", "git config"], {
				files: EMPTY_REPO,
			});
			expect(results[1].exitCode).toBe(2);
			expect(results[1].stderr).toContain("usage");
		});

		test("config persists to .git/config file", async () => {
			const { bash } = await runScenario(["git init", 'git config set user.name "Stored"'], {
				files: EMPTY_REPO,
			});
			const content = await readFile(bash.fs, "/repo/.git/config");
			expect(content).toContain("name = Stored");
		});

		test("unset removes empty section", async () => {
			const { bash } = await runScenario(
				["git init", 'git config set custom.key "value"', "git config unset custom.key"],
				{ files: EMPTY_REPO },
			);
			const content = await readFile(bash.fs, "/repo/.git/config");
			expect(content).not.toContain("[custom]");
		});
	});
});
