import { readCommit } from "./object-db.ts";
import { relative } from "./path.ts";
import { flattenTreeToMap } from "./tree-ops.ts";
import type { GitContext, Index, ObjectId } from "./types.ts";
import { diffIndexToWorkTree } from "./worktree/worktree.ts";

/**
 * Check whether the index has staged changes relative to a HEAD tree.
 * Compares stage-0 index entries against the tree map for modifications,
 * additions, and deletions.
 */
export function hasStagedChanges(index: Index, headMap: Map<string, { hash: string }>): boolean {
	const stage0 = new Map<string, { hash: string }>();
	for (const e of index.entries) {
		if (e.stage === 0) stage0.set(e.path, e);
	}
	for (const [path, entry] of stage0) {
		const headEntry = headMap.get(path);
		if (!headEntry || headEntry.hash !== entry.hash) return true;
	}
	for (const [path] of headMap) {
		if (!stage0.has(path)) return true;
	}
	return false;
}

export interface SequencerDirtyState {
	hasStaged: boolean;
	hasUnstaged: boolean;
}

export async function getSequencerDirtyState(
	gitCtx: GitContext,
	headHash: ObjectId,
	index: Index,
): Promise<SequencerDirtyState | null> {
	if (!gitCtx.workTree) return null;

	const headCommit = await readCommit(gitCtx, headHash);
	const headMap = await flattenTreeToMap(gitCtx, headCommit.tree);
	const hasStaged = hasStagedChanges(index, headMap);
	const wtDiffs = await diffIndexToWorkTree(gitCtx, index);
	const hasUnstaged = wtDiffs.some((d) => d.status === "modified" || d.status === "deleted");

	if (!hasStaged && !hasUnstaged) return null;
	return { hasStaged, hasUnstaged };
}

/** Compute the working-directory-relative prefix for pathspec resolution. */
export function getCwdPrefix(gitCtx: GitContext, cwd: string): string {
	return gitCtx.workTree ? relative(gitCtx.workTree, cwd) : "";
}
