import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	type AmOutcome,
	authorLog,
	buildRichHistory,
	jgAm,
	jgFormatPatch,
	realAm,
	realFormatPatch,
	treeOf,
} from "./am-harness";
import { createSandbox, realGitIn, removeSandbox } from "./util";

/**
 * `git am` interop: a patch series produced by real git or just-git must
 * rebuild the original history identically when replayed with just-git's `am`.
 * The oracle is a real-git tree-OID comparison (see am-harness.ts).
 */
describe("interop: format-patch → am rebuilds history", () => {
	let sandbox: string;
	let git: ReturnType<typeof realGitIn>;
	let baseSha: string;
	let originalTree: string;
	let originalLog: string;

	beforeAll(async () => {
		sandbox = createSandbox();
		git = realGitIn(sandbox);
		baseSha = await buildRichHistory(sandbox, git);
		originalTree = await treeOf(git, "main");
		originalLog = await authorLog(git, `${baseSha}..main`);
	});
	afterAll(() => removeSandbox(sandbox));

	/** Fresh branch off the base, replay `series` with `consume`, return outcome. */
	async function rebuild(
		branch: string,
		series: string,
		consume: (mbox: string) => Promise<AmOutcome>,
	): Promise<AmOutcome> {
		await git.execAsync(["checkout", "-b", branch, baseSha]);
		return consume(series);
	}

	test("real format-patch → just-git am", async () => {
		const series = await realFormatPatch(git, `${baseSha}..main`);
		const out = await rebuild("applied-real-jg", series, (m) => jgAm(sandbox, m));
		expect(out.exitCode).toBe(0);
		expect(await treeOf(git, "applied-real-jg")).toBe(originalTree);
		expect(await authorLog(git, `${baseSha}..applied-real-jg`)).toBe(originalLog);
	});

	test("just-git format-patch → just-git am (full round trip)", async () => {
		const series = await jgFormatPatch(sandbox, `${baseSha}..main`);
		expect(series).toContain("GIT binary patch");
		const out = await rebuild("applied-jg-jg", series, (m) => jgAm(sandbox, m));
		expect(out.exitCode).toBe(0);
		expect(await treeOf(git, "applied-jg-jg")).toBe(originalTree);
		expect(await authorLog(git, `${baseSha}..applied-jg-jg`)).toBe(originalLog);
	});

	test("real format-patch → real git am (control)", async () => {
		const series = await realFormatPatch(git, `${baseSha}..main`);
		const out = await rebuild("applied-real-real", series, (m) => realAm(sandbox, m));
		expect(out.exitCode).toBe(0);
		expect(await treeOf(git, "applied-real-real")).toBe(originalTree);
	});

	test("real git fsck passes on the just-git-rebuilt history", async () => {
		const r = await git.execAsync(["fsck", "--full"]);
		expect(r.exitCode).toBe(0);
	});
});
