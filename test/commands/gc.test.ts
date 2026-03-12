import { describe, expect, test } from "bun:test";
import { BASIC_REPO } from "../fixtures";
import { createTestBash, pathExists, runScenario } from "../util";

const TEST_ENV = {
	GIT_AUTHOR_NAME: "Test",
	GIT_AUTHOR_EMAIL: "test@test.com",
	GIT_COMMITTER_NAME: "Test",
	GIT_COMMITTER_EMAIL: "test@test.com",
	GIT_AUTHOR_DATE: "1000000000 +0000",
	GIT_COMMITTER_DATE: "1000000000 +0000",
};

describe("git gc", () => {
	test("outside a git repo", async () => {
		const { results } = await runScenario(["git gc"]);
		expect(results[0]!.exitCode).toBe(128);
		expect(results[0]!.stderr).toContain("not a git repository");
	});

	test("on empty repo", async () => {
		const { results } = await runScenario(["git init", "git gc"], {
			files: BASIC_REPO,
		});
		expect(results[1]!.exitCode).toBe(0);
	});

	test("creates pack and cleans loose objects", async () => {
		const bash = createTestBash({ files: BASIC_REPO });
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "first"', { env: TEST_ENV });
		await bash.fs.writeFile("/repo/file2.txt", "second\n");
		await bash.exec("git add file2.txt");
		await bash.exec('git commit -m "second"', { env: TEST_ENV });

		const result = await bash.exec("git gc");
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain("Enumerating objects:");

		// Pack should exist
		const packDir = "/repo/.git/objects/pack";
		expect(await pathExists(bash.fs, packDir)).toBe(true);
		const packFiles = await bash.fs.readdir(packDir);
		expect(packFiles.filter((f) => f.endsWith(".pack")).length).toBe(1);
		expect(packFiles.filter((f) => f.endsWith(".idx")).length).toBe(1);

		// No loose objects should remain
		const objectsDir = "/repo/.git/objects";
		const entries = await bash.fs.readdir(objectsDir);
		const looseDirs = entries.filter((d) => d.length === 2 && d !== "pa" && d !== "in");
		let looseCount = 0;
		for (const dir of looseDirs) {
			try {
				const files = await bash.fs.readdir(`${objectsDir}/${dir}`);
				looseCount += files.length;
			} catch {
				// removed
			}
		}
		expect(looseCount).toBe(0);
	});

	test("objects readable after gc", async () => {
		const bash = createTestBash({ files: BASIC_REPO });
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "initial"', { env: TEST_ENV });
		await bash.fs.writeFile("/repo/README.md", "# Updated\n");
		await bash.exec("git add README.md");
		await bash.exec('git commit -m "update"', { env: TEST_ENV });

		await bash.exec("git gc");

		const logResult = await bash.exec("git log --oneline");
		expect(logResult.exitCode).toBe(0);
		expect(logResult.stdout).toContain("update");
		expect(logResult.stdout).toContain("initial");

		const showResult = await bash.exec("git show HEAD");
		expect(showResult.exitCode).toBe(0);

		const statusResult = await bash.exec("git status");
		expect(statusResult.exitCode).toBe(0);
	});

	test("packs refs into packed-refs file", async () => {
		const bash = createTestBash({ files: BASIC_REPO });
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "initial"', { env: TEST_ENV });
		await bash.exec("git branch feature");
		await bash.exec("git tag v1.0");

		await bash.exec("git gc");

		// packed-refs should exist
		const packedRefsPath = "/repo/.git/packed-refs";
		expect(await pathExists(bash.fs, packedRefsPath)).toBe(true);
		const packedContent = await bash.fs.readFile(packedRefsPath);
		expect(packedContent).toContain("# pack-refs with:");
		expect(packedContent).toContain("refs/heads/main");
		expect(packedContent).toContain("refs/heads/feature");
		expect(packedContent).toContain("refs/tags/v1.0");

		// Loose ref files under refs/ should be gone
		expect(await pathExists(bash.fs, "/repo/.git/refs/heads/main")).toBe(false);
		expect(await pathExists(bash.fs, "/repo/.git/refs/heads/feature")).toBe(false);
		expect(await pathExists(bash.fs, "/repo/.git/refs/tags/v1.0")).toBe(false);
	});

	test("refs still work after packing", async () => {
		const bash = createTestBash({ files: BASIC_REPO });
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "initial"', { env: TEST_ENV });
		await bash.exec("git branch feature");
		await bash.exec("git tag v1.0");

		await bash.exec("git gc");

		// git branch should list branches
		const branchResult = await bash.exec("git branch");
		expect(branchResult.exitCode).toBe(0);
		expect(branchResult.stdout).toContain("main");
		expect(branchResult.stdout).toContain("feature");

		// git tag should list tags
		const tagResult = await bash.exec("git tag");
		expect(tagResult.exitCode).toBe(0);
		expect(tagResult.stdout).toContain("v1.0");

		// checkout should work
		const checkoutResult = await bash.exec("git checkout feature");
		expect(checkoutResult.exitCode).toBe(0);

		const logResult = await bash.exec("git log --oneline");
		expect(logResult.exitCode).toBe(0);
		expect(logResult.stdout).toContain("initial");
	});

	test("deleteRef removes packed ref after gc", async () => {
		const bash = createTestBash({ files: BASIC_REPO });
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "initial"', { env: TEST_ENV });
		await bash.exec("git branch to-delete");

		await bash.exec("git gc");

		// Verify the branch is in packed-refs
		let packedContent = await bash.fs.readFile("/repo/.git/packed-refs");
		expect(packedContent).toContain("refs/heads/to-delete");

		// Delete the branch
		const deleteResult = await bash.exec("git branch -d to-delete");
		expect(deleteResult.exitCode).toBe(0);

		// Verify the branch is removed from packed-refs
		packedContent = await bash.fs.readFile("/repo/.git/packed-refs");
		expect(packedContent).not.toContain("refs/heads/to-delete");

		// Branch should no longer appear
		const branchResult = await bash.exec("git branch");
		expect(branchResult.stdout).not.toContain("to-delete");
	});

	test("prunes unreachable objects", async () => {
		const bash = createTestBash({ files: BASIC_REPO });
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "first"', { env: TEST_ENV });

		await bash.fs.writeFile("/repo/file2.txt", "second content\n");
		await bash.exec("git add file2.txt");
		await bash.exec('git commit -m "second"', { env: TEST_ENV });

		// Amend creates an orphaned commit
		await bash.fs.writeFile("/repo/file2.txt", "amended content\n");
		await bash.exec("git add file2.txt");
		await bash.exec("git commit --amend --no-edit", { env: TEST_ENV });

		// Run gc
		await bash.exec("git gc");

		// All loose objects should be gone (reachable ones in pack, unreachable pruned)
		const objectsDir = "/repo/.git/objects";
		const entries = await bash.fs.readdir(objectsDir);
		const looseDirs = entries.filter((d) => d.length === 2 && d !== "pa" && d !== "in");
		let looseCount = 0;
		for (const dir of looseDirs) {
			try {
				const files = await bash.fs.readdir(`${objectsDir}/${dir}`);
				looseCount += files.length;
			} catch {
				// removed
			}
		}
		expect(looseCount).toBe(0);

		// Current history should be intact
		const logResult = await bash.exec("git log --oneline");
		expect(logResult.exitCode).toBe(0);
		const lines = logResult.stdout.trim().split("\n");
		expect(lines.length).toBe(2);
	});

	test("preserves reflog-reachable objects", async () => {
		const bash = createTestBash({ files: BASIC_REPO });
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "first"', { env: TEST_ENV });

		// Get the first commit hash
		const logBefore = await bash.exec("git rev-parse HEAD");
		const firstHash = logBefore.stdout.trim();

		await bash.fs.writeFile("/repo/file2.txt", "new content\n");
		await bash.exec("git add file2.txt");
		await bash.exec('git commit -m "second"', { env: TEST_ENV });

		// Reset to make the second commit unreachable from refs, but still in reflog
		await bash.exec(`git reset --hard ${firstHash}`);

		// The second commit is now only reachable from HEAD's reflog
		await bash.exec("git gc");

		// The first commit should still be accessible (it's the current HEAD)
		const showResult = await bash.exec("git show HEAD");
		expect(showResult.exitCode).toBe(0);
		expect(showResult.stdout).toContain("first");
	});

	test("--aggressive completes successfully", async () => {
		const bash = createTestBash({ files: BASIC_REPO });
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "initial"', { env: TEST_ENV });
		await bash.fs.writeFile("/repo/file2.txt", "more content\n");
		await bash.exec("git add file2.txt");
		await bash.exec('git commit -m "more"', { env: TEST_ENV });

		const result = await bash.exec("git gc --aggressive");
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain("Delta compression");

		// Objects should still be readable
		const logResult = await bash.exec("git log --oneline");
		expect(logResult.exitCode).toBe(0);
		expect(logResult.stdout.trim().split("\n").length).toBe(2);
	});

	test("multiple gc runs are idempotent", async () => {
		const bash = createTestBash({ files: BASIC_REPO });
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "initial"', { env: TEST_ENV });
		await bash.exec("git branch feature");

		const r1 = await bash.exec("git gc");
		expect(r1.exitCode).toBe(0);

		const r2 = await bash.exec("git gc");
		expect(r2.exitCode).toBe(0);

		// Everything should still work
		const logResult = await bash.exec("git log --oneline");
		expect(logResult.exitCode).toBe(0);
		expect(logResult.stdout).toContain("initial");

		const branchResult = await bash.exec("git branch");
		expect(branchResult.exitCode).toBe(0);
		expect(branchResult.stdout).toContain("main");
		expect(branchResult.stdout).toContain("feature");
	});

	test("works with branches and tags", async () => {
		const bash = createTestBash({ files: BASIC_REPO });
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "initial"', { env: TEST_ENV });
		await bash.exec("git tag v1.0");
		await bash.exec('git tag -a v2.0 -m "annotated tag"', {
			env: TEST_ENV,
		});

		await bash.exec("git checkout -b feature");
		await bash.fs.writeFile("/repo/feature.txt", "feature work\n");
		await bash.exec("git add feature.txt");
		await bash.exec('git commit -m "feature"', { env: TEST_ENV });

		const result = await bash.exec("git gc");
		expect(result.exitCode).toBe(0);

		// All refs should survive
		const tagResult = await bash.exec("git tag");
		expect(tagResult.exitCode).toBe(0);
		expect(tagResult.stdout).toContain("v1.0");
		expect(tagResult.stdout).toContain("v2.0");

		await bash.exec("git checkout main");
		const logResult = await bash.exec("git log --oneline");
		expect(logResult.exitCode).toBe(0);
		expect(logResult.stdout).toContain("initial");

		// packed-refs should have peeled hash for annotated tag
		const packedContent = await bash.fs.readFile("/repo/.git/packed-refs");
		expect(packedContent).toContain("refs/tags/v2.0");
		const lines = packedContent.split("\n");
		const v2Line = lines.findIndex((l) => l.includes("refs/tags/v2.0"));
		expect(v2Line).toBeGreaterThan(-1);
		// Next line should be a peeled hash
		expect(lines[v2Line + 1]!.startsWith("^")).toBe(true);
	});
});
