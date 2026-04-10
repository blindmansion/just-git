import { describe, expect, test } from "bun:test";
import { EMPTY_REPO } from "../fixtures";
import { runScenario } from "../util";

const ALICE_ENV = {
	GIT_AUTHOR_NAME: "Alice",
	GIT_AUTHOR_EMAIL: "alice@example.com",
	GIT_COMMITTER_NAME: "Alice",
	GIT_COMMITTER_EMAIL: "alice@example.com",
	GIT_AUTHOR_DATE: "1000000000",
	GIT_COMMITTER_DATE: "1000000000",
};

async function setupMultiAuthorRepo() {
	return runScenario(
		[
			"git init",
			"git add .",
			'git commit -m "Initial commit"',
			'git commit --allow-empty -m "Second commit"',
			'GIT_AUTHOR_NAME=Bob GIT_AUTHOR_EMAIL=bob@example.com GIT_COMMITTER_NAME=Bob GIT_COMMITTER_EMAIL=bob@example.com git commit --allow-empty -m "Bob first"',
			'git commit --allow-empty -m "Third commit"',
			'GIT_AUTHOR_NAME=Bob GIT_AUTHOR_EMAIL=bob@example.com GIT_COMMITTER_NAME=Bob GIT_COMMITTER_EMAIL=bob@example.com git commit --allow-empty -m "Bob second"',
		],
		{ files: EMPTY_REPO, env: ALICE_ENV },
	);
}

