import { describe, expect, test } from "bun:test";
import { TEST_ENV } from "../fixtures";
import { quickExec, runScenario } from "../util";

const FILES = {
	"/repo/README.md": "# Hello\n\nThis is a TODO list app.\n\n## TODO\n- Add tests\n",
	"/repo/src/app.ts":
		'function App() {\n  const count = 0;\n  // TODO: fix this\n  return "hello";\n}\n',
	"/repo/src/utils/math.ts":
		"export function add(a: number, b: number) {\n  return a + b;\n}\n\nexport function multiply(a: number, b: number) {\n  return a * b;\n}\n",
	"/repo/src/utils/date.ts":
		"export function formatDate(date: Date) {\n  // TODO: handle timezone\n  return date.toISOString();\n}\n",
};

function setup() {
	return ["git init", "git add .", 'git commit -m "initial"'];
}

describe("git grep", () => {
	// ── Error cases ─────────────────────────────────────────────────

	describe("error cases", () => {
		test("fails outside a git repo", async () => {
			const r = await quickExec('git grep "TODO"', { files: FILES });
			expect(r.exitCode).toBe(128);
			expect(r.stderr).toContain("not a git repository");
		});

		test("fails with no pattern", async () => {
			const { results } = await runScenario([...setup(), "git grep"], {
				files: FILES,
				env: TEST_ENV,
			});
			expect(results[3].exitCode).toBe(128);
			expect(results[3].stderr).toContain("no pattern given");
		});

		test("fails with invalid regex", async () => {
			const { results } = await runScenario([...setup(), 'git grep "[invalid"'], {
				files: FILES,
				env: TEST_ENV,
			});
			expect(results[3].exitCode).toBe(128);
			expect(results[3].stderr).toContain("invalid regular expression");
		});

		test("fails with bad revision", async () => {
			const { results } = await runScenario([...setup(), 'git grep "TODO" nonexistent-rev'], {
				files: FILES,
				env: TEST_ENV,
			});
			expect(results[3].exitCode).toBe(128);
		});
	});

	// ── Basic search ────────────────────────────────────────────────

	describe("basic search", () => {
		test("finds matches in tracked worktree files", async () => {
			const { results } = await runScenario([...setup(), 'git grep "TODO"'], {
				files: FILES,
				env: TEST_ENV,
			});
			const r = results[3];
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toContain("README.md:");
			expect(r.stdout).toContain("src/app.ts:");
			expect(r.stdout).toContain("src/utils/date.ts:");
		});

		test("exit code 1 when no matches", async () => {
			const { results } = await runScenario([...setup(), 'git grep "NONEXISTENT_XYZ"'], {
				files: FILES,
				env: TEST_ENV,
			});
			expect(results[3].exitCode).toBe(1);
			expect(results[3].stdout).toBe("");
		});

		test("does not search untracked files", async () => {
			const { results } = await runScenario(
				[...setup(), 'echo "UNIQUE_MARKER" > /repo/untracked.txt', 'git grep "UNIQUE_MARKER"'],
				{ files: FILES, env: TEST_ENV },
			);
			expect(results[4].exitCode).toBe(1);
		});

		test("searches worktree content (not index blob)", async () => {
			const { results } = await runScenario(
				[...setup(), 'echo "WORKTREE_EDIT" >> /repo/README.md', 'git grep "WORKTREE_EDIT"'],
				{ files: FILES, env: TEST_ENV },
			);
			expect(results[4].exitCode).toBe(0);
			expect(results[4].stdout).toContain("README.md:WORKTREE_EDIT");
		});
	});

	// ── Flags ───────────────────────────────────────────────────────

	describe("flags", () => {
		test("-n shows line numbers", async () => {
			const { results } = await runScenario([...setup(), 'git grep -n "TODO"'], {
				files: FILES,
				env: TEST_ENV,
			});
			const r = results[3];
			expect(r.exitCode).toBe(0);
			// Format: path:linenum:line
			const lines = r.stdout.trim().split("\n");
			for (const line of lines) {
				expect(line).toMatch(/^[^:]+:\d+:/);
			}
		});

		test("-i case insensitive", async () => {
			const { results } = await runScenario([...setup(), 'git grep -i "todo"'], {
				files: FILES,
				env: TEST_ENV,
			});
			const r = results[3];
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toContain("TODO");
		});

		test("-l shows only filenames", async () => {
			const { results } = await runScenario([...setup(), 'git grep -l "TODO"'], {
				files: FILES,
				env: TEST_ENV,
			});
			const r = results[3];
			expect(r.exitCode).toBe(0);
			const lines = r.stdout.trim().split("\n");
			for (const line of lines) {
				expect(line).not.toContain(":");
			}
			expect(lines).toContain("README.md");
			expect(lines).toContain("src/app.ts");
		});

		test("-L shows files without matches", async () => {
			const { results } = await runScenario([...setup(), 'git grep -L "TODO"'], {
				files: FILES,
				env: TEST_ENV,
			});
			const r = results[3];
			expect(r.exitCode).toBe(0);
			const lines = r.stdout.trim().split("\n");
			expect(lines).toContain("src/utils/math.ts");
			for (const line of lines) {
				expect(line).not.toContain(":");
				expect(line).not.toContain("src/app.ts");
				expect(line).not.toContain("README.md");
				expect(line).not.toContain("src/utils/date.ts");
			}
		});

		test("-c shows count per file", async () => {
			const { results } = await runScenario([...setup(), 'git grep -c "TODO"'], {
				files: FILES,
				env: TEST_ENV,
			});
			const r = results[3];
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toContain("README.md:2");
			expect(r.stdout).toContain("src/app.ts:1");
		});

		test("-w word match", async () => {
			const { results } = await runScenario([...setup(), 'git grep -w "add"'], {
				files: FILES,
				env: TEST_ENV,
			});
			const r = results[3];
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toContain("math.ts:");
		});

		test("-v invert match", async () => {
			const { results } = await runScenario([...setup(), 'git grep -v "TODO" -- src/app.ts'], {
				files: FILES,
				env: TEST_ENV,
			});
			const r = results[3];
			expect(r.exitCode).toBe(0);
			expect(r.stdout).not.toContain("TODO");
			expect(r.stdout).toContain("function App");
		});

		test("-F fixed string", async () => {
			const { results } = await runScenario([...setup(), 'git grep -F "a + b"'], {
				files: FILES,
				env: TEST_ENV,
			});
			const r = results[3];
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toContain("math.ts:");
		});

		test("-h suppresses filename", async () => {
			const { results } = await runScenario([...setup(), 'git grep -h "TODO" -- src/app.ts'], {
				files: FILES,
				env: TEST_ENV,
			});
			const r = results[3];
			expect(r.exitCode).toBe(0);
			const lines = r.stdout.trim().split("\n");
			for (const line of lines) {
				expect(line).not.toContain("app.ts:");
			}
		});

		test("-q quiet mode (match)", async () => {
			const { results } = await runScenario([...setup(), 'git grep -q "TODO"'], {
				files: FILES,
				env: TEST_ENV,
			});
			expect(results[3].exitCode).toBe(0);
			expect(results[3].stdout).toBe("");
		});

		test("-q quiet mode (no match)", async () => {
			const { results } = await runScenario([...setup(), 'git grep -q "NONEXISTENT"'], {
				files: FILES,
				env: TEST_ENV,
			});
			expect(results[3].exitCode).toBe(1);
			expect(results[3].stdout).toBe("");
		});
	});

	// ── Revision search ─────────────────────────────────────────────

	describe("revision search", () => {
		test("search at HEAD", async () => {
			const { results } = await runScenario([...setup(), 'git grep "TODO" HEAD'], {
				files: FILES,
				env: TEST_ENV,
			});
			const r = results[3];
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toContain("HEAD:README.md:");
			expect(r.stdout).toContain("HEAD:src/app.ts:");
		});

		test("search at previous commit", async () => {
			const { results } = await runScenario(
				[
					...setup(),
					'echo "NEW_MARKER" >> /repo/README.md',
					"git add .",
					'git commit -m "add marker"',
					'git grep "NEW_MARKER" HEAD~1',
				],
				{ files: FILES, env: TEST_ENV },
			);
			// HEAD~1 is the initial commit — should NOT have NEW_MARKER
			expect(results[6].exitCode).toBe(1);
		});

		test("search at branch name", async () => {
			const { results } = await runScenario(
				[
					...setup(),
					"git checkout -b feature",
					'echo "FEATURE_THING" >> /repo/README.md',
					"git add .",
					'git commit -m "feature"',
					"git checkout main",
					'git grep "FEATURE_THING" feature',
				],
				{ files: FILES, env: TEST_ENV },
			);
			const r = results[8];
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toContain("feature:README.md:");
		});

		test("search multiple revisions", async () => {
			const { results } = await runScenario(
				[
					...setup(),
					"git checkout -b feature",
					'echo "BRANCH_LINE" >> /repo/README.md',
					"git add .",
					'git commit -m "feature"',
					"git checkout main",
					'git grep "TODO" main feature',
				],
				{ files: FILES, env: TEST_ENV },
			);
			const r = results[8];
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toContain("main:");
			expect(r.stdout).toContain("feature:");
		});
	});

	// ── --cached ────────────────────────────────────────────────────

	describe("--cached", () => {
		test("searches index content", async () => {
			const { results } = await runScenario(
				[
					...setup(),
					'echo "STAGED_CONTENT" > /repo/staged.txt',
					"git add staged.txt",
					'git grep --cached "STAGED_CONTENT"',
				],
				{ files: FILES, env: TEST_ENV },
			);
			expect(results[5].exitCode).toBe(0);
			expect(results[5].stdout).toContain("staged.txt:");
		});

		test("--cached ignores worktree modifications", async () => {
			const { results } = await runScenario(
				[
					...setup(),
					'echo "UNSTAGED_EDIT" >> /repo/README.md',
					'git grep --cached "UNSTAGED_EDIT"',
				],
				{ files: FILES, env: TEST_ENV },
			);
			expect(results[4].exitCode).toBe(1);
		});
	});

	// ── Pathspec filtering ──────────────────────────────────────────

	describe("pathspecs", () => {
		test("filters by glob pathspec", async () => {
			const { results } = await runScenario([...setup(), 'git grep "TODO" -- "*.ts"'], {
				files: FILES,
				env: TEST_ENV,
			});
			const r = results[3];
			expect(r.exitCode).toBe(0);
			expect(r.stdout).not.toContain("README.md");
			expect(r.stdout).toContain("src/app.ts:");
		});

		test("filters by directory pathspec", async () => {
			const { results } = await runScenario([...setup(), 'git grep "function" -- src/utils/'], {
				files: FILES,
				env: TEST_ENV,
			});
			const r = results[3];
			expect(r.exitCode).toBe(0);
			expect(r.stdout).not.toContain("app.ts");
			expect(r.stdout).toContain("src/utils/math.ts:");
		});

		test("pathspec with revision", async () => {
			const { results } = await runScenario([...setup(), 'git grep "TODO" HEAD -- "*.ts"'], {
				files: FILES,
				env: TEST_ENV,
			});
			const r = results[3];
			expect(r.exitCode).toBe(0);
			expect(r.stdout).not.toContain("README.md");
			expect(r.stdout).toContain("HEAD:src/");
		});
	});

	// ── Context lines ───────────────────────────────────────────────

	describe("context", () => {
		test("-C shows surrounding context", async () => {
			const { results } = await runScenario([...setup(), 'git grep -C 1 "TODO" -- src/app.ts'], {
				files: FILES,
				env: TEST_ENV,
			});
			const r = results[3];
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toContain("const count");
			expect(r.stdout).toContain("TODO");
			expect(r.stdout).toContain("return");
		});

		test("-A shows after context", async () => {
			const { results } = await runScenario([...setup(), 'git grep -A 1 "TODO" -- src/app.ts'], {
				files: FILES,
				env: TEST_ENV,
			});
			const r = results[3];
			expect(r.exitCode).toBe(0);
			// Match line + one after
			expect(r.stdout).toContain("TODO");
			expect(r.stdout).toContain("return");
		});

		test("-B shows before context", async () => {
			const { results } = await runScenario([...setup(), 'git grep -B 1 "TODO" -- src/app.ts'], {
				files: FILES,
				env: TEST_ENV,
			});
			const r = results[3];
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toContain("const count");
			expect(r.stdout).toContain("TODO");
		});

		test("context uses : for match lines, - for context lines", async () => {
			const { results } = await runScenario([...setup(), 'git grep -C 1 "TODO" -- src/app.ts'], {
				files: FILES,
				env: TEST_ENV,
			});
			const lines = results[3].stdout.trim().split("\n");
			const matchLine = lines.find((l) => l.includes("TODO"))!;
			expect(matchLine).toMatch(/:.*TODO/);
			const contextLine = lines.find((l) => l.includes("const count"))!;
			expect(contextLine).toContain("-");
		});
	});

	// ── Multiple patterns ───────────────────────────────────────────

	describe("multiple patterns", () => {
		test("-e OR semantics", async () => {
			const { results } = await runScenario([...setup(), 'git grep -e "TODO" -e "function"'], {
				files: FILES,
				env: TEST_ENV,
			});
			const r = results[3];
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toContain("TODO");
			expect(r.stdout).toContain("function");
		});

		test("--all-match AND at file level", async () => {
			const { results } = await runScenario(
				[...setup(), 'git grep --all-match -e "TODO" -e "handle"'],
				{ files: FILES, env: TEST_ENV },
			);
			const r = results[3];
			expect(r.exitCode).toBe(0);
			// Only date.ts has both "TODO" and "handle"
			expect(r.stdout).toContain("src/utils/date.ts:");
			expect(r.stdout).not.toContain("README.md");
		});
	});

	// ── --max-depth ─────────────────────────────────────────────────

	describe("--max-depth", () => {
		test("limits search depth", async () => {
			const { results } = await runScenario([...setup(), 'git grep --max-depth 0 "TODO"'], {
				files: FILES,
				env: TEST_ENV,
			});
			const r = results[3];
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toContain("README.md:");
			expect(r.stdout).not.toContain("src/");
		});
	});

	// ── --full-name from subdirectory ───────────────────────────────

	describe("subdirectory behavior", () => {
		test("paths relative to cwd by default", async () => {
			const { results } = await runScenario([...setup(), 'cd /repo/src && git grep "TODO"'], {
				files: FILES,
				env: TEST_ENV,
			});
			const r = results[3];
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toContain("app.ts:");
			expect(r.stdout).toContain("utils/date.ts:");
		});

		test("--full-name shows repo-relative paths", async () => {
			const { results } = await runScenario(
				[...setup(), 'cd /repo/src && git grep --full-name "TODO"'],
				{ files: FILES, env: TEST_ENV },
			);
			const r = results[3];
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toContain("src/app.ts:");
			expect(r.stdout).toContain("src/utils/date.ts:");
		});
	});

	// ── --break / --heading ─────────────────────────────────────────

	describe("output formatting", () => {
		test("--heading shows filename as header", async () => {
			const { results } = await runScenario([...setup(), 'git grep --heading "TODO" -- src/'], {
				files: FILES,
				env: TEST_ENV,
			});
			const r = results[3];
			expect(r.exitCode).toBe(0);
			const lines = r.stdout.trim().split("\n");
			// Heading line should be just the filename (no colon)
			expect(lines.some((l) => l === "src/app.ts")).toBe(true);
		});

		test("--break adds blank lines between files", async () => {
			const { results } = await runScenario([...setup(), 'git grep --break --heading "TODO"'], {
				files: FILES,
				env: TEST_ENV,
			});
			const r = results[3];
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toContain("\n\n");
		});
	});

	// ── -e with dash pattern ────────────────────────────────────────

	describe("-e explicit pattern", () => {
		test("allows patterns starting with -", async () => {
			const { results } = await runScenario(
				[
					"git init",
					'echo "x-y" > /repo/file.txt',
					"git add .",
					'git commit -m "init"',
					'git grep -e "-y"',
				],
				{ files: {}, env: TEST_ENV },
			);
			const r = results[4];
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toContain("file.txt:");
		});

		test("-e with -- pathspec", async () => {
			const { results } = await runScenario([...setup(), 'git grep -e "function" -- "*.ts"'], {
				files: FILES,
				env: TEST_ENV,
			});
			const r = results[3];
			expect(r.exitCode).toBe(0);
			expect(r.stdout).not.toContain("README.md");
			expect(r.stdout).toContain("src/app.ts:");
			expect(r.stdout).toContain("src/utils/math.ts:");
		});

		test("-e with revision and -- pathspec", async () => {
			const { results } = await runScenario([...setup(), 'git grep -e "TODO" HEAD -- "*.ts"'], {
				files: FILES,
				env: TEST_ENV,
			});
			const r = results[3];
			expect(r.exitCode).toBe(0);
			expect(r.stdout).not.toContain("README.md");
			expect(r.stdout).toContain("HEAD:src/app.ts:");
			expect(r.stdout).toContain("HEAD:src/utils/date.ts:");
		});

		test("-e --all-match with -- pathspec", async () => {
			const { results } = await runScenario(
				[...setup(), 'git grep -e "TODO" -e "handle" --all-match -- "*.ts"'],
				{ files: FILES, env: TEST_ENV },
			);
			const r = results[3];
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toContain("src/utils/date.ts:");
			expect(r.stdout).not.toContain("README.md");
			expect(r.stdout).not.toContain("src/app.ts");
		});
	});

	// ── Empty repo (no commits but index exists) ────────────────────

	describe("no commits", () => {
		test("searches tracked files when no commits exist", async () => {
			const { results } = await runScenario(["git init", "git add .", 'git grep "TODO"'], {
				files: FILES,
				env: TEST_ENV,
			});
			const r = results[2];
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toContain("TODO");
		});
	});
});
