import { describe, expect, test } from "bun:test";
import { BASIC_REPO, EMPTY_REPO, NESTED_REPO, TEST_ENV_NAMED as TEST_ENV } from "../fixtures";
import { createTestBash, quickExec, runScenario } from "../util";

describe("git log", () => {
	describe("outside a git repo", () => {
		test("fails with exit 128", async () => {
			const result = await quickExec("git log", { files: EMPTY_REPO });
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("not a git repository");
		});
	});

	describe("no commits", () => {
		test("fails with exit 128", async () => {
			const { results } = await runScenario(["git init", "git log"], {
				files: EMPTY_REPO,
			});
			expect(results[1].exitCode).toBe(128);
			expect(results[1].stderr).toContain("does not have any commits yet");
		});
	});

	describe("default format", () => {
		test("shows commit hash", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "initial commit"', "git log"],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			const log = results[3];
			expect(log.exitCode).toBe(0);
			expect(log.stdout).toMatch(/commit [a-f0-9]{40}/);
		});

		test("shows author name and email", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "initial commit"', "git log"],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			const log = results[3];
			expect(log.stdout).toContain("Author: Test Author <author@test.com>");
		});

		test("shows date line", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "initial commit"', "git log"],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			const log = results[3];
			expect(log.stdout).toContain("Date:");
		});

		test("shows indented commit message", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "initial commit"', "git log"],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			const log = results[3];
			expect(log.stdout).toContain("    initial commit");
		});

		test("shows multiple commits in reverse chronological order", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");

			await bash.exec("git add README.md");
			await bash.exec('git commit -m "first commit"');

			await bash.exec("git add src/main.ts");
			await bash.exec('git commit -m "second commit"');

			const log = await bash.exec("git log");
			expect(log.exitCode).toBe(0);

			const secondIdx = log.stdout.indexOf("second commit");
			const firstIdx = log.stdout.indexOf("first commit");
			expect(secondIdx).toBeGreaterThan(-1);
			expect(firstIdx).toBeGreaterThan(-1);
			expect(secondIdx).toBeLessThan(firstIdx);
		});

		test("separates commits with blank lines", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add README.md");
			await bash.exec('git commit -m "first"');
			await bash.exec("git add src/main.ts");
			await bash.exec('git commit -m "second"');

			const log = await bash.exec("git log");
			const lines = log.stdout.split("\n");
			const commitLines = lines
				.map((l, i) => ({ line: l, idx: i }))
				.filter((x) => x.line.startsWith("commit "));
			expect(commitLines.length).toBe(2);
		});
	});

	describe("--oneline", () => {
		test("shows short hash and message on one line", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "initial commit"', "git log --oneline"],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			const log = results[3];
			expect(log.exitCode).toBe(0);
			expect(log.stdout).toMatch(/^[a-f0-9]{7} initial commit\n$/);
		});

		test("shows multiple commits one per line", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add README.md");
			await bash.exec('git commit -m "first"');
			await bash.exec("git add src/main.ts");
			await bash.exec('git commit -m "second"');

			const log = await bash.exec("git log --oneline");
			const lines = log.stdout.trim().split("\n");
			expect(lines.length).toBe(2);
			expect(lines[0]).toContain("second");
			expect(lines[1]).toContain("first");
		});
	});

	describe("-n (--max-count)", () => {
		test("limits output to n commits", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add README.md");
			await bash.exec('git commit -m "first"');
			await bash.exec("git add src/main.ts");
			await bash.exec('git commit -m "second"');
			await bash.exec("git add src/util.ts");
			await bash.exec('git commit -m "third"');

			const log = await bash.exec("git log -n 2 --oneline");
			const lines = log.stdout.trim().split("\n");
			expect(lines.length).toBe(2);
			expect(lines[0]).toContain("third");
			expect(lines[1]).toContain("second");
		});

		test("-n 1 shows only the latest commit", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add README.md");
			await bash.exec('git commit -m "first"');
			await bash.exec("git add src/main.ts");
			await bash.exec('git commit -m "second"');

			const log = await bash.exec("git log -n 1 --oneline");
			const lines = log.stdout.trim().split("\n");
			expect(lines.length).toBe(1);
			expect(lines[0]).toContain("second");
		});

		test("-1 shorthand is equivalent to -n 1", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add README.md");
			await bash.exec('git commit -m "first"');
			await bash.exec("git add src/main.ts");
			await bash.exec('git commit -m "second"');

			const log = await bash.exec("git log -1 --oneline");
			expect(log.exitCode).toBe(0);
			const lines = log.stdout.trim().split("\n");
			expect(lines.length).toBe(1);
			expect(lines[0]).toContain("second");
		});

		test("-3 shorthand limits to 3 commits", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add README.md");
			await bash.exec('git commit -m "first"');
			await bash.exec("git add src/main.ts");
			await bash.exec('git commit -m "second"');
			await bash.exec("git add src/util.ts");
			await bash.exec('git commit -m "third"');

			const full = await bash.exec("git log --oneline");
			expect(full.stdout.trim().split("\n").length).toBe(3);

			const limited = await bash.exec("git log -2 --oneline");
			expect(limited.exitCode).toBe(0);
			const lines = limited.stdout.trim().split("\n");
			expect(lines.length).toBe(2);
			expect(lines[0]).toContain("third");
			expect(lines[1]).toContain("second");
		});

		test("-10 with fewer commits returns all", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add README.md");
			await bash.exec('git commit -m "only"');

			const log = await bash.exec("git log -10 --oneline");
			expect(log.exitCode).toBe(0);
			const lines = log.stdout.trim().split("\n");
			expect(lines.length).toBe(1);
			expect(lines[0]).toContain("only");
		});
	});

	describe("deterministic timestamps", () => {
		test("uses GIT_AUTHOR_DATE for the date", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "test"', "git log"],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			const log = results[3];
			expect(log.stdout).toContain("2001");
		});
	});

	// ── New feature tests ───────────────────────────────────────────

	describe("--all", () => {
		test("shows commits from all branches", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add README.md");
			await bash.exec('git commit -m "main commit"');
			await bash.exec("git checkout -b feature");
			await bash.exec("git add src/main.ts");
			await bash.exec('git commit -m "feature commit"');
			await bash.exec("git checkout main");

			// Without --all, only main branch commits are visible
			const logNoAll = await bash.exec("git log --oneline");
			expect(logNoAll.stdout).toContain("main commit");
			expect(logNoAll.stdout).not.toContain("feature commit");

			// With --all, commits from both branches appear
			const logAll = await bash.exec("git log --all --oneline");
			expect(logAll.stdout).toContain("main commit");
			expect(logAll.stdout).toContain("feature commit");
		});

		test("deduplicates shared commits across branches", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add README.md");
			await bash.exec('git commit -m "shared"');
			await bash.exec("git checkout -b feature");

			const log = await bash.exec("git log --all --oneline");
			const lines = log.stdout.trim().split("\n");
			expect(lines.length).toBe(1);
			expect(lines[0]).toContain("shared");
		});

		test("shows tagged commits", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add README.md");
			await bash.exec('git commit -m "v1 release"');
			await bash.exec("git tag v1.0");
			await bash.exec("git checkout -b dev");
			await bash.exec("git add src/main.ts");
			await bash.exec('git commit -m "dev work"');
			await bash.exec("git checkout main");
			await bash.exec("git tag -d v1.0");
			// Even though we deleted the tag, main still has the commit

			const log = await bash.exec("git log --all --oneline");
			expect(log.stdout).toContain("v1 release");
			expect(log.stdout).toContain("dev work");
		});
	});

	describe("-- <path>", () => {
		test("filters by single file path", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add README.md");
			await bash.exec('git commit -m "add readme"');
			await bash.exec("git add src/main.ts");
			await bash.exec('git commit -m "add main"');

			const log = await bash.exec("git log --oneline -- README.md");
			const lines = log.stdout.trim().split("\n");
			expect(lines.length).toBe(1);
			expect(lines[0]).toContain("add readme");
		});

		test("filters by directory path", async () => {
			const bash = createTestBash({ files: NESTED_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add README.md");
			await bash.exec('git commit -m "add readme"');
			await bash.exec("git add src/");
			await bash.exec('git commit -m "add source"');
			await bash.exec("git add docs/");
			await bash.exec('git commit -m "add docs"');

			const log = await bash.exec("git log --oneline -- src/");
			const lines = log.stdout.trim().split("\n");
			expect(lines.length).toBe(1);
			expect(lines[0]).toContain("add source");
		});

		test("includes root commits that touch the path", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			const log = await bash.exec("git log --oneline -- README.md");
			const lines = log.stdout.trim().split("\n");
			expect(lines.length).toBe(1);
			expect(lines[0]).toContain("initial");
		});

		test("returns empty when path has no commits", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add README.md");
			await bash.exec('git commit -m "add readme"');

			const log = await bash.exec("git log --oneline -- nonexistent.txt");
			expect(log.stdout).toBe("");
			expect(log.exitCode).toBe(0);
		});

		test("supports glob pathspecs", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add README.md");
			await bash.exec('git commit -m "add readme"');
			await bash.exec("git add src/main.ts");
			await bash.exec('git commit -m "add main ts"');
			await bash.exec("git add src/util.ts");
			await bash.exec('git commit -m "add util ts"');

			const log = await bash.exec("git log --oneline -- '*.ts'");
			const lines = log.stdout.trim().split("\n");
			expect(lines.length).toBe(2);
			expect(lines[0]).toContain("add util ts");
			expect(lines[1]).toContain("add main ts");
		});
	});

	describe("--author", () => {
		test("filters commits by author name", async () => {
			const bash = createTestBash({ files: BASIC_REPO });
			await bash.exec("git init");
			await bash.exec("git add README.md");
			await bash.exec('git commit -m "alice commit"', {
				env: {
					...TEST_ENV,
					GIT_AUTHOR_NAME: "Alice",
					GIT_AUTHOR_EMAIL: "alice@test.com",
				},
			});
			await bash.exec("git add src/main.ts");
			await bash.exec('git commit -m "bob commit"', {
				env: {
					...TEST_ENV,
					GIT_AUTHOR_NAME: "Bob",
					GIT_AUTHOR_EMAIL: "bob@test.com",
				},
			});

			const log = await bash.exec("git log --oneline --author=Alice");
			const lines = log.stdout.trim().split("\n");
			expect(lines.length).toBe(1);
			expect(lines[0]).toContain("alice commit");
		});

		test("matches author email", async () => {
			const bash = createTestBash({ files: BASIC_REPO });
			await bash.exec("git init");
			await bash.exec("git add README.md");
			await bash.exec('git commit -m "from alice"', {
				env: {
					...TEST_ENV,
					GIT_AUTHOR_NAME: "Alice",
					GIT_AUTHOR_EMAIL: "alice@example.com",
				},
			});
			await bash.exec("git add src/main.ts");
			await bash.exec('git commit -m "from bob"', {
				env: {
					...TEST_ENV,
					GIT_AUTHOR_NAME: "Bob",
					GIT_AUTHOR_EMAIL: "bob@test.com",
				},
			});

			const log = await bash.exec("git log --oneline --author=example.com");
			const lines = log.stdout.trim().split("\n");
			expect(lines.length).toBe(1);
			expect(lines[0]).toContain("from alice");
		});

		test("returns empty when no match", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "test"');

			const log = await bash.exec("git log --oneline --author=Nobody");
			expect(log.stdout).toBe("");
			expect(log.exitCode).toBe(0);
		});

		test("supports regex patterns", async () => {
			const bash = createTestBash({ files: BASIC_REPO });
			await bash.exec("git init");
			await bash.exec("git add README.md");
			await bash.exec('git commit -m "commit 1"', {
				env: {
					...TEST_ENV,
					GIT_AUTHOR_NAME: "Alice Smith",
					GIT_AUTHOR_EMAIL: "alice@test.com",
				},
			});
			await bash.exec("git add src/main.ts");
			await bash.exec('git commit -m "commit 2"', {
				env: {
					...TEST_ENV,
					GIT_AUTHOR_NAME: "Bob Jones",
					GIT_AUTHOR_EMAIL: "bob@test.com",
				},
			});

			const log = await bash.exec("git log --oneline --author='^Alice'");
			const lines = log.stdout.trim().split("\n");
			expect(lines.length).toBe(1);
			expect(lines[0]).toContain("commit 1");
		});
	});

	describe("--grep", () => {
		test("filters commits by message substring", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add README.md");
			await bash.exec('git commit -m "fix: resolve bug #123"');
			await bash.exec("git add src/main.ts");
			await bash.exec('git commit -m "feat: add new feature"');

			const log = await bash.exec("git log --oneline --grep=fix");
			const lines = log.stdout.trim().split("\n");
			expect(lines.length).toBe(1);
			expect(lines[0]).toContain("fix: resolve bug #123");
		});

		test("matches with regex", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add README.md");
			await bash.exec('git commit -m "fix: bug #100"');
			await bash.exec("git add src/main.ts");
			await bash.exec('git commit -m "fix: bug #200"');
			await bash.exec("git add src/util.ts");
			await bash.exec('git commit -m "feat: new thing"');

			const log = await bash.exec("git log --oneline --grep='bug #[12]00'");
			const lines = log.stdout.trim().split("\n");
			expect(lines.length).toBe(2);
		});

		test("returns empty when no match", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "hello world"');

			const log = await bash.exec("git log --oneline --grep=xyz");
			expect(log.stdout).toBe("");
			expect(log.exitCode).toBe(0);
		});
	});

	describe("--since / --until", () => {
		test("--since filters out older commits", async () => {
			const bash = createTestBash({ files: BASIC_REPO });
			await bash.exec("git init");
			await bash.exec("git add README.md");
			await bash.exec('git commit -m "old commit"', {
				env: {
					...TEST_ENV,
					GIT_COMMITTER_DATE: "1000000000",
					GIT_AUTHOR_DATE: "1000000000",
				},
			});
			await bash.exec("git add src/main.ts");
			await bash.exec('git commit -m "new commit"', {
				env: {
					...TEST_ENV,
					GIT_COMMITTER_DATE: "1000001000",
					GIT_AUTHOR_DATE: "1000001000",
				},
			});

			const log = await bash.exec("git log --oneline --since=1000000500");
			const lines = log.stdout.trim().split("\n");
			expect(lines.length).toBe(1);
			expect(lines[0]).toContain("new commit");
		});

		test("--until filters out newer commits", async () => {
			const bash = createTestBash({ files: BASIC_REPO });
			await bash.exec("git init");
			await bash.exec("git add README.md");
			await bash.exec('git commit -m "old commit"', {
				env: {
					...TEST_ENV,
					GIT_COMMITTER_DATE: "1000000000",
					GIT_AUTHOR_DATE: "1000000000",
				},
			});
			await bash.exec("git add src/main.ts");
			await bash.exec('git commit -m "new commit"', {
				env: {
					...TEST_ENV,
					GIT_COMMITTER_DATE: "1000001000",
					GIT_AUTHOR_DATE: "1000001000",
				},
			});

			const log = await bash.exec("git log --oneline --until=1000000500");
			const lines = log.stdout.trim().split("\n");
			expect(lines.length).toBe(1);
			expect(lines[0]).toContain("old commit");
		});

		test("--after is a synonym for --since", async () => {
			const bash = createTestBash({ files: BASIC_REPO });
			await bash.exec("git init");
			await bash.exec("git add README.md");
			await bash.exec('git commit -m "old"', {
				env: {
					...TEST_ENV,
					GIT_COMMITTER_DATE: "1000000000",
					GIT_AUTHOR_DATE: "1000000000",
				},
			});
			await bash.exec("git add src/main.ts");
			await bash.exec('git commit -m "new"', {
				env: {
					...TEST_ENV,
					GIT_COMMITTER_DATE: "1000002000",
					GIT_AUTHOR_DATE: "1000002000",
				},
			});

			const log = await bash.exec("git log --oneline --after=1000001000");
			const lines = log.stdout.trim().split("\n");
			expect(lines.length).toBe(1);
			expect(lines[0]).toContain("new");
		});

		test("--before is a synonym for --until", async () => {
			const bash = createTestBash({ files: BASIC_REPO });
			await bash.exec("git init");
			await bash.exec("git add README.md");
			await bash.exec('git commit -m "early"', {
				env: {
					...TEST_ENV,
					GIT_COMMITTER_DATE: "1000000000",
					GIT_AUTHOR_DATE: "1000000000",
				},
			});
			await bash.exec("git add src/main.ts");
			await bash.exec('git commit -m "late"', {
				env: {
					...TEST_ENV,
					GIT_COMMITTER_DATE: "1000002000",
					GIT_AUTHOR_DATE: "1000002000",
				},
			});

			const log = await bash.exec("git log --oneline --before=1000001000");
			const lines = log.stdout.trim().split("\n");
			expect(lines.length).toBe(1);
			expect(lines[0]).toContain("early");
		});

		test("--since and --until together define a range", async () => {
			const bash = createTestBash({ files: BASIC_REPO });
			await bash.exec("git init");
			await bash.exec("git add README.md");
			await bash.exec('git commit -m "too old"', {
				env: {
					...TEST_ENV,
					GIT_COMMITTER_DATE: "1000000000",
					GIT_AUTHOR_DATE: "1000000000",
				},
			});
			await bash.exec("git add src/main.ts");
			await bash.exec('git commit -m "just right"', {
				env: {
					...TEST_ENV,
					GIT_COMMITTER_DATE: "1000001000",
					GIT_AUTHOR_DATE: "1000001000",
				},
			});
			await bash.exec("git add src/util.ts");
			await bash.exec('git commit -m "too new"', {
				env: {
					...TEST_ENV,
					GIT_COMMITTER_DATE: "1000002000",
					GIT_AUTHOR_DATE: "1000002000",
				},
			});

			const log = await bash.exec("git log --oneline --since=1000000500 --until=1000001500");
			const lines = log.stdout.trim().split("\n");
			expect(lines.length).toBe(1);
			expect(lines[0]).toContain("just right");
		});
	});

	describe("--decorate", () => {
		test("shows HEAD -> branch for current branch", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			const log = await bash.exec("git log --decorate -n 1");
			expect(log.stdout).toMatch(/commit [a-f0-9]{40} \(HEAD -> main\)/);
		});

		test("shows tag decorations", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "release"');
			await bash.exec("git tag v1.0");

			const log = await bash.exec("git log --decorate -n 1");
			expect(log.stdout).toContain("HEAD -> main");
			expect(log.stdout).toContain("tag: v1.0");
		});

		test("shows multiple branches on same commit", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "shared"');
			await bash.exec("git branch feature");

			const log = await bash.exec("git log --decorate --oneline");
			const line = log.stdout.trim();
			expect(line).toContain("HEAD -> main");
			expect(line).toContain("feature");
		});

		test("works with --oneline format", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "test"');

			const log = await bash.exec("git log --decorate --oneline");
			expect(log.stdout).toMatch(/^[a-f0-9]{7} \(HEAD -> main\) test\n$/);
		});

		test("no decoration on commits without refs", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add README.md");
			await bash.exec('git commit -m "first"');
			await bash.exec("git add src/main.ts");
			await bash.exec('git commit -m "second"');

			const log = await bash.exec("git log --decorate --oneline");
			const lines = log.stdout.trim().split("\n");
			expect(lines.length).toBe(2);
			// Only the latest commit (HEAD) has decoration
			expect(lines[0]).toContain("(HEAD -> main)");
			expect(lines[1]).not.toContain("(");
		});
	});

	describe("combined filters", () => {
		test("--all with --author", async () => {
			const bash = createTestBash({ files: BASIC_REPO });
			await bash.exec("git init");
			await bash.exec("git add README.md");
			await bash.exec('git commit -m "alice on main"', {
				env: {
					...TEST_ENV,
					GIT_AUTHOR_NAME: "Alice",
					GIT_AUTHOR_EMAIL: "alice@test.com",
				},
			});
			await bash.exec("git checkout -b feature");
			await bash.exec("git add src/main.ts");
			await bash.exec('git commit -m "bob on feature"', {
				env: {
					...TEST_ENV,
					GIT_AUTHOR_NAME: "Bob",
					GIT_AUTHOR_EMAIL: "bob@test.com",
				},
			});

			const log = await bash.exec("git log --all --oneline --author=Bob");
			const lines = log.stdout.trim().split("\n");
			expect(lines.length).toBe(1);
			expect(lines[0]).toContain("bob on feature");
		});

		test("--grep with -n", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add README.md");
			await bash.exec('git commit -m "fix: bug 1"');
			await bash.exec("git add src/main.ts");
			await bash.exec('git commit -m "fix: bug 2"');
			await bash.exec("git add src/util.ts");
			await bash.exec('git commit -m "feat: new"');

			const log = await bash.exec("git log --oneline --grep=fix -n 1");
			const lines = log.stdout.trim().split("\n");
			expect(lines.length).toBe(1);
			expect(lines[0]).toContain("fix: bug 2");
		});

		test("path filter with --all", async () => {
			const bash = createTestBash({ files: BASIC_REPO });
			await bash.exec("git init");
			await bash.exec("git add README.md");
			await bash.exec('git commit -m "readme on main"', {
				env: TEST_ENV,
			});
			await bash.exec("git checkout -b docs-branch");
			await bash.exec("git add src/main.ts");
			await bash.exec('git commit -m "main.ts on docs"', {
				env: TEST_ENV,
			});

			const log = await bash.exec("git log --all --oneline -- README.md");
			const lines = log.stdout.trim().split("\n");
			expect(lines.length).toBe(1);
			expect(lines[0]).toContain("readme on main");
		});
	});

	describe("range syntax", () => {
		function setupDivergedBranches() {
			const bash = createTestBash({ files: BASIC_REPO });
			return {
				bash,
				init: async () => {
					await bash.exec("git init");
					await bash.exec("git add README.md");
					await bash.exec('git commit -m "initial"', { env: TEST_ENV });

					await bash.exec("git checkout -b feature");
					await bash.exec("echo 'feature1' > feat.txt");
					await bash.exec("git add feat.txt");
					await bash.exec('git commit -m "feature commit 1"', {
						env: TEST_ENV,
					});
					await bash.exec("echo 'feature2' >> feat.txt");
					await bash.exec("git add feat.txt");
					await bash.exec('git commit -m "feature commit 2"', {
						env: TEST_ENV,
					});

					await bash.exec("git checkout main");
					await bash.exec("echo 'main work' > main.txt");
					await bash.exec("git add main.txt");
					await bash.exec('git commit -m "main commit"', {
						env: TEST_ENV,
					});
				},
			};
		}

		test("A..B shows commits on B not reachable from A", async () => {
			const { bash, init } = setupDivergedBranches();
			await init();

			const log = await bash.exec("git log main..feature --oneline");
			expect(log.exitCode).toBe(0);
			const lines = log.stdout.trim().split("\n");
			expect(lines.length).toBe(2);
			expect(lines[0]).toContain("feature commit 2");
			expect(lines[1]).toContain("feature commit 1");
		});

		test("A..B in the other direction", async () => {
			const { bash, init } = setupDivergedBranches();
			await init();

			const log = await bash.exec("git log feature..main --oneline");
			expect(log.exitCode).toBe(0);
			const lines = log.stdout.trim().split("\n");
			expect(lines.length).toBe(1);
			expect(lines[0]).toContain("main commit");
		});

		test("A...B shows commits on either side but not shared", async () => {
			const { bash, init } = setupDivergedBranches();
			await init();

			const log = await bash.exec("git log main...feature --oneline");
			expect(log.exitCode).toBe(0);
			const lines = log.stdout.trim().split("\n");
			expect(lines.length).toBe(3);
			const messages = lines.map((l) => l.split(" ").slice(1).join(" "));
			expect(messages).toContain("feature commit 2");
			expect(messages).toContain("feature commit 1");
			expect(messages).toContain("main commit");
		});

		test("empty left defaults to HEAD (..B)", async () => {
			const { bash, init } = setupDivergedBranches();
			await init();
			// HEAD is on main, so ..feature = main..feature
			const log = await bash.exec("git log ..feature --oneline");
			expect(log.exitCode).toBe(0);
			const lines = log.stdout.trim().split("\n");
			expect(lines.length).toBe(2);
			expect(lines[0]).toContain("feature commit 2");
			expect(lines[1]).toContain("feature commit 1");
		});

		test("empty right defaults to HEAD (A..)", async () => {
			const { bash, init } = setupDivergedBranches();
			await init();
			// HEAD is on main, so feature.. = feature..main
			const log = await bash.exec("git log feature.. --oneline");
			expect(log.exitCode).toBe(0);
			const lines = log.stdout.trim().split("\n");
			expect(lines.length).toBe(1);
			expect(lines[0]).toContain("main commit");
		});

		test("same ref yields empty output", async () => {
			const { bash, init } = setupDivergedBranches();
			await init();

			const log = await bash.exec("git log main..main --oneline");
			expect(log.exitCode).toBe(0);
			expect(log.stdout.trim()).toBe("");
		});

		test("works with --reverse", async () => {
			const { bash, init } = setupDivergedBranches();
			await init();

			const log = await bash.exec("git log main..feature --oneline --reverse");
			expect(log.exitCode).toBe(0);
			const lines = log.stdout.trim().split("\n");
			expect(lines.length).toBe(2);
			expect(lines[0]).toContain("feature commit 1");
			expect(lines[1]).toContain("feature commit 2");
		});

		test("works with -n limit", async () => {
			const { bash, init } = setupDivergedBranches();
			await init();

			const log = await bash.exec("git log main..feature --oneline -n 1");
			expect(log.exitCode).toBe(0);
			const lines = log.stdout.trim().split("\n");
			expect(lines.length).toBe(1);
			expect(lines[0]).toContain("feature commit 2");
		});

		test("works with -- <path> filtering", async () => {
			const { bash, init } = setupDivergedBranches();
			await init();

			const log = await bash.exec("git log main..feature --oneline -- feat.txt");
			expect(log.exitCode).toBe(0);
			const lines = log.stdout.trim().split("\n");
			expect(lines.length).toBe(2);
			expect(lines[0]).toContain("feature commit 2");

			const noMatch = await bash.exec("git log main..feature --oneline -- nonexistent.txt");
			expect(noMatch.exitCode).toBe(0);
			expect(noMatch.stdout.trim()).toBe("");
		});

		test("invalid revision in range returns fatal error", async () => {
			const { bash, init } = setupDivergedBranches();
			await init();

			const log = await bash.exec("git log badref..main --oneline");
			expect(log.exitCode).toBe(128);
			expect(log.stderr).toContain("unknown revision");
		});

		test("A...B excludes shared ancestor commits", async () => {
			const { bash, init } = setupDivergedBranches();
			await init();

			const log = await bash.exec("git log main...feature --oneline");
			expect(log.exitCode).toBe(0);
			const lines = log.stdout.trim().split("\n");
			const messages = lines.map((l) => l.split(" ").slice(1).join(" "));
			expect(messages).not.toContain("initial");
		});

		test("range with --all still applies exclusion", async () => {
			const { bash, init } = setupDivergedBranches();
			await init();

			const log = await bash.exec("git log main..feature --all --oneline");
			expect(log.exitCode).toBe(0);
			const lines = log.stdout.trim().split("\n");
			expect(lines.length).toBe(2);
			expect(lines[0]).toContain("feature commit 2");
			expect(lines[1]).toContain("feature commit 1");
		});
	});

	describe("diff output flags", () => {
		function setupDiffRepo() {
			const bash = createTestBash();
			const init = async () => {
				await bash.exec("git init", { env: TEST_ENV });
				await bash.fs.writeFile("/repo/a.txt", "hello\n");
				await bash.fs.writeFile("/repo/b.txt", "world\n");
				await bash.exec("git add .", { env: TEST_ENV });
				await bash.exec('git commit -m "initial"', { env: TEST_ENV });
				await bash.fs.writeFile("/repo/a.txt", "modified\n");
				await bash.fs.writeFile("/repo/c.txt", "new file\n");
				await bash.exec("git add .", { env: TEST_ENV });
				await bash.exec('git commit -m "second"', { env: TEST_ENV });
				await bash.exec("git rm b.txt", { env: TEST_ENV });
				await bash.exec('git commit -m "third"', { env: TEST_ENV });
			};
			return { bash, init };
		}

		test("--name-status shows status letters with filenames", async () => {
			const { bash, init } = setupDiffRepo();
			await init();

			const log = await bash.exec("git log --name-status", { env: TEST_ENV });
			expect(log.exitCode).toBe(0);
			expect(log.stdout).toContain("D\tb.txt");
			expect(log.stdout).toContain("M\ta.txt");
			expect(log.stdout).toContain("A\tc.txt");
			expect(log.stdout).toContain("A\ta.txt");
			expect(log.stdout).toContain("A\tb.txt");
		});

		test("--name-only shows only filenames", async () => {
			const { bash, init } = setupDiffRepo();
			await init();

			const log = await bash.exec("git log --name-only -1", { env: TEST_ENV });
			expect(log.exitCode).toBe(0);
			expect(log.stdout).toContain("b.txt");
			expect(log.stdout).not.toContain("D\t");
		});

		test("--stat shows diffstat table", async () => {
			const { bash, init } = setupDiffRepo();
			await init();

			const log = await bash.exec("git log --stat -1", { env: TEST_ENV });
			expect(log.exitCode).toBe(0);
			expect(log.stdout).toContain("b.txt");
			expect(log.stdout).toContain("1 file changed");
			expect(log.stdout).toContain("1 deletion(-)");
		});

		test("--shortstat shows only summary line", async () => {
			const { bash, init } = setupDiffRepo();
			await init();

			const log = await bash.exec("git log --shortstat -1", { env: TEST_ENV });
			expect(log.exitCode).toBe(0);
			expect(log.stdout).toContain("1 file changed");
			expect(log.stdout).not.toContain("|");
		});

		test("--numstat shows machine-readable output", async () => {
			const { bash, init } = setupDiffRepo();
			await init();

			const log = await bash.exec("git log --numstat -1", { env: TEST_ENV });
			expect(log.exitCode).toBe(0);
			expect(log.stdout).toContain("0\t1\tb.txt");
		});

		test("-p / --patch shows unified diff", async () => {
			const { bash, init } = setupDiffRepo();
			await init();

			const log = await bash.exec("git log -p -1", { env: TEST_ENV });
			expect(log.exitCode).toBe(0);
			expect(log.stdout).toContain("diff --git a/b.txt b/b.txt");
			expect(log.stdout).toContain("deleted file mode");
			expect(log.stdout).toContain("-world");
		});

		test("--patch alias works", async () => {
			const { bash, init } = setupDiffRepo();
			await init();

			const log = await bash.exec("git log --patch -1", { env: TEST_ENV });
			expect(log.exitCode).toBe(0);
			expect(log.stdout).toContain("diff --git");
		});

		test("merge commits produce no diff output", async () => {
			const bash = createTestBash();
			await bash.exec("git init", { env: TEST_ENV });
			await bash.fs.writeFile("/repo/base.txt", "base\n");
			await bash.exec("git add .", { env: TEST_ENV });
			await bash.exec('git commit -m "base"', { env: TEST_ENV });
			await bash.exec("git checkout -b feature", { env: TEST_ENV });
			await bash.fs.writeFile("/repo/feat.txt", "feature\n");
			await bash.exec("git add .", { env: TEST_ENV });
			await bash.exec('git commit -m "feature"', { env: TEST_ENV });
			await bash.exec("git checkout main", { env: TEST_ENV });
			await bash.fs.writeFile("/repo/main.txt", "main\n");
			await bash.exec("git add .", { env: TEST_ENV });
			await bash.exec('git commit -m "main change"', { env: TEST_ENV });
			await bash.exec("git merge feature --no-ff", { env: TEST_ENV });

			const log = await bash.exec("git log --name-status -1", { env: TEST_ENV });
			expect(log.exitCode).toBe(0);
			expect(log.stdout).toContain("Merge:");
			expect(log.stdout).not.toContain("\tbase.txt");
			expect(log.stdout).not.toContain("\tfeat.txt");
			expect(log.stdout).not.toContain("\tmain.txt");
		});

		test("--name-status works with --oneline (no blank line separator)", async () => {
			const { bash, init } = setupDiffRepo();
			await init();

			const log = await bash.exec("git log --name-status --oneline -1", { env: TEST_ENV });
			expect(log.exitCode).toBe(0);
			const lines = log.stdout.trim().split("\n");
			expect(lines[0]).toMatch(/^[a-f0-9]+ third$/);
			expect(lines[1]).toBe("D\tb.txt");
		});

		test("--name-status works with --format", async () => {
			const { bash, init } = setupDiffRepo();
			await init();

			const log = await bash.exec('git log --name-status --format="%h %s" -1', {
				env: TEST_ENV,
			});
			expect(log.exitCode).toBe(0);
			const lines = log.stdout.trim().split("\n");
			expect(lines[0]).toMatch(/^[a-f0-9]+ third$/);
			expect(lines[1]).toBe("");
			expect(lines[2]).toBe("D\tb.txt");
		});

		test("root commit shows all files as Added", async () => {
			const { bash, init } = setupDiffRepo();
			await init();

			const log = await bash.exec("git log --name-status --oneline", { env: TEST_ENV });
			expect(log.exitCode).toBe(0);
			const output = log.stdout;
			const lastCommitSection = output.slice(output.lastIndexOf("initial"));
			expect(lastCommitSection).toContain("A\ta.txt");
			expect(lastCommitSection).toContain("A\tb.txt");
		});

		test("--name-status shows all commits in multi-commit log", async () => {
			const { bash, init } = setupDiffRepo();
			await init();

			const log = await bash.exec("git log --name-status --oneline", { env: TEST_ENV });
			expect(log.exitCode).toBe(0);
			const lines = log.stdout.trim().split("\n");
			expect(lines.some((l) => l === "D\tb.txt")).toBe(true);
			expect(lines.some((l) => l === "M\ta.txt")).toBe(true);
			expect(lines.some((l) => l === "A\tc.txt")).toBe(true);
		});

		test("--stat with multiple commits", async () => {
			const { bash, init } = setupDiffRepo();
			await init();

			const log = await bash.exec("git log --stat", { env: TEST_ENV });
			expect(log.exitCode).toBe(0);
			const matches = log.stdout.match(/file(s?) changed/g);
			expect(matches).not.toBeNull();
			expect(matches!.length).toBe(3);
		});
	});

	describe("--pretty=raw / --format=raw", () => {
		test("shows tree hash and raw author/committer lines", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "initial commit"', "git log --pretty=raw"],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			const log = results[3];
			expect(log.exitCode).toBe(0);
			expect(log.stdout).toMatch(/^commit [a-f0-9]{40}\n/);
			expect(log.stdout).toMatch(/tree [a-f0-9]{40}/);
			expect(log.stdout).toMatch(/author Test Author <author@test\.com> 1000000000 \+0000/);
			expect(log.stdout).toMatch(
				/committer Test Committer <committer@test\.com> 1000000000 \+0000/,
			);
			expect(log.stdout).toContain("    initial commit");
			expect(log.stdout).not.toContain("Date:");
			expect(log.stdout).not.toContain("Author:");
		});

		test("--format=raw is equivalent", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "test"', "git log --format=raw"],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			const log = results[3];
			expect(log.exitCode).toBe(0);
			expect(log.stdout).toMatch(/tree [a-f0-9]{40}/);
			expect(log.stdout).toMatch(/author Test Author <author@test\.com>/);
		});

		test("root commit has no parent line", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "root"', "git log --pretty=raw"],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			const log = results[3];
			expect(log.stdout).not.toContain("parent ");
		});

		test("non-root commit shows parent hash", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add README.md");
			await bash.exec('git commit -m "first"');
			await bash.exec("git add src/main.ts");
			await bash.exec('git commit -m "second"');

			const log = await bash.exec("git log --pretty=raw -n1");
			expect(log.stdout).toMatch(/parent [a-f0-9]{40}/);
		});

		test("merge commit shows two parent lines", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add README.md");
			await bash.exec('git commit -m "base"');
			await bash.exec("git checkout -b feature");
			await bash.exec("git add src/main.ts");
			await bash.exec('git commit -m "feature"');
			await bash.exec("git checkout main");
			await bash.exec("git add src/util.ts");
			await bash.exec('git commit -m "main work"');
			await bash.exec('git merge feature -m "merge"');

			const log = await bash.exec("git log --pretty=raw -n1");
			const parentLines = log.stdout.split("\n").filter((l) => l.startsWith("parent "));
			expect(parentLines.length).toBe(2);
			for (const line of parentLines) {
				expect(line).toMatch(/^parent [a-f0-9]{40}$/);
			}
		});
	});

	describe("relative date placeholders (%ar, %cr)", () => {
		test("%ar outputs a relative date string", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "test"', 'git log --format="%ar"'],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			const log = results[3];
			expect(log.exitCode).toBe(0);
			expect(log.stdout.trim()).toMatch(/ago$/);
			expect(log.stdout.trim()).not.toBe("%ar");
		});

		test("%cr outputs a relative date string", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "test"', 'git log --format="%cr"'],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			const log = results[3];
			expect(log.exitCode).toBe(0);
			expect(log.stdout.trim()).toMatch(/ago$/);
			expect(log.stdout.trim()).not.toBe("%cr");
		});

		test("%ar and %cr together in format string", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "test"', 'git log --format="a:%ar c:%cr"'],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			const log = results[3];
			expect(log.exitCode).toBe(0);
			expect(log.stdout.trim()).toMatch(/^a:.*ago c:.*ago$/);
		});

		test("%aR and %cR are not valid placeholders (output literally)", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "test"', 'git log --format="%aR %cR"'],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			const log = results[3];
			expect(log.exitCode).toBe(0);
			expect(log.stdout.trim()).toBe("%aR %cR");
		});
	});

	describe("--first-parent", () => {
		async function setupMergeHistory() {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.exec('echo "second" > /repo/file.txt');
			await bash.exec("git add .");
			await bash.exec('git commit -m "second"');
			// Create feature branch with two commits
			await bash.exec("git checkout -b feature");
			await bash.exec('echo "feat1" > /repo/feature.txt');
			await bash.exec("git add .");
			await bash.exec('git commit -m "feature-1"');
			await bash.exec('echo "feat2" >> /repo/feature.txt');
			await bash.exec("git add .");
			await bash.exec('git commit -m "feature-2"');
			// Back to main, add a commit, then merge
			await bash.exec("git checkout main");
			await bash.exec('echo "main-work" > /repo/main.txt');
			await bash.exec("git add .");
			await bash.exec('git commit -m "main-work"');
			await bash.exec('git merge feature -m "merge-feature"');
			return bash;
		}

		test("on linear history shows all commits", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');
			await bash.exec('echo "change" > /repo/file.txt');
			await bash.exec("git add .");
			await bash.exec('git commit -m "second"');

			const result = await bash.exec("git log --first-parent --oneline");
			expect(result.exitCode).toBe(0);
			const lines = result.stdout.trim().split("\n");
			expect(lines).toHaveLength(2);
			expect(lines[0]).toContain("second");
			expect(lines[1]).toContain("first");
		});

		test("skips second-parent branch after merge", async () => {
			const bash = await setupMergeHistory();

			const result = await bash.exec("git log --first-parent --oneline");
			expect(result.exitCode).toBe(0);
			const lines = result.stdout.trim().split("\n");
			const messages = lines.map((l) => l.slice(l.indexOf(" ") + 1));
			expect(messages).toEqual(["merge-feature", "main-work", "second", "initial"]);
		});

		test("combines with -n limit", async () => {
			const bash = await setupMergeHistory();

			const result = await bash.exec("git log --first-parent --oneline -n2");
			expect(result.exitCode).toBe(0);
			const lines = result.stdout.trim().split("\n");
			expect(lines).toHaveLength(2);
			expect(lines[0]).toContain("merge-feature");
			expect(lines[1]).toContain("main-work");
		});

		test("combines with --reverse", async () => {
			const bash = await setupMergeHistory();

			const result = await bash.exec("git log --first-parent --reverse --oneline");
			expect(result.exitCode).toBe(0);
			const lines = result.stdout.trim().split("\n");
			const messages = lines.map((l) => l.slice(l.indexOf(" ") + 1));
			expect(messages).toEqual(["initial", "second", "main-work", "merge-feature"]);
		});

		test("without --first-parent includes feature branch commits", async () => {
			const bash = await setupMergeHistory();

			const result = await bash.exec("git log --oneline");
			expect(result.exitCode).toBe(0);
			const output = result.stdout;
			expect(output).toContain("feature-1");
			expect(output).toContain("feature-2");
		});
	});

	describe("--date", () => {
		async function setupRepo() {
			const { results, bash } = await runScenario(
				["git init", "git add .", 'git commit -m "test commit"'],
				{ files: BASIC_REPO, env: TEST_ENV },
			);
			expect(results[2]!.exitCode).toBe(0);
			return bash;
		}

		test("--date=short shows YYYY-MM-DD only", async () => {
			const bash = await setupRepo();
			const result = await bash.exec("git log -1 --date=short");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toMatch(/Date:\s+\d{4}-\d{2}-\d{2}\n/);
			expect(result.stdout).toContain("Date:   2001-09-09");
		});

		test("--date=iso shows ISO-like format", async () => {
			const bash = await setupRepo();
			const result = await bash.exec("git log -1 --date=iso");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("2001-09-09 01:46:40 +0000");
		});

		test("--date=iso-strict shows strict ISO 8601 with Z for UTC", async () => {
			const bash = await setupRepo();
			const result = await bash.exec("git log -1 --date=iso-strict");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("2001-09-09T01:46:40Z");
		});

		test("--date=raw shows timestamp and timezone", async () => {
			const bash = await setupRepo();
			const result = await bash.exec("git log -1 --date=raw");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Date:   1000000000 +0000");
		});

		test("--date=unix shows bare timestamp", async () => {
			const bash = await setupRepo();
			const result = await bash.exec("git log -1 --date=unix");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toMatch(/Date:\s+1000000000\n/);
		});

		test("--date=rfc shows RFC 2822 format", async () => {
			const bash = await setupRepo();
			const result = await bash.exec("git log -1 --date=rfc");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toMatch(/Date:\s+Sun, 9 Sep 2001 01:46:40 \+0000/);
		});

		test("--date=relative shows relative time", async () => {
			const bash = await setupRepo();
			const result = await bash.exec("git log -1 --date=relative");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toMatch(/Date:\s+\d+ years/);
		});

		test("--date=default shows standard git date", async () => {
			const bash = await setupRepo();
			const result = await bash.exec("git log -1 --date=default");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Sun Sep 9 01:46:40 2001 +0000");
		});

		test("--date=local shows date in local timezone without tz suffix", async () => {
			const bash = await setupRepo();
			const result = await bash.exec("git log -1 --date=local");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toMatch(/Date:\s+\w{3} \w{3} \d+ \d{2}:\d{2}:\d{2} \d{4}\n/);
			expect(result.stdout).not.toMatch(/\+0000\n/);
		});

		test("--date affects %ad in custom format", async () => {
			const bash = await setupRepo();
			const result = await bash.exec('git log -1 --format="%ad" --date=short');
			expect(result.exitCode).toBe(0);
			expect(result.stdout.trim()).toBe("2001-09-09");
		});

		test("--date does not affect %aI (always ISO strict)", async () => {
			const bash = await setupRepo();
			const result = await bash.exec('git log -1 --format="%aI" --date=short');
			expect(result.exitCode).toBe(0);
			expect(result.stdout.trim()).toBe("2001-09-09T01:46:40Z");
		});

		test("invalid --date value returns error", async () => {
			const bash = await setupRepo();
			const result = await bash.exec("git log -1 --date=bogus");
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("unknown date format bogus");
		});
	});
});