describe("git shortlog", () => {
	describe("default output", () => {
		test("groups commits by author with subject lines", async () => {
			const { bash } = await setupMultiAuthorRepo();
			const r = await bash.exec("git shortlog HEAD");
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toContain("Alice (3):");
			expect(r.stdout).toContain("      Initial commit\n");
			expect(r.stdout).toContain("Bob (2):");
			expect(r.stdout).toContain("      Bob first\n");
		});

		test("sorts alphabetically by default", async () => {
			const { bash } = await setupMultiAuthorRepo();
			const r = await bash.exec("git shortlog HEAD");
			const aliceIdx = r.stdout.indexOf("Alice");
			const bobIdx = r.stdout.indexOf("Bob");
			expect(aliceIdx).toBeLessThan(bobIdx);
		});

		test("separates groups with blank line", async () => {
			const { bash } = await setupMultiAuthorRepo();
			const r = await bash.exec("git shortlog HEAD");
			expect(r.stdout).toContain("\n\nBob");
		});

		test("uses 6-space indent for subjects", async () => {
			const { bash } = await setupMultiAuthorRepo();
			const r = await bash.exec("git shortlog HEAD");
			const lines = r.stdout.split("\n");
			const subjectLines = lines.filter((l) => l.startsWith("      "));
			expect(subjectLines.length).toBe(5);
		});
	});

	describe("-s (summary)", () => {
		test("outputs count and name only", async () => {
			const { bash } = await setupMultiAuthorRepo();
			const r = await bash.exec("git shortlog -s HEAD");
			expect(r.exitCode).toBe(0);
			const lines = r.stdout.trimEnd().split("\n");
			expect(lines.length).toBe(2);
			expect(lines[0]).toMatch(/^\s+3\tAlice$/);
			expect(lines[1]).toMatch(/^\s+2\tBob$/);
		});

		test("right-aligns count in 6-char field", async () => {
			const { bash } = await setupMultiAuthorRepo();
			const r = await bash.exec("git shortlog -s HEAD");
			const lines = r.stdout.trimEnd().split("\n");
			expect(lines[0]).toBe("     3\tAlice");
		});
	});

	describe("-n (numbered)", () => {
		test("sorts by commit count descending", async () => {
			const { bash } = await setupMultiAuthorRepo();
			const r = await bash.exec("git shortlog -sn HEAD");
			const lines = r.stdout.trimEnd().split("\n");
			expect(lines[0]).toMatch(/3\tAlice/);
			expect(lines[1]).toMatch(/2\tBob/);
		});

		test("breaks ties alphabetically", async () => {
			await runScenario(
				[
					"git init",
					"git add .",
					'git commit -m "init"',
					'GIT_AUTHOR_NAME=Zara GIT_AUTHOR_EMAIL=z@z.com GIT_COMMITTER_NAME=Zara GIT_COMMITTER_EMAIL=z@z.com git commit --allow-empty -m "z1"',
				],
				{ files: EMPTY_REPO, env: ALICE_ENV },
			);
			await (await runScenario([], { files: EMPTY_REPO, env: ALICE_ENV })).bash.exec("git init");
			// Both have 1 commit each — need same bash instance
			const { bash: b } = await runScenario(
				[
					"git init",
					"git add .",
					'git commit -m "a commit"',
					'GIT_AUTHOR_NAME=Zara GIT_AUTHOR_EMAIL=z@z.com GIT_COMMITTER_NAME=Zara GIT_COMMITTER_EMAIL=z@z.com git commit --allow-empty -m "z commit"',
				],
				{ files: EMPTY_REPO, env: ALICE_ENV },
			);
			const r = await b.exec("git shortlog -sn HEAD");
			const lines = r.stdout.trimEnd().split("\n");
			expect(lines[0]).toMatch(/Alice/);
			expect(lines[1]).toMatch(/Zara/);
		});
	});

	describe("-e (email)", () => {
		test("includes email in default mode", async () => {
			const { bash } = await setupMultiAuthorRepo();
			const r = await bash.exec("git shortlog -e HEAD");
			expect(r.stdout).toContain("Alice <alice@example.com> (3):");
			expect(r.stdout).toContain("Bob <bob@example.com> (2):");
		});

		test("includes email in summary mode", async () => {
			const { bash } = await setupMultiAuthorRepo();
			const r = await bash.exec("git shortlog -sne HEAD");
			const lines = r.stdout.trimEnd().split("\n");
			expect(lines[0]).toMatch(/Alice <alice@example.com>/);
			expect(lines[1]).toMatch(/Bob <bob@example.com>/);
		});
	});

	describe("--group=committer", () => {
		test("groups by committer instead of author", async () => {
			const { results } = await runScenario(
				[
					"git init",
					"git add .",
					'git commit -m "init"',
					'GIT_AUTHOR_NAME=Author GIT_AUTHOR_EMAIL=author@x.com git commit --allow-empty -m "different author"',
					"git shortlog -s --group=committer HEAD",
				],
				{ files: EMPTY_REPO, env: ALICE_ENV },
			);
			const r = results[4]!;
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toContain("2\tAlice");
			expect(r.stdout).not.toContain("Author");
		});
	});

	describe("--format", () => {
		test("uses format string for each commit line", async () => {
			const { bash } = await setupMultiAuthorRepo();
			const r = await bash.exec('git shortlog --format="%h %s" HEAD');
			expect(r.exitCode).toBe(0);
			const lines = r.stdout.split("\n").filter((l) => l.startsWith("      "));
			for (const line of lines) {
				expect(line.trimStart()).toMatch(/^[0-9a-f]+ .+$/);
			}
		});
	});

	describe("--no-merges", () => {
		test("excludes merge commits", async () => {
			const { bash } = await runScenario(
				[
					"git init",
					"git add .",
					'git commit -m "init"',
					"git checkout -b feature",
					'git commit --allow-empty -m "feature"',
					"git checkout main",
					'git commit --allow-empty -m "main advance"',
					"git merge feature --no-ff -m 'Merge feature'",
				],
				{ files: EMPTY_REPO, env: ALICE_ENV },
			);
			const withMerges = await bash.exec("git shortlog -s HEAD");
			const withoutMerges = await bash.exec("git shortlog -s --no-merges HEAD");
			const countWith = parseInt(withMerges.stdout.trim().split("\t")[0]!.trim());
			const countWithout = parseInt(withoutMerges.stdout.trim().split("\t")[0]!.trim());
			expect(countWithout).toBe(countWith - 1);
		});
	});

	describe("revision ranges", () => {
		test("supports A..B range", async () => {
			const { bash } = await setupMultiAuthorRepo();
			const r = await bash.exec("git shortlog -s HEAD~2..HEAD");
			expect(r.exitCode).toBe(0);
			const total = r.stdout
				.trimEnd()
				.split("\n")
				.reduce((sum, line) => sum + parseInt(line.trim().split("\t")[0]!), 0);
			expect(total).toBe(2);
		});
	});

	describe("--all", () => {
		test("walks all refs", async () => {
			const { bash } = await runScenario(
				[
					"git init",
					"git add .",
					'git commit -m "init"',
					"git checkout -b other",
					'git commit --allow-empty -m "on other"',
				],
				{ files: EMPTY_REPO, env: ALICE_ENV },
			);
			const r = await bash.exec("git shortlog -s --all");
			expect(r.exitCode).toBe(0);
			const count = parseInt(r.stdout.trim().split("\t")[0]!.trim());
			expect(count).toBe(2);
		});
	});

	describe("pathspec filtering", () => {
		test("filters commits by path", async () => {
			const { bash } = await runScenario(
				[
					"git init",
					"git add .",
					'git commit -m "init with readme"',
					"echo 'fn main(){}' > /repo/src/main.ts",
					"git add .",
					'git commit -m "add main.ts"',
					'git commit --allow-empty -m "empty commit"',
				],
				{
					files: { "/repo/README.md": "# Hello" },
					env: ALICE_ENV,
				},
			);
			const r = await bash.exec("git shortlog -s HEAD -- src/main.ts");
			expect(r.exitCode).toBe(0);
			const count = parseInt(r.stdout.trim().split("\t")[0]!.trim());
			expect(count).toBe(1);
		});
	});

	describe("empty repo", () => {
		test("fatal on no commits", async () => {
			const { results } = await runScenario(["git init", "git shortlog HEAD"], {
				files: EMPTY_REPO,
				env: ALICE_ENV,
			});
			expect(results[1]!.exitCode).not.toBe(0);
		});
	});

	describe("single author", () => {
		test("works with single author", async () => {
			const { results } = await runScenario(
				[
					"git init",
					"git add .",
					'git commit -m "first"',
					'git commit --allow-empty -m "second"',
					"git shortlog -s HEAD",
				],
				{ files: EMPTY_REPO, env: ALICE_ENV },
			);
			const r = results[4]!;
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toBe("     2\tAlice\n");
		});
	});
});
