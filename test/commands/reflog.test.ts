import { describe, expect, test } from "bun:test";
import { EMPTY_REPO } from "../fixtures";
import { createTestBash } from "../util";

const ENV = {
	GIT_AUTHOR_NAME: "Test",
	GIT_AUTHOR_EMAIL: "test@test.com",
	GIT_COMMITTER_NAME: "Test",
	GIT_COMMITTER_EMAIL: "test@test.com",
};

function setup() {
	return createTestBash({ files: EMPTY_REPO, env: ENV });
}

describe("git reflog", () => {
	test("shows HEAD reflog by default", async () => {
		const bash = setup();
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "initial"');

		const result = await bash.exec("git reflog");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("HEAD@{0}");
		expect(result.stdout).toContain("commit (initial): initial");
	});

	test("shows multiple entries newest-first", async () => {
		const bash = setup();
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "first"');
		await bash.exec('echo "v2" > /repo/README.md');
		await bash.exec("git add .");
		await bash.exec('git commit -m "second"');

		const result = await bash.exec("git reflog");
		expect(result.exitCode).toBe(0);

		const lines = result.stdout.trim().split("\n");
		expect(lines.length).toBeGreaterThanOrEqual(2);
		expect(lines[0]).toContain("HEAD@{0}");
		expect(lines[0]).toContain("second");
		expect(lines[1]).toContain("HEAD@{1}");
		expect(lines[1]).toContain("first");
	});

	test("git reflog show is equivalent to bare git reflog", async () => {
		const bash = setup();
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "initial"');

		const bare = await bash.exec("git reflog");
		const show = await bash.exec("git reflog show");

		expect(show.exitCode).toBe(0);
		expect(show.stdout).toBe(bare.stdout);
	});

	test("shows reflog for a specific branch", async () => {
		const bash = setup();
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "first"');
		await bash.exec("git checkout -b feature");
		await bash.exec('echo "feat" > /repo/feat.txt');
		await bash.exec("git add .");
		await bash.exec('git commit -m "feature work"');

		const result = await bash.exec("git reflog show feature");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("feature@{0}");
		expect(result.stdout).toContain("feature work");
	});

	test("bare ref name treated as show", async () => {
		const bash = setup();
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "initial"');

		const show = await bash.exec("git reflog show HEAD");
		const bare = await bash.exec("git reflog HEAD");

		expect(bare.exitCode).toBe(0);
		expect(bare.stdout).toBe(show.stdout);
	});

	test("includes abbreviated commit hash", async () => {
		const bash = setup();
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "initial"');

		const hash = (await bash.exec("git rev-parse HEAD")).stdout.trim();
		const result = await bash.exec("git reflog");

		expect(result.stdout).toContain(hash.slice(0, 7));
	});

	test("-n limits output", async () => {
		const bash = setup();
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "first"');
		await bash.exec('echo "v2" > /repo/README.md');
		await bash.exec("git add .");
		await bash.exec('git commit -m "second"');
		await bash.exec('echo "v3" > /repo/README.md');
		await bash.exec("git add .");
		await bash.exec('git commit -m "third"');

		const result = await bash.exec("git reflog -n 2");
		expect(result.exitCode).toBe(0);
		const lines = result.stdout.trim().split("\n");
		expect(lines.length).toBe(2);
		expect(lines[0]).toContain("HEAD@{0}");
		expect(lines[1]).toContain("HEAD@{1}");
	});

	test("checkout entries appear in reflog", async () => {
		const bash = setup();
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "initial"');
		await bash.exec("git checkout -b feature");
		await bash.exec("git checkout main");

		const result = await bash.exec("git reflog");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("checkout: moving from");
	});

	test("nonexistent ref returns error", async () => {
		const bash = setup();
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "initial"');

		const result = await bash.exec("git reflog show nonexistent");
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("unknown revision");
	});
});

describe("git reflog exists", () => {
	test("returns 0 for ref with reflog", async () => {
		const bash = setup();
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "initial"');

		const result = await bash.exec("git reflog exists HEAD");
		expect(result.exitCode).toBe(0);
	});

	test("returns 0 for branch with reflog (full ref path)", async () => {
		const bash = setup();
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "initial"');

		const result = await bash.exec("git reflog exists refs/heads/main");
		expect(result.exitCode).toBe(0);
	});

	test("returns 1 for branch short name (no resolution)", async () => {
		const bash = setup();
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "initial"');

		const result = await bash.exec("git reflog exists main");
		expect(result.exitCode).toBe(1);
	});

	test("returns 1 for ref without reflog", async () => {
		const bash = setup();
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "initial"');

		const result = await bash.exec("git reflog exists nonexistent");
		expect(result.exitCode).toBe(1);
	});

	test("requires a ref argument", async () => {
		const bash = setup();
		await bash.exec("git init");

		const result = await bash.exec("git reflog exists");
		expect(result.exitCode).toBe(128);
		expect(result.stderr).toContain("requires a ref");
	});

	test("returns 1 after branch deletion", async () => {
		const bash = setup();
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "initial"');
		await bash.exec("git checkout -b temp");
		await bash.exec("git checkout main");
		await bash.exec("git branch -d temp");

		const result = await bash.exec("git reflog exists temp");
		expect(result.exitCode).toBe(1);
	});
});
