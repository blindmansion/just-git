import type { GitExtensions } from "../git.ts";
import {
	abbreviateHash,
	ambiguousArgError,
	fatal,
	firstLine,
	getCwdPrefix,
	isCommandError,
	requireGitContext,
	requireWorkTree,
} from "../lib/command-utils.ts";
import {
	addEntry,
	buildIndex,
	clearIndex,
	defaultStat,
	hasConflicts,
	readIndex,
	removeEntry,
	writeIndex,
} from "../lib/index.ts";
import { peelToCommit, readCommit } from "../lib/object-db.ts";
import { clearAllOperationState } from "../lib/operation-state.ts";
import { join } from "../lib/path.ts";
import { containsWildcard, matchPathspecs, parsePathspec } from "../lib/pathspec.ts";
import { logRef } from "../lib/reflog.ts";
import { readHead, resolveHead, resolveRef, updateRef } from "../lib/refs.ts";
import { resolveRevision } from "../lib/rev-parse.ts";
import { flattenTree, flattenTreeToMap } from "../lib/tree-ops.ts";
import type { GitContext, ObjectId } from "../lib/types.ts";
import { applyWorktreeOps, resetHard } from "../lib/unpack-trees.ts";
import { diffIndexToWorkTree } from "../lib/worktree.ts";
import { a, type Command, f } from "../parse/index.ts";

export function registerResetCommand(parent: Command, ext?: GitExtensions) {
	parent.command("reset", {
		description: "Reset current HEAD to the specified state",
		args: [a.string().name("args").variadic().optional()],
		options: {
			soft: f().describe("Only move HEAD"),
			mixed: f().describe("Move HEAD and reset index (default)"),
			hard: f().describe("Move HEAD, reset index, and reset working tree"),
		},
		handler: async (args, ctx, meta) => {
			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;
			const gitCtx = gitCtxOrError;

			const positional = args.args;

			// Validate mutually exclusive flags
			const flagCount = [args.soft, args.mixed, args.hard].filter(Boolean).length;
			if (flagCount > 1) {
				return fatal("--soft, --mixed, and --hard are mutually exclusive");
			}

			const hasMode = args.soft || args.mixed || args.hard;

			const cwdPrefix = getCwdPrefix(gitCtx, ctx.cwd);

			// ── Explicit `--` separator ─────────────────────────────────
			// `git reset <commit> -- <paths>` or `git reset -- <paths>`
			if (meta.passthrough.length > 0) {
				const commitRef = positional.length > 0 ? positional[0] : undefined;
				return resetPaths(gitCtx, meta.passthrough, cwdPrefix, commitRef, ext);
			}

			// ── Path-based reset (unstage) ──────────────────────────────
			// `git reset <path>...` — no mode flags
			if (!hasMode && positional.length > 0) {
				const firstArg = positional[0]!;

				// Heuristic: if the first arg resolves as a revision,
				// treat as a commit-based reset or commit + paths.
				const firstIsRevision = await resolveRevision(gitCtx, firstArg);

				// If only one arg and it resolves as a revision, it's
				// `git reset <commit>` with default --mixed mode
				if (positional.length === 1 && firstIsRevision) {
					return resetToCommit(gitCtx, firstArg, "mixed", ctx.env, ext);
				}

				// All args are paths to unstage
				if (!firstIsRevision) {
					return resetPaths(gitCtx, positional, cwdPrefix, undefined, ext);
				}

				// First arg is a revision, rest are paths
				// `git reset <commit> <paths>` — unstage paths using commit's tree
				return resetPaths(gitCtx, positional.slice(1), cwdPrefix, firstArg, ext);
			}

			// ── Commit-based reset (with mode flag) ─────────────────────
			const mode = args.soft ? "soft" : args.hard ? "hard" : "mixed";
			const commitRef = positional.length > 0 ? positional[0]! : "HEAD";

			return resetToCommit(gitCtx, commitRef, mode, ctx.env, ext);
		},
	});
}

// ── Path-based reset (unstaging) ────────────────────────────────────

/**
 * `git reset <paths>` — restore index entries from HEAD tree.
 * This is the opposite of `git add`. Supports glob pathspecs.
 */
