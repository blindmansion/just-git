import { abbreviateHash } from "./command-utils.ts";
import { formatDiffStat } from "./commit-summary.ts";
import { getConfigValue } from "./config.ts";
import { readIndex, writeIndex } from "./index.ts";
import { readCommit } from "./object-db.ts";
import { advanceBranchRef } from "./refs.ts";
import type { GitContext, GitRepo, IndexEntry, ObjectId } from "./types.ts";
import { applyWorktreeOps, fastForwardMerge } from "./unpack-trees.ts";

// ── Types ───────────────────────────────────────────────────────────

export interface MergeConflict {
	path: string;
	reason:
		| "content"
		| "delete-modify"
		| "add-add"
		| "rename-delete"
		| "rename-rename"
		| "directory-rename";
	/** For delete-modify / rename-delete: which side deleted the file. */
	deletedBy?: "ours" | "theirs";
	/** For rename conflicts: the old (base) path. */
	oldPath?: string;
	/** For rename/rename: the path ours renamed to. */
	oursPath?: string;
	/** For rename/rename: the path theirs renamed to. */
	theirsPath?: string;
	/**
	 * For content conflicts arising from renames: the path where ours' version
	 * was before the merge. If different from `path`, indicates ours had the
	 * file at a different location.
	 */
	oursOrigPath?: string;
	/**
	 * For content conflicts arising from renames: the path where theirs'
	 * version was before the merge.
	 */
	theirsOrigPath?: string;
}

export interface MergeTreeResult {
	/** Merged index entries (stage 0 for clean, stages 1-3 for conflicts). */
	entries: IndexEntry[];
	/** List of conflicted paths with descriptions. */
	conflicts: MergeConflict[];
	/**
	 * Merge progress messages (Auto-merging, CONFLICT) sorted by path.
	 * These go to stdout in real git.
	 */
	messages: string[];
}

// ── Merge base computation ──────────────────────────────────────────

/**
 * Collect all ancestors of a commit (including itself) via BFS.
 */
async function collectAncestors(ctx: GitRepo, hash: ObjectId): Promise<Set<ObjectId>> {
	const ancestors = new Set<ObjectId>();
	const queue: ObjectId[] = [hash];
	let qi = 0;
	while (qi < queue.length) {
		const current = queue[qi++]!;
		if (ancestors.has(current)) continue;
		ancestors.add(current);
		let commit;
		try {
			commit = await readCommit(ctx, current);
		} catch {
			continue;
		}
		for (const parent of commit.parents) {
			if (!ancestors.has(parent)) queue.push(parent);
		}
	}
	return ancestors;
}

/**
 * Check if `candidate` is an ancestor of `descendant`.
 * Uses BFS with early exit — stops as soon as `candidate` is found
 * rather than building the full ancestor set.
 */
export async function isAncestor(
	ctx: GitRepo,
	candidate: ObjectId,
	descendant: ObjectId,
): Promise<boolean> {
	if (candidate === descendant) return true;
	const visited = new Set<ObjectId>();
	const queue: ObjectId[] = [descendant];
	let qi = 0;
	while (qi < queue.length) {
		const current = queue[qi++]!;
		if (current === candidate) return true;
		if (visited.has(current)) continue;
		visited.add(current);
		let commit;
		try {
			commit = await readCommit(ctx, current);
		} catch {
			continue;
		}
		for (const parent of commit.parents) {
			if (!visited.has(parent)) queue.push(parent);
		}
	}
	return false;
}

/**
 * Find ALL merge bases (lowest common ancestors) of two commits.
 *
 * Algorithm:
 * 1. Collect all ancestors of A.
 * 2. BFS from B — collect all common ancestors (present in A's set).
 * 3. Filter: remove any common ancestor that is an ancestor of another
 *    common ancestor (keep only the "lowest" / most recent ones).
 *
 * Returns an empty array for disjoint histories.
 */
export async function findAllMergeBases(
	ctx: GitRepo,
	hashA: ObjectId,
	hashB: ObjectId,
): Promise<ObjectId[]> {
	if (hashA === hashB) return [hashA];

	const ancestorsA = await collectAncestors(ctx, hashA);

	// BFS from B to find all common ancestors
	const commonAncestors: ObjectId[] = [];
	const visitedB = new Set<ObjectId>();
	const queueB: ObjectId[] = [hashB];

	let qbi = 0;
	while (qbi < queueB.length) {
		const current = queueB[qbi++]!;
		if (visitedB.has(current)) continue;
		visitedB.add(current);

		if (ancestorsA.has(current)) {
			commonAncestors.push(current);
			// Don't walk past a common ancestor — its ancestors are
			// guaranteed to not be LCAs (they'd be ancestors of this one).
			continue;
		}

		let commit;
		try {
			commit = await readCommit(ctx, current);
		} catch {
			continue;
		}
		for (const parent of commit.parents) {
			if (!visitedB.has(parent)) queueB.push(parent);
		}
	}

	if (commonAncestors.length <= 1) return commonAncestors;

	// Filter: keep only those that are not ancestors of any other.
	// An LCA is a common ancestor that no other common ancestor descends from.
	const lcas: ObjectId[] = [];
	for (const candidate of commonAncestors) {
		let dominated = false;
		for (const other of commonAncestors) {
			if (other === candidate) continue;
			if (await isAncestor(ctx, candidate, other)) {
				// candidate is an ancestor of other → other is "newer", candidate is not an LCA
				dominated = true;
				break;
			}
		}
		if (!dominated) lcas.push(candidate);
	}

	if (lcas.length <= 1) return lcas;

	// Order LCAs by git-like paint discovery order (date-priority walk).
	return orderMergeBasesByPaintOrder(ctx, hashA, hashB, lcas);
}

