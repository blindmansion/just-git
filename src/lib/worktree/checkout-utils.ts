import { findOrphanedCommits } from "../commit-walk.ts";
import { addEntry, defaultStat, readIndex, writeIndex } from "../index.ts";
import { hashObject, peelToCommit, readCommit } from "../object-db.ts";
import { clearAllOperationState } from "../operation-state.ts";
import { join } from "../path.ts";
import { matchPathspecs, parsePathspec } from "../attributes/pathspec.ts";
import { readReflog } from "../refs/reflog.ts";
import { listRefs, resolveRef } from "../refs/refs.ts";
import { isSubmoduleMode } from "../symlink.ts";
import { flattenTree, flattenTreeToMap } from "../tree-ops.ts";
import type { GitContext, GitRepo, ObjectId } from "../types.ts";
import { checkoutEntry } from "./worktree.ts";
import { firstLine } from "../text-utils.ts";
import { uniqueAbbrev } from "../abbrev.ts";
import { resolveRevision } from "../refs/rev-parse.ts";
import { readConfig, writeConfig, getConfigValue } from "../config/store.ts";

/**
 * Scan the HEAD reflog for the most recent "checkout: moving from X to Y"
 * entry and resolve the previous target. Branches return their current
 * hash; detached commits are surfaced distinctly so callers can provide
 * git-compatible guidance.
 */
export async function findPreviousCheckoutTarget(
	gitCtx: GitContext,
): Promise<
	| { kind: "branch"; name: string; refName: string; hash: ObjectId }
	| { kind: "commit"; target: string }
	| null
> {
	const entries = await readReflog(gitCtx, "HEAD");
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (!entry) continue;
		const match = entry.message.match(/^checkout: moving from (.+) to (.+)$/);
		if (!match?.[1]) continue;

		const target = match[1];
		const refName = `refs/heads/${target}`;
		const hash = await resolveRef(gitCtx, refName);
		if (hash) {
			return { kind: "branch", name: target, refName, hash };
		}

		const resolved = await resolveRevision(gitCtx, target);
		if (resolved) {
			try {
				await peelToCommit(gitCtx, resolved);
				return { kind: "commit", target };
			} catch {
				// Not a commit-ish; fall through to "no previous target".
			}
		}

		return null;
	}
	return null;
}

/**
 * Scan the HEAD reflog for the most recent "checkout: moving from X to Y"
 * entry and return the previous branch name and its current hash, or null
 * if no valid previous branch can be found.
 */
export async function findPreviousBranch(
	gitCtx: GitContext,
): Promise<{ name: string; refName: string; hash: ObjectId } | null> {
	const previous = await findPreviousCheckoutTarget(gitCtx);
	return previous?.kind === "branch" ? previous : null;
}

/** Which in-progress operations were cancelled by a checkout/switch. */
export interface ClearedOperations {
	cherryPickCancelled: boolean;
	revertCancelled: boolean;
}

/**
 * Clear merge/cherry-pick operation state after a successful checkout.
 * Real git clears these when switching branches. Returns which operations
 * were cancelled so the caller can render the appropriate warnings.
 */
export async function clearOperationState(gitCtx: GitContext): Promise<ClearedOperations> {
	const cherryPickCancelled = !!(await resolveRef(gitCtx, "CHERRY_PICK_HEAD"));
	const revertCancelled = !!(await resolveRef(gitCtx, "REVERT_HEAD"));
	await clearAllOperationState(gitCtx);
	return { cherryPickCancelled, revertCancelled };
}

/**
 * Structured result of a `restore*` operation. Carries semantic success or the
 * kind of failure encountered; the CLI mapper (`commands/kit/restore#renderRestoreOutcome`)
 * turns each variant into git-exact stderr text + exit code.
 */
