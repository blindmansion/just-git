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

describe("git repack", () => {
	test("outside a git repo", async () => {
		const { results } = await runScenario(["git repack"]);
		expect(results[0]!.exitCode).toBe(128);
		expect(results[0]!.stderr).toContain("not a git repository");
	});

	test("on empty repo (no commits)", async () => {
		const { results } = await runScenario(["git init", "git repack"], {
			files: BASIC_REPO,
		});
		expect(results[1]!.exitCode).toBe(0);
		expect(results[1]!.stdout).toContain("Nothing new to pack");
	});

	test("creates pack and index files", async () => {
		const bash = createTestBash({ files: BASIC_REPO });
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "initial"', { env: TEST_ENV });

		const result = await bash.exec("git repack");
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain("Enumerating objects:");
		expect(result.stderr).toContain("done.");

		// Verify pack directory has files
		const packDir = "/repo/.git/objects/pack";
		expect(await pathExists(bash.fs, packDir)).toBe(true);

		const packFiles = await bash.fs.readdir(packDir);
		const packs = packFiles.filter((f) => f.endsWith(".pack"));
		const idxs = packFiles.filter((f) => f.endsWith(".idx"));
		expect(packs.length).toBe(1);
		expect(idxs.length).toBe(1);
		expect(packs[0]!.replace(".pack", "")).toBe(idxs[0]!.replace(".idx", ""));
	});

	test("objects readable after repack", async () => {
		const bash = createTestBash({ files: BASIC_REPO });
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "initial"', { env: TEST_ENV });

		// Create more commits for interesting delta candidates
		await bash.fs.writeFile("/repo/README.md", "# Updated\n");
		await bash.exec("git add README.md");
		await bash.exec('git commit -m "update readme"', { env: TEST_ENV });

		await bash.exec("git repack");

		// Verify git log still works
		const logResult = await bash.exec("git log --oneline");
		expect(logResult.exitCode).toBe(0);
		expect(logResult.stdout).toContain("update readme");
		expect(logResult.stdout).toContain("initial");

		// Verify git show works
		const showResult = await bash.exec("git show HEAD");
		expect(showResult.exitCode).toBe(0);
		expect(showResult.stdout).toContain("update readme");

		// Verify git status works
		const statusResult = await bash.exec("git status");
		expect(statusResult.exitCode).toBe(0);
	});

	test("repack with -d removes loose objects", async () => {
		const bash = createTestBash({ files: BASIC_REPO });
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "initial"', { env: TEST_ENV });

		// Verify loose objects exist before repack
		const objectsDir = "/repo/.git/objects";
		const entriesBefore = await bash.fs.readdir(objectsDir);
		const looseDirsBefore = entriesBefore.filter((d) => d.length === 2 && d !== "pa" && d !== "in");
		expect(looseDirsBefore.length).toBeGreaterThan(0);

		const result = await bash.exec("git repack -d");
		expect(result.exitCode).toBe(0);

		// Verify loose objects are cleaned up
		const entriesAfter = await bash.fs.readdir(objectsDir);
		const looseDirsAfter = entriesAfter.filter((d) => d.length === 2 && d !== "pa" && d !== "in");

		// All loose dirs should be empty or removed
		let looseFileCount = 0;
		for (const dir of looseDirsAfter) {
			try {
				const files = await bash.fs.readdir(`${objectsDir}/${dir}`);
				looseFileCount += files.length;
			} catch {
				// dir removed
			}
		}
		expect(looseFileCount).toBe(0);

		// Pack files should still exist
		const packDir = `${objectsDir}/pack`;
		const packFiles = await bash.fs.readdir(packDir);
		expect(packFiles.filter((f) => f.endsWith(".pack")).length).toBe(1);
		expect(packFiles.filter((f) => f.endsWith(".idx")).length).toBe(1);
	});

	test("repack -a -d consolidates everything", async () => {
		const bash = createTestBash({ files: BASIC_REPO });
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "first"', { env: TEST_ENV });

		await bash.fs.writeFile("/repo/file2.txt", "second file\n");
		await bash.exec("git add file2.txt");
		await bash.exec('git commit -m "second"', { env: TEST_ENV });

		await bash.fs.writeFile("/repo/file3.txt", "third file\n");
		await bash.exec("git add file3.txt");
		await bash.exec('git commit -m "third"', { env: TEST_ENV });

		const result = await bash.exec("git repack -a -d");
		expect(result.exitCode).toBe(0);

		// Should have exactly one pack
		const packDir = "/repo/.git/objects/pack";
		const packFiles = await bash.fs.readdir(packDir);
		expect(packFiles.filter((f) => f.endsWith(".pack")).length).toBe(1);

		// All operations should still work
		const logResult = await bash.exec("git log --oneline");
		expect(logResult.exitCode).toBe(0);
		const lines = logResult.stdout.trim().split("\n");
		expect(lines.length).toBe(3);
	});

	test("multiple repacks produce valid state", async () => {
		const bash = createTestBash({ files: BASIC_REPO });
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "initial"', { env: TEST_ENV });

		// First repack
		const r1 = await bash.exec("git repack");
		expect(r1.exitCode).toBe(0);

		// Add more content
		await bash.fs.writeFile("/repo/new.txt", "new content\n");
		await bash.exec("git add new.txt");
		await bash.exec('git commit -m "add new"', { env: TEST_ENV });

		// Second repack
		const r2 = await bash.exec("git repack -a -d");
		expect(r2.exitCode).toBe(0);

		// Verify everything works
		const logResult = await bash.exec("git log --oneline");
		expect(logResult.exitCode).toBe(0);
		expect(logResult.stdout.trim().split("\n").length).toBe(2);

		const showResult = await bash.exec("git show HEAD:new.txt");
		expect(showResult.exitCode).toBe(0);
		expect(showResult.stdout).toBe("new content\n");
	});

	test("output format includes expected lines", async () => {
		const bash = createTestBash({ files: BASIC_REPO });
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "initial"', { env: TEST_ENV });

		const result = await bash.exec("git repack");
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain("Enumerating objects:");
		expect(result.stderr).toContain("Delta compression");
		expect(result.stderr).toContain("Compressing objects:");
		expect(result.stderr).toContain("Writing objects:");
		expect(result.stderr).toContain("Total");
	});

	test("works with branches and tags", async () => {
		const bash = createTestBash({ files: BASIC_REPO });
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "initial"', { env: TEST_ENV });
		await bash.exec("git tag v1.0");

		await bash.exec("git checkout -b feature");
		await bash.fs.writeFile("/repo/feature.txt", "feature work\n");
		await bash.exec("git add feature.txt");
		await bash.exec('git commit -m "feature"', { env: TEST_ENV });

		const result = await bash.exec("git repack -a -d");
		expect(result.exitCode).toBe(0);

		// All refs should still work
		const tagResult = await bash.exec("git show v1.0");
		expect(tagResult.exitCode).toBe(0);

		await bash.exec("git checkout main");
		const logResult = await bash.exec("git log --oneline");
		expect(logResult.exitCode).toBe(0);
		expect(logResult.stdout).toContain("initial");
	});

	test("repack -d with existing pack removes old pack", async () => {
		const bash = createTestBash({ files: BASIC_REPO });
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "first"', { env: TEST_ENV });

		// First repack creates a pack
		await bash.exec("git repack");

		const packDir = "/repo/.git/objects/pack";
		const firstPackFiles = await bash.fs.readdir(packDir);
		expect(firstPackFiles.filter((f) => f.endsWith(".pack")).length).toBe(1);

		// Add more content and repack -a -d
		await bash.fs.writeFile("/repo/more.txt", "more data\n");
		await bash.exec("git add more.txt");
		await bash.exec('git commit -m "more"', { env: TEST_ENV });

		await bash.exec("git repack -a -d");

		const newPackFiles = await bash.fs.readdir(packDir);
		const packs = newPackFiles.filter((f) => f.endsWith(".pack"));
		// Should have only one pack (the new one)
		expect(packs.length).toBe(1);
		// The old pack should be gone (different name since it covers more objects)
		// Note: if the pack hash happens to be the same, that's fine too
	});
});