async function resetPaths(
	gitCtx: GitContext,
	paths: string[],
	cwdPrefix: string,
	commitRef?: string,
	ext?: GitExtensions,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	if (ext?.hooks) {
		const abort = await ext.hooks.emitPre("pre-reset", {
			mode: "paths",
			target: commitRef ?? null,
		});
		if (abort) return { stdout: "", stderr: abort.message ?? "", exitCode: 1 };
	}
	// Resolve the tree to restore from
	let treeHash: ObjectId | null = null;
	if (commitRef) {
		const rawHash = await resolveRevision(gitCtx, commitRef);
		if (!rawHash) {
			return ambiguousArgError(commitRef);
		}
		const hash = await peelToCommit(gitCtx, rawHash);
		const commit = await readCommit(gitCtx, hash);
		treeHash = commit.tree;
	} else {
		const headHash = await resolveHead(gitCtx);
		if (headHash) {
			const headCommit = await readCommit(gitCtx, headHash);
			treeHash = headCommit.tree;
		}
	}

	const treeMap = await flattenTreeToMap(gitCtx, treeHash ?? null);

	let index = await readIndex(gitCtx);

	// Check if any paths are glob patterns
	const hasGlobs = paths.some(containsWildcard);

	if (hasGlobs) {
		const specs = paths.map((p) => parsePathspec(p, cwdPrefix));
		// Collect all candidate paths from tree and index
		const allPaths = new Set<string>();
		for (const [p] of treeMap) allPaths.add(p);
		for (const e of index.entries) allPaths.add(e.path);

		for (const path of allPaths) {
			if (!matchPathspecs(specs, path)) continue;
			const treeEntry = treeMap.get(path);
			if (treeEntry) {
				index = addEntry(index, {
					path: treeEntry.path,
					mode: parseInt(treeEntry.mode, 8),
					hash: treeEntry.hash,
					stage: 0,
					stat: defaultStat(),
				});
			} else {
				index = removeEntry(index, path);
			}
		}
	} else {
		for (const path of paths) {
			const treeEntry = treeMap.get(path);
			if (treeEntry) {
				index = addEntry(index, {
					path: treeEntry.path,
					mode: parseInt(treeEntry.mode, 8),
					hash: treeEntry.hash,
					stage: 0,
					stat: defaultStat(),
				});
			} else {
				const inIndex = index.entries.some((e) => e.path === path);
				if (!inIndex) {
					const inWorktree =
						gitCtx.workTree && (await gitCtx.fs.exists(join(gitCtx.workTree, path)));
					if (!inWorktree) {
						return ambiguousArgError(path);
					}
				} else {
					index = removeEntry(index, path);
				}
			}
		}
	}

	await writeIndex(gitCtx, index);

	const response = {
		stdout: await formatUnstagedAfterReset(gitCtx, index),
		stderr: "",
		exitCode: 0,
	};
	await ext?.hooks?.emitPost("post-reset", {
		mode: "paths",
		targetHash: null,
	});
	return response;
}

/**
 * After any reset, diff index vs worktree and format the
 * "Unstaged changes after reset:" output that real git shows.
 * Includes M (modified), D (deleted), and U (unmerged) entries.
 */
async function formatUnstagedAfterReset(
	gitCtx: GitContext,
	index: ReturnType<typeof clearIndex>,
): Promise<string> {
	if (!gitCtx.workTree) return "";

	const unmergedPaths = new Set<string>();
	for (const e of index.entries) {
		if (e.stage > 0) unmergedPaths.add(e.path);
	}

	const diffs = await diffIndexToWorkTree(gitCtx, index);
	const unstaged = diffs.filter((d) => d.status === "modified" || d.status === "deleted");

	if (unstaged.length === 0 && unmergedPaths.size === 0) return "";

	const lines = ["Unstaged changes after reset:"];
	for (const d of unstaged) {
		const tag = d.status === "modified" ? "M" : "D";
		lines.push(`${tag}\t${d.path}`);
	}
	for (const p of [...unmergedPaths].sort()) {
		lines.push(`U\t${p}`);
	}
	lines.sort((a, b) => {
		if (a === "Unstaged changes after reset:") return -1;
		if (b === "Unstaged changes after reset:") return 1;
		const pathA = a.slice(2);
		const pathB = b.slice(2);
		return pathA < pathB ? -1 : pathA > pathB ? 1 : 0;
	});
	return `${lines.join("\n")}\n`;
}

