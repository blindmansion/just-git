import { describe, expect, test } from "bun:test";
import { EMPTY_REPO, TEST_ENV_NAMED as TEST_ENV } from "../fixtures";
import { createTestBash, quickExec, readFile, runScenario } from "../util";

describe("git tag", () => {
	describe("outside a git repo", () => {
		test("fails with exit 128", async () => {
			const result = await quickExec("git tag", { files: EMPTY_REPO });
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("not a git repository");
		});
	});

	describe("list tags", () => {
		test("empty output when no tags", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "first"', "git tag"],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			expect(results[3].exitCode).toBe(0);
			expect(results[3].stdout).toBe("");
		});

		test("lists tags alphabetically", async () => {
			const { results } = await runScenario(
				[
					"git init",
					"git add .",
					'git commit -m "first"',
					"git tag v2.0",
					"git tag v1.0",
					"git tag",
				],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			const output = results[5].stdout;
			expect(output).toContain("v1.0");
			expect(output).toContain("v2.0");
			// v1.0 should come before v2.0
			const lines = output.trim().split("\n");
			expect(lines[0]).toBe("v1.0");
			expect(lines[1]).toBe("v2.0");
		});
	});

	describe("lightweight tag", () => {
		test("creates a tag at HEAD", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');

			const result = await bash.exec("git tag v1.0");
			expect(result.exitCode).toBe(0);

			// Verify the ref was created
			const ref = await readFile(bash.fs, "/repo/.git/refs/tags/v1.0");
			expect(ref?.trim()).toMatch(/^[a-f0-9]{40}$/);
		});

		test("points directly to the commit", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');

			await bash.exec("git tag v1.0");

			const headRef = await readFile(bash.fs, "/repo/.git/refs/heads/main");
			const tagRef = await readFile(bash.fs, "/repo/.git/refs/tags/v1.0");
			expect(tagRef?.trim()).toBe(headRef?.trim());
		});

		test("fails on empty repo", async () => {
			const { results } = await runScenario(["git init", "git tag v1.0"], {
				files: EMPTY_REPO,
				env: TEST_ENV,
			});
			expect(results[1].exitCode).toBe(128);
			expect(results[1].stderr).toContain("Failed to resolve");
		});

		test("fails when tag already exists", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "first"', "git tag v1.0", "git tag v1.0"],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			expect(results[4].exitCode).toBe(128);
			expect(results[4].stderr).toContain("already exists");
		});
	});

	describe("annotated tag", () => {
		test("creates an annotated tag with -a -m", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');

			const result = await bash.exec('git tag -a v1.0 -m "Release 1.0"');
			expect(result.exitCode).toBe(0);

			// Verify the ref was created
			const ref = await readFile(bash.fs, "/repo/.git/refs/tags/v1.0");
			expect(ref?.trim()).toMatch(/^[a-f0-9]{40}$/);

			// Annotated tag ref should NOT point directly to the commit
			// (it points to the tag object instead)
			const headRef = await readFile(bash.fs, "/repo/.git/refs/heads/main");
			expect(ref?.trim()).not.toBe(headRef?.trim());
		});

		test("creates with -m alone (implies annotated)", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');

			const result = await bash.exec('git tag v1.0 -m "Release 1.0"');
			expect(result.exitCode).toBe(0);

			// Should be annotated (ref != commit hash)
			const headRef = await readFile(bash.fs, "/repo/.git/refs/heads/main");
			const tagRef = await readFile(bash.fs, "/repo/.git/refs/tags/v1.0");
			expect(tagRef?.trim()).not.toBe(headRef?.trim());
		});

		test("fails when -a is given without -m", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "first"', "git tag -a v1.0"],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			expect(results[3].exitCode).toBe(128);
			expect(results[3].stderr).toContain("no tag message");
		});
	});

	describe("tag at specific commit", () => {
		test("creates a tag at a specific commit hash", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');
			const firstHash = (await readFile(bash.fs, "/repo/.git/refs/heads/main"))?.trim();

			bash.fs.writeFile("/repo/README.md", "updated");
			await bash.exec("git add .");
			await bash.exec('git commit -m "second"');

			const result = await bash.exec(`git tag v1.0 ${firstHash}`);
			expect(result.exitCode).toBe(0);

			const tagRef = await readFile(bash.fs, "/repo/.git/refs/tags/v1.0");
			expect(tagRef?.trim()).toBe(firstHash);
		});

		test("creates an annotated tag at a specific commit", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');

			bash.fs.writeFile("/repo/README.md", "updated");
			await bash.exec("git add .");
			await bash.exec('git commit -m "second"');

			const firstHash = (await bash.exec("git log --format=%H -n 1 HEAD~1")).stdout.trim();
			const result = await bash.exec(`git tag -m "old release" v1.0 ${firstHash}`);
			expect(result.exitCode).toBe(0);
		});

		test("fails when commit does not exist", async () => {
			const { results } = await runScenario(
				[
					"git init",
					"git add .",
					'git commit -m "first"',
					"git tag v1.0 deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
				],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			expect(results[3].exitCode).toBe(128);
			expect(results[3].stderr).toContain("Failed to resolve");
		});

		test("tags a branch name as commit ref", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');
			await bash.exec("git checkout -b feature");
			bash.fs.writeFile("/repo/README.md", "feature work");
			await bash.exec("git add .");
			await bash.exec('git commit -m "feature commit"');
			await bash.exec("git checkout main");

			const result = await bash.exec("git tag v1.0 feature");
			expect(result.exitCode).toBe(0);

			const featureHash = (await readFile(bash.fs, "/repo/.git/refs/heads/feature"))?.trim();
			const tagRef = await readFile(bash.fs, "/repo/.git/refs/tags/v1.0");
			expect(tagRef?.trim()).toBe(featureHash);
		});
	});

	describe("force tag (-f)", () => {
		test("overwrites an existing tag", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');
			await bash.exec("git tag v1.0");

			bash.fs.writeFile("/repo/README.md", "updated");
			await bash.exec("git add .");
			await bash.exec('git commit -m "second"');

			const result = await bash.exec("git tag -f v1.0");
			expect(result.exitCode).toBe(0);

			const headRef = await readFile(bash.fs, "/repo/.git/refs/heads/main");
			const tagRef = await readFile(bash.fs, "/repo/.git/refs/tags/v1.0");
			expect(tagRef?.trim()).toBe(headRef?.trim());
		});

		test("overwrites without -f fails", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "first"', "git tag v1.0", "git tag v1.0"],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			expect(results[4].exitCode).toBe(128);
			expect(results[4].stderr).toContain("already exists");
		});
	});

	describe("list with pattern (-l)", () => {
		test("filters tags by glob pattern", async () => {
			const { results } = await runScenario(
				[
					"git init",
					"git add .",
					'git commit -m "first"',
					"git tag v1.0",
					"git tag v2.0",
					"git tag release-1",
					"git tag -l v*",
				],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			const output = results[6].stdout;
			expect(output).toContain("v1.0");
			expect(output).toContain("v2.0");
			expect(output).not.toContain("release-1");
		});

		test("returns empty when no tags match", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "first"', "git tag v1.0", "git tag -l nope*"],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			expect(results[4].exitCode).toBe(0);
			expect(results[4].stdout).toBe("");
		});

		test("matches exact tag name", async () => {
			const { results } = await runScenario(
				[
					"git init",
					"git add .",
					'git commit -m "first"',
					"git tag v1.0",
					"git tag v2.0",
					"git tag -l v1.0",
				],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			const output = results[5].stdout;
			expect(output).toBe("v1.0\n");
		});
	});

	describe("delete tag", () => {
		test("deletes a lightweight tag", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');
			await bash.exec("git tag v1.0");

			const result = await bash.exec("git tag -d v1.0");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Deleted tag 'v1.0'");

			const ref = await readFile(bash.fs, "/repo/.git/refs/tags/v1.0");
			expect(ref).toBeUndefined();
		});

		test("deletes an annotated tag", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');
			await bash.exec('git tag -a v1.0 -m "Release"');

			const result = await bash.exec("git tag -d v1.0");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Deleted tag 'v1.0'");
		});

		test("shows the short hash in deletion message", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');
			await bash.exec("git tag v1.0");

			const result = await bash.exec("git tag -d v1.0");
			expect(result.stdout).toMatch(/was [a-f0-9]{7}/);
		});

		test("fails when tag does not exist", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "first"', "git tag -d nonexistent"],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			expect(results[3].exitCode).toBe(1);
			expect(results[3].stderr).toContain("not found");
		});

		test("fails when no tag name given", async () => {
			const { results } = await runScenario(["git init", "git tag -d"], {
				files: EMPTY_REPO,
				env: TEST_ENV,
			});
			expect(results[1].exitCode).toBe(128);
			expect(results[1].stderr).toContain("tag name required");
		});
	});
});