export type RestoreOutcome =
	| { kind: "ok" }
	| { kind: "notWorkTree" }
	| { kind: "unmerged"; path: string }
	| { kind: "noMatch"; pathspec: string }
	| { kind: "noVersion"; path: string; side: "our" | "their" };

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
): Promise<RestoreOutcome> {
	if (!gitCtx.workTree) {
		return { kind: "notWorkTree" };
	}

	if (sourceTree) {
		return restoreFromTree(gitCtx, paths, cwdPrefix, sourceTree);
	}

	const index = await readIndex(gitCtx);
	const specs = paths.map((p) => parsePathspec(p, cwdPrefix));
	const matched = index.entries.filter((e) => e.stage === 0 && matchPathspecs(specs, e.path));

	if (matched.length === 0) {
		const hasConflictMatch = index.entries.some(
			(e) => e.stage > 0 && matchPathspecs(specs, e.path),
		);
		if (hasConflictMatch) {
			return { kind: "unmerged", path: paths[0] ?? "" };
		}
		return { kind: "noMatch", pathspec: paths[0] ?? "" };
	}

	for (const entry of matched) {
		await checkoutEntry(gitCtx, {
			path: entry.path,
			hash: entry.hash,
			mode: entry.mode,
		});
	}

	return { kind: "ok" };
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
): Promise<RestoreOutcome> {
	const treeMap = await flattenTreeToMap(gitCtx, treeHash);

	let index = await readIndex(gitCtx);
	const specs = paths.map((p) => parsePathspec(p, cwdPrefix));
	const matchedPaths: string[] = [];

	for (const [path] of treeMap) {
		if (matchPathspecs(specs, path)) {
			matchedPaths.push(path);
		}
	}

	if (matchedPaths.length === 0) {
		return { kind: "noMatch", pathspec: paths[0] ?? "" };
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
	return { kind: "ok" };
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
): Promise<RestoreOutcome> {
	if (!gitCtx.workTree) {
		return { kind: "notWorkTree" };
	}

	const deleteOnMissing = opts?.deleteOnMissing ?? false;
	const index = await readIndex(gitCtx);
	const specs = paths.map((p) => parsePathspec(p, cwdPrefix));

	const seen = new Set<string>();
	for (const e of index.entries) {
		if (matchPathspecs(specs, e.path)) seen.add(e.path);
	}
	if (seen.size === 0) {
		return { kind: "noMatch", pathspec: paths[0] ?? "" };
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
		} else {
			const hasConflict = index.entries.some((e) => e.path === path && e.stage > 0);
			if (hasConflict) {
				return { kind: "noVersion", path, side: stage === 2 ? "our" : "their" };
			}
		}
	}

	return { kind: "ok" };
}

/** One file's status in the checkout/switch stdout summary. */
export interface CheckoutFileChange {
	status: "A" | "M" | "D";
	path: string;
}

/**
 * Compute the file change summary shown by `git checkout`/`git switch` on
 * stdout, as structured data (renderer lives in `commands/kit/format/checkout.ts`).
 *
 * Matches real git's `show_local_changes` which runs `diff-index HEAD`
 * (non-cached): compares the new HEAD tree to the effective worktree
 * content. A file is reported if it differs from the tree, whether
 * the difference is staged (index differs from tree) or unstaged
 * (worktree differs from index which matches the tree).
 */