// ── Commit-based reset ──────────────────────────────────────────────

/**
 * `git reset [--soft|--mixed|--hard] <commit>`
 *
 * - soft: move HEAD only
 * - mixed: move HEAD + reset index (default)
 * - hard: move HEAD + reset index + reset working tree
 */
async function resetToCommit(
	gitCtx: GitContext,
	commitRef: string,
	mode: "soft" | "mixed" | "hard",
	env: Map<string, string>,
	ext?: GitExtensions,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	if (ext?.hooks) {
		const abort = await ext.hooks.emitPre("pre-reset", {
			mode,
			target: commitRef,
		});
		if (abort) return { stdout: "", stderr: abort.message ?? "", exitCode: 1 };
	}
	const rawTarget = await resolveRevision(gitCtx, commitRef);
	if (!rawTarget) {
		return ambiguousArgError(commitRef);
	}
	const targetHash = await peelToCommit(gitCtx, rawTarget);

	const targetCommit = await readCommit(gitCtx, targetHash);

	// Real git blocks soft reset when MERGE_HEAD exists or index has
	// unmerged entries ("Cannot do a soft reset in the middle of a merge.")
	if (mode === "soft") {
		const mergeHead = await resolveRef(gitCtx, "MERGE_HEAD");
		const idx = await readIndex(gitCtx);
		if (mergeHead || hasConflicts(idx)) {
			return fatal("Cannot do a soft reset in the middle of a merge.");
		}
	}

	// ── Move HEAD ───────────────────────────────────────────────────
	const headHash = await resolveHead(gitCtx);
	const head = await readHead(gitCtx);
	if (head?.type === "symbolic") {
		// Move the branch that HEAD points to
		await updateRef(gitCtx, head.target, targetHash);
	} else {
		// Detached HEAD — move HEAD directly
		await updateRef(gitCtx, "HEAD", targetHash);
	}

	const resetMsg = `reset: moving to ${commitRef}`;
	if (head?.type === "symbolic" && headHash !== targetHash) {
		await logRef(gitCtx, env, head.target, headHash, targetHash, resetMsg, true);
	} else if (head?.type === "symbolic" || headHash !== targetHash) {
		await logRef(gitCtx, env, "HEAD", headHash, targetHash, resetMsg);
	}

	// Clear merge/cherry-pick state for ALL modes (including soft).
	// Real git's remove_branch_state() runs unconditionally after reset,
	// clearing CHERRY_PICK_HEAD, MERGE_HEAD, MERGE_MSG, etc.
	// (For soft mode, MERGE_HEAD was already blocked above, but
	// CHERRY_PICK_HEAD still needs clearing.)
	await clearAllOperationState(gitCtx);

	// ── Reset index (mixed mode) ────────────────────────────────────
	if (mode === "mixed") {
		const treeEntries = await flattenTree(gitCtx, targetCommit.tree);
		const index = buildIndex(
			treeEntries.map((entry) => ({
				path: entry.path,
				mode: parseInt(entry.mode, 8),
				hash: entry.hash,
				stage: 0,
				stat: defaultStat(),
			})),
		);
		await writeIndex(gitCtx, index);

		const resetOutput = await formatUnstagedAfterReset(gitCtx, index);
		if (resetOutput) {
			await ext?.hooks?.emitPost("post-reset", {
				mode,
				targetHash,
			});
			return { stdout: resetOutput, stderr: "", exitCode: 0 };
		}
	}

	// ── Reset index + working tree (hard mode) ─────────────────────
	if (mode === "hard") {
		const workTreeError = requireWorkTree(gitCtx);
		if (workTreeError) return workTreeError;

		const oldIndex = await readIndex(gitCtx);
		const result = await resetHard(gitCtx, targetCommit.tree, oldIndex);
		// resetHard always succeeds (reset=true skips all preconditions)
		await writeIndex(gitCtx, { version: 2, entries: result.newEntries });
		await applyWorktreeOps(gitCtx, result.worktreeOps);
	}

	const stdout =
		mode === "hard"
			? `HEAD is now at ${abbreviateHash(targetHash)} ${firstLine(targetCommit.message)}\n`
			: "";
	await ext?.hooks?.emitPost("post-reset", {
		mode,
		targetHash,
	});
	return { stdout, stderr: "", exitCode: 0 };
}
