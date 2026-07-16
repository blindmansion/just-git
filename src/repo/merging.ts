import { bindAttributes } from "../lib/attributes/bound-attributes.ts";
import { type MergeConflict } from "../lib/merge.ts";
import { mergeOrtRecursive, mergeOrtNonRecursive } from "../lib/merge-ort.ts";
import type { MergeDriver, MergeDriverResult } from "../lib/merge-ort.ts";
import { writeObject } from "../lib/object-db.ts";
import type { GitRepo, IndexEntry } from "../lib/types.ts";
import { type TreeUpdate, updateTree } from "./writing.ts";

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
	options?: { ours?: string; theirs?: string },
): Promise<MergeTreesResult> {
	const mergeLabels = options
		? { a: options.ours ?? "ours", b: options.theirs ?? "theirs" }
		: undefined;

	const result = await mergeOrtRecursive(
		repo,
		oursCommit,
		theirsCommit,
		mergeLabels,
		(await bindAttributes(repo, "merge"))?.merge,
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
	options?: { ours?: string; theirs?: string },
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
		(await bindAttributes(repo, "merge"))?.merge,
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

/**
 * How to resolve one conflicted path.
 *
 * Selecting a missing side deletes the path. Explicit content defaults to the
 * ours mode, then theirs, then a regular non-executable file.
 */
export type Resolution = "ours" | "theirs" | null | { content: string | Uint8Array; mode?: string };

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
	options?: { ours?: string; theirs?: string },
): Promise<MergeTreesDetailedResult> {
	const mergeLabels = options
		? { a: options.ours ?? "ours", b: options.theirs ?? "theirs" }
		: undefined;

	const result = await mergeOrtRecursive(
		repo,
		oursCommit,
		theirsCommit,
		mergeLabels,
		(await bindAttributes(repo, "merge"))?.merge,
	);

	return toDetailedMergeResult(result);
}

/**
 * Like {@link mergeTreesFromTreeHashes}, but surfaces the per-side (stage
 * 1/2/3) blob refs for each conflicted path — the from-tree-hashes counterpart
 * to {@link mergeTreesDetailed}. Used by operations (cherry-pick-style replays
 * such as `rebase`) that already have the base/ours/theirs trees and need
 * resolvable conflict descriptors.
 */
export async function mergeTreesDetailedFromTreeHashes(
	repo: GitRepo,
	baseTree: string | null,
	oursTree: string,
	theirsTree: string,
	options?: { ours?: string; theirs?: string },
): Promise<MergeTreesDetailedResult> {
	const mergeLabels = options
		? { a: options.ours ?? "ours", b: options.theirs ?? "theirs" }
		: undefined;

	const result = await mergeOrtNonRecursive(
		repo,
		baseTree,
		oursTree,
		theirsTree,
		mergeLabels,
		(await bindAttributes(repo, "merge"))?.merge,
	);

	return toDetailedMergeResult(result);
}

/** Shape the raw merge-ort output into a {@link MergeTreesDetailedResult}. */
export function toDetailedMergeResult(result: {
	resultTree: string;
	conflicts: MergeConflict[];
	entries: IndexEntry[];
	messages: string[];
}): MergeTreesDetailedResult {
	return {
		treeHash: result.resultTree,
		clean: result.conflicts.length === 0,
		conflicts: buildConflictedPaths(result.entries, result.conflicts),
		messages: result.messages,
	};
}

/** Outcome of applying a resolution map to a detailed merge result. */
export interface AppliedResolutions {
	/**
	 * The resolved tree when every conflict is handled, otherwise the original
	 * conflicted tree containing marker blobs.
	 */
	treeHash: string;
	/** Conflicted paths with no supplied resolution. */
	unresolved: string[];
}

/** Turn a {@link Resolution} into a tree update for one conflicted path. */
async function resolveConflict(
	repo: GitRepo,
	conflict: ConflictedPath,
	resolution: Resolution,
): Promise<TreeUpdate> {
	if (resolution === null) return { path: conflict.path, hash: null };
	if (resolution === "ours") {
		return conflict.ours
			? { path: conflict.path, hash: conflict.ours.hash, mode: conflict.ours.mode }
			: { path: conflict.path, hash: null };
	}
	if (resolution === "theirs") {
		return conflict.theirs
			? { path: conflict.path, hash: conflict.theirs.hash, mode: conflict.theirs.mode }
			: { path: conflict.path, hash: null };
	}
	const bytes =
		typeof resolution.content === "string"
			? new TextEncoder().encode(resolution.content)
			: resolution.content;
	const hash = await writeObject(repo, "blob", bytes);
	const mode = resolution.mode ?? conflict.ours?.mode ?? conflict.theirs?.mode ?? "100644";
	return { path: conflict.path, hash, mode };
}

/**
 * Apply post-hoc path resolutions to a detailed merge result.
 *
 * Unknown resolution paths are rejected so stale maps cannot silently modify
 * an unrelated replay. Partial maps report unresolved paths and leave the
 * conflicted marker tree unchanged.
 */
export async function applyResolutions(
	repo: GitRepo,
	detailed: MergeTreesDetailedResult,
	resolutions: Record<string, Resolution>,
	label: string,
): Promise<AppliedResolutions> {
	if (detailed.clean) {
		const stray = Object.keys(resolutions)[0];
		if (stray !== undefined) {
			throw new Error(
				`${label}: resolution provided for '${stray}', which is not a conflicted path`,
			);
		}
		return { treeHash: detailed.treeHash, unresolved: [] };
	}

	const conflictPaths = new Set(detailed.conflicts.map((c) => c.path));
	for (const path of Object.keys(resolutions)) {
		if (!conflictPaths.has(path)) {
			throw new Error(
				`${label}: resolution provided for '${path}', which is not a conflicted path`,
			);
		}
	}

	const updates: TreeUpdate[] = [];
	const unresolved: string[] = [];
	for (const conflict of detailed.conflicts) {
		if (!Object.hasOwn(resolutions, conflict.path)) {
			unresolved.push(conflict.path);
			continue;
		}
		updates.push(await resolveConflict(repo, conflict, resolutions[conflict.path] as Resolution));
	}

	if (unresolved.length > 0) return { treeHash: detailed.treeHash, unresolved };
	return {
		treeHash: await updateTree(repo, detailed.treeHash, updates),
		unresolved: [],
	};
}

/**
 * Build {@link ConflictedPath} descriptors from the merge engine's unmerged
 * index entries (stages > 0) and conflict list. The unmerged stage entries are
 * the ground truth for "which paths still need resolution"; the conflict list
 * supplies the human-readable reason (and may contribute structural conflicts
 * that carry no stage entries).
 */
function buildConflictedPaths(entries: IndexEntry[], conflicts: MergeConflict[]): ConflictedPath[] {
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