export async function computeCheckoutStatus(
	ctx: GitContext,
	targetTreeHash: ObjectId,
	index: { entries: { path: string; hash: string; stage: number }[] },
): Promise<CheckoutFileChange[]> {
	if (!ctx.workTree) return [];

	const treeEntries = await flattenTree(ctx, targetTreeHash);
	const treeMap = new Map<string, string>();
	for (const e of treeEntries) {
		if (isSubmoduleMode(e.mode)) continue;
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

	const changes: CheckoutFileChange[] = [];

	for (const [path, treeHash] of treeMap) {
		const indexHash = indexMap.get(path);
		if (indexHash === undefined) {
			changes.push({ status: "D", path });
			continue;
		}

		const wtHash = wtHashMap.get(path);
		if (wtHash === null) {
			changes.push({ status: "D", path });
		} else if (indexHash !== treeHash || (wtHash !== undefined && wtHash !== treeHash)) {
			changes.push({ status: "M", path });
		}
	}

	for (const [path] of indexMap) {
		if (!treeMap.has(path)) {
			const wtHash = wtHashMap.get(path);
			if (wtHash != null) {
				changes.push({ status: "A", path });
			}
		}
	}

	return changes;
}

const ORPHAN_DISPLAY_THRESHOLD = 5;

/**
 * Structured data for the preamble shown when leaving detached HEAD.
 * Rendered by `commands/kit/format/checkout.ts`.
 */
export type DetachPreamble =
	| {
			kind: "orphan";
			count: number;
			commits: { abbrev: string; subject: string }[];
			remaining: number;
			branchExample: string;
	  }
	| { kind: "prev-head"; abbrev: string; subject: string }
	| { kind: "none" };

/**
 * Gather the "Previous HEAD position was <short> <subject>" data for a commit.
 */
export async function gatherPrevHead(
	gitCtx: GitRepo,
	hash: ObjectId,
): Promise<{ kind: "prev-head"; abbrev: string; subject: string }> {
	const commit = await readCommit(gitCtx, hash);
	return {
		kind: "prev-head",
		abbrev: await uniqueAbbrev(gitCtx, hash),
		subject: firstLine(commit.message),
	};
}

/**
 * Gather the preamble data shown when leaving detached HEAD.
 * If orphaned commits exist, returns the orphan-warning data; otherwise
 * the previous-HEAD-position data (or `none` when currentHash === targetHash).
 */
export async function gatherDetachPreamble(
	gitCtx: GitRepo,
	currentHash: ObjectId,
	targetHash: ObjectId,
): Promise<DetachPreamble> {
	const orphans = await findOrphanedCommits(gitCtx, currentHash, {
		targetHash,
	});
	if (orphans.length > 0) {
		const count = orphans.length;
		const displayCount = count > ORPHAN_DISPLAY_THRESHOLD ? ORPHAN_DISPLAY_THRESHOLD - 1 : count;
		const displayed = orphans.slice(0, displayCount);
		const abbrevs = await Promise.all(displayed.map((o) => uniqueAbbrev(gitCtx, o.hash)));
		return {
			kind: "orphan",
			count,
			commits: displayed.map((o, i) => ({ abbrev: abbrevs[i]!, subject: o.subject })),
			remaining: count - displayCount,
			branchExample: abbrevs[0]!,
		};
	}
	if (currentHash !== targetHash) {
		return gatherPrevHead(gitCtx, currentHash);
	}
	return { kind: "none" };
}

// ── Remote tracking ref detection and auto-setup ─────────────────────

/**
 * Resolve a start-point name to a remote tracking ref if possible.
 * Returns `{ remote, branch, ref }` if it matches `refs/remotes/<remote>/<branch>`,
 * or null otherwise.
 */
async function resolveRemoteTrackingRef(
	gitCtx: GitRepo,
	startPoint: string,
): Promise<{ remote: string; branch: string; ref: string } | null> {
	if (startPoint.startsWith("refs/remotes/")) {
		const hash = await resolveRef(gitCtx, startPoint);
		if (!hash) return null;
		const parts = startPoint.slice("refs/remotes/".length).split("/");
		if (parts.length < 2) return null;
		const remote = parts[0]!;
		const branch = parts.slice(1).join("/");
		return { remote, branch, ref: startPoint };
	}

	// Try short form: origin/main → refs/remotes/origin/main
	const fullRef = `refs/remotes/${startPoint}`;
	const hash = await resolveRef(gitCtx, fullRef);
	if (hash) {
		const parts = startPoint.split("/");
		if (parts.length < 2) return null;
		const remote = parts[0]!;
		const branch = parts.slice(1).join("/");
		return { remote, branch, ref: fullRef };
	}

	return null;
}

/** The remote/branch a local branch was set up to track. */
export interface TrackingSetup {
	remote: string;
	branch: string;
}

/**
 * Auto-set branch tracking config when creating a branch from a remote tracking ref,
 * respecting `branch.autoSetupMerge` config (default: true).
 * Returns the remote/branch that was configured, or null if no tracking was set.
 */
export async function setupTracking(
	gitCtx: GitContext,
	branchName: string,
	startPoint: string,
): Promise<TrackingSetup | null> {
	const tracking = await resolveRemoteTrackingRef(gitCtx, startPoint);
	if (!tracking) return null;

	const autoSetup = await getConfigValue(gitCtx, "branch.autoSetupMerge");
	if (autoSetup === "false") return null;

	const config = await readConfig(gitCtx);
	const section = `branch "${branchName}"`;
	if (!config[section]) config[section] = {};
	config[section].remote = tracking.remote;
	config[section].merge = `refs/heads/${tracking.branch}`;
	await writeConfig(gitCtx, config);

	return { remote: tracking.remote, branch: tracking.branch };
}

/**
 * DWIM: guess a remote tracking branch for a name that doesn't match
 * any local branch. Returns the match if exactly one remote has the branch,
 * or uses `checkout.defaultRemote` config to disambiguate multiple matches.
 */
export async function guessRemoteBranch(
	gitCtx: GitContext,
	name: string,
): Promise<{ remote: string; startPoint: string; trackingRef: string } | null> {
	const allRefs = await listRefs(gitCtx, "refs/remotes");
	const candidates: { remote: string; ref: string }[] = [];

	for (const ref of allRefs) {
		const parts = ref.name.replace(/^refs\/remotes\//, "").split("/");
		const remote = parts[0];
		if (parts.length >= 2 && remote) {
			const branch = parts.slice(1).join("/");
			if (branch === name) {
				candidates.push({ remote, ref: ref.name });
			}
		}
	}

	if (candidates.length === 1) {
		const c = candidates[0]!;
		return { remote: c.remote, startPoint: c.ref, trackingRef: c.ref };
	}

	if (candidates.length > 1) {
		const defaultRemote = await getConfigValue(gitCtx, "checkout.defaultRemote");
		if (defaultRemote) {
			const filtered = candidates.filter((c) => c.remote === defaultRemote);
			if (filtered.length === 1) {
				const c = filtered[0]!;
				return { remote: c.remote, startPoint: c.ref, trackingRef: c.ref };
			}
		}
	}

	return null;
}
