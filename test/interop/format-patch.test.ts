import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "fs";
import { join } from "path";
import { createSandbox, jg, justBash, realGitIn, removeSandbox, writeToSandbox } from "./util";

/**
 * The `-- \n<signature>` footer is stamped with the git version, which differs
 * between just-git's emulated version and the host git binary. Pinning it to a
 * fixed string on both sides neutralizes that difference so the rest of the
 * output can be compared byte-for-byte.
 */
const FIXED_SIGNATURE = "just-git-interop";

/**
 * Build a linear history on `main` that exercises every diff shape
 * format-patch has to render: a plain add, a content modify (with a body), a
 * rename, a pure mode change, a binary blob, a non-ASCII subject, and a
 * delete. Returns the sha of the (root) base commit — everything after it is
 * what the patch series has to reproduce.
 */
async function buildRichHistory(
	sandbox: string,
	git: ReturnType<typeof realGitIn>,
): Promise<string> {
	await git.execAsync(["init"]);

	writeToSandbox(sandbox, "A.txt", "alpha\nbeta\ngamma\n");
	await git.execAsync(["add", "."]);
	await git.execAsync(["commit", "-m", "base"]);
	const baseSha = (await git.execAsync(["rev-parse", "HEAD"])).stdout.trim();

	writeToSandbox(sandbox, "B.txt", "one\ntwo\n");
	await git.execAsync(["add", "."]);
	await git.execAsync(["commit", "-m", "Add B.txt"]);

	writeToSandbox(sandbox, "A.txt", "alpha\nBETA\ngamma\ndelta\n");
	await git.execAsync(["add", "."]);
	await git.execAsync(["commit", "-m", "Modify A.txt", "-m", "This is the body paragraph."]);

	await git.execAsync(["mv", "B.txt", "C.txt"]);
	await git.execAsync(["commit", "-m", "Rename B.txt to C.txt"]);

	chmodSync(join(sandbox, "C.txt"), 0o755);
	await git.execAsync(["add", "C.txt"]);
	await git.execAsync(["commit", "-m", "Make C.txt executable"]);

	const bin = new Uint8Array(64);
	for (let i = 0; i < bin.length; i++) bin[i] = (i * 7) % 256;
	writeToSandbox(sandbox, "blob.bin", bin);
	await git.execAsync(["add", "."]);
	await git.execAsync(["commit", "-m", "Add binary blob"]);

	writeToSandbox(sandbox, "A.txt", "alpha\nBETA\ngamma\ndelta\nepsilon\n");
	await git.execAsync(["add", "."]);
	await git.execAsync(["commit", "-m", "Café ☕ update", "-m", "Bödy with ünïcode."]);

	await git.execAsync(["rm", "A.txt"]);
	await git.execAsync(["commit", "-m", "Remove A.txt"]);

	return baseSha;
}

describe("interop: format-patch round-trips through git am", () => {
	let sandbox: string;
	let git: ReturnType<typeof realGitIn>;
	let baseSha: string;

	beforeAll(async () => {
		sandbox = createSandbox();
		git = realGitIn(sandbox);
		baseSha = await buildRichHistory(sandbox, git);
	});
	afterAll(() => removeSandbox(sandbox));

	test("just-git patches apply cleanly with real git am", async () => {
		const b = justBash(sandbox);
		const fp = await jg(b, `git format-patch --stdout ${baseSha}..HEAD`);
		expect(fp.exitCode).toBe(0);
		expect(fp.stdout).toContain("GIT binary patch");

		// Write the series where it won't collide with tracked paths, then rebuild
		// the whole history from the shared base with real git's am.
		const mbox = join(sandbox, "series.mbox");
		writeFileSync(mbox, fp.stdout);

		await git.execAsync(["checkout", "-b", "applied", baseSha]);
		const am = await git.execAsync(["am", mbox]);
		expect(am.exitCode).toBe(0);
	});

	test("the rebuilt tree is identical to the original", async () => {
		const original = (await git.execAsync(["rev-parse", "main^{tree}"])).stdout.trim();
		const rebuilt = (await git.execAsync(["rev-parse", "applied^{tree}"])).stdout.trim();
		expect(rebuilt).toBe(original);
	});

	test("author identity, dates, and subjects survive the round trip", async () => {
		const fmt = ["log", "--format=%an <%ae> %ad %s", "--date=iso-strict"];
		const original = (await git.execAsync([...fmt, `${baseSha}..main`])).stdout.trim();
		const rebuilt = (await git.execAsync([...fmt, `${baseSha}..applied`])).stdout.trim();
		expect(rebuilt).toBe(original);
		// Sanity: the non-ASCII subject actually made it through both sides.
		expect(rebuilt).toContain("Café ☕ update");
	});

	test("real git fsck passes on the rebuilt history", async () => {
		const r = await git.execAsync(["fsck", "--full"]);
		expect(r.exitCode).toBe(0);
	});
});

describe("interop: format-patch output matches real git byte-for-byte", () => {
	let sandbox: string;
	let git: ReturnType<typeof realGitIn>;
	let baseSha: string;

	beforeAll(async () => {
		sandbox = createSandbox();
		git = realGitIn(sandbox);
		await git.execAsync(["init"]);
		writeToSandbox(sandbox, "file.txt", "line1\nline2\nline3\n");
		await git.execAsync(["add", "."]);
		await git.execAsync(["commit", "-m", "Add file.txt", "-m", "Original body."]);
		baseSha = (await git.execAsync(["rev-parse", "HEAD"])).stdout.trim();

		writeToSandbox(sandbox, "file.txt", "line1\nchanged\nline3\nline4\n");
		await git.execAsync(["add", "."]);
		await git.execAsync(["commit", "-m", "Modify file.txt"]);

		writeToSandbox(sandbox, "other.txt", "brand new\n");
		await git.execAsync(["add", "."]);
		await git.execAsync(["commit", "-m", "Add other.txt"]);
	});
	afterAll(() => removeSandbox(sandbox));

	/** just-git and real git format-patch for the same args, signature pinned. */
	async function bothWays(extra: string, realExtra: string[]): Promise<[string, string]> {
		const b = justBash(sandbox);
		const jgOut = await jg(b, `git format-patch --stdout --signature ${FIXED_SIGNATURE} ${extra}`);
		expect(jgOut.exitCode).toBe(0);
		const realOut = await git.execAsync([
			"format-patch",
			"--stdout",
			"--signature",
			FIXED_SIGNATURE,
			...realExtra,
		]);
		return [jgOut.stdout, realOut.stdout];
	}

	test("a single patch is byte-identical", async () => {
		const [jgOut, realOut] = await bothWays("-1", ["-1"]);
		expect(jgOut).toBe(realOut);
	});

	test("a multi-commit series is byte-identical", async () => {
		const [jgOut, realOut] = await bothWays(`${baseSha}..HEAD`, [`${baseSha}..HEAD`]);
		expect(jgOut).toBe(realOut);
	});

	test("a reroll (-v2) series is byte-identical", async () => {
		const [jgOut, realOut] = await bothWays(`-v2 ${baseSha}..HEAD`, ["-v2", `${baseSha}..HEAD`]);
		expect(jgOut).toBe(realOut);
	});

	test("a custom subject-prefix is byte-identical", async () => {
		const [jgOut, realOut] = await bothWays(`--subject-prefix PATCH-X ${baseSha}..HEAD`, [
			"--subject-prefix",
			"PATCH-X",
			`${baseSha}..HEAD`,
		]);
		expect(jgOut).toBe(realOut);
	});
});
