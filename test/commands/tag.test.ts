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
			expect(result.stdout).toContain("Updated tag 'v1.0' (was ");

			const headRef = await readFile(bash.fs, "/repo/.git/refs/heads/main");
			const tagRef = await readFile(bash.fs, "/repo/.git/refs/tags/v1.0");
			expect(tagRef?.trim()).toBe(headRef?.trim());
		});

		test("stays silent when force-updating to the same target", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');

			const headRef = (await readFile(bash.fs, "/repo/.git/refs/heads/main"))?.trim();
			await bash.exec("git tag v1.0");

			const result = await bash.exec(`git tag -f v1.0 ${headRef}`);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toBe("");
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
		test("-l with no pattern lists all tags", async () => {
			const { results } = await runScenario(
				[
					"git init",
					"git add .",
					'git commit -m "first"',
					"git tag v1.0",
					"git tag v2.0",
					"git tag alpha",
					"git tag -l",
				],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			const output = results[6].stdout;
			expect(results[6].exitCode).toBe(0);
			expect(output).toBe("alpha\nv1.0\nv2.0\n");
		});

		test("--list with no pattern lists all tags", async () => {
			const { results } = await runScenario(
				[
					"git init",
					"git add .",
					'git commit -m "first"',
					"git tag v1.0",
					"git tag v2.0",
					"git tag alpha",
					"git tag --list",
				],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			const output = results[6].stdout;
			expect(results[6].exitCode).toBe(0);
			expect(output).toBe("alpha\nv1.0\nv2.0\n");
		});

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

	describe("--sort", () => {
		const env1 = { ...TEST_ENV, GIT_AUTHOR_DATE: "1000000001", GIT_COMMITTER_DATE: "1000000001" };
		const env2 = { ...TEST_ENV, GIT_AUTHOR_DATE: "1000000002", GIT_COMMITTER_DATE: "1000000002" };
		const env3 = { ...TEST_ENV, GIT_AUTHOR_DATE: "1000000003", GIT_COMMITTER_DATE: "1000000003" };

		test("--sort=creatordate sorts lightweight tags by commit date", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: env1 });
			await bash.exec("git init && git add . && git commit -m 'first'");
			await bash.exec("echo two > /repo/two.txt && git add . && git commit -m 'second'", {
				env: env2,
			});
			await bash.exec("echo three > /repo/three.txt && git add . && git commit -m 'third'", {
				env: env3,
			});
			const c1 = (await bash.exec("git rev-parse HEAD~2")).stdout.trim();
			const c3 = (await bash.exec("git rev-parse HEAD")).stdout.trim();
			const c2 = (await bash.exec("git rev-parse HEAD~1")).stdout.trim();
			await bash.exec(`git tag beta ${c2}`);
			await bash.exec(`git tag alpha ${c3}`);
			await bash.exec(`git tag gamma ${c1}`);

			const result = await bash.exec("git tag --sort=creatordate");
			expect(result.exitCode).toBe(0);
			const lines = result.stdout.trim().split("\n");
			expect(lines).toEqual(["gamma", "beta", "alpha"]);
		});

		test("--sort=-creatordate sorts newest first", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: env1 });
			await bash.exec("git init && git add . && git commit -m 'first'");
			await bash.exec("echo two > /repo/two.txt && git add . && git commit -m 'second'", {
				env: env2,
			});
			await bash.exec(`git tag old HEAD~1`);
			await bash.exec(`git tag new HEAD`);

			const result = await bash.exec("git tag --sort=-creatordate");
			expect(result.exitCode).toBe(0);
			const lines = result.stdout.trim().split("\n");
			expect(lines).toEqual(["new", "old"]);
		});

		test("--sort=creatordate uses tagger date for annotated tags", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: env1 });
			await bash.exec("git init && git add . && git commit -m 'first'");
			const env10 = { ...TEST_ENV, GIT_COMMITTER_DATE: "1000000010" };
			const env20 = { ...TEST_ENV, GIT_COMMITTER_DATE: "1000000020" };
			await bash.exec("git tag -a early-ann -m 'annotated early'", { env: env10 });
			await bash.exec("git tag -a late-ann -m 'annotated late'", { env: env20 });

			const result = await bash.exec("git tag --sort=creatordate");
			expect(result.exitCode).toBe(0);
			const lines = result.stdout.trim().split("\n");
			expect(lines).toEqual(["early-ann", "late-ann"]);
		});

		test("--sort=version:refname sorts by semantic version", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init && git add . && git commit -m 'first'");
			await bash.exec("git tag v1.10.0");
			await bash.exec("git tag v1.2.0");
			await bash.exec("git tag v2.0.0");
			await bash.exec("git tag v1.2.1");

			const result = await bash.exec("git tag --sort=version:refname");
			expect(result.exitCode).toBe(0);
			const lines = result.stdout.trim().split("\n");
			expect(lines).toEqual(["v1.2.0", "v1.2.1", "v1.10.0", "v2.0.0"]);
		});

		test("--sort=-version:refname reverses version sort", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init && git add . && git commit -m 'first'");
			await bash.exec("git tag v1.0");
			await bash.exec("git tag v2.0");
			await bash.exec("git tag v3.0");

			const result = await bash.exec("git tag --sort=-version:refname");
			expect(result.exitCode).toBe(0);
			const lines = result.stdout.trim().split("\n");
			expect(lines).toEqual(["v3.0", "v2.0", "v1.0"]);
		});

		test("--sort=refname sorts alphabetically (default behavior)", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init && git add . && git commit -m 'first'");
			await bash.exec("git tag charlie");
			await bash.exec("git tag alpha");
			await bash.exec("git tag bravo");

			const result = await bash.exec("git tag --sort=refname");
			expect(result.exitCode).toBe(0);
			const lines = result.stdout.trim().split("\n");
			expect(lines).toEqual(["alpha", "bravo", "charlie"]);
		});

		test("--sort=-refname reverses alphabetical order", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init && git add . && git commit -m 'first'");
			await bash.exec("git tag alpha");
			await bash.exec("git tag bravo");

			const result = await bash.exec("git tag --sort=-refname");
			expect(result.exitCode).toBe(0);
			const lines = result.stdout.trim().split("\n");
			expect(lines).toEqual(["bravo", "alpha"]);
		});

		test("--sort works with -l pattern", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: env1 });
			await bash.exec("git init && git add . && git commit -m 'first'");
			await bash.exec("echo two > /repo/two.txt && git add . && git commit -m 'second'", {
				env: env2,
			});
			await bash.exec("git tag release-2 HEAD~1");
			await bash.exec("git tag release-1 HEAD");
			await bash.exec("git tag other HEAD~1");

			const result = await bash.exec("git tag -l 'release-*' --sort=creatordate");
			expect(result.exitCode).toBe(0);
			const lines = result.stdout.trim().split("\n");
			expect(lines).toEqual(["release-2", "release-1"]);
		});
	});
});
