import type { GitExtensions } from "../git.ts";
import { abbreviateHash, type CommandResult, err, fatal, firstLine } from "./command-utils.ts";
import { findOrphanedCommits } from "./commit-walk.ts";
import { readConfig } from "./config.ts";
import { addEntry, defaultStat, findEntry, readIndex, writeIndex } from "./index.ts";
import { hashObject, readCommit } from "./object-db.ts";
import { clearAllOperationState, clearDetachPoint, writeDetachPoint } from "./operation-state.ts";
import { join } from "./path.ts";
import { containsWildcard, matchPathspecs, parsePathspec } from "./pathspec.ts";
import { logRef, readReflog, ZERO_HASH } from "./reflog.ts";
import { createSymbolicRef, readHead, resolveHead, resolveRef, updateRef } from "./refs.ts";
import { formatLongTrackingInfo, getTrackingInfo } from "./status-format.ts";
import { flattenTree, flattenTreeToMap } from "./tree-ops.ts";
import type { GitContext, ObjectId } from "./types.ts";
import { applyWorktreeOps, checkoutTrees } from "./unpack-trees.ts";
import { checkoutEntry } from "./worktree.ts";

/**
 * Scan the HEAD reflog for the most recent "checkout: moving from X to Y"
 * entry and return the previous branch name and its current hash, or null
 * if no valid previous branch can be found.
 */
export async function findPreviousBranch(
	gitCtx: GitContext,
): Promise<{ name: string; refName: string; hash: ObjectId } | null> {
	const entries = await readReflog(gitCtx, "HEAD");
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (!entry) continue;
		const match = entry.message.match(/^checkout: moving from (.+) to (.+)$/);
		if (match?.[1]) {
			const prevBranch = match[1];
			const refName = `refs/heads/${prevBranch}`;
			const hash = await resolveRef(gitCtx, refName);
			if (hash) {
				return { name: prevBranch, refName, hash };
			}
		}
	}
	return null;
}

/**
 * Clear merge/cherry-pick operation state after a successful checkout.
 * Real git clears these when switching branches.
 * Returns a warning string if a cherry-pick was cancelled.
 */
export async function clearOperationState(gitCtx: GitContext): Promise<string> {
	let warning = "";
	const cpHead = await resolveRef(gitCtx, "CHERRY_PICK_HEAD");
	if (cpHead) {
		warning = "warning: cancelling a cherry picking in progress\n";
	}
	const revertHead = await resolveRef(gitCtx, "REVERT_HEAD");
	if (revertHead) {
		warning += "warning: cancelling a revert in progress\n";
	}
	await clearAllOperationState(gitCtx);
	return warning;
}

/**
 * Build the "<path>: needs merge" file list that real git prints to
 * stdout when checkout is blocked by unmerged index entries.
 */
