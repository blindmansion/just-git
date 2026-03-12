import { describe, expect, test } from "bun:test";
import { EMPTY_REPO, envAt, TEST_ENV_NAMED as TEST_ENV } from "../fixtures";
import { quickExec, runScenario } from "../util";

describe("git blame", () => {
	describe("error cases", () => {
		test("fails outside a git repo", async () => {
			const result = await quickExec("git blame file.txt", { files: EMPTY_REPO });
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("not a git repository");
		});

		test("fails when no commits exist", async () => {
			const { results } = await runScenario(["git init", "git blame README.md"], {
				files: EMPTY_REPO,
			});
			expect(results[1].exitCode).toBe(128);
			expect(results[1].stderr).toContain("does not have any commits");
		});

		test("fails when no file specified", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "init"', "git blame"],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			expect(results[3].exitCode).toBe(128);
			expect(results[3].stderr).toContain("no file specified");
		});

		test("fails for nonexistent file", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "init"', "git blame nonexistent.txt"],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			expect(results[3].exitCode).toBe(128);
			expect(results[3].stderr).toContain("no such path");
		});

		test("fails for bad revision", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "init"', "git blame badrev -- README.md"],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			expect(results[3].exitCode).toBe(128);
		});
	});

	describe("single commit", () => {
		test("all lines attributed to root commit with boundary marker", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "initial"', "git blame README.md"],
				{ files: EMPTY_REPO, env: envAt("1000000000") },
			);
			const blame = results[3];
			expect(blame.exitCode).toBe(0);
			const lines = blame.stdout.trim().split("\n");
			expect(lines).toHaveLength(1);
			expect(lines[0]).toMatch(/^\^[a-f0-9]{7}/);
			expect(lines[0]).toContain("Test Author");
			expect(lines[0]).toContain("# My Project");
		});
	});

	describe("multi-commit attribution", () => {
		test("attributes lines to correct commits", async () => {
			const { results } = await runScenario(
				[
					"git init",
					"git add .",
					'git commit -m "initial"',
					'echo "line2" >> /repo/README.md',
					"git add .",
					'git commit -m "add line2"',
					"git blame README.md",
				],
				{
					files: { "/repo/README.md": "line1\n" },
					env: envAt("1000000000"),
				},
			);
			const blame = results[6];
			expect(blame.exitCode).toBe(0);
			const lines = blame.stdout.trim().split("\n");
			expect(lines).toHaveLength(2);
			// First line should have boundary marker (root commit)
			expect(lines[0]).toMatch(/^\^[a-f0-9]{7}/);
			expect(lines[0]).toContain("line1");
			// Second line should not have boundary marker (second commit)
			expect(lines[1]).toMatch(/^[a-f0-9]{8}/);
			expect(lines[1]).not.toMatch(/^\^/);
			expect(lines[1]).toContain("line2");
		});

		test("modified line attributed to modifying commit", async () => {
			const { results } = await runScenario(
				[
					"git init",
					"git add .",
					'git commit -m "initial"',
					'printf "modified\\nline2\\n" > /repo/README.md',
					"git add .",
					'git commit -m "modify"',
					"git blame README.md",
				],
				{
					files: { "/repo/README.md": "original\nline2\n" },
					env: envAt("1000000000"),
				},
			);
			const blame = results[6];
			expect(blame.exitCode).toBe(0);
			const lines = blame.stdout.trim().split("\n");
			expect(lines).toHaveLength(2);
			// "modified" line should be from second commit (no boundary)
			expect(lines[0]).toMatch(/^[a-f0-9]{8}/);
			expect(lines[0]).not.toMatch(/^\^/);
			expect(lines[0]).toContain("modified");
			// "line2" should still be from root commit (boundary)
			expect(lines[1]).toMatch(/^\^[a-f0-9]{7}/);
			expect(lines[1]).toContain("line2");
		});
	});

	describe("-L line range", () => {
		test("restricts output to specified lines", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "initial"', "git blame -L 1,1 README.md"],
				{
					files: { "/repo/README.md": "line1\nline2\nline3\n" },
					env: envAt("1000000000"),
				},
			);
			const blame = results[3];
			expect(blame.exitCode).toBe(0);
			const lines = blame.stdout.trim().split("\n");
			expect(lines).toHaveLength(1);
			expect(lines[0]).toContain("line1");
		});

		test("shows middle range", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "initial"', "git blame -L 2,3 README.md"],
				{
					files: { "/repo/README.md": "line1\nline2\nline3\n" },
					env: envAt("1000000000"),
				},
			);
			const blame = results[3];
			expect(blame.exitCode).toBe(0);
			const lines = blame.stdout.trim().split("\n");
			expect(lines).toHaveLength(2);
			expect(lines[0]).toContain("line2");
			expect(lines[1]).toContain("line3");
		});
	});

	describe("formatting flags", () => {
		test("-l shows long hash", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "initial"', "git blame -l README.md"],
				{ files: EMPTY_REPO, env: envAt("1000000000") },
			);
			const blame = results[3];
			expect(blame.exitCode).toBe(0);
			// Boundary long hash: ^<39 chars>
			expect(blame.stdout).toMatch(/^\^[a-f0-9]{39}\s/);
		});

		test("-e shows email", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "initial"', "git blame -e README.md"],
				{ files: EMPTY_REPO, env: envAt("1000000000") },
			);
			const blame = results[3];
			expect(blame.exitCode).toBe(0);
			expect(blame.stdout).toContain("<author@test.com>");
			expect(blame.stdout).not.toContain("Test Author");
		});

		test("-s suppresses author and date", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "initial"', "git blame -s README.md"],
				{ files: EMPTY_REPO, env: envAt("1000000000") },
			);
			const blame = results[3];
			expect(blame.exitCode).toBe(0);
			expect(blame.stdout).not.toContain("Test Author");
			expect(blame.stdout).not.toContain("author@test.com");
			expect(blame.stdout).toContain("# My Project");
			// Should have hash, line number, content — no parenthesized author section
			expect(blame.stdout).toMatch(/^\^[a-f0-9]{7}\s+\d+\)/);
		});
	});

	describe("--porcelain", () => {
		test("outputs porcelain format", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "initial"', "git blame --porcelain README.md"],
				{
					files: { "/repo/README.md": "line1\nline2\n" },
					env: envAt("1000000000"),
				},
			);
			const blame = results[3];
			expect(blame.exitCode).toBe(0);
			expect(blame.stdout).toContain("author Test Author");
			expect(blame.stdout).toContain("author-mail <author@test.com>");
			expect(blame.stdout).toContain("author-time 1000000000");
			expect(blame.stdout).toContain("committer Test Committer");
			expect(blame.stdout).toContain("summary initial");
			expect(blame.stdout).toContain("boundary");
			expect(blame.stdout).toContain("filename README.md");
			expect(blame.stdout).toContain("\tline1");
			expect(blame.stdout).toContain("\tline2");
		});

		test("deduplicates headers for same commit", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "initial"', "git blame --porcelain README.md"],
				{
					files: { "/repo/README.md": "line1\nline2\n" },
					env: envAt("1000000000"),
				},
			);
			const blame = results[3];
			const authorCount = (blame.stdout.match(/^author /gm) ?? []).length;
			// Should only have one "author" header since both lines are same commit
			expect(authorCount).toBe(1);
		});
	});

	describe("--line-porcelain", () => {
		test("repeats headers for every line", async () => {
			const { results } = await runScenario(
				[
					"git init",
					"git add .",
					'git commit -m "initial"',
					"git blame --line-porcelain README.md",
				],
				{
					files: { "/repo/README.md": "line1\nline2\n" },
					env: envAt("1000000000"),
				},
			);
			const blame = results[3];
			const authorCount = (blame.stdout.match(/^author /gm) ?? []).length;
			expect(authorCount).toBe(2);
		});
	});

	describe("blame with revision argument", () => {
		test("blames at a specific revision", async () => {
			const { results } = await runScenario(
				[
					"git init",
					"git add .",
					'git commit -m "initial"',
					'printf "modified\\n" > /repo/README.md',
					"git add .",
					'git commit -m "modify"',
					"git blame HEAD~1 -- README.md",
				],
				{
					files: { "/repo/README.md": "original\n" },
					env: envAt("1000000000"),
				},
			);
			const blame = results[6];
			expect(blame.exitCode).toBe(0);
			expect(blame.stdout).toContain("original");
			expect(blame.stdout).not.toContain("modified");
		});
	});

	describe("rename following", () => {
		test("follows file renames and shows original path", async () => {
			const { results } = await runScenario(
				[
					"git init",
					"git add .",
					'git commit -m "initial"',
					"git mv README.md RENAMED.md",
					'git commit -m "rename"',
					"git blame RENAMED.md",
				],
				{ files: EMPTY_REPO, env: envAt("1000000000") },
			);
			const blame = results[5];
			expect(blame.exitCode).toBe(0);
			expect(blame.stdout).toContain("# My Project");
			// Should show original filename when it differs
			expect(blame.stdout).toContain("README.md");
		});
	});

	describe("date formatting", () => {
		test("shows dates in YYYY-MM-DD HH:MM:SS +ZZZZ format", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "initial"', "git blame README.md"],
				{ files: EMPTY_REPO, env: envAt("1000000000") },
			);
			const blame = results[3];
			expect(blame.exitCode).toBe(0);
			// 1000000000 = 2001-09-09 01:46:40 +0000
			expect(blame.stdout).toMatch(/2001-09-09 01:46:40 \+0000/);
		});
	});

	describe("column alignment", () => {
		test("line numbers are right-aligned", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "initial"', "git blame README.md"],
				{
					files: {
						"/repo/README.md":
							Array.from({ length: 12 }, (_, i) => `line${i + 1}`).join("\n") + "\n",
					},
					env: envAt("1000000000"),
				},
			);
			const blame = results[3];
			expect(blame.exitCode).toBe(0);
			const lines = blame.stdout.trim().split("\n");
			expect(lines).toHaveLength(12);
			// Single-digit line numbers should be right-aligned to match double-digit width
			expect(lines[0]).toContain(" 1)");
			expect(lines[8]).toContain(" 9)");
			expect(lines[9]).toContain("10)");
		});
	});

	describe("porcelain previous field", () => {
		test("shows previous commit and path for non-boundary lines", async () => {
			const { results } = await runScenario(
				[
					"git init",
					"git add .",
					'git commit -m "initial"',
					'printf "original\\nappended\\n" > /repo/README.md',
					"git add .",
					'git commit -m "append"',
					"git blame --porcelain README.md",
				],
				{
					files: { "/repo/README.md": "original\n" },
					env: envAt("1000000000"),
				},
			);
			const blame = results[6];
			expect(blame.exitCode).toBe(0);
			// The "appended" line should have a "previous" field
			expect(blame.stdout).toMatch(/^previous [a-f0-9]{40} README\.md$/m);
		});
	});
});