interface PaintQueueItem {
	hash: ObjectId;
	mask: 1 | 2 | 3;
	seq: number;
}

/**
 * Approximate git's paint_down_to_common() ordering for merge bases.
 *
 * Walk both sides through commit history using committer-date priority.
 * LCAs are returned in the order they become common during this paint.
 */
async function orderMergeBasesByPaintOrder(
	ctx: GitRepo,
	hashA: ObjectId,
	hashB: ObjectId,
	lcas: ObjectId[],
): Promise<ObjectId[]> {
	const lcaSet = new Set<ObjectId>(lcas);
	const added = new Set<ObjectId>();
	const ordered: ObjectId[] = [];

	const seenMask = new Map<ObjectId, number>();
	const timestampCache = new Map<ObjectId, number>();
	let seq = 0;
	const queue: PaintQueueItem[] = [
		{ hash: hashA, mask: 1, seq: seq++ },
		{ hash: hashB, mask: 2, seq: seq++ },
	];

	async function getTimestamp(hash: ObjectId): Promise<number> {
		const cached = timestampCache.get(hash);
		if (cached !== undefined) return cached;
		const ts = (await readCommit(ctx, hash)).committer.timestamp;
		timestampCache.set(hash, ts);
		return ts;
	}

	while (queue.length > 0) {
		// Pop highest timestamp; break ties by insertion order (FIFO).
		let bestIdx = 0;
		let bestTs = await getTimestamp(queue[0]!.hash);
		for (let i = 1; i < queue.length; i++) {
			const item = queue[i]!;
			const ts = await getTimestamp(item.hash);
			const bestItem = queue[bestIdx]!;
			if (ts > bestTs || (ts === bestTs && item.seq < bestItem.seq)) {
				bestIdx = i;
				bestTs = ts;
			}
		}

		const item = queue.splice(bestIdx, 1)[0]!;
		const previousMask = seenMask.get(item.hash) ?? 0;
		const nextMask = (previousMask | item.mask) as 1 | 2 | 3;
		if (nextMask === previousMask) continue;
		seenMask.set(item.hash, nextMask);

		if (nextMask === 3 && lcaSet.has(item.hash) && !added.has(item.hash)) {
			ordered.push(item.hash);
			added.add(item.hash);
			if (added.size === lcaSet.size) break;
		}

		const commit = await readCommit(ctx, item.hash);
		for (const parent of commit.parents) {
			queue.push({ hash: parent, mask: nextMask, seq: seq++ });
		}
	}

	// Fallback: include anything missed, preserving original LCA order.
	for (const hash of lcas) {
		if (!added.has(hash)) ordered.push(hash);
	}
	return ordered;
}

// ── buildMergeMessage ───────────────────────────────────────────────

/**
 * Build the default merge commit message.
 *
 * Real git omits "into <branch>" when merging into the repository's default
 * branch (typically "main" or "master"). We replicate this by checking the
 * `init.defaultBranch` config value, falling back to "main".
 */
export async function buildMergeMessage(
	gitCtx: GitContext,
	branchName: string,
	currentBranch: string,
): Promise<string> {
	const defaultBranch = (await getConfigValue(gitCtx, "init.defaultBranch")) ?? "main";
	if (currentBranch === defaultBranch) {
		return `Merge branch '${branchName}'\n`;
	}
	return `Merge branch '${branchName}' into ${currentBranch}\n`;
}

// ── Fast-forward merge (high-level) ─────────────────────────────────

export async function handleFastForward(
	gitCtx: GitContext,
	headHash: ObjectId,
	theirsHash: ObjectId,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const headCommit = await readCommit(gitCtx, headHash);
	const theirsCommit = await readCommit(gitCtx, theirsHash);

	const oldShort = abbreviateHash(headHash);
	const newShort = abbreviateHash(theirsHash);
	const updatingLine = `Updating ${oldShort}..${newShort}\n`;

	if (gitCtx.workTree) {
		const currentIndex = await readIndex(gitCtx);
		const result = await fastForwardMerge(gitCtx, headCommit.tree, theirsCommit.tree, currentIndex);
		if (!result.success) {
			const err = result.errorOutput as {
				stdout: string;
				stderr: string;
				exitCode: number;
			};
			return {
				stdout: updatingLine + err.stdout,
				stderr: err.stderr,
				exitCode: err.exitCode,
			};
		}
		await writeIndex(gitCtx, { version: 2, entries: result.newEntries });
		await applyWorktreeOps(gitCtx, result.worktreeOps);
	}

	await advanceBranchRef(gitCtx, theirsHash);

	const diffstat = await formatDiffStat(gitCtx, headCommit.tree, theirsCommit.tree);
	return {
		stdout: `${updatingLine}Fast-forward\n${diffstat}`,
		stderr: "",
		exitCode: 0,
	};
}
