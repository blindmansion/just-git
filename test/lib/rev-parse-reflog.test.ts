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

describe("rev-parse @{N} reflog syntax", () => {
	test("HEAD@{0} resolves to current HEAD", async () => {
		const bash = setup();
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "initial"');

		const head = await bash.exec("git rev-parse HEAD");
		const reflog0 = await bash.exec("git rev-parse HEAD@{0}");

		expect(reflog0.exitCode).toBe(0);
		expect(reflog0.stdout.trim()).toBe(head.stdout.trim());
	});

	test("HEAD@{1} resolves to previous HEAD value", async () => {
		const bash = setup();
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "first"');

		const first = (await bash.exec("git rev-parse HEAD")).stdout.trim();

		await bash.exec('echo "change" > /repo/file.txt');
		await bash.exec("git add .");
		await bash.exec('git commit -m "second"');

		const second = (await bash.exec("git rev-parse HEAD")).stdout.trim();
		const prev = await bash.exec("git rev-parse HEAD@{1}");

		expect(prev.exitCode).toBe(0);
		expect(prev.stdout.trim()).toBe(first);
		expect(prev.stdout.trim()).not.toBe(second);
	});

	test("branch@{N} resolves via branch reflog", async () => {
		const bash = setup();
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "first"');

		const first = (await bash.exec("git rev-parse main")).stdout.trim();

		await bash.exec('echo "v2" > /repo/README.md');
		await bash.exec("git add .");
		await bash.exec('git commit -m "second"');

		const prev = await bash.exec("git rev-parse main@{1}");
		expect(prev.exitCode).toBe(0);
		expect(prev.stdout.trim()).toBe(first);
	});

	test("@{N} out of range returns error", async () => {
		const bash = setup();
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "only commit"');

		const result = await bash.exec("git rev-parse HEAD@{99}");
		expect(result.exitCode).not.toBe(0);
	});

	test("chained with tilde: HEAD@{1}~1", async () => {
		const bash = setup();
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "c1"');

		const c1 = (await bash.exec("git rev-parse HEAD")).stdout.trim();

		await bash.exec('echo "two" > /repo/file.txt');
		await bash.exec("git add .");
		await bash.exec('git commit -m "c2"');

		await bash.exec('echo "three" > /repo/file.txt');
		await bash.exec("git add .");
		await bash.exec('git commit -m "c3"');

		// HEAD@{1} = c2 (previous HEAD), HEAD@{1}~1 = c1 (parent of c2)
		const result = await bash.exec("git rev-parse HEAD@{1}~1");
		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe(c1);
	});

	test("works with git show", async () => {
		const bash = setup();
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "initial"');
		await bash.exec('echo "v2" > /repo/README.md');
		await bash.exec("git add .");
		await bash.exec('git commit -m "update readme"');

		const result = await bash.exec("git show HEAD@{1}");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("initial");
	});

	test("works with git diff between reflog entries", async () => {
		const bash = setup();
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "first"');
		await bash.exec('echo "changed" > /repo/README.md');
		await bash.exec("git add .");
		await bash.exec('git commit -m "second"');

		const result = await bash.exec("git diff HEAD@{1} HEAD");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("README.md");
	});

	test("works with git reset", async () => {
		const bash = setup();
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "first"');

		const first = (await bash.exec("git rev-parse HEAD")).stdout.trim();

		await bash.exec('echo "changed" > /repo/README.md');
		await bash.exec("git add .");
		await bash.exec('git commit -m "second"');

		await bash.exec("git reset --hard HEAD@{1}");
		const after = (await bash.exec("git rev-parse HEAD")).stdout.trim();
		expect(after).toBe(first);
	});

	test("checkout reflog entries are counted", async () => {
		const bash = setup();
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "initial"');
		await bash.exec("git checkout -b feature");
		await bash.exec('echo "feat" > /repo/feat.txt');
		await bash.exec("git add .");
		await bash.exec('git commit -m "feature commit"');
		await bash.exec("git checkout main");

		// HEAD@{0} should be main (just checked out)
		// HEAD@{1} should be the feature commit
		const at0 = (await bash.exec("git rev-parse HEAD@{0}")).stdout.trim();
		const mainHash = (await bash.exec("git rev-parse main")).stdout.trim();
		expect(at0).toBe(mainHash);

		const at1 = (await bash.exec("git rev-parse HEAD@{1}")).stdout.trim();
		const featHash = (await bash.exec("git rev-parse feature")).stdout.trim();
		expect(at1).toBe(featHash);
	});
});
