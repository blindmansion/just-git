import { describe, expect, test } from "bun:test";
import { BASIC_REPO, EMPTY_REPO, TEST_ENV_NAMED as TEST_ENV } from "../fixtures";
import { createTestBash, quickExec, runScenario } from "../util";

describe("git show", () => {
	describe("outside a git repo", () => {
		test("fails with exit 128", async () => {
			const result = await quickExec("git show", { files: EMPTY_REPO });
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("not a git repository");
		});
	});

	describe("no commits", () => {
		test("fails with exit 128", async () => {
			const { results } = await runScenario(["git init", "git show"], {
				files: EMPTY_REPO,
			});
			expect(results[1].exitCode).toBe(128);
			expect(results[1].stderr).toContain("does not have any commits yet");
		});
	});

	describe("bad revision", () => {
		test("fails with exit 128 for nonexistent ref", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "first"', "git show nonexistent"],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			expect(results[3].exitCode).toBe(128);
			expect(results[3].stderr).toContain("bad object");
		});
	});

	describe("show commit (default HEAD)", () => {
		test("shows commit header with hash, author, date, message", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "initial commit"', "git show"],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			const show = results[3];
			expect(show.exitCode).toBe(0);
			expect(show.stdout).toMatch(/commit [a-f0-9]{40}/);
			expect(show.stdout).toContain("Author: Test Author <author@test.com>");
			expect(show.stdout).toContain("Date:");
			expect(show.stdout).toContain("    initial commit");
		});

		test("includes diff against empty tree for root commit", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "initial"', "git show"],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			const show = results[3];
			expect(show.exitCode).toBe(0);
			// Should show the README.md being added
			expect(show.stdout).toContain("diff --git a/README.md b/README.md");
			expect(show.stdout).toContain("new file mode");
			expect(show.stdout).toContain("+# My Project");
		});

		test("includes diff against parent for non-root commit", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add README.md");
			await bash.exec('git commit -m "first"');
			await bash.exec("git add src/main.ts");
			await bash.exec('git commit -m "add main"');

			const show = await bash.exec("git show");
			expect(show.exitCode).toBe(0);
			expect(show.stdout).toContain("    add main");
			expect(show.stdout).toContain("diff --git a/src/main.ts b/src/main.ts");
			expect(show.stdout).toContain("new file mode");
			// Should NOT contain README.md diff (that was in first commit)
			expect(show.stdout).not.toContain("diff --git a/README.md b/README.md");
		});
	});

	describe("show commit by hash", () => {
		test("shows specific commit when given a full hash", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add README.md");
			await bash.exec('git commit -m "first"');
			await bash.exec("git add src/main.ts");
			await bash.exec('git commit -m "second"');

			// Extract the full hash of the first commit from git log
			const log = await bash.exec("git log");
			const hashes = [...log.stdout.matchAll(/commit ([a-f0-9]{40})/g)].map((m) => m[1] as string);
			const firstHash = hashes[1] as string; // second in log = first chronologically

			const show = await bash.exec(`git show ${firstHash}`);
			expect(show.exitCode).toBe(0);
			expect(show.stdout).toContain("    first");
			expect(show.stdout).toContain("diff --git a/README.md b/README.md");
		});
	});

	describe("show merge commit", () => {
		test("shows Merge line and no diff for merge commits", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add README.md");
			await bash.exec('git commit -m "initial"');

			await bash.exec("git checkout -b feature");
			await bash.exec("git add src/main.ts");
			await bash.exec('git commit -m "feature work"');

			await bash.exec("git checkout main");
			await bash.exec("git add src/util.ts");
			await bash.exec('git commit -m "main work"');

			await bash.exec("git merge --no-ff feature");

			const show = await bash.exec("git show");
			expect(show.exitCode).toBe(0);
			expect(show.stdout).toContain("Merge:");
			// Merge commits should NOT include diff output
			expect(show.stdout).not.toContain("diff --git");
		});
	});

	describe("show annotated tag", () => {
		test("shows tag info then commit info", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.exec('git tag -a v1.0 -m "release 1.0"');

			const show = await bash.exec("git show v1.0");
			expect(show.exitCode).toBe(0);
			expect(show.stdout).toContain("tag v1.0");
			expect(show.stdout).toContain("Tagger: Test Committer <committer@test.com>");
			expect(show.stdout).toContain("    release 1.0");
			// Should also show the commit
			expect(show.stdout).toMatch(/commit [a-f0-9]{40}/);
			expect(show.stdout).toContain("    initial");
			// And the commit's diff
			expect(show.stdout).toContain("diff --git a/README.md b/README.md");
		});
	});

	describe("show lightweight tag", () => {
		test("resolves to commit and shows commit", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.exec("git tag v1.0");

			const show = await bash.exec("git show v1.0");
			expect(show.exitCode).toBe(0);
			// Lightweight tag points directly to commit, no tag header
			expect(show.stdout).not.toContain("tag v1.0");
			expect(show.stdout).toMatch(/commit [a-f0-9]{40}/);
			expect(show.stdout).toContain("    initial");
		});
	});

	describe("show tree object", () => {
		test("lists tree entries", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			// Get the full commit hash
			const log = await bash.exec("git log");
			const commitHash = (
				log.stdout.match(/commit ([a-f0-9]{40})/) as RegExpMatchArray
			)[1] as string;

			// Extract tree hash from the object store
			const treeHash = await getTreeHash(bash, commitHash);
			if (!treeHash) throw new Error("Could not get tree hash");

			const treeShow = await bash.exec(`git show ${treeHash}`);
			expect(treeShow.exitCode).toBe(0);
			expect(treeShow.stdout).toContain("100644 blob");
			expect(treeShow.stdout).toContain("README.md");
			expect(treeShow.stdout).toContain("040000 tree");
			expect(treeShow.stdout).toContain("src");
		});
	});

	describe("show blob object", () => {
		test("prints raw blob content", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			// Get full commit hash
			const log = await bash.exec("git log");
			const commitHash = (
				log.stdout.match(/commit ([a-f0-9]{40})/) as RegExpMatchArray
			)[1] as string;

			const treeHash = await getTreeHash(bash, commitHash);
			if (!treeHash) throw new Error("Could not get tree hash");

			// Read tree to find README.md blob hash
			const treeShow = await bash.exec(`git show ${treeHash}`);
			// Parse "100644 blob <hash>\tREADME.md"
			const match = treeShow.stdout.match(/100644 blob ([a-f0-9]{40})\tREADME\.md/);
			expect(match).toBeTruthy();
			const blobHash = match?.[1] as string;

			const blobShow = await bash.exec(`git show ${blobHash}`);
			expect(blobShow.exitCode).toBe(0);
			expect(blobShow.stdout).toBe("# My Project");
		});
	});

	describe("show with modified files", () => {
		test("diff shows modifications correctly", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			// Modify the file
			bash.fs.writeFile("/repo/README.md", "# Updated Project\n\nNew content\n");
			await bash.exec("git add .");
			await bash.exec('git commit -m "update readme"');

			const show = await bash.exec("git show");
			expect(show.exitCode).toBe(0);
			expect(show.stdout).toContain("    update readme");
			expect(show.stdout).toContain("-# My Project");
			expect(show.stdout).toContain("+# Updated Project");
		});

		test("diff shows deleted files", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.exec("git rm src/util.ts");
			await bash.exec('git commit -m "remove util"');

			const show = await bash.exec("git show");
			expect(show.exitCode).toBe(0);
			expect(show.stdout).toContain("deleted file mode");
			expect(show.stdout).toContain("diff --git a/src/util.ts b/src/util.ts");
		});
	});
});

// ── Helpers ─────────────────────────────────────────────────────────

async function getTreeHash(
	bash: ReturnType<typeof createTestBash>,
	commitHash: string,
): Promise<string | null> {
	const { inflate } = await import("../../src/lib/pack/zlib");
	const prefix = commitHash.slice(0, 2);
	const rest = commitHash.slice(2);
	const objPath = `/repo/.git/objects/${prefix}/${rest}`;
	const raw = await bash.fs.readFileBuffer(objPath);
	const data = await inflate(raw);

	const nullIdx = data.indexOf(0);
	const content = new TextDecoder().decode(data.subarray(nullIdx + 1));
	const treeLine = content.split("\n").find((l) => l.startsWith("tree "));
	if (!treeLine) return null;
	return treeLine.slice(5);
}
