import { expect } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { RealGit } from "../real-git";
import { justBash, realGit, writeToSandbox } from "./util";

/**
 * Interop harness for `git am`, the consumer counterpart to `apply-harness`.
 * The oracle is the same tree-OID identity: `format-patch <base>..HEAD` with one
 * tool, `am` the series onto a fresh branch off `<base>` with another, then let
 * **real git** re-measure the rebuilt branch's tree and assert it equals the
 * original `HEAD^{tree}`. Real git is always the measuring instrument, so the
 * oracle never trusts just-git's own hashing when it is the tool under test.
 *
 * `format-patch.test.ts` already covers the jg-format-patch → real-`am`
 * direction; this harness closes the loop by exercising just-git's `am` as the
 * consumer (of both real and just-git produced series).
 */

/** Result of one `am` invocation. */
export interface AmOutcome {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/**
 * Build a linear history on `main` that exercises every diff shape a patch
 * series carries: a plain add, a content modify (with a body), a rename, a pure
 * mode change, a binary blob, a non-ASCII subject, and a delete. Returns the sha
 * of the (root) base commit — everything after it is what `am` has to rebuild.
 */
export async function buildRichHistory(sandbox: string, git: RealGit): Promise<string> {
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

// ── Producers ───────────────────────────────────────────────────────

/** The `<base>..HEAD` series as emitted by real git format-patch. */
export async function realFormatPatch(git: RealGit, range: string): Promise<string> {
	return (await git.execAsync(["format-patch", "--stdout", range])).stdout;
}

/** The `<base>..HEAD` series as emitted by just-git format-patch. */
export async function jgFormatPatch(sandbox: string, range: string): Promise<string> {
	const bash = justBash(sandbox);
	const r = await bash.exec(`git format-patch --stdout ${range}`);
	expect(r.exitCode).toBe(0);
	return r.stdout;
}

// ── Consumers ───────────────────────────────────────────────────────

/** Apply a series with just-git `am` (mailbox fed over stdin). */
export async function jgAm(sandbox: string, mbox: string): Promise<AmOutcome> {
	const bash = justBash(sandbox);
	const r = await bash.exec("git am", { stdin: mbox });
	return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
}

/**
 * Apply a series with real git `am`. The mailbox is written outside the sandbox
 * and referenced by absolute path so it never lands in the measured worktree.
 */
export async function realAm(sandbox: string, mbox: string): Promise<AmOutcome> {
	const dir = mkdtempSync(join(tmpdir(), "jg-am-"));
	const path = join(dir, "series.mbox");
	writeFileSync(path, mbox);
	try {
		const r = await realGit(sandbox, `am ${path}`);
		return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// ── Oracle helpers ──────────────────────────────────────────────────

/** The tree OID of a ref, measured by real git. */
export async function treeOf(git: RealGit, ref: string): Promise<string> {
	return (await git.execAsync(["rev-parse", `${ref}^{tree}`])).stdout.trim();
}

/** Author identity + date + subject for every commit in a range (real git). */
export async function authorLog(git: RealGit, range: string): Promise<string> {
	const fmt = ["log", "--format=%an <%ae> %ad %s", "--date=iso-strict", range];
	return (await git.execAsync(fmt)).stdout.trim();
}