function formatUnmergedList(index: { entries: { path: string; stage: number }[] }): string {
	const seen = new Set<string>();
	const lines: string[] = [];
	for (const e of index.entries) {
		if (e.stage > 0 && !seen.has(e.path)) {
			seen.add(e.path);
			lines.push(`${e.path}: needs merge`);
		}
	}
	lines.sort();
	return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

/**
 * Return an error result if the index has unmerged entries, or null if clean.
 * Combines hasConflicts check + formatUnmergedList output, matching the
 * standard "you need to resolve your current index first" message.
 */
export function requireResolvedIndex(index: {
	entries: { path: string; stage: number }[];
}): CommandResult | null {
	if (!index.entries.some((e) => e.stage > 0)) return null;
	return {
		stdout: formatUnmergedList(index),
		stderr: "error: you need to resolve your current index first\n",
		exitCode: 1,
	};
}

/**
 * Restore files from the index or a specific tree.
 * Supports glob pathspecs. When `sourceTree` is provided, restores from
 * that tree and updates the index to match.
 */
export async function restoreFiles(
	gitCtx: GitContext,
	paths: string[],
	cwdPrefix: string,
	sourceTree?: ObjectId | null,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	if (!gitCtx.workTree) {
		return fatal("this operation must be run in a work tree");
	}

	if (sourceTree) {
		return restoreFromTree(gitCtx, paths, cwdPrefix, sourceTree);
	}

	const index = await readIndex(gitCtx);
	const hasGlobs = paths.some(containsWildcard);

	if (hasGlobs) {
		const specs = paths.map((p) => parsePathspec(p, cwdPrefix));
		const matched = index.entries.filter((e) => e.stage === 0 && matchPathspecs(specs, e.path));
		if (matched.length === 0) {
			return err(`error: pathspec '${paths[0]}' did not match any file(s) known to git\n`);
		}
		for (const entry of matched) {
			await checkoutEntry(gitCtx, {
				path: entry.path,
				hash: entry.hash,
				mode: entry.mode,
			});
		}
	} else {
		for (const path of paths) {
			const entry = findEntry(index, path);
			if (!entry) {
				const hasConflictEntry = index.entries.some((e) => e.path === path && e.stage > 0);
				if (hasConflictEntry) {
					return err(`error: path '${path}' is unmerged\n`);
				}
				return err(`error: pathspec '${path}' did not match any file(s) known to git\n`);
			}
			await checkoutEntry(gitCtx, {
				path: entry.path,
				hash: entry.hash,
				mode: entry.mode,
			});
		}
	}

	return { stdout: "", stderr: "", exitCode: 0 };
}

/**
 * Restore files from a specific tree hash.
 * Updates both the worktree and the index.
 */
async function restoreFromTree(
	gitCtx: GitContext,
	paths: string[],
	cwdPrefix: string,
	treeHash: ObjectId,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const treeMap = await flattenTreeToMap(gitCtx, treeHash);

	let index = await readIndex(gitCtx);
	const hasGlobs = paths.some(containsWildcard);

	const matchedPaths: string[] = [];

	if (hasGlobs) {
		const specs = paths.map((p) => parsePathspec(p, cwdPrefix));
		for (const [path] of treeMap) {
			if (matchPathspecs(specs, path)) {
				matchedPaths.push(path);
			}
		}
		if (matchedPaths.length === 0) {
			return err(`error: pathspec '${paths[0]}' did not match any file(s) known to git\n`);
		}
	} else {
		for (const path of paths) {
			const treeEntry = treeMap.get(path);
			if (!treeEntry) {
				return err(`error: pathspec '${path}' did not match any file(s) known to git\n`);
			}
			matchedPaths.push(path);
		}
	}

	for (const path of matchedPaths) {
		const treeEntry = treeMap.get(path);
		if (!treeEntry) continue;
		await checkoutEntry(gitCtx, {
			path: treeEntry.path,
			hash: treeEntry.hash,
			mode: treeEntry.mode,
		});
		index = addEntry(index, {
			path: treeEntry.path,
			hash: treeEntry.hash,
			mode: parseInt(treeEntry.mode, 8),
			stage: 0,
			stat: defaultStat(),
		});
	}

	await writeIndex(gitCtx, index);
	return { stdout: "", stderr: "", exitCode: 0 };
}

/**
 * Resolve conflicted files using --ours (stage 2) or --theirs (stage 3).
 * Writes the chosen version to the worktree and updates the index to
 * stage 0, clearing higher stages for the path.
 */
export async function restoreConflicted(
	gitCtx: GitContext,
	paths: string[],
	cwdPrefix: string,
	stage: 2 | 3,
	opts?: { deleteOnMissing?: boolean },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	if (!gitCtx.workTree) {
		return fatal("this operation must be run in a work tree");
	}

	const deleteOnMissing = opts?.deleteOnMissing ?? false;
	const index = await readIndex(gitCtx);
	const hasGlobs = paths.some(containsWildcard);

	if (hasGlobs) {
		const specs = paths.map((p) => parsePathspec(p, cwdPrefix));
		const seen = new Set<string>();
		for (const e of index.entries) {
			if (matchPathspecs(specs, e.path)) seen.add(e.path);
		}
		if (seen.size === 0) {
			return err(`error: pathspec '${paths[0]}' did not match any file(s) known to git\n`);
		}
		for (const path of seen) {
			const stageEntry = index.entries.find((e) => e.path === path && e.stage === stage);
			const fallback = !stageEntry && index.entries.find((e) => e.path === path && e.stage === 0);
			const entry = stageEntry || fallback;
			if (entry) {
				await checkoutEntry(gitCtx, {
					path: entry.path,
					hash: entry.hash,
					mode: entry.mode,
				});
			} else if (deleteOnMissing) {
				const fullPath = join(gitCtx.workTree as string, path);
				if (await gitCtx.fs.exists(fullPath)) {
					await gitCtx.fs.rm(fullPath);
				}
			}
		}
	} else {
		for (const path of paths) {
			const hasConflict = index.entries.some((e) => e.path === path && e.stage > 0);
			if (hasConflict) {
				const entry = index.entries.find((e) => e.path === path && e.stage === stage);
				if (!entry) {
					if (deleteOnMissing) {
						const fullPath = join(gitCtx.workTree as string, path);
						if (await gitCtx.fs.exists(fullPath)) {
							await gitCtx.fs.rm(fullPath);
						}
					} else {
						const label = stage === 2 ? "our" : "their";
						return err(`error: path '${path}' does not have ${label} version\n`);
					}
				} else {
					await checkoutEntry(gitCtx, {
						path: entry.path,
						hash: entry.hash,
						mode: entry.mode,
					});
				}
			} else {
				const entry = findEntry(index, path);
				if (!entry) {
					return err(`error: pathspec '${path}' did not match any file(s) known to git\n`);
				}
				await checkoutEntry(gitCtx, {
					path: entry.path,
					hash: entry.hash,
					mode: entry.mode,
				});
			}
		}
	}

	return { stdout: "", stderr: "", exitCode: 0 };
}

/**
 * Format the file change summary shown by `git checkout`/`git switch` on stdout.
 *
 * Matches real git's `show_local_changes` which runs `diff-index HEAD`
 * (non-cached): compares the new HEAD tree to the effective worktree
 * content. A file is reported if it differs from the tree, whether
 * the difference is staged (index differs from tree) or unstaged
 * (worktree differs from index which matches the tree).
 */
export async function formatCheckoutSummary(
	ctx: GitContext,
	targetTreeHash: ObjectId,
	index: { entries: { path: string; hash: string; stage: number }[] },
): Promise<string> {
	if (!ctx.workTree) return "";

	const treeEntries = await flattenTree(ctx, targetTreeHash);
	const treeMap = new Map<string, string>();
	for (const e of treeEntries) {
		treeMap.set(e.path, e.hash);
	}

	const indexMap = new Map<string, string>();
	for (const e of index.entries) {
		if (e.stage === 0) {
			indexMap.set(e.path, e.hash);
		}
	}

	const wtHashMap = new Map<string, string | null>();
	for (const [path] of indexMap) {
		const fullPath = join(ctx.workTree as string, path);
		if (await ctx.fs.exists(fullPath)) {
			const stat = await ctx.fs.stat(fullPath);
			if (stat.isFile) {
				const content = await ctx.fs.readFileBuffer(fullPath);
				wtHashMap.set(path, await hashObject("blob", content));
			}
		} else {
			wtHashMap.set(path, null);
		}
	}

	const lines: string[] = [];

	for (const [path, treeHash] of treeMap) {
		const indexHash = indexMap.get(path);
		if (indexHash === undefined) {
			lines.push(`D\t${path}`);
			continue;
		}

		const wtHash = wtHashMap.get(path);
		if (wtHash === null) {
			lines.push(`D\t${path}`);
		} else if (indexHash !== treeHash || (wtHash !== undefined && wtHash !== treeHash)) {
			lines.push(`M\t${path}`);
		}
	}

	for (const [path] of indexMap) {
		if (!treeMap.has(path)) {
			const wtHash = wtHashMap.get(path);
			if (wtHash != null) {
				lines.push(`A\t${path}`);
			}
		}
	}

	if (lines.length === 0) return "";
	lines.sort((a, b) => {
		const pathA = a.slice(2);
		const pathB = b.slice(2);
		return pathA < pathB ? -1 : pathA > pathB ? 1 : 0;
	});
	return `${lines.join("\n")}\n`;
}

const ORPHAN_DISPLAY_THRESHOLD = 5;

/**
 * Format the "Warning: you are leaving N commits behind" message.
 * Real git truncates the list when count > threshold.
 */
function formatOrphanWarning(orphans: { hash: string; subject: string }[]): string {
	const count = orphans.length;
	const plural = count === 1 ? "commit" : "commits";
	const keepWord = count === 1 ? "it" : "them";
	const displayCount = count > ORPHAN_DISPLAY_THRESHOLD ? ORPHAN_DISPLAY_THRESHOLD - 1 : count;
	const displayed = orphans.slice(0, displayCount);
	const lines = displayed.map((o) => `  ${abbreviateHash(o.hash)} ${o.subject}`);
	const remaining = count - displayCount;
	if (remaining > 0) {
		lines.push(` ... and ${remaining} more.`);
	}
	return (
		`Warning: you are leaving ${count} ${plural} behind, not connected to\n` +
		`any of your branches:\n` +
		`\n` +
		`${lines.join("\n")}\n` +
		`\n` +
		`If you want to keep ${keepWord} by creating a new branch, this may be a good time\n` +
		`to do so with:\n` +
		`\n` +
		` git branch <new-branch-name> ${abbreviateHash((orphans[0] as { hash: string }).hash)}\n` +
		`\n`
	);
}

/**
 * Format "Previous HEAD position was <short> <subject>\n".
 */
export async function formatPrevHeadPosition(gitCtx: GitContext, hash: ObjectId): Promise<string> {
	const commit = await readCommit(gitCtx, hash);
	return `Previous HEAD position was ${abbreviateHash(hash)} ${firstLine(commit.message)}\n`;
}

/**
 * Build the preamble shown when leaving detached HEAD.
 * If orphaned commits exist, returns the orphan warning; otherwise
 * returns the "Previous HEAD position was ..." line (or "" when
 * currentHash === targetHash).
 */
export async function buildDetachPreamble(
	gitCtx: GitContext,
	currentHash: ObjectId,
	targetHash: ObjectId,
): Promise<string> {
	const orphans = await findOrphanedCommits(gitCtx, currentHash, {
		targetHash,
	});
	if (orphans.length > 0) {
		return formatOrphanWarning(orphans);
	}
	if (currentHash !== targetHash) {
		return formatPrevHeadPosition(gitCtx, currentHash);
	}
	return "";
}

/**
 * Core branch-switching logic shared by `checkout` and `switch`.
 * Handles: already-on check, conflict check, tree checkout, detach
 * preamble, HEAD/reflog update, post-checkout hook, and tracking info.
 * Callers perform their own pre-checks (hooks, active-operation guards).
 */
export async function switchBranchCore(
	gitCtx: GitContext,
	branchName: string,
	refName: string,
	targetHash: ObjectId,
	env: Map<string, string>,
	ext?: GitExtensions,
): Promise<CommandResult> {
	const head = await readHead(gitCtx);
	if (head?.type === "symbolic" && head.target === refName) {
		return {
			stdout: "",
			stderr: `Already on '${branchName}'\n`,
			exitCode: 0,
		};
	}

	let currentIndex = await readIndex(gitCtx);
	const conflictErr = requireResolvedIndex(currentIndex);
	if (conflictErr) return conflictErr;

	const currentHash = await resolveHead(gitCtx);
	const targetCommit = await readCommit(gitCtx, targetHash);
	const targetTree = targetCommit.tree;

	let currentTree: ObjectId | null = null;
	if (currentHash) {
		const currentCommit = await readCommit(gitCtx, currentHash);
		currentTree = currentCommit.tree;
	}

	if (currentTree !== targetTree) {
		const result = await checkoutTrees(gitCtx, currentTree, targetTree, currentIndex);
		if (!result.success) {
			return result.errorOutput ?? err("error: checkout would overwrite local changes");
		}
		currentIndex = { version: 2, entries: result.newEntries };
		await writeIndex(gitCtx, currentIndex);
		await applyWorktreeOps(gitCtx, result.worktreeOps);
	}

	let detachPreamble = "";
	if (head?.type === "direct" && currentHash) {
		detachPreamble = await buildDetachPreamble(gitCtx, currentHash, targetHash);
	}

	const fromName =
		head?.type === "symbolic"
			? head.target.replace(/^refs\/heads\//, "")
			: (currentHash ?? ZERO_HASH);
	await createSymbolicRef(gitCtx, "HEAD", refName);
	await clearDetachPoint(gitCtx);
	const opWarning = await clearOperationState(gitCtx);

	await logRef(
		gitCtx,
		env,
		"HEAD",
		currentHash,
		targetHash,
		`checkout: moving from ${fromName} to ${branchName}`,
	);

	await ext?.hooks?.emitPost("post-checkout", {
		prevHead: currentHash,
		newHead: targetHash,
		isBranchCheckout: true,
	});

	let stdout = await formatCheckoutSummary(gitCtx, targetTree, currentIndex);

	const config = await readConfig(gitCtx);
	const trackingInfo = await getTrackingInfo(gitCtx, config, branchName);
	if (trackingInfo) {
		stdout += formatLongTrackingInfo(trackingInfo);
	}

	return {
		stdout,
		stderr: `${detachPreamble}Switched to branch '${branchName}'\n${opWarning}`,
		exitCode: 0,
	};
}

/**
 * Core detach-HEAD logic shared by `checkout` and `switch`.
 * Handles: conflict check, tree checkout, ref update, reflog,
 * post-checkout hook, and checkout summary.
 *
 * When `detachAdviceTarget` is set and HEAD was previously on a branch,
 * the full detached-HEAD advice is shown (checkout behavior). Otherwise
 * only "HEAD is now at ..." is shown (switch behavior).
 */
export async function detachHeadCore(
	gitCtx: GitContext,
	targetHash: ObjectId,
	env: Map<string, string>,
	ext?: GitExtensions,
	opts?: {
		detachAdviceTarget?: string;
	},
): Promise<CommandResult> {
	let currentIndex = await readIndex(gitCtx);
	const conflictErr = requireResolvedIndex(currentIndex);
	if (conflictErr) return conflictErr;

	const currentHash = await resolveHead(gitCtx);
	const targetCommit = await readCommit(gitCtx, targetHash);
	const targetTree = targetCommit.tree;

	let currentTree: ObjectId | null = null;
	if (currentHash) {
		const currentCommit = await readCommit(gitCtx, currentHash);
		currentTree = currentCommit.tree;
	}

	if (currentTree !== targetTree) {
		const result = await checkoutTrees(gitCtx, currentTree, targetTree, currentIndex);
		if (!result.success) {
			return result.errorOutput ?? err("error: checkout would overwrite local changes");
		}
		currentIndex = { version: 2, entries: result.newEntries };
		await writeIndex(gitCtx, currentIndex);
		await applyWorktreeOps(gitCtx, result.worktreeOps);
	}

	const head = await readHead(gitCtx);
	const wasAlreadyDetachedAtTarget = head?.type === "direct" && currentHash === targetHash;

	await updateRef(gitCtx, "HEAD", targetHash);
	if (!wasAlreadyDetachedAtTarget) {
		await writeDetachPoint(gitCtx, targetHash);
		const fromName =
			head?.type === "symbolic"
				? head.target.replace(/^refs\/heads\//, "")
				: (currentHash ?? ZERO_HASH);
		await logRef(
			gitCtx,
			env,
			"HEAD",
			currentHash,
			targetHash,
			`checkout: moving from ${fromName} to ${targetHash}`,
		);
	}
	const opWarning = await clearOperationState(gitCtx);

	await ext?.hooks?.emitPost("post-checkout", {
		prevHead: currentHash,
		newHead: targetHash,
		isBranchCheckout: false,
	});

	const shortHash = abbreviateHash(targetHash);
	const subject = firstLine(targetCommit.message);
	const alreadyDetached = head?.type === "direct";

	let stderr = "";

	if (alreadyDetached && currentHash && currentHash !== targetHash) {
		stderr += await buildDetachPreamble(gitCtx, currentHash, targetHash);
	}

	if (alreadyDetached || !opts?.detachAdviceTarget) {
		stderr += `HEAD is now at ${shortHash} ${subject}\n`;
	} else {
		stderr =
			`Note: switching to '${opts.detachAdviceTarget}'.\n` +
			`\n` +
			`You are in 'detached HEAD' state. You can look around, make experimental\n` +
			`changes and commit them, and you can discard any commits you make in this\n` +
			`state without impacting any branches by switching back to a branch.\n` +
			`\n` +
			`If you want to create a new branch to retain commits you create, you may\n` +
			`do so (now or later) by using -c with the switch command. Example:\n` +
			`\n` +
			`  git switch -c <new-branch-name>\n` +
			`\n` +
			`Or undo this operation with:\n` +
			`\n` +
			`  git switch -\n` +
			`\n` +
			`Turn off this advice by setting config variable advice.detachedHead to false\n` +
			`\n` +
			`HEAD is now at ${shortHash} ${subject}\n`;
	}

	stderr += opWarning;

	const stdout = await formatCheckoutSummary(gitCtx, targetTree, currentIndex);

	return { stdout, stderr, exitCode: 0 };
}
