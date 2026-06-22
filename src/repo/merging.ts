import { type MergeConflict } from "../lib/merge.ts";
import { mergeOrtRecursive, mergeOrtNonRecursive } from "../lib/merge-ort.ts";
import type { MergeDriver, MergeDriverResult } from "../lib/merge-ort.ts";
import type { GitRepo, IndexEntry } from "../lib/types.ts";

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

// ── Detailed merge (surfaces stage 1/2/3 blobs) ─────────────────────

/** One side (base/ours/theirs) of a conflicted path. */
export interface BlobSide {
	hash: string;
	/** Octal file mode, e.g. `"100644"`. */
	mode: string;
}

/**
 * A conflicted path with its three stages exposed, so a caller can resolve it
 * by selecting a side (`"ours"`/`"theirs"`) or supplying merged content
 * without re-reading the trees.
 *
 * A `null` side means that side does not have the path (e.g. a delete/modify
 * conflict where `ours` deleted the file leaves `ours: null`).
 */
export interface ConflictedPath {
	path: string;
	reason: MergeConflict["reason"];
	/** Stage 1 — the merge base version. */
	base: BlobSide | null;
	/** Stage 2 — our version. */
	ours: BlobSide | null;
	/** Stage 3 — their version. */
	theirs: BlobSide | null;
}

/** Result of {@link mergeTreesDetailed}. */
export interface MergeTreesDetailedResult {
	/** Result tree, with conflict-marker blobs at any conflicted path. */
	treeHash: string;
	clean: boolean;
	/** Conflicted paths with per-side blob refs. Empty when `clean`. */
	conflicts: ConflictedPath[];
	messages: string[];
}

/**
 * Like {@link mergeTrees}, but surfaces the per-side (stage 1/2/3) blob refs
 * for each conflicted path. This is what the two-phase `merge` flow (see
 * `operations.ts`) uses to let callers resolve conflicts by selecting a side
 * or supplying merged content.
 *
 * Takes two commit hashes; merge bases are computed automatically.
 */
export async function mergeTreesDetailed(
	repo: GitRepo,
	oursCommit: string,
	theirsCommit: string,
	options?: { ours?: string; theirs?: string; mergeDriver?: MergeDriver },
): Promise<MergeTreesDetailedResult> {
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
		conflicts: buildConflictedPaths(result.entries, result.conflicts),
		messages: result.messages,
	};
}

/**
 * Build {@link ConflictedPath} descriptors from the merge engine's unmerged
 * index entries (stages > 0) and conflict list. The unmerged stage entries are
 * the ground truth for "which paths still need resolution"; the conflict list
 * supplies the human-readable reason (and may contribute structural conflicts
 * that carry no stage entries).
 */
function buildConflictedPaths(
	entries: IndexEntry[],
	conflicts: MergeConflict[],
): ConflictedPath[] {
	const stagesByPath = new Map<
		string,
		{ base: BlobSide | null; ours: BlobSide | null; theirs: BlobSide | null }
	>();

	const ensure = (path: string) => {
		let g = stagesByPath.get(path);
		if (!g) {
			g = { base: null, ours: null, theirs: null };
			stagesByPath.set(path, g);
		}
		return g;
	};

	for (const e of entries) {
		if (e.stage === 0) continue;
		const side: BlobSide = { hash: e.hash, mode: e.mode.toString(8) };
		const g = ensure(e.path);
		if (e.stage === 1) g.base = side;
		else if (e.stage === 2) g.ours = side;
		else if (e.stage === 3) g.theirs = side;
	}

	const reasonByPath = new Map<string, MergeConflict["reason"]>();
	for (const c of conflicts) {
		reasonByPath.set(c.path, c.reason);
		// Structural conflicts may not produce stage entries — surface them too.
		ensure(c.path);
	}

	const result: ConflictedPath[] = [];
	for (const [path, g] of stagesByPath) {
		result.push({
			path,
			reason: reasonByPath.get(path) ?? "content",
			base: g.base,
			ours: g.ours,
			theirs: g.theirs,
		});
	}
	result.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	return result;
}
