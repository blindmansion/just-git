import { expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { RealGit } from "../real-git";
import { justBash, realGit, writeToSandbox } from "./util";

/**
 * Integration/interop harness for `git apply`, built around one idea: because
 * just-git and real git share the same on-disk repo, and a git **tree OID** is
 * a single hash over every file's content + mode + path, "did apply produce the
 * right result?" reduces to one hash comparison.
 *
 * A {@link Shape} is a base tree (commit `A`) plus an overlay reaching commit
 * `B`. The oracle: reset the repo to `A`, produce the `A→B` patch with one tool,
 * apply it with another, then re-measure the tree with **real git**
 * (`git add -A && git write-tree`) and assert it equals `B^{tree}`. Real git is
 * always the measuring instrument so the oracle never trusts just-git's own
 * hashing when it is the tool under test.
 */

/** A file map: relative path → content, or `null` to delete the path. */
export type FileMap = Record<string, string | Uint8Array | null>;

export interface Shape {
	name: string;
	/** Files present at commit `A`. */
	base: FileMap;
	/** Overlay applied to reach commit `B` (`null` deletes). */
	target: FileMap;
	/** Extra `git diff` args the shape needs (e.g. `-M`, `--binary`). */
	diffArgs?: string[];
	/** Which producers can emit this shape's patch (default: both). */
	producers?: ("real" | "jg")[];
	/** Extra fs work after writing the base map (e.g. `chmodSync`). */
	baseSetup?: (sandbox: string) => void;
	/** Extra fs work after writing the target map (e.g. `chmodSync`). */
	targetSetup?: (sandbox: string) => void;
}

export interface BuiltShape {
	aSha: string;
	bSha: string;
	bTree: string;
}

async function commitAll(git: RealGit, msg: string): Promise<string> {
	await git.execAsync(["add", "-A"]);
	await git.execAsync(["commit", "-q", "-m", msg]);
	return (await git.execAsync(["rev-parse", "HEAD"])).stdout.trim();
}

function writeMap(sandbox: string, map: FileMap): void {
	for (const [rel, content] of Object.entries(map)) {
		if (content === null) {
			rmSync(join(sandbox, rel), { force: true });
		} else {
			writeToSandbox(sandbox, rel, content);
		}
	}
}

/** Init the sandbox repo and commit `A` then `B`; capture `B`'s tree OID. */
export async function buildShape(git: RealGit, sandbox: string, shape: Shape): Promise<BuiltShape> {
	await git.execAsync(["init", "-q"]);
	writeMap(sandbox, shape.base);
	shape.baseSetup?.(sandbox);
	const aSha = await commitAll(git, "A");
	writeMap(sandbox, shape.target);
	shape.targetSetup?.(sandbox);
	const bSha = await commitAll(git, "B");
	const bTree = (await git.execAsync(["rev-parse", `${bSha}^{tree}`])).stdout.trim();
	return { aSha, bSha, bTree };
}

/** Hard-reset the worktree + index back to commit `A` and drop untracked cruft. */
export async function resetTo(git: RealGit, aSha: string): Promise<void> {
	await git.execAsync(["reset", "-q", "--hard", aSha]);
	await git.execAsync(["clean", "-fdq"]);
}

/** Re-measure the current worktree as a tree OID, using real git as the oracle. */
export async function resultTree(git: RealGit): Promise<string> {
	await git.execAsync(["add", "-A"]);
	return (await git.execAsync(["write-tree"])).stdout.trim();
}

// ── Patch producers ─────────────────────────────────────────────────

/** The `A→B` patch as emitted by real git. */
export async function realDiff(
	git: RealGit,
	aSha: string,
	bSha: string,
	extra: string[] = [],
): Promise<string> {
	return (await git.execAsync(["diff", ...extra, aSha, bSha])).stdout;
}

/** The `A→B` patch as emitted by just-git. */
export async function jgDiff(
	sandbox: string,
	aSha: string,
	bSha: string,
	extra: string[] = [],
): Promise<string> {
	const bash = justBash(sandbox);
	const cmd = ["git", "diff", ...extra, aSha, bSha].join(" ");
	const r = await bash.exec(cmd);
	expect(r.exitCode).toBe(0);
	return r.stdout;
}

// ── Patch consumers ─────────────────────────────────────────────────

export interface ApplyOutcome {
	exitCode: number;
	stderr: string;
}

/** Apply a patch with just-git (patch fed over stdin). */
export async function jgApply(sandbox: string, patch: string, flags = ""): Promise<ApplyOutcome> {
	const bash = justBash(sandbox);
	const r = await bash.exec(`git apply ${flags}`.trim(), { stdin: patch });
	return { exitCode: r.exitCode, stderr: r.stderr };
}

/**
 * Apply a patch with real git. The patch is written outside the sandbox and
 * referenced by absolute path so it never pollutes the worktree we measure.
 */
export async function realApply(sandbox: string, patch: string, flags = ""): Promise<ApplyOutcome> {
	const dir = mkdtempSync(join(tmpdir(), "jg-apply-"));
	const patchPath = join(dir, "p.patch");
	writeFileSync(patchPath, patch);
	try {
		const r = await realGit(sandbox, `apply ${flags} ${patchPath}`.replace(/\s+/g, " ").trim());
		return { exitCode: r.exitCode, stderr: r.stderr };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
