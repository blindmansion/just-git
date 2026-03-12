import { describe, expect, test } from "bun:test";
import { resolveHead } from "../../src/lib/refs.ts";
import { findGitDir } from "../../src/lib/repo.ts";
import { enumerateObjects } from "../../src/lib/transport/object-walk.ts";
import { TEST_ENV as ENV } from "../fixtures";
import { createTestBash } from "../util";

async function setupRepo(files: Record<string, string> = {}) {
	const bash = createTestBash({
		files: { "/repo/README.md": "# Hello", ...files },
		env: ENV,
	});
	await bash.exec("git init");
	return bash;
}

describe("enumerateObjects (with haves)", () => {
	test("excludes objects reachable from haves", async () => {
		const bash = await setupRepo();
		await bash.exec("git add .");
		await bash.exec('git commit -m "first"');

		const ctx = (await findGitDir(bash.fs, "/repo"))!;
		const firstCommit = (await resolveHead(ctx))!;

		await bash.exec("echo 'new content' > /repo/file2.txt");
		await bash.exec("git add .");
		await bash.exec('git commit -m "second"');

		const secondCommit = (await resolveHead(ctx))!;

		// Only objects in second commit but not reachable from first
		const objects = await enumerateObjects(ctx, [secondCommit], [firstCommit]);

		// Should get: 1 new commit + 1 new tree + 1 new blob
		// (README.md blob is shared and should be excluded via tree reachability)
		const commits = objects.filter((o) => o.type === "commit");
		expect(commits).toHaveLength(1);
		expect(commits[0]!.hash).toBe(secondCommit);

		// Should NOT include the first commit
		expect(objects.find((o) => o.hash === firstCommit)).toBeUndefined();
	});

	test("returns empty when wants are subset of haves", async () => {
		const bash = await setupRepo();
		await bash.exec("git add .");
		await bash.exec('git commit -m "initial"');

		const ctx = (await findGitDir(bash.fs, "/repo"))!;
		const head = (await resolveHead(ctx))!;

		const objects = await enumerateObjects(ctx, [head], [head]);
		expect(objects).toHaveLength(0);
	});
});
