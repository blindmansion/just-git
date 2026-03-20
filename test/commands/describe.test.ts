import { describe, expect, test } from "bun:test";
import { EMPTY_REPO, envAt, TEST_ENV } from "../fixtures";
import { createTestBash, quickExec, runScenario } from "../util";

describe("git describe", () => {
	describe("basic", () => {
		test("describes HEAD relative to an annotated tag", async () => {
			const { results } = await runScenario(
				[
					"git init",
					"git add .",
					'git commit -m "initial"',
					'git tag -a v1.0.0 -m "release 1"',
					'git commit --allow-empty -m "second"',
					'git commit --allow-empty -m "third"',
					"git describe",
				],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			const out = results[6]!.stdout.trim();
			expect(out).toMatch(/^v1\.0\.0-2-g[0-9a-f]{7}$/);
			expect(results[6]!.exitCode).toBe(0);
		});

		test("on exact annotated tag outputs just the tag name", async () => {
			const { results } = await runScenario(
				[
					"git init",
					"git add .",
					'git commit -m "initial"',
					'git tag -a v1.0.0 -m "release 1"',
					"git describe",
				],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			expect(results[4]!.stdout.trim()).toBe("v1.0.0");
		});

		test("describes a specific committish", async () => {
			const { results } = await runScenario(
				[
					"git init",
					"git add .",
					'git commit -m "initial"',
					'git tag -a v1.0.0 -m "release 1"',
					'git commit --allow-empty -m "second"',
					'git commit --allow-empty -m "third"',
					"git describe HEAD~1",
				],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			const out = results[6]!.stdout.trim();
			expect(out).toMatch(/^v1\.0\.0-1-g[0-9a-f]{7}$/);
		});
	});

	describe("--long", () => {
		test("always outputs long format even on exact tag", async () => {
			const { results } = await runScenario(
				[
					"git init",
					"git add .",
					'git commit -m "initial"',
					'git tag -a v1.0.0 -m "release 1"',
					"git describe --long",
				],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			const out = results[4]!.stdout.trim();
			expect(out).toMatch(/^v1\.0\.0-0-g[0-9a-f]{7}$/);
		});
	});

	describe("--tags", () => {
		test("finds lightweight tags when --tags is specified", async () => {
			const { results } = await runScenario(
				[
					"git init",
					"git add .",
					'git commit -m "initial"',
					"git tag v1.0.0",
					'git commit --allow-empty -m "second"',
					"git describe --tags",
				],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			const out = results[5]!.stdout.trim();
			expect(out).toMatch(/^v1\.0\.0-1-g[0-9a-f]{7}$/);
		});

		test("lightweight tag on exact commit", async () => {
			const { results } = await runScenario(
				[
					"git init",
					"git add .",
					'git commit -m "initial"',
					"git tag v1.0.0",
					"git describe --tags",
				],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			expect(results[4]!.stdout.trim()).toBe("v1.0.0");
		});
	});

	describe("no tags / --always", () => {
		test("errors when no annotated tags exist", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "initial"', "git describe"],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			expect(results[3]!.exitCode).toBe(128);
			expect(results[3]!.stderr).toContain("No names found");
		});

		test("errors with hint when lightweight tags exist but --tags not specified", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "initial"', "git tag v1.0.0", "git describe"],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			expect(results[4]!.exitCode).toBe(128);
			expect(results[4]!.stderr).toContain("No annotated tags");
			expect(results[4]!.stderr).toContain("try --tags");
		});

		test("--always falls back to abbreviated hash", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "initial"', "git describe --always"],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			expect(results[3]!.exitCode).toBe(0);
			expect(results[3]!.stdout.trim()).toMatch(/^[0-9a-f]{7}$/);
		});

		test("--always still prefers tags when available", async () => {
			const { results } = await runScenario(
				[
					"git init",
					"git add .",
					'git commit -m "initial"',
					'git tag -a v1.0.0 -m "r1"',
					"git describe --always",
				],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			expect(results[4]!.stdout.trim()).toBe("v1.0.0");
		});
	});

	describe("--abbrev", () => {
		test("custom abbreviation length", async () => {
			const { results } = await runScenario(
				[
					"git init",
					"git add .",
					'git commit -m "initial"',
					'git tag -a v1.0.0 -m "r1"',
					'git commit --allow-empty -m "second"',
					"git describe --abbrev=12",
				],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			const out = results[5]!.stdout.trim();
			expect(out).toMatch(/^v1\.0\.0-1-g[0-9a-f]{12}$/);
		});

		test("--abbrev=0 suppresses the suffix", async () => {
			const { results } = await runScenario(
				[
					"git init",
					"git add .",
					'git commit -m "initial"',
					'git tag -a v1.0.0 -m "r1"',
					'git commit --allow-empty -m "second"',
					"git describe --abbrev=0",
				],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			expect(results[5]!.stdout.trim()).toBe("v1.0.0");
		});

		test("--always respects --abbrev", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "initial"', "git describe --always --abbrev=12"],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			expect(results[3]!.stdout.trim()).toMatch(/^[0-9a-f]{12}$/);
		});
	});

	describe("--dirty", () => {
		test("appends -dirty when worktree has unstaged changes", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.exec('git tag -a v1.0.0 -m "r1"');
			await bash.exec("echo modified >> /repo/README.md");
			const result = await bash.exec("git describe --dirty");
			expect(result.stdout.trim()).toBe("v1.0.0-dirty");
		});

		test("appends -dirty when worktree has staged changes", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.exec('git tag -a v1.0.0 -m "r1"');
			await bash.exec("echo modified >> /repo/README.md");
			await bash.exec("git add .");
			const result = await bash.exec("git describe --dirty");
			expect(result.stdout.trim()).toBe("v1.0.0-dirty");
		});

		test("no -dirty when worktree is clean", async () => {
			const { results } = await runScenario(
				[
					"git init",
					"git add .",
					'git commit -m "initial"',
					'git tag -a v1.0.0 -m "r1"',
					"git describe --dirty",
				],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			expect(results[4]!.stdout.trim()).toBe("v1.0.0");
		});

		test("custom dirty suffix", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.exec('git tag -a v1.0.0 -m "r1"');
			await bash.exec("echo modified >> /repo/README.md");
			const result = await bash.exec("git describe --dirty=-modified");
			expect(result.stdout.trim()).toBe("v1.0.0-modified");
		});
	});

	describe("--match / --exclude", () => {
		test("--match filters tags by glob pattern", async () => {
			const { results } = await runScenario(
				[
					"git init",
					"git add .",
					'git commit -m "initial"',
					'git tag -a v1.0.0 -m "r1"',
					'git commit --allow-empty -m "second"',
					'git tag -a release-2.0 -m "r2"',
					'git commit --allow-empty -m "third"',
					'git describe --match "v*"',
				],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			const out = results[7]!.stdout.trim();
			expect(out).toMatch(/^v1\.0\.0-2-g[0-9a-f]{7}$/);
		});

		test("--exclude filters out matching tags", async () => {
			const { results } = await runScenario(
				[
					"git init",
					"git add .",
					'git commit -m "initial"',
					'git tag -a v1.0.0 -m "r1"',
					'git commit --allow-empty -m "second"',
					'git tag -a v2.0.0 -m "r2"',
					'git commit --allow-empty -m "third"',
					'git describe --exclude "v2*"',
				],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			const out = results[7]!.stdout.trim();
			expect(out).toMatch(/^v1\.0\.0-2-g[0-9a-f]{7}$/);
		});
	});

	describe("--exact-match", () => {
		test("succeeds when HEAD is exactly tagged", async () => {
			const { results } = await runScenario(
				[
					"git init",
					"git add .",
					'git commit -m "initial"',
					'git tag -a v1.0.0 -m "r1"',
					"git describe --exact-match",
				],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			expect(results[4]!.exitCode).toBe(0);
			expect(results[4]!.stdout.trim()).toBe("v1.0.0");
		});

		test("fails when HEAD is not exactly tagged", async () => {
			const { results } = await runScenario(
				[
					"git init",
					"git add .",
					'git commit -m "initial"',
					'git tag -a v1.0.0 -m "r1"',
					'git commit --allow-empty -m "second"',
					"git describe --exact-match",
				],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			expect(results[5]!.exitCode).toBe(128);
			expect(results[5]!.stderr).toContain("no tag exactly matches");
		});
	});

	describe("--first-parent", () => {
		test("only follows first parents through merges", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.exec('git tag -a base -m "base"');

			await bash.exec("git checkout -b side");
			await bash.exec('git commit --allow-empty -m "side1"');
			await bash.exec('git tag -a side-tag -m "side tag"');
			await bash.exec('git commit --allow-empty -m "side2"');

			await bash.exec("git checkout main");
			await bash.exec('git commit --allow-empty -m "main1"');
			await bash.exec('git commit --allow-empty -m "main2"');
			await bash.exec('git merge side -m "merge"');

			// Without --first-parent, finds side-tag (closer via merge parent)
			const defaultResult = await bash.exec("git describe");
			expect(defaultResult.stdout.trim()).toMatch(/^side-tag/);

			// With --first-parent, only follows main line, finds base
			const fpResult = await bash.exec("git describe --first-parent");
			expect(fpResult.stdout.trim()).toMatch(/^base/);
		});
	});

	describe("multiple tags", () => {
		test("prefers newest annotated tag when multiple tags on same commit", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: envAt("1000000000") });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			// Create two tags with different timestamps
			await bash.exec('git tag -a alpha -m "a"', { env: envAt("1000000010") });
			await bash.exec('git tag -a beta -m "b"', { env: envAt("1000000020") });

			const result = await bash.exec("git describe");
			expect(result.stdout.trim()).toBe("beta");
		});

		test("alphabetically first when timestamps are equal", async () => {
			const env = envAt("1000000000");
			const bash = createTestBash({ files: EMPTY_REPO, env });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.exec('git tag -a zebra -m "z"');
			await bash.exec('git tag -a alpha -m "a"');

			const result = await bash.exec("git describe");
			expect(result.stdout.trim()).toBe("alpha");
		});
	});

	describe("error cases", () => {
		test("not a git repo", async () => {
			const result = await quickExec("git describe");
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("not a git repository");
		});

		test("bad revision", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "initial"', "git describe nonexistent"],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			expect(results[3]!.exitCode).toBe(128);
			expect(results[3]!.stderr).toContain("Not a valid object name");
		});

		test("no commits yet", async () => {
			const { results } = await runScenario(["git init", "git describe"], { files: EMPTY_REPO });
			expect(results[1]!.exitCode).toBe(128);
			expect(results[1]!.stderr).toContain("does not have any commits");
		});
	});
});
