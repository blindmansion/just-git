import { type MergeConflict } from "../lib/merge.ts";
import { mergeOrtRecursive, mergeOrtNonRecursive } from "../lib/merge-ort.ts";
import type { MergeDriver, MergeDriverResult } from "../lib/merge-ort.ts";
import type { GitRepo } from "../lib/types.ts";

export type { MergeConflict } from "../lib/merge.ts";
export type { MergeDriver, MergeDriverResult } from "../lib/merge-ort.ts";

/** Result of a tree-level merge via {@link mergeTrees} or {@link mergeTreesFromTreeHashes}. */
export interface MergeTreesResult {
	/** Hash of the result tree (may contain conflict-marker blobs). */
	treeHash: string;
	/** True if the merge completed without conflicts. */
	clean: boolean;
	/** Details of each conflict, if any. */
	conflicts: MergeConflict[];
	/** Informational messages from the merge engine. */
	messages: string[];
}

/**
 * Three-way tree merge using merge-ort. Operates purely on the object
 * store — no filesystem or worktree needed.
 *
 * Takes two commit hashes, finds their merge base(s) automatically
 * (handling criss-cross merges via recursive base merging), and produces
 * a result tree with conflict-marker blobs embedded for any conflicts.
 *
 * Use `mergeTreesFromTreeHashes` if you already have tree hashes and a
 * known base tree.
 */
export async function mergeTrees(
	repo: GitRepo,
	oursCommit: string,
	theirsCommit: string,
	options?: { ours?: string; theirs?: string; mergeDriver?: MergeDriver },
): Promise<MergeTreesResult> {
	const mergeLabels = options
		? { a: options.ours ?? "ours", b: options.theirs ?? "theirs" }
		: undefined;

	const result = await mergeOrtRecursive(
		repo,
		oursCommit,
		theirsCommit,
		mergeLabels,
		options?.mergeDriver,
	);

	return {
		treeHash: result.resultTree,
		clean: result.conflicts.length === 0,
		conflicts: result.conflicts,
		messages: result.messages,
	};
}

/**
 * Three-way tree merge from raw tree hashes. Useful when you already
 * have the base/ours/theirs trees and don't want automatic merge-base
 * computation.
 */
export async function mergeTreesFromTreeHashes(
	repo: GitRepo,
	baseTree: string | null,
	oursTree: string,
	theirsTree: string,
	options?: { ours?: string; theirs?: string; mergeDriver?: MergeDriver },
): Promise<MergeTreesResult> {
	const mergeLabels = options
		? { a: options.ours ?? "ours", b: options.theirs ?? "theirs" }
		: undefined;

	const result = await mergeOrtNonRecursive(
		repo,
		baseTree,
		oursTree,
		theirsTree,
		mergeLabels,
		options?.mergeDriver,
	);

	return {
		treeHash: result.resultTree,
		clean: result.conflicts.length === 0,
		conflicts: result.conflicts,
		messages: result.messages,
	};
}
