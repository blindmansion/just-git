import { describe, expect, test } from "bun:test";
import { EMPTY_REPO } from "../fixtures";
import { createTestBash, quickExec, readFile, runScenario } from "../util";

describe("git remote", () => {
	describe("outside a git repo", () => {
		test("fails with exit 128", async () => {
			const result = await quickExec("git remote", {
				files: EMPTY_REPO,
			});
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("not a git repository");
		});
	});

	describe("list remotes", () => {
		test("empty output when no remotes configured", async () => {
			const { results } = await runScenario(["git init", "git remote"], {
				files: EMPTY_REPO,
			});
			expect(results[1].exitCode).toBe(0);
			expect(results[1].stdout).toBe("");
		});

		test("lists remote names", async () => {
			const { results } = await runScenario(
				["git init", "git remote add origin https://example.com/repo.git", "git remote"],
				{ files: EMPTY_REPO },
			);
			expect(results[2].exitCode).toBe(0);
			expect(results[2].stdout).toBe("origin\n");
		});

		test("lists multiple remotes sorted alphabetically", async () => {
			const { results } = await runScenario(
				[
					"git init",
					"git remote add upstream https://example.com/upstream.git",
					"git remote add origin https://example.com/origin.git",
					"git remote",
				],
				{ files: EMPTY_REPO },
			);
			expect(results[3].exitCode).toBe(0);
			const lines = results[3].stdout.trim().split("\n");
			expect(lines).toEqual(["origin", "upstream"]);
		});
	});

	describe("verbose list (-v)", () => {
		test("shows fetch and push URLs", async () => {
			const { results } = await runScenario(
				["git init", "git remote add origin https://example.com/repo.git", "git remote -v"],
				{ files: EMPTY_REPO },
			);
			expect(results[2].exitCode).toBe(0);
			const output = results[2].stdout;
			expect(output).toContain("origin\thttps://example.com/repo.git (fetch)");
			expect(output).toContain("origin\thttps://example.com/repo.git (push)");
		});

		test("shows multiple remotes with URLs", async () => {
			const { results } = await runScenario(
				[
					"git init",
					"git remote add origin https://example.com/origin.git",
					"git remote add upstream https://example.com/upstream.git",
					"git remote -v",
				],
				{ files: EMPTY_REPO },
			);
			const output = results[3].stdout;
			expect(output).toContain("origin\thttps://example.com/origin.git (fetch)");
			expect(output).toContain("origin\thttps://example.com/origin.git (push)");
			expect(output).toContain("upstream\thttps://example.com/upstream.git (fetch)");
			expect(output).toContain("upstream\thttps://example.com/upstream.git (push)");
		});

		test("empty output when no remotes with -v", async () => {
			const { results } = await runScenario(["git init", "git remote -v"], {
				files: EMPTY_REPO,
			});
			expect(results[1].exitCode).toBe(0);
			expect(results[1].stdout).toBe("");
		});
	});

	describe("add remote", () => {
		test("adds a remote to config", async () => {
			const bash = createTestBash({ files: EMPTY_REPO });
			await bash.exec("git init");

			const result = await bash.exec("git remote add origin https://example.com/repo.git");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toBe("");
			expect(result.stderr).toBe("");

			// Verify the config was written
			const config = await readFile(bash.fs, "/repo/.git/config");
			expect(config).toContain('[remote "origin"]');
			expect(config).toContain("url = https://example.com/repo.git");
			expect(config).toContain("fetch = +refs/heads/*:refs/remotes/origin/*");
		});

		test("fails when remote already exists", async () => {
			const { results } = await runScenario(
				[
					"git init",
					"git remote add origin https://example.com/repo.git",
					"git remote add origin https://example.com/other.git",
				],
				{ files: EMPTY_REPO },
			);
			expect(results[2].exitCode).toBe(3);
			expect(results[2].stderr).toContain("error: remote origin already exists.");
		});

		test("fails when name is missing", async () => {
			const { results } = await runScenario(["git init", "git remote add"], {
				files: EMPTY_REPO,
			});
			expect(results[1].exitCode).toBe(1);
			expect(results[1].stderr).toContain("Missing required argument");
		});

		test("fails when url is missing", async () => {
			const { results } = await runScenario(["git init", "git remote add origin"], {
				files: EMPTY_REPO,
			});
			expect(results[1].exitCode).toBe(1);
			expect(results[1].stderr).toContain("Missing required argument");
		});

		test("can add multiple remotes", async () => {
			const { results } = await runScenario(
				[
					"git init",
					"git remote add origin https://example.com/origin.git",
					"git remote add upstream https://example.com/upstream.git",
					"git remote",
				],
				{ files: EMPTY_REPO },
			);
			expect(results[1].exitCode).toBe(0);
			expect(results[2].exitCode).toBe(0);
			const lines = results[3].stdout.trim().split("\n");
			expect(lines).toContain("origin");
			expect(lines).toContain("upstream");
		});
	});

	describe("remove remote", () => {
		test("removes a remote from config", async () => {
			const bash = createTestBash({ files: EMPTY_REPO });
			await bash.exec("git init");
			await bash.exec("git remote add origin https://example.com/repo.git");

			const result = await bash.exec("git remote remove origin");
			expect(result.exitCode).toBe(0);

			// Verify the remote is gone
			const listResult = await bash.exec("git remote");
			expect(listResult.stdout).toBe("");

			// Verify config no longer has the remote section
			const config = await readFile(bash.fs, "/repo/.git/config");
			expect(config).not.toContain('[remote "origin"]');
		});

		test("rm is an alias for remove", async () => {
			const bash = createTestBash({ files: EMPTY_REPO });
			await bash.exec("git init");
			await bash.exec("git remote add origin https://example.com/repo.git");

			const result = await bash.exec("git remote rm origin");
			expect(result.exitCode).toBe(0);

			const listResult = await bash.exec("git remote");
			expect(listResult.stdout).toBe("");
		});

		test("fails when remote does not exist", async () => {
			const { results } = await runScenario(["git init", "git remote remove nonexistent"], {
				files: EMPTY_REPO,
			});
			expect(results[1].exitCode).toBe(2);
			expect(results[1].stderr).toContain("No such remote");
		});

		test("fails when name is missing", async () => {
			const { results } = await runScenario(["git init", "git remote remove"], {
				files: EMPTY_REPO,
			});
			expect(results[1].exitCode).toBe(1);
			expect(results[1].stderr).toContain("Missing required argument");
		});

		test("removing one remote does not affect others", async () => {
			const bash = createTestBash({ files: EMPTY_REPO });
			await bash.exec("git init");
			await bash.exec("git remote add origin https://example.com/origin.git");
			await bash.exec("git remote add upstream https://example.com/upstream.git");

			await bash.exec("git remote remove origin");

			const result = await bash.exec("git remote");
			expect(result.stdout).toBe("upstream\n");

			const verboseResult = await bash.exec("git remote -v");
			expect(verboseResult.stdout).toContain("upstream");
			expect(verboseResult.stdout).not.toContain("origin");
		});
	});

	describe("remove remote cleanup", () => {
		test("cleans up remote tracking refs", async () => {
			const bash = createTestBash({
				files: EMPTY_REPO,
				env: {
					GIT_AUTHOR_NAME: "Test",
					GIT_AUTHOR_EMAIL: "test@test.com",
					GIT_COMMITTER_NAME: "Test",
					GIT_COMMITTER_EMAIL: "test@test.com",
					GIT_AUTHOR_DATE: "1000000000",
					GIT_COMMITTER_DATE: "1000000000",
				},
			});
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');
			await bash.exec("git remote add origin https://example.com/repo.git");

			// Manually create a tracking ref (simulating fetch)
			await bash.fs.mkdir("/repo/.git/refs/remotes/origin", {
				recursive: true,
			});
			const head = await readFile(bash.fs, "/repo/.git/refs/heads/main");
			await bash.fs.writeFile("/repo/.git/refs/remotes/origin/main", head ?? "");

			const result = await bash.exec("git remote remove origin");
			expect(result.exitCode).toBe(0);

			// Tracking ref should be gone
			const exists = await bash.fs.exists("/repo/.git/refs/remotes/origin/main");
			expect(exists).toBe(false);
		});

		test("cleans up branch tracking config", async () => {
			const bash = createTestBash({ files: EMPTY_REPO });
			await bash.exec("git init");
			await bash.exec("git remote add origin https://example.com/repo.git");
			await bash.exec("git config branch.main.remote origin");
			await bash.exec("git config branch.main.merge refs/heads/main");

			const result = await bash.exec("git remote remove origin");
			expect(result.exitCode).toBe(0);

			// Branch tracking config should be cleaned up
			const config = await readFile(bash.fs, "/repo/.git/config");
			expect(config).not.toContain('[branch "main"]');
			expect(config).not.toContain("branch.main.remote");
		});

		test("preserves branch config for other remotes", async () => {
			const bash = createTestBash({ files: EMPTY_REPO });
			await bash.exec("git init");
			await bash.exec("git remote add origin https://example.com/origin.git");
			await bash.exec("git remote add upstream https://example.com/upstream.git");
			await bash.exec("git config branch.main.remote upstream");
			await bash.exec("git config branch.main.merge refs/heads/main");

			await bash.exec("git remote remove origin");

			// Branch tracking for upstream should remain
			const remoteVal = await bash.exec("git config branch.main.remote");
			expect(remoteVal.stdout.trim()).toBe("upstream");
		});
	});

	describe("rename remote", () => {
		test("renames a remote", async () => {
			const bash = createTestBash({ files: EMPTY_REPO });
			await bash.exec("git init");
			await bash.exec("git remote add origin https://example.com/repo.git");

			const result = await bash.exec("git remote rename origin upstream");
			expect(result.exitCode).toBe(0);

			const list = await bash.exec("git remote");
			expect(list.stdout).toBe("upstream\n");

			const config = await readFile(bash.fs, "/repo/.git/config");
			expect(config).not.toContain('[remote "origin"]');
			expect(config).toContain('[remote "upstream"]');
			expect(config).toContain("url = https://example.com/repo.git");
		});

		test("updates fetch refspec", async () => {
			const bash = createTestBash({ files: EMPTY_REPO });
			await bash.exec("git init");
			await bash.exec("git remote add origin https://example.com/repo.git");

			await bash.exec("git remote rename origin upstream");

			const config = await readFile(bash.fs, "/repo/.git/config");
			expect(config).toContain("fetch = +refs/heads/*:refs/remotes/upstream/*");
			expect(config).not.toContain("refs/remotes/origin/");
		});

		test("moves tracking refs", async () => {
			const bash = createTestBash({
				files: EMPTY_REPO,
				env: {
					GIT_AUTHOR_NAME: "Test",
					GIT_AUTHOR_EMAIL: "test@test.com",
					GIT_COMMITTER_NAME: "Test",
					GIT_COMMITTER_EMAIL: "test@test.com",
					GIT_AUTHOR_DATE: "1000000000",
					GIT_COMMITTER_DATE: "1000000000",
				},
			});
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');
			await bash.exec("git remote add origin https://example.com/repo.git");

			// Simulate a tracking ref
			await bash.fs.mkdir("/repo/.git/refs/remotes/origin", {
				recursive: true,
			});
			const head = await readFile(bash.fs, "/repo/.git/refs/heads/main");
			await bash.fs.writeFile("/repo/.git/refs/remotes/origin/main", head ?? "");

			await bash.exec("git remote rename origin upstream");

			const oldExists = await bash.fs.exists("/repo/.git/refs/remotes/origin/main");
			expect(oldExists).toBe(false);

			const newRef = await readFile(bash.fs, "/repo/.git/refs/remotes/upstream/main");
			expect(newRef?.trim()).toBe(head?.trim());
		});

		test("updates branch tracking config", async () => {
			const bash = createTestBash({ files: EMPTY_REPO });
			await bash.exec("git init");
			await bash.exec("git remote add origin https://example.com/repo.git");
			await bash.exec("git config branch.main.remote origin");
			await bash.exec("git config branch.main.merge refs/heads/main");

			await bash.exec("git remote rename origin upstream");

			const remote = await bash.exec("git config branch.main.remote");
			expect(remote.stdout.trim()).toBe("upstream");
		});

		test("fails when old remote does not exist", async () => {
			const { results } = await runScenario(["git init", "git remote rename nonexistent newname"], {
				files: EMPTY_REPO,
			});
			expect(results[1].exitCode).toBe(2);
			expect(results[1].stderr).toContain("No such remote");
		});

		test("fails when new name already exists", async () => {
			const { results } = await runScenario(
				[
					"git init",
					"git remote add origin https://example.com/origin.git",
					"git remote add upstream https://example.com/upstream.git",
					"git remote rename origin upstream",
				],
				{ files: EMPTY_REPO },
			);
			expect(results[3].exitCode).toBe(128);
			expect(results[3].stderr).toContain("already exists");
		});

		test("fails when arguments are missing", async () => {
			const { results } = await runScenario(["git init", "git remote rename"], {
				files: EMPTY_REPO,
			});
			expect(results[1].exitCode).toBe(1);
			expect(results[1].stderr).toContain("Missing required argument");
		});
	});

	describe("set-url", () => {
		test("updates the URL of a remote", async () => {
			const bash = createTestBash({ files: EMPTY_REPO });
			await bash.exec("git init");
			await bash.exec("git remote add origin https://example.com/old.git");

			const result = await bash.exec("git remote set-url origin https://example.com/new.git");
			expect(result.exitCode).toBe(0);

			const verbose = await bash.exec("git remote -v");
			expect(verbose.stdout).toContain("https://example.com/new.git");
			expect(verbose.stdout).not.toContain("https://example.com/old.git");
		});

		test("fails when remote does not exist", async () => {
			const { results } = await runScenario(
				["git init", "git remote set-url nonexistent https://example.com/x.git"],
				{ files: EMPTY_REPO },
			);
			expect(results[1].exitCode).toBe(2);
			expect(results[1].stderr).toContain("No such remote");
		});

		test("fails when arguments are missing", async () => {
			const { results } = await runScenario(["git init", "git remote set-url"], {
				files: EMPTY_REPO,
			});
			expect(results[1].exitCode).toBe(1);
			expect(results[1].stderr).toContain("Missing required argument");
		});
	});

	describe("get-url", () => {
		test("prints the URL of a remote", async () => {
			const { results } = await runScenario(
				[
					"git init",
					"git remote add origin https://example.com/repo.git",
					"git remote get-url origin",
				],
				{ files: EMPTY_REPO },
			);
			expect(results[2].exitCode).toBe(0);
			expect(results[2].stdout).toBe("https://example.com/repo.git\n");
		});

		test("reflects set-url changes", async () => {
			const bash = createTestBash({ files: EMPTY_REPO });
			await bash.exec("git init");
			await bash.exec("git remote add origin https://example.com/old.git");
			await bash.exec("git remote set-url origin https://example.com/new.git");

			const result = await bash.exec("git remote get-url origin");
			expect(result.stdout).toBe("https://example.com/new.git\n");
		});

		test("fails when remote does not exist", async () => {
			const { results } = await runScenario(["git init", "git remote get-url nonexistent"], {
				files: EMPTY_REPO,
			});
			expect(results[1].exitCode).toBe(2);
			expect(results[1].stderr).toContain("No such remote");
		});

		test("fails when name is missing", async () => {
			const { results } = await runScenario(["git init", "git remote get-url"], {
				files: EMPTY_REPO,
			});
			expect(results[1].exitCode).toBe(1);
			expect(results[1].stderr).toContain("Missing required argument");
		});
	});

	describe("unknown subcommand", () => {
		test("errors on unknown action", async () => {
			const { results } = await runScenario(["git init", "git remote frobnicate"], {
				files: EMPTY_REPO,
			});
			expect(results[1].exitCode).toBe(1);
			expect(results[1].stderr).toContain("Unexpected argument");
		});
	});
});
