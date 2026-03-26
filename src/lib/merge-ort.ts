/**
 * merge-ort — Three-way merge engine modeled after Git's merge-ort.c.
 *
 * Key insight: the entire merge is computed in-core first (producing a
 * result tree with conflict-marker blobs embedded), then a standard
 * two-way checkout applies the result to the worktree.
 *
 * Three phases:
 *   1. collectMergeInfo  — flatten three trees, build per-path ConflictInfo
 *   2. detectAndProcessRenames — rename detection, update path map
 *   3. processEntries — resolve conflicts, content merge, build result tree
 *
 * The recursive wrapper (mergeOrtRecursive) handles criss-cross merges
 * by pairwise-merging multiple LCAs into a virtual base tree.
 */

import { comparePaths } from "./command-utils.ts";
import type { MergeLabels } from "./diff3.ts";
import {
	merge as diff3Merge,
	renderConflictMarkers,
	splitLinesWithSentinel,
	stripSentinel,
} from "./diff3.ts";
import { defaultStat, getStage0Entries, readIndex, writeIndex } from "./index.ts";
import { findAllMergeBases, type MergeConflict, type MergeTreeResult } from "./merge.ts";
import { isBinaryStr, readBlobContent, readCommit, readObject, writeObject } from "./object-db.ts";
import { serializeCommit } from "./objects/commit.ts";
import { join } from "./path.ts";
import { detectRenames, type RenamePair } from "./rename-detection.ts";
import { isSymlinkMode } from "./symlink.ts";
import { buildTreeFromIndex, type FlatTreeEntry, flattenTreeToMap } from "./tree-ops.ts";
import { checkoutEntry } from "./worktree.ts";
import type {
	GitContext,
	GitRepo,
	Identity,
	Index,
	IndexEntry,
	ObjectId,
	TreeDiffEntry,
} from "./types.ts";
import {
	applyWorktreeOps,
	onewayMerge,
	twowayMerge,
	UnpackError,
	unpackTrees,
} from "./unpack-trees.ts";

// ── Constants ───────────────────────────────────────────────────────

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** Placeholder identity for virtual merge-base commits. */
const VIRTUAL_IDENTITY: Identity = {
	name: "virtual",
	email: "virtual@merge",
	timestamp: 0,
	timezone: "+0000",
};

// ── Types ───────────────────────────────────────────────────────────

/** Per-path version info: hash + mode. null hash = absent. */
interface VersionInfo {
	hash: ObjectId | null;
	mode: string; // e.g. "100644"
}

/**
 * Per-path merge state — the central data structure.
 *
 * Tracks base/ours/theirs versions, pathnames (which may differ due to
 * renames), and the merged result.
 */
interface ConflictInfo {
	/** The canonical path this entry lives at in the result. */
	path: string;
	/** [base, ours, theirs] versions. null version = absent on that side. */
	stages: [VersionInfo | null, VersionInfo | null, VersionInfo | null];
	/** [base, ours, theirs] pathnames — may differ due to renames. */
	pathnames: [string, string, string];
	/** 3-bit mask: which sides have this path (bit0=base, bit1=ours, bit2=theirs). */
	filemask: number;
	/** 3-bit mask: which stages have identical content. */
	matchMask: number;
	/** Merged result. null result = path should be deleted. */
	merged: { result: VersionInfo | null; clean: boolean };
	/** Whether this path has a structural (path) conflict from renames. */
	pathConflict: boolean;
}

/** Extended result with a worktree-ready result tree. */
interface MergeOrtResult extends MergeTreeResult {
	/**
	 * Tree hash representing the final worktree state.
	 * Clean entries use their merged blob. Conflicted entries use
	 * conflict-marker blobs (content/add-add) or the surviving side's
	 * blob (delete-modify, rename-delete).
	 *
	 * This tree can be fed to checkoutTrees() for safe worktree updates.
	 */
	resultTree: ObjectId;
}

/**
 * Custom content merge callback. Called during three-way merge before the
 * default line-based diff3 algorithm. Analogous to git's `.gitattributes`
 * `merge=` drivers, but as an async callback rather than a shell command.
 *
 * Return a result to override the default merge, or `null` to fall back
 * to diff3. When `conflict` is `false`, the content is written as a clean
 * stage-0 entry. When `conflict` is `true`, the original base/ours/theirs
 * blobs are preserved as index stages 1/2/3 (so `--ours`/`--theirs`
 * checkout still works) and the returned content becomes the worktree blob.
 */
export type MergeDriver = (ctx: {
	path: string;
	base: string | null;
	ours: string;
	theirs: string;
}) => MergeDriverResult | null | Promise<MergeDriverResult | null>;

/** Result from a {@link MergeDriver} callback. */
export interface MergeDriverResult {
	content: string;
	conflict: boolean;
}

/** Sortable message buffer entry. */
interface SortableMsg {
	sortKey: string;
	subOrder: number;
	text: string;
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Non-recursive three-way merge.
 *
 * Takes three tree hashes and produces a MergeTreeResult with:
 * - entries: IndexEntry[] (stage 0 for clean, stages 1-3 for conflicts)
 * - conflicts: MergeConflict[]
 * - messages: string[] (Auto-merging, CONFLICT messages)
 *
 * Conflict content (markers) is written as blobs and included in
 * stage-0 entries of the result, so the result tree is self-contained.
 */
export async function mergeOrtNonRecursive(
	ctx: GitRepo,
	baseTree: ObjectId | null,
	oursTree: ObjectId,
	theirsTree: ObjectId,
	labels?: MergeLabels,
	mergeDriver?: MergeDriver,
): Promise<MergeOrtResult> {
	// Phase 1: Collect
	const { paths, baseMap, oursMap, theirsMap } = await collectMergeInfo(
		ctx,
		baseTree,
		oursTree,
		theirsTree,
	);

	// Phase 2: Rename detection (produces entries/conflicts directly for rename-handled paths)
	const renameOutput = await detectAndProcessRenames(
		ctx,
		paths,
		baseMap,
		oursMap,
		theirsMap,
		labels,
		mergeDriver,
	);

	// Phase 3: Process remaining entries + merge rename output
	return processEntries(ctx, paths, labels, renameOutput, mergeDriver);
}

/**
 * Recursive three-way merge — handles criss-cross merges with
 * multiple merge bases by pairwise-merging them into a virtual base.
 *
 * This replaces findRecursiveMergeBaseTree + mergeTrees.
 */
export async function mergeOrtRecursive(
	ctx: GitRepo,
	oursHash: ObjectId,
	theirsHash: ObjectId,
	labels?: MergeLabels,
	mergeDriver?: MergeDriver,
): Promise<MergeOrtResult & { baseTree: ObjectId | null }> {
	const bases = await findAllMergeBases(ctx, oursHash, theirsHash);
	const oursCommit = await readCommit(ctx, oursHash);
	const theirsCommit = await readCommit(ctx, theirsHash);

	if (bases.length === 0) {
		// Disjoint histories — merge with empty base
		const result = await mergeOrtNonRecursive(
			ctx,
			null,
			oursCommit.tree,
			theirsCommit.tree,
			labels,
			mergeDriver,
		);
		return { ...result, baseTree: null };
	}

	if (bases.length === 1) {
		const baseCommit = await readCommit(ctx, bases[0]!);
		const result = await mergeOrtNonRecursive(
			ctx,
			baseCommit.tree,
			oursCommit.tree,
			theirsCommit.tree,
			labels,
			mergeDriver,
		);
		return { ...result, baseTree: baseCommit.tree };
	}

	// Multiple LCAs — recursively merge pairwise to produce virtual base.
	const baseTree = await computeRecursiveMergeBase(
		ctx, oursHash, theirsHash, bases, 1, mergeDriver,
	);

	const result = await mergeOrtNonRecursive(
		ctx,
		baseTree,
		oursCommit.tree,
		theirsCommit.tree,
		labels,
		mergeDriver,
	);
	return { ...result, baseTree };
}

// ── Phase 1: Collect merge info ─────────────────────────────────────

async function collectMergeInfo(
	ctx: GitRepo,
	baseTree: ObjectId | null,
	oursTree: ObjectId,
	theirsTree: ObjectId,
): Promise<{
	paths: Map<string, ConflictInfo>;
	baseMap: Map<string, FlatTreeEntry>;
	oursMap: Map<string, FlatTreeEntry>;
	theirsMap: Map<string, FlatTreeEntry>;
}> {
	const baseMap = await flattenTreeToMap(ctx, baseTree);
	const oursMap = await flattenTreeToMap(ctx, oursTree);
	const theirsMap = await flattenTreeToMap(ctx, theirsTree);

	// Collect all unique paths
	const allPaths = new Set<string>();
	for (const p of baseMap.keys()) allPaths.add(p);
	for (const p of oursMap.keys()) allPaths.add(p);
	for (const p of theirsMap.keys()) allPaths.add(p);

	const paths = new Map<string, ConflictInfo>();

	for (const path of allPaths) {
		const base = baseMap.get(path) ?? null;
		const ours = oursMap.get(path) ?? null;
		const theirs = theirsMap.get(path) ?? null;

		const baseV: VersionInfo | null = base ? { hash: base.hash, mode: base.mode } : null;
		const oursV: VersionInfo | null = ours ? { hash: ours.hash, mode: ours.mode } : null;
		const theirsV: VersionInfo | null = theirs ? { hash: theirs.hash, mode: theirs.mode } : null;

		const filemask = (base ? 1 : 0) | (ours ? 2 : 0) | (theirs ? 4 : 0);

		// Compute match mask (which stages have identical hash)
		const bh = base?.hash ?? null;
		const oh = ours?.hash ?? null;
		const th = theirs?.hash ?? null;
		let matchMask = 0;
		if (bh !== null && bh === oh) matchMask |= 3; // base == ours
		if (bh !== null && bh === th) matchMask |= 5; // base == theirs
		if (oh !== null && oh === th) matchMask |= 6; // ours == theirs

		// Trivial resolution check
		const ci: ConflictInfo = {
			path,
			stages: [baseV, oursV, theirsV],
			pathnames: [path, path, path],
			filemask,
			matchMask,
			merged: { result: null, clean: false },
			pathConflict: false,
		};

		// Try trivial resolution
		if (triviallyResolve(ci)) {
			paths.set(path, ci);
			continue;
		}

		paths.set(path, ci);
	}

	return { paths, baseMap, oursMap, theirsMap };
}

/**
 * Try to resolve a path trivially without content merge.
 * Returns true if resolved (sets ci.merged).
 */
function triviallyResolve(ci: ConflictInfo): boolean {
	const [base, ours, theirs] = ci.stages;
	const bh = base?.hash ?? null;
	const oh = ours?.hash ?? null;
	const th = theirs?.hash ?? null;

	// All three match or both sides match base (no changes)
	if (oh === bh && th === bh) {
		if (ours) {
			ci.merged = { result: { hash: oh, mode: ours.mode }, clean: true };
		} else {
			ci.merged = { result: null, clean: true }; // all absent or all deleted
		}
		return true;
	}

	// Both sides made identical changes
	if (oh === th && oh !== null) {
		ci.merged = { result: { hash: oh, mode: ours!.mode }, clean: true };
		return true;
	}

	// Both deleted
	if (oh === null && th === null) {
		ci.merged = { result: null, clean: true };
		return true;
	}

	// Only ours changed (theirs matches base)
	if (th === bh && oh !== bh) {
		if (ours) {
			ci.merged = { result: { hash: oh, mode: ours.mode }, clean: true };
		} else {
			ci.merged = { result: null, clean: true }; // ours deleted
		}
		return true;
	}

	// Only theirs changed (ours matches base)
	if (oh === bh && th !== bh) {
		if (theirs) {
			ci.merged = { result: { hash: th, mode: theirs.mode }, clean: true };
		} else {
			ci.merged = { result: null, clean: true }; // theirs deleted
		}
		return true;
	}

	return false; // needs content merge or is a conflict
}

// ── Phase 2: Rename detection ───────────────────────────────────────

/**
 * Rename context passed through Phase 2 to directly produce
 * entries, conflicts, and messages for rename-handled paths.
 * This avoids trying to encode complex rename interactions
 * into a single ConflictInfo per path.
 */
interface RenameOutput {
	entries: IndexEntry[];
	conflicts: MergeConflict[];
	msgBuf: SortableMsg[];
	worktreeBlobs: Map<string, { hash: ObjectId; mode: string }>;
}

async function detectAndProcessRenames(
	ctx: GitRepo,
	paths: Map<string, ConflictInfo>,
	baseMap: Map<string, FlatTreeEntry>,
	oursMap: Map<string, FlatTreeEntry>,
	theirsMap: Map<string, FlatTreeEntry>,
	labels?: MergeLabels,
	mergeDriver?: MergeDriver,
): Promise<RenameOutput> {
	const output: RenameOutput = {
		entries: [],
		conflicts: [],
		msgBuf: [],
		worktreeBlobs: new Map(),
	};

	// Build diff lists for rename detection (base→ours, base→theirs)
	const oursDiffs: TreeDiffEntry[] = [];
	const theirsDiffs: TreeDiffEntry[] = [];

	for (const [path, baseEntry] of baseMap) {
		if (!oursMap.has(path)) {
			oursDiffs.push({
				path,
				status: "deleted",
				oldHash: baseEntry.hash,
				oldMode: baseEntry.mode,
			});
		}
		if (!theirsMap.has(path)) {
			theirsDiffs.push({
				path,
				status: "deleted",
				oldHash: baseEntry.hash,
				oldMode: baseEntry.mode,
			});
		}
	}
	for (const [path, entry] of oursMap) {
		if (!baseMap.has(path)) {
			oursDiffs.push({
				path,
				status: "added",
				newHash: entry.hash,
				newMode: entry.mode,
			});
		}
	}
	for (const [path, entry] of theirsMap) {
		if (!baseMap.has(path)) {
			theirsDiffs.push({
				path,
				status: "added",
				newHash: entry.hash,
				newMode: entry.mode,
			});
		}
	}

	const oursRenameResult = await detectRenames(ctx, oursDiffs);
	const theirsRenameResult = await detectRenames(ctx, theirsDiffs);

	if (oursRenameResult.renames.length === 0 && theirsRenameResult.renames.length === 0) {
		return output;
	}

	const ourRenameByOld = new Map<string, RenamePair>();
	const theirRenameByOld = new Map<string, RenamePair>();
	for (const r of oursRenameResult.renames) ourRenameByOld.set(r.oldPath, r);
	for (const r of theirsRenameResult.renames) theirRenameByOld.set(r.oldPath, r);

	// Paths that exist in both ours and theirs but not in base — potential add/add collisions
	const addAddPaths = new Set<string>();
	for (const [path] of oursMap) {
		if (!baseMap.has(path) && theirsMap.has(path)) {
			addAddPaths.add(path);
		}
	}

	// Set of paths fully handled by rename processing
	const handledPaths = new Set<string>();

	const oursLabel = labels?.a ?? "HEAD";
	const theirsLabel = labels?.b ?? "theirs";

	function pushMsg(sortKey: string, text: string, subOrder = 0) {
		output.msgBuf.push({ sortKey, subOrder, text });
	}

	for (const basePath of [...baseMap.keys()].sort()) {
		const ourRename = ourRenameByOld.get(basePath);
		const theirRename = theirRenameByOld.get(basePath);
		if (!ourRename && !theirRename) continue;

		const base = baseMap.get(basePath)!;
		handledPaths.add(basePath);

		if (ourRename && theirRename) {
			handledPaths.add(ourRename.newPath);
			handledPaths.add(theirRename.newPath);

			if (ourRename.newPath === theirRename.newPath) {
				// Same destination — content merge at new path
				const oursEntry = oursMap.get(ourRename.newPath)!;
				const theirsEntry = theirsMap.get(theirRename.newPath)!;

				if (oursEntry.hash === theirsEntry.hash) {
					output.entries.push(makeFlatEntry(ourRename.newPath, oursEntry));
				} else {
					// Set up for content merge via ConflictInfo
					const ci = getOrCreate(paths, ourRename.newPath);
					ci.stages = [
						{ hash: base.hash, mode: base.mode },
						{ hash: oursEntry.hash, mode: oursEntry.mode },
						{ hash: theirsEntry.hash, mode: theirsEntry.mode },
					];
					ci.pathnames = [basePath, ourRename.newPath, theirRename.newPath];
					ci.filemask = 7;
					ci.merged = { result: null, clean: false };
				}
			} else {
				// rename/rename(1to2) conflict
				const oursEntry = oursMap.get(ourRename.newPath)!;
				const theirsEntry = theirsMap.get(theirRename.newPath)!;

				// Content merge of the renamed file (base + ours' version + theirs' version).
				// Real git uses the merged content for both stage-2 and stage-3 entries.
				const merged = await mergeRenameContent(
					ctx, base, oursEntry, theirsEntry, labels, undefined, undefined, mergeDriver,
				);

				if (merged.conflict) {
					pushMsg(basePath, `Auto-merging ${basePath}`, -1);
				}
				output.conflicts.push({
					path: basePath,
					reason: "rename-rename",
					oursPath: ourRename.newPath,
					theirsPath: theirRename.newPath,
				});
				pushMsg(
					basePath,
					`CONFLICT (rename/rename): ${basePath} renamed to ${ourRename.newPath} in ${oursLabel} and to ${theirRename.newPath} in ${theirsLabel}.`,
				);
				output.entries.push(makeFlatEntry(basePath, base, 1));
				output.entries.push(makeEntryFromHash(ourRename.newPath, oursEntry.mode, merged.hash, 2));
				output.entries.push(
					makeEntryFromHash(theirRename.newPath, theirsEntry.mode, merged.hash, 3),
				);
				output.worktreeBlobs.set(ourRename.newPath, {
					hash: merged.hash,
					mode: oursEntry.mode,
				});
				output.worktreeBlobs.set(theirRename.newPath, {
					hash: merged.hash,
					mode: theirsEntry.mode,
				});
			}
		} else if (ourRename) {
			handledPaths.add(ourRename.newPath);
			const theirsEntry = theirsMap.get(basePath);
			const oursEntry = oursMap.get(ourRename.newPath)!;
			const isTargetAddAdd = addAddPaths.has(ourRename.newPath);

			if (!theirsEntry) {
				// Theirs deleted — rename/delete
				const theirsTargetEntry = theirsMap.get(ourRename.newPath);
				output.conflicts.push({
					path: ourRename.newPath,
					reason: "rename-delete",
					deletedBy: "theirs",
					oldPath: basePath,
				});
				pushMsg(
					ourRename.newPath,
					`CONFLICT (rename/delete): ${basePath} renamed to ${ourRename.newPath} in ${oursLabel}, but deleted in ${theirsLabel}.`,
				);

				if (theirsTargetEntry) {
					// add/add collision at target
					output.conflicts.push({ path: ourRename.newPath, reason: "add-add" });
					pushMsg(ourRename.newPath, `Auto-merging ${ourRename.newPath}`, 0);
					pushMsg(
						ourRename.newPath,
						`CONFLICT (add/add): Merge conflict in ${ourRename.newPath}`,
						1,
					);
					output.entries.push(makeFlatEntry(ourRename.newPath, oursEntry, 2));
					output.entries.push(makeFlatEntry(ourRename.newPath, theirsTargetEntry, 3));
					// Write conflict markers for worktree (add/add = empty base)
					const markerHash = await writeAddAddMarkers(
						ctx,
						oursEntry.hash,
						theirsTargetEntry.hash,
						oursEntry.mode,
						labels,
					);
					output.worktreeBlobs.set(ourRename.newPath, {
						hash: markerHash,
						mode: oursEntry.mode,
					});
				} else {
					output.entries.push(makeEntryFromHash(ourRename.newPath, base.mode, base.hash, 1));
					output.entries.push(makeFlatEntry(ourRename.newPath, oursEntry, 2));
					output.worktreeBlobs.set(ourRename.newPath, {
						hash: oursEntry.hash,
						mode: oursEntry.mode,
					});
					// Git emits a modify/delete when the renamed file's content differs from base
					if (oursEntry.hash !== base.hash) {
						pushMsg(
							ourRename.newPath,
							`CONFLICT (modify/delete): ${ourRename.newPath} deleted in ${theirsLabel} and modified in ${oursLabel}.  Version ${oursLabel} of ${ourRename.newPath} left in tree.`,
							1,
						);
					}
				}
			} else if (isTargetAddAdd) {
				// Theirs has old path AND target is add/add
				await handleRenameAddAdd(
					ctx,
					output,
					ourRename.newPath,
					basePath,
					base,
					oursEntry,
					theirsEntry,
					oursMap,
					theirsMap,
					false,
					labels,
					mergeDriver,
				);
			} else {
				// Normal rename — content merge at new path
				if (theirsEntry.hash === base.hash && oursEntry.hash === base.hash) {
					output.entries.push(makeFlatEntry(ourRename.newPath, oursEntry));
				} else if (theirsEntry.hash === base.hash) {
					output.entries.push(makeFlatEntry(ourRename.newPath, oursEntry));
				} else if (oursEntry.hash === base.hash) {
					// Ours only renamed (no content change), theirs modified.
					// Trivial resolution: take theirs' content at ours' new path.
					// Git does NOT emit "Auto-merging" for this case.
					output.entries.push(
						makeEntryFromHash(ourRename.newPath, oursEntry.mode, theirsEntry.hash),
					);
				} else {
					// Content merge needed — set up ConflictInfo
					const ci = getOrCreate(paths, ourRename.newPath);
					ci.stages = [
						{ hash: base.hash, mode: base.mode },
						{ hash: oursEntry.hash, mode: oursEntry.mode },
						{ hash: theirsEntry.hash, mode: theirsEntry.mode },
					];
					ci.pathnames = [basePath, ourRename.newPath, basePath];
					ci.filemask = 7;
					ci.merged = { result: null, clean: false };
				}
			}
		} else if (theirRename) {
			handledPaths.add(theirRename.newPath);
			const oursEntry = oursMap.get(basePath);
			const theirsEntry = theirsMap.get(theirRename.newPath)!;
			const isTargetAddAdd = addAddPaths.has(theirRename.newPath);

			if (!oursEntry) {
				// Ours deleted — rename/delete
				const oursTargetEntry = oursMap.get(theirRename.newPath);
				output.conflicts.push({
					path: theirRename.newPath,
					reason: "rename-delete",
					deletedBy: "ours",
					oldPath: basePath,
				});
				pushMsg(
					theirRename.newPath,
					`CONFLICT (rename/delete): ${basePath} renamed to ${theirRename.newPath} in ${theirsLabel}, but deleted in ${oursLabel}.`,
				);

				if (oursTargetEntry) {
					// add/add collision at target
					output.conflicts.push({
						path: theirRename.newPath,
						reason: "add-add",
					});
					pushMsg(theirRename.newPath, `Auto-merging ${theirRename.newPath}`, 0);
					pushMsg(
						theirRename.newPath,
						`CONFLICT (add/add): Merge conflict in ${theirRename.newPath}`,
						1,
					);
					output.entries.push(makeFlatEntry(theirRename.newPath, oursTargetEntry, 2));
					output.entries.push(makeFlatEntry(theirRename.newPath, theirsEntry, 3));
					// Write conflict markers for worktree (add/add = empty base)
					const markerHash = await writeAddAddMarkers(
						ctx,
						oursTargetEntry.hash,
						theirsEntry.hash,
						oursTargetEntry.mode,
						labels,
					);
					output.worktreeBlobs.set(theirRename.newPath, {
						hash: markerHash,
						mode: oursTargetEntry.mode,
					});
				} else {
					output.entries.push(makeEntryFromHash(theirRename.newPath, base.mode, base.hash, 1));
					output.entries.push(makeFlatEntry(theirRename.newPath, theirsEntry, 3));
					output.worktreeBlobs.set(theirRename.newPath, {
						hash: theirsEntry.hash,
						mode: theirsEntry.mode,
					});
					// Git emits a modify/delete when the renamed file's content differs from base
					if (theirsEntry.hash !== base.hash) {
						pushMsg(
							theirRename.newPath,
							`CONFLICT (modify/delete): ${theirRename.newPath} deleted in ${oursLabel} and modified in ${theirsLabel}.  Version ${theirsLabel} of ${theirRename.newPath} left in tree.`,
							1,
						);
					}
				}
			} else if (isTargetAddAdd) {
				await handleRenameAddAdd(
					ctx,
					output,
					theirRename.newPath,
					basePath,
					base,
					oursEntry,
					theirsEntry,
					oursMap,
					theirsMap,
					true,
					labels,
					mergeDriver,
				);
			} else {
				// Normal rename — content merge at new path
				if (oursEntry.hash === base.hash && theirsEntry.hash === base.hash) {
					output.entries.push(makeFlatEntry(theirRename.newPath, theirsEntry));
				} else if (oursEntry.hash === base.hash) {
					output.entries.push(makeFlatEntry(theirRename.newPath, theirsEntry));
				} else if (theirsEntry.hash === base.hash) {
					// Theirs only renamed (no content change), ours modified.
					// Trivial resolution: take ours' content at theirs' new path.
					// Git does NOT emit "Auto-merging" for this case.
					output.entries.push(
						makeEntryFromHash(theirRename.newPath, theirsEntry.mode, oursEntry.hash),
					);
				} else {
					// Content merge needed — set up ConflictInfo
					const ci = getOrCreate(paths, theirRename.newPath);
					ci.stages = [
						{ hash: base.hash, mode: base.mode },
						{ hash: oursEntry.hash, mode: oursEntry.mode },
						{ hash: theirsEntry.hash, mode: theirsEntry.mode },
					];
					ci.pathnames = [basePath, basePath, theirRename.newPath];
					ci.filemask = 7;
					ci.merged = { result: null, clean: false };
				}
			}
		}
	}

	// ── Phase 2b: Directory rename detection ──
	//
	// After file-level rename detection, infer directory renames from
	// the pattern of file renames. If most files in dir A were renamed
	// to dir B, then new files added in dir A on the other side should
	// be implicitly moved to dir B.
	//
	// Default behavior (MERGE_DIRECTORY_RENAMES_CONFLICT): move the file
	// but mark it as a conflict so the user confirms the location.

	const oursRenamedNewPaths = new Set(oursRenameResult.renames.map((r) => r.newPath));
	const theirsRenamedNewPaths = new Set(theirsRenameResult.renames.map((r) => r.newPath));

	// Compute which base directories were fully vacated on each side.
	// A directory is "removed" if it existed in the base tree but has
	// NO files at all on that side — not just base files removed, but
	// truly empty (no additions either). Git checks at the directory
	// level during tree walk.
	const oursRemovedDirs = computeRemovedDirs(baseMap, oursMap);
	const theirsRemovedDirs = computeRemovedDirs(baseMap, theirsMap);

	// Filter to only directories relevant for directory rename detection.
	// Git's merge-ort marks a removed directory as RELEVANT_FOR_SELF only
	// when a file was added DIRECTLY in that directory on the opposite
	// side. Without this filter, a single rename out of dir X (vacating it)
	// would trigger directory rename inference for files added in X's
	// subdirectories on the other side, which real git does not do.
	const oursRelevantRemovedDirs = filterRelevantRemovedDirs(oursRemovedDirs, theirsMap, baseMap);
	const theirsRelevantRemovedDirs = filterRelevantRemovedDirs(theirsRemovedDirs, oursMap, baseMap);

	// Compute directory rename counts from file renames (only for relevant dirs)
	const dirRenameCountOurs = computeDirRenameCounts(
		oursRenameResult.renames,
		oursRelevantRemovedDirs,
	);
	const dirRenameCountTheirs = computeDirRenameCounts(
		theirsRenameResult.renames,
		theirsRelevantRemovedDirs,
	);

	// Collapse to directory renames (unique majority wins)
	const dirRenamesOurs = collapseDirRenames(dirRenameCountOurs);
	const dirRenamesTheirs = collapseDirRenames(dirRenameCountTheirs);

	// Remove conflicting directory renames (both sides renamed same dir)
	for (const key of [...dirRenamesOurs.keys()]) {
		if (dirRenamesTheirs.has(key)) {
			dirRenamesOurs.delete(key);
			dirRenamesTheirs.delete(key);
		}
	}

	// Build exclusion sets: source dirs (keys) of each side's renames.
	// When applying theirs' dir renames, exclude if the target dir is a
	// source of ours' renames (and vice versa). This prevents spurious
	// rename/rename(1to2) conflicts from transitive directory renames.
	const oursSourceDirs = new Set(dirRenamesOurs.keys());
	const theirsSourceDirs = new Set(dirRenamesTheirs.keys());

	// Apply theirs' directory renames to ours' additions (files added in
	// ours that are inside a directory renamed in theirs)
	if (dirRenamesTheirs.size > 0) {
		for (const diff of oursDiffs) {
			if (diff.status !== "added") continue;
			if (oursRenamedNewPaths.has(diff.path)) continue; // already a rename target
			const newPath = applyDirRename(diff.path, dirRenamesTheirs, oursSourceDirs);
			if (!newPath) continue;

			// Collision: target path already exists in the merge.
			// Two sub-cases depending on which side has the collision:
			// - Same side (ours) has content at target → "implicit dir rename"
			//   (keep file at original location, just warn)
			// - Opposite side (theirs/base) has content at target →
			//   "file location" conflict (create add/add at target)
			if (
				paths.has(newPath) ||
				baseMap.has(newPath) ||
				oursMap.has(newPath) ||
				theirsMap.has(newPath)
			) {
				if (oursMap.has(newPath)) {
					pushMsg(
						newPath,
						`CONFLICT (implicit dir rename): Existing file/dir at ${newPath} in the way of implicit directory rename(s) putting the following path(s) there: ${diff.path}.`,
						1,
					);
					continue;
				}
				const srcEntry = oursMap.get(diff.path)!;
				const existingEntry = theirsMap.get(newPath) ?? baseMap.get(newPath);
				output.entries.push(makeEntryFromHash(newPath, srcEntry.mode, srcEntry.hash, 2));
				if (existingEntry) {
					output.entries.push(
						makeEntryFromHash(newPath, existingEntry.mode, existingEntry.hash, 3),
					);
				}
				output.worktreeBlobs.set(newPath, {
					hash: srcEntry.hash,
					mode: srcEntry.mode,
				});
				output.conflicts.push({ path: newPath, reason: "add-add" });
				pushMsg(
					newPath,
					`CONFLICT (file location): ${diff.path} added in ${oursLabel} inside a directory that was renamed in ${theirsLabel}, suggesting it should perhaps be moved to ${newPath}.`,
					1,
				);
				const ci = paths.get(diff.path);
				if (ci) ci.merged = { result: null, clean: true };
				handledPaths.add(diff.path);
				continue;
			}

			// Move the file from old path to new path as a conflict
			const entry = oursMap.get(diff.path)!;
			output.entries.push(makeEntryFromHash(newPath, entry.mode, entry.hash, 2));
			output.worktreeBlobs.set(newPath, {
				hash: entry.hash,
				mode: entry.mode,
			});
			output.conflicts.push({
				path: newPath,
				reason: "directory-rename",
			});
			pushMsg(
				newPath,
				`CONFLICT (file location): ${diff.path} added in ${oursLabel} inside a directory that was renamed in ${theirsLabel}, suggesting it should perhaps be moved to ${newPath}.`,
				1,
			);
			// Mark old path as deleted: suppress Phase 3 stage-0 entry.
			// Must directly set merged.clean with null result because
			// collectMergeInfo may have already resolved it as a clean add.
			const ci = paths.get(diff.path);
			if (ci) ci.merged = { result: null, clean: true };
			handledPaths.add(diff.path);
		}
	}

	// Apply ours' directory renames to theirs' additions
	if (dirRenamesOurs.size > 0) {
		for (const diff of theirsDiffs) {
			if (diff.status !== "added") continue;
			if (theirsRenamedNewPaths.has(diff.path)) continue;
			const newPath = applyDirRename(diff.path, dirRenamesOurs, theirsSourceDirs);
			if (!newPath) continue;

			// Collision: target path already exists.
			// Same-side (theirs) collision → "implicit dir rename" (just warn).
			// Opposite-side (ours/base) collision → "file location" add/add.
			if (
				paths.has(newPath) ||
				baseMap.has(newPath) ||
				oursMap.has(newPath) ||
				theirsMap.has(newPath)
			) {
				if (theirsMap.has(newPath)) {
					pushMsg(
						newPath,
						`CONFLICT (implicit dir rename): Existing file/dir at ${newPath} in the way of implicit directory rename(s) putting the following path(s) there: ${diff.path}.`,
						1,
					);
					continue;
				}
				const srcEntry = theirsMap.get(diff.path)!;
				const existingEntry = oursMap.get(newPath) ?? baseMap.get(newPath);
				if (existingEntry) {
					output.entries.push(
						makeEntryFromHash(newPath, existingEntry.mode, existingEntry.hash, 2),
					);
				}
				output.entries.push(makeEntryFromHash(newPath, srcEntry.mode, srcEntry.hash, 3));
				output.worktreeBlobs.set(newPath, {
					hash: srcEntry.hash,
					mode: srcEntry.mode,
				});
				output.conflicts.push({ path: newPath, reason: "add-add" });
				pushMsg(
					newPath,
					`CONFLICT (file location): ${diff.path} added in ${theirsLabel} inside a directory that was renamed in ${oursLabel}, suggesting it should perhaps be moved to ${newPath}.`,
					1,
				);
				const ci2 = paths.get(diff.path);
				if (ci2) ci2.merged = { result: null, clean: true };
				handledPaths.add(diff.path);
				continue;
			}

			const entry = theirsMap.get(diff.path)!;
			output.entries.push(makeEntryFromHash(newPath, entry.mode, entry.hash, 3));
			output.worktreeBlobs.set(newPath, {
				hash: entry.hash,
				mode: entry.mode,
			});
			output.conflicts.push({
				path: newPath,
				reason: "directory-rename",
			});
			pushMsg(
				newPath,
				`CONFLICT (file location): ${diff.path} added in ${theirsLabel} inside a directory that was renamed in ${oursLabel}, suggesting it should perhaps be moved to ${newPath}.`,
				1,
			);
			const ci2 = paths.get(diff.path);
			if (ci2) ci2.merged = { result: null, clean: true };
			handledPaths.add(diff.path);
		}
	}

	// ── Mark paths handled by Phase 2 so Phase 3 skips them ──
	//
	// Two categories:
	// 1. Paths that have entries directly produced by Phase 2 (in output.entries)
	//    → must be marked clean so Phase 3 doesn't emit duplicate entries
	// 2. Old base paths consumed by renames (in handledPaths but not in output.entries)
	//    → mark as resolved/deleted unless Phase 2 set them up for Phase 3 content merge

	const phase2EntryPaths = new Set(output.entries.map((e) => e.path));

	// Category 1: Force-suppress Phase 3 for paths with direct Phase 2 entries
	for (const path of phase2EntryPaths) {
		const ci = paths.get(path);
		if (ci) ci.merged = { result: null, clean: true };
	}

	// Category 2: Mark remaining handledPaths as resolved (deleted)
	for (const path of handledPaths) {
		if (phase2EntryPaths.has(path)) continue; // already handled above
		const ci = paths.get(path);
		if (!ci || ci.merged.clean) continue; // already trivially resolved
		// Don't mark paths that Phase 2 set up for Phase 3 content merge
		const wasSetForPhase3 = ci.filemask === 7 && !ci.pathConflict;
		if (!wasSetForPhase3) {
			ci.merged = { result: null, clean: true };
		}
	}

	return output;
}

// ── Directory rename detection helpers ───────────────────────────────

/**
 * Compute which directories were fully vacated on a given side.
 * A directory is "removed" on side X if it existed in the base tree
 * but has NO files at all in side X's tree. This matches Git's tree-walk
 * based detection (a directory node exists in base but not in the side).
 */
function computeRemovedDirs(
	baseMap: Map<string, FlatTreeEntry>,
	sideMap: Map<string, FlatTreeEntry>,
): Set<string> {
	// Collect all directories present in the base tree
	const baseDirs = new Set<string>();
	for (const path of baseMap.keys()) {
		let dir = dirnamePath(path);
		while (dir) {
			baseDirs.add(dir);
			dir = dirnamePath(dir);
		}
	}

	// Collect all directories present in the side tree
	const sideDirs = new Set<string>();
	for (const path of sideMap.keys()) {
		let dir = dirnamePath(path);
		while (dir) {
			sideDirs.add(dir);
			dir = dirnamePath(dir);
		}
	}

	// A directory is "removed" if it exists in base but not on this side
	const removed = new Set<string>();
	for (const dir of baseDirs) {
		if (!sideDirs.has(dir)) {
			removed.add(dir);
		}
	}
	return removed;
}

/**
 * Filter removed directories to only those relevant for directory rename
 * detection. A removed directory D (on side X) is relevant only if at least
 * one file was added DIRECTLY in D on the opposite side — i.e., a file whose
 * immediate parent is D exists on the opposite side but not in the base.
 *
 * This mirrors Git's RELEVANT_FOR_SELF upgrade: during tree walk, a removed
 * directory starts as NOT_RELEVANT and is upgraded only when a file with the
 * right filemask is found directly inside it. Directories that remain
 * NOT_RELEVANT are cleaned from dir_rename_count after rename detection.
 */
function filterRelevantRemovedDirs(
	removedDirs: Set<string>,
	oppositeMap: Map<string, FlatTreeEntry>,
	baseMap: Map<string, FlatTreeEntry>,
): Set<string> {
	if (removedDirs.size === 0) return removedDirs;

	const relevant = new Set<string>();
	for (const path of oppositeMap.keys()) {
		if (baseMap.has(path)) continue;
		const parentDir = dirnamePath(path) ?? "";
		if (removedDirs.has(parentDir)) {
			relevant.add(parentDir);
		}
	}

	// Also include ancestor dirs of relevant dirs that are themselves removed,
	// matching Git's RELEVANT_FOR_ANCESTOR propagation.
	for (const dir of [...relevant]) {
		let parent = dirnamePath(dir);
		while (parent) {
			if (removedDirs.has(parent) && !relevant.has(parent)) {
				relevant.add(parent);
			}
			parent = dirnamePath(parent);
		}
	}

	return relevant;
}

/**
 * Count how many files were renamed from each source directory to each
 * destination directory. This is the raw data for directory rename inference.
 *
 * Only counts renames from directories that are in `removedDirs` (fully
 * vacated on that side). This prevents inferring directory renames from
 * partial moves.
 *
 * For a rename "a/b/file.ts" → "x/y/file.ts", we count:
 *   "a/b" → "x/y": +1
 *   "a" → "x": +1  (parent dirs, only if trailing components match)
 */
function computeDirRenameCounts(
	renames: RenamePair[],
	removedDirs: Set<string>,
): Map<string, Map<string, number>> {
	const counts = new Map<string, Map<string, number>>();

	for (const r of renames) {
		let oldDir = dirnamePath(r.oldPath);
		let newDir = dirnamePath(r.newPath);
		let firstLoop = true;

		while (true) {
			// For non-first iterations, check that trailing subdirectory
			// components match BEFORE incrementing (otherwise we'd count
			// spurious parent renames).
			if (!firstLoop) {
				const startOld = oldDir.length + (oldDir ? 1 : 0);
				const startNew = newDir.length + (newDir ? 1 : 0);
				const oldSub = r.oldPath.slice(startOld, r.oldPath.indexOf("/", startOld));
				const newSub = r.newPath.slice(startNew, r.newPath.indexOf("/", startNew));
				if (oldSub !== newSub) break;
			}

			// Only count if the source directory was fully vacated
			if (removedDirs.has(oldDir)) {
				let destCounts = counts.get(oldDir);
				if (!destCounts) {
					destCounts = new Map();
					counts.set(oldDir, destCounts);
				}
				destCounts.set(newDir, (destCounts.get(newDir) ?? 0) + 1);
			}
			firstLoop = false;

			// Move up to parent directories
			if (!oldDir || !newDir) break;
			oldDir = dirnamePath(oldDir);
			newDir = dirnamePath(newDir);
		}
	}

	return counts;
}

/**
 * Collapse directory rename counts to a single best destination per source.
 * Uses Git's "unique majority" rule: the destination with the highest count
 * wins, but only if it's strictly greater than any other destination count.
 */
function collapseDirRenames(counts: Map<string, Map<string, number>>): Map<string, string> {
	const renames = new Map<string, string>();

	for (const [sourceDir, destCounts] of counts) {
		let max = 0;
		let badMax = 0;
		let best: string | null = null;

		for (const [targetDir, count] of destCounts) {
			if (count === max) {
				badMax = max;
			} else if (count > max) {
				max = count;
				best = targetDir;
			}
		}

		if (max > 0 && badMax !== max && best !== null) {
			renames.set(sourceDir, best);
		}
		// If badMax === max (tie), skip — Git would report a "directory rename
		// split" conflict, but we just skip the ambiguous rename.
	}

	return renames;
}

/**
 * Check if a file's parent directory was renamed and compute the new path.
 * Returns null if no directory rename applies.
 *
 * Walks up the directory tree to find the longest matching prefix that
 * was renamed (e.g., "a/b/c/file.ts" checks "a/b/c", "a/b", "a").
 */
function applyDirRename(
	path: string,
	dirRenames: Map<string, string>,
	exclusions: Set<string>,
): string | null {
	// Try longest prefix first
	let dir = dirnamePath(path);
	while (dir) {
		const newDir = dirRenames.get(dir);
		if (newDir !== undefined) {
			// Check exclusion: don't rename into a directory that was
			// itself renamed by the other side
			if (exclusions.has(newDir)) return null;
			// Replace the directory prefix
			const rest = path.slice(dir.length + 1); // skip "/" separator
			return newDir ? `${newDir}/${rest}` : rest;
		}
		dir = dirnamePath(dir);
	}
	// Check root ("") rename
	const newDir = dirRenames.get("");
	if (newDir !== undefined && !exclusions.has(newDir)) {
		return `${newDir}/${path}`;
	}
	return null;
}

/** Extract the directory part of a path (everything before the last /). */
function dirnamePath(path: string): string {
	const idx = path.lastIndexOf("/");
	return idx === -1 ? "" : path.slice(0, idx);
}

/** Handle rename + add/add target collision. */
async function handleRenameAddAdd(
	ctx: GitRepo,
	output: RenameOutput,
	targetPath: string,
	basePath: string,
	base: FlatTreeEntry,
	oursEntry: FlatTreeEntry,
	theirsEntry: FlatTreeEntry,
	oursMap: Map<string, FlatTreeEntry>,
	theirsMap: Map<string, FlatTreeEntry>,
	isTheirsRename = false,
	labels?: MergeLabels,
	mergeDriver?: MergeDriver,
): Promise<void> {
	const targetEntry = isTheirsRename ? oursMap.get(targetPath)! : theirsMap.get(targetPath)!;

	// When both sides independently have the same content at the target path,
	// git treats this as a trivial match — the rename content merge at the old
	// path is irrelevant since both sides already agree on the destination.
	// Git still emits "Auto-merging <oldpath>" for the rename content merge.
	const renamerEntry = isTheirsRename ? theirsEntry : oursEntry;
	if (targetEntry.hash === renamerEntry.hash) {
		output.entries.push(makeEntryFromHash(targetPath, targetEntry.mode, targetEntry.hash));
		output.msgBuf.push({
			sortKey: basePath,
			subOrder: 0,
			text: `Auto-merging ${basePath}`,
		});
		return;
	}

	const pathLabels = isTheirsRename
		? { oursPath: basePath, theirsPath: targetPath }
		: { oursPath: targetPath, theirsPath: basePath };

	const merged = await mergeRenameContent(ctx, base, oursEntry, theirsEntry, labels, pathLabels, 8, mergeDriver);

	if (targetEntry.hash === merged.hash) {
		output.entries.push(makeEntryFromHash(targetPath, targetEntry.mode, merged.hash));
	} else {
		// Real git always treats rename+add collisions with differing content
		// as add/add conflicts — no attempt to merge collision content with
		// the rename result. Stages 2/3 hold the raw content from each side.
		output.conflicts.push({ path: targetPath, reason: "add-add" });
		output.msgBuf.push({
			sortKey: targetPath,
			subOrder: 0,
			text: `Auto-merging ${targetPath}`,
		});
		output.msgBuf.push({
			sortKey: targetPath,
			subOrder: 1,
			text: `CONFLICT (add/add): Merge conflict in ${targetPath}`,
		});
		if (isTheirsRename) {
			output.entries.push(makeFlatEntry(targetPath, targetEntry, 2));
			output.entries.push(makeEntryFromHash(targetPath, theirsEntry.mode, merged.hash, 3));
			const markerHash = await writeAddAddMarkers(
				ctx,
				targetEntry.hash,
				merged.hash,
				targetEntry.mode,
				labels,
			);
			output.worktreeBlobs.set(targetPath, {
				hash: markerHash,
				mode: targetEntry.mode,
			});
		} else {
			output.entries.push(makeEntryFromHash(targetPath, oursEntry.mode, merged.hash, 2));
			output.entries.push(makeFlatEntry(targetPath, targetEntry, 3));
			const markerHash = await writeAddAddMarkers(
				ctx,
				merged.hash,
				targetEntry.hash,
				oursEntry.mode,
				labels,
			);
			output.worktreeBlobs.set(targetPath, {
				hash: markerHash,
				mode: oursEntry.mode,
			});
		}
	}
}

/**
 * Merge rename content and return the resulting hash.
 *
 * When the merge has conflicts, produces conflict-marker content (real git
 * does this for rename+collision cases, resulting in "nested conflict markers").
 *
 * @param pathLabels Optional path labels for conflict markers (e.g., old/new paths).
 *                   When provided, produces rename-style markers: "HEAD:oldpath" / "theirs:newpath".
 * @param markerSize Optional marker size override (default 7; use 8 for nested/collision markers).
 */
async function mergeRenameContent(
	ctx: GitRepo,
	base: FlatTreeEntry,
	ours: FlatTreeEntry,
	theirs: FlatTreeEntry,
	labels?: MergeLabels,
	pathLabels?: { oursPath?: string; theirsPath?: string },
	markerSize?: number,
	mergeDriver?: MergeDriver,
): Promise<{ hash: ObjectId; conflict: boolean }> {
	if (ours.hash === base.hash) return { hash: theirs.hash, conflict: false };
	if (theirs.hash === base.hash) return { hash: ours.hash, conflict: false };
	if (ours.hash === theirs.hash) return { hash: ours.hash, conflict: false };

	// Symlinks can't be textually merged — all-or-nothing conflict
	if (isSymlinkMode(base.mode) || isSymlinkMode(ours.mode) || isSymlinkMode(theirs.mode)) {
		return { hash: ours.hash, conflict: true };
	}

	const baseText = await readBlobContent(ctx, base.hash);
	const oursText = await readBlobContent(ctx, ours.hash);
	const theirsText = await readBlobContent(ctx, theirs.hash);

	// Binary files can't be textually merged
	if (isBinaryStr(oursText) || isBinaryStr(theirsText) || isBinaryStr(baseText)) {
		return { hash: ours.hash, conflict: true };
	}

	if (mergeDriver) {
		const driverResult = await mergeDriver({
			path: base.path ?? ours.path ?? theirs.path ?? "",
			base: baseText, ours: oursText, theirs: theirsText,
		});
		if (driverResult !== null) {
			const hash = await writeObject(ctx, "blob", encoder.encode(driverResult.content));
			return { hash, conflict: driverResult.conflict };
		}
	}

	const baseLines = splitLinesWithSentinel(baseText);
	const oursLines = splitLinesWithSentinel(oursText);
	const theirsLines = splitLinesWithSentinel(theirsText);

	const style = labels?.conflictStyle;
	const mergeResult = diff3Merge(oursLines, baseLines, theirsLines, { conflictStyle: style });

	if (!mergeResult.conflict) {
		const mergedHash = await writeCleanMergeBlob(ctx, mergeResult.result);
		return { hash: mergedHash, conflict: false };
	}

	// Conflict — produce content with conflict markers (used for nested markers
	// in rename+collision cases and for rename/rename(1to2)).
	const aBase = labels?.a ?? "HEAD";
	const bBase = labels?.b ?? "theirs";
	const markerA = pathLabels?.oursPath ? `${aBase}:${pathLabels.oursPath}` : aBase;
	const markerB = pathLabels?.theirsPath ? `${bBase}:${pathLabels.theirsPath}` : bBase;
	const markerContent = renderConflictMarkers(oursText, baseText, theirsText, {
		a: markerA,
		b: markerB,
		markerSize: markerSize ?? 7,
		conflictStyle: style,
	});
	const markerHash = await writeObject(ctx, "blob", encoder.encode(markerContent));
	return { hash: markerHash, conflict: true };
}

/**
 * Write add/add conflict markers to the object store and return the hash.
 * Used for Phase 2 worktree blobs when rename handling produces add/add conflicts.
 */
async function writeAddAddMarkers(
	ctx: GitRepo,
	oursHash: ObjectId,
	theirsHash: ObjectId,
	_mode: string,
	labels?: MergeLabels,
): Promise<ObjectId> {
	const oursText = await readBlobContent(ctx, oursHash);
	const theirsText = await readBlobContent(ctx, theirsHash);
	const markerContent = renderConflictMarkers(oursText, "", theirsText, {
		a: labels?.a ?? "HEAD",
		b: labels?.b ?? "theirs",
		conflictStyle: labels?.conflictStyle,
	});
	return writeObject(ctx, "blob", encoder.encode(markerContent));
}

/** Create an IndexEntry from a FlatTreeEntry. */
function makeFlatEntry(path: string, entry: FlatTreeEntry, stage = 0): IndexEntry {
	return makeEntryFromHash(path, entry.mode, entry.hash, stage);
}

/** Create an IndexEntry from a hash and mode string. */
function makeEntryFromHash(path: string, mode: string, hash: ObjectId, stage = 0): IndexEntry {
	return { path, mode: parseInt(mode, 8), hash, stage, stat: defaultStat() };
}

// ── Phase 3: Process entries ────────────────────────────────────────

async function processEntries(
	ctx: GitRepo,
	paths: Map<string, ConflictInfo>,
	labels: MergeLabels | undefined,
	renameOutput: RenameOutput,
	mergeDriver?: MergeDriver,
): Promise<MergeOrtResult> {
	// Start with rename-produced entries/conflicts/messages
	const entries: IndexEntry[] = [...renameOutput.entries];
	const conflicts: MergeConflict[] = [...renameOutput.conflicts];
	const msgBuf: SortableMsg[] = [...renameOutput.msgBuf];
	const worktreeBlobs = new Map(renameOutput.worktreeBlobs);

	function pushMsg(sortKey: string, text: string, subOrder = 0) {
		msgBuf.push({ sortKey, subOrder, text });
	}

	// Process all paths in sorted order
	for (const path of [...paths.keys()].sort()) {
		const ci = paths.get(path)!;

		// Already resolved in Phase 1 or Phase 2
		if (ci.merged.clean) {
			if (ci.merged.result?.hash) {
				entries.push(makeEntry(path, ci.merged.result.hash, ci.merged.result.mode));
			}
			// null result = deleted, don't add entry
			continue;
		}

		// Needs conflict resolution
		await processEntry(ctx, ci, labels, entries, conflicts, pushMsg, worktreeBlobs, mergeDriver);
	}

	// Sort messages by path (byte-level, matching git's strcmp) then sub-order
	msgBuf.sort(
		(a, b) =>
			(a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0) || a.subOrder - b.subOrder,
	);
	const messages = msgBuf.map((m) => m.text);

	// Build the result tree: stage-0 entries + worktree blobs for conflicts
	const treeEntries: IndexEntry[] = [];
	const treePaths = new Set<string>();
	for (const entry of entries) {
		if (entry.stage === 0) {
			treeEntries.push(entry);
			treePaths.add(entry.path);
		}
	}
	for (const [path, blob] of worktreeBlobs) {
		if (!treePaths.has(path)) {
			treeEntries.push(makeEntry(path, blob.hash, blob.mode));
		}
	}
	treeEntries.sort((a, b) => comparePaths(a.path, b.path));
	const resultTree = await buildTreeFromIndex(ctx, treeEntries);

	return { entries, conflicts, messages, resultTree };
}

async function processEntry(
	ctx: GitRepo,
	ci: ConflictInfo,
	labels: MergeLabels | undefined,
	entries: IndexEntry[],
	conflicts: MergeConflict[],
	pushMsg: (sortKey: string, text: string, subOrder?: number) => void,
	worktreeBlobs: Map<string, { hash: ObjectId; mode: string }>,
	mergeDriver?: MergeDriver,
): Promise<void> {
	const path = ci.path;
	const [base, ours, theirs] = ci.stages;
	const bh = base?.hash ?? null;
	const oh = ours?.hash ?? null;
	const th = theirs?.hash ?? null;

	// ── Delete/modify conflict ──
	if (oh === null && th !== null && bh !== null) {
		// Ours deleted, theirs modified
		conflicts.push({ path, reason: "delete-modify", deletedBy: "ours" });
		const delLabel = labels?.a ?? "HEAD";
		const modLabel = labels?.b ?? "theirs";
		pushMsg(
			path,
			`CONFLICT (modify/delete): ${path} deleted in ${delLabel} and modified in ${modLabel}.  Version ${modLabel} of ${path} left in tree.`,
		);
		if (base) entries.push(makeEntry(path, bh!, base.mode, 1));
		entries.push(makeEntry(path, th!, theirs!.mode, 3));
		// Worktree gets theirs' version (ours deleted it)
		worktreeBlobs.set(path, { hash: th!, mode: theirs!.mode });
		return;
	}
	if (th === null && oh !== null && bh !== null) {
		// Theirs deleted, ours modified
		conflicts.push({ path, reason: "delete-modify", deletedBy: "theirs" });
		const delLabel = labels?.b ?? "theirs";
		const modLabel = labels?.a ?? "HEAD";
		pushMsg(
			path,
			`CONFLICT (modify/delete): ${path} deleted in ${delLabel} and modified in ${modLabel}.  Version ${modLabel} of ${path} left in tree.`,
		);
		if (base) entries.push(makeEntry(path, bh!, base.mode, 1));
		entries.push(makeEntry(path, oh!, ours!.mode, 2));
		// Worktree keeps ours' version (same as HEAD, no blob override needed)
		worktreeBlobs.set(path, { hash: oh!, mode: ours!.mode });
		return;
	}

	// ── Add/add (no base) — attempt three-way merge with empty base ──
	if (bh === null && oh !== null && th !== null) {
		if (oh === th) {
			entries.push(makeEntry(path, oh!, ours!.mode));
			return;
		}

		pushMsg(path, `Auto-merging ${path}`, 0);

		const oursText = await readBlobContent(ctx, oh);
		const theirsText = await readBlobContent(ctx, th);

		if (isBinaryStr(oursText) || isBinaryStr(theirsText)) {
			conflicts.push({ path, reason: "add-add" });
			pushMsg(
				path,
				`warning: Cannot merge binary files: ${path} (${labels?.a ?? "HEAD"} vs. ${labels?.b ?? "theirs"})`,
				-1,
			);
			pushMsg(path, `CONFLICT (add/add): Merge conflict in ${path}`, 1);
			entries.push(makeEntry(path, oh!, ours!.mode, 2));
			entries.push(makeEntry(path, th!, theirs!.mode, 3));
			worktreeBlobs.set(path, { hash: oh!, mode: ours!.mode });
			return;
		}

		if (mergeDriver) {
			const driverResult = await mergeDriver({
				path, base: null, ours: oursText, theirs: theirsText,
			});
			if (driverResult !== null) {
				const driverHash = await writeObject(ctx, "blob", encoder.encode(driverResult.content));
				if (!driverResult.conflict) {
					entries.push(makeEntry(path, driverHash, ours!.mode));
					return;
				}
				conflicts.push({ path, reason: "add-add" });
				pushMsg(path, `CONFLICT (add/add): Merge conflict in ${path}`, 1);
				entries.push(makeEntry(path, oh!, ours!.mode, 2));
				entries.push(makeEntry(path, th!, theirs!.mode, 3));
				worktreeBlobs.set(path, { hash: driverHash, mode: ours!.mode });
				return;
			}
		}

		const baseLines = splitLinesWithSentinel("");
		const oursLines = splitLinesWithSentinel(oursText);
		const theirsLines = splitLinesWithSentinel(theirsText);
		const mergeResult = diff3Merge(oursLines, baseLines, theirsLines, {
			conflictStyle: labels?.conflictStyle,
		});

		if (!mergeResult.conflict) {
			const mergedHash = await writeCleanMergeBlob(ctx, mergeResult.result);
			entries.push(makeEntry(path, mergedHash, ours!.mode));
			return;
		}

		conflicts.push({ path, reason: "add-add" });
		pushMsg(path, `CONFLICT (add/add): Merge conflict in ${path}`, 1);
		entries.push(makeEntry(path, oh!, ours!.mode, 2));
		entries.push(makeEntry(path, th!, theirs!.mode, 3));
		const markerContent = renderConflictMarkers(oursText, "", theirsText, {
			a: labels?.a ?? "HEAD",
			b: labels?.b ?? "theirs",
			conflictStyle: labels?.conflictStyle,
		});
		const markerHash = await writeObject(ctx, "blob", encoder.encode(markerContent));
		worktreeBlobs.set(path, { hash: markerHash, mode: ours!.mode });
		return;
	}

	// ── Content merge (both sides present with base) ──
	if (bh !== null && oh !== null && th !== null) {
		// Trivial cases — resolve without "Auto-merging" message.
		// These can occur when rename detection pushes a path through Phase 3
		// even though only one side actually modified the file content.
		if (oh === bh) {
			// Only theirs modified — take theirs
			entries.push(makeEntry(path, th!, theirs!.mode));
			return;
		}
		if (th === bh) {
			// Only ours modified — take ours
			entries.push(makeEntry(path, oh!, ours!.mode));
			return;
		}
		if (oh === th) {
			// Both made identical changes — take either
			entries.push(makeEntry(path, oh!, ours!.mode));
			return;
		}

		// True three-way content merge needed
		pushMsg(path, `Auto-merging ${path}`, 0);

		// Symlinks can't be textually merged — all-or-nothing conflict.
		// Keep "ours" in worktree, same as binary conflict handling.
		if (isSymlinkMode(base!.mode) || isSymlinkMode(ours!.mode) || isSymlinkMode(theirs!.mode)) {
			conflicts.push({ path, reason: "content" });
			pushMsg(path, `CONFLICT (content): Merge conflict in ${path}`, 1);
			entries.push(makeEntry(path, bh, base!.mode, 1));
			entries.push(makeEntry(path, oh, ours!.mode, 2));
			entries.push(makeEntry(path, th, theirs!.mode, 3));
			worktreeBlobs.set(path, { hash: oh, mode: ours!.mode });
			return;
		}

		const baseText = await readBlobContent(ctx, bh);
		const oursText = await readBlobContent(ctx, oh);
		const theirsText = await readBlobContent(ctx, th);

		// Binary files can't be textually merged — treat as conflict,
		// keep "ours" in worktree (matching real git behavior).
		// Git emits: warning → Auto-merging → CONFLICT (content), so
		// the warning gets subOrder -1 (before Auto-merging at 0).
		if (isBinaryStr(oursText) || isBinaryStr(theirsText) || isBinaryStr(baseText)) {
			conflicts.push({ path, reason: "content" });
			pushMsg(
				path,
				`warning: Cannot merge binary files: ${path} (${labels?.a ?? "HEAD"} vs. ${labels?.b ?? "theirs"})`,
				-1,
			);
			pushMsg(path, `CONFLICT (content): Merge conflict in ${path}`, 1);
			entries.push(makeEntry(path, bh, base!.mode, 1));
			entries.push(makeEntry(path, oh, ours!.mode, 2));
			entries.push(makeEntry(path, th, theirs!.mode, 3));
			worktreeBlobs.set(path, { hash: oh, mode: ours!.mode });
			return;
		}

		if (mergeDriver) {
			const driverResult = await mergeDriver({
				path, base: baseText, ours: oursText, theirs: theirsText,
			});
			if (driverResult !== null) {
				const driverHash = await writeObject(ctx, "blob", encoder.encode(driverResult.content));
				if (!driverResult.conflict) {
					entries.push(makeEntry(path, driverHash, ours!.mode));
					return;
				}
				const oursOrigPath = ci.pathnames[1];
				const theirsOrigPath = ci.pathnames[2];
				const hasRenameLabels = oursOrigPath !== path || theirsOrigPath !== path;
				const conflict: MergeConflict = { path, reason: "content" };
				if (hasRenameLabels) {
					if (oursOrigPath !== path) conflict.oursOrigPath = oursOrigPath;
					if (theirsOrigPath !== path) conflict.theirsOrigPath = theirsOrigPath;
				}
				conflicts.push(conflict);
				pushMsg(path, `CONFLICT (content): Merge conflict in ${path}`, 1);
				entries.push(makeEntry(path, bh, base!.mode, 1));
				entries.push(makeEntry(path, oh, ours!.mode, 2));
				entries.push(makeEntry(path, th, theirs!.mode, 3));
				worktreeBlobs.set(path, { hash: driverHash, mode: ours!.mode });
				return;
			}
		}

		// Use diff3Merge for clean/conflict detection (matches old mergeTrees behavior)
		const baseLines = splitLinesWithSentinel(baseText);
		const oursLines = splitLinesWithSentinel(oursText);
		const theirsLines = splitLinesWithSentinel(theirsText);

		const mergeResult = diff3Merge(oursLines, baseLines, theirsLines, {
			conflictStyle: labels?.conflictStyle,
		});

		if (!mergeResult.conflict) {
			const mergedHash = await writeCleanMergeBlob(ctx, mergeResult.result);
			entries.push(makeEntry(path, mergedHash, ours!.mode));
		} else {
			// Conflict — write stages 1-3 for the index
			const oursOrigPath = ci.pathnames[1];
			const theirsOrigPath = ci.pathnames[2];
			const hasRenameLabels = oursOrigPath !== path || theirsOrigPath !== path;

			const conflict: MergeConflict = { path, reason: "content" };
			if (hasRenameLabels) {
				if (oursOrigPath !== path) conflict.oursOrigPath = oursOrigPath;
				if (theirsOrigPath !== path) conflict.theirsOrigPath = theirsOrigPath;
			}
			conflicts.push(conflict);
			pushMsg(path, `CONFLICT (content): Merge conflict in ${path}`, 1);

			entries.push(makeEntry(path, bh, base!.mode, 1));
			entries.push(makeEntry(path, oh, ours!.mode, 2));
			entries.push(makeEntry(path, th, theirs!.mode, 3));

			// Worktree gets the conflict-marker content via renderConflictMarkers
			const oursLabel = hasRenameLabels
				? `${labels?.a ?? "HEAD"}:${oursOrigPath}`
				: (labels?.a ?? "HEAD");
			const theirsLabel = hasRenameLabels
				? `${labels?.b ?? "theirs"}:${theirsOrigPath}`
				: (labels?.b ?? "theirs");
			const markerContent = renderConflictMarkers(oursText, baseText, theirsText, {
				a: oursLabel,
				b: theirsLabel,
				conflictStyle: labels?.conflictStyle,
			});
			const markerHash = await writeObject(ctx, "blob", encoder.encode(markerContent));
			worktreeBlobs.set(path, { hash: markerHash, mode: ours!.mode });
		}
		return;
	}
}

// ── Recursive merge base computation ────────────────────────────────

/** Git's GIT_MERGE_DEFAULT_CALL_DEPTH — cap recursion depth. */
const MAX_MERGE_CALL_DEPTH = 200;

async function computeRecursiveMergeBase(
	ctx: GitRepo,
	_oursHash: ObjectId,
	_theirsHash: ObjectId,
	bases: ObjectId[],
	callDepth: number,
	mergeDriver?: MergeDriver,
): Promise<ObjectId> {
	// Sort merge bases oldest-first (ascending by commit timestamp)
	const basesWithTimestamp = await Promise.all(
		bases.map(async (hash) => ({
			hash,
			timestamp: (await readCommit(ctx, hash)).committer.timestamp,
		})),
	);
	basesWithTimestamp.sort((a, b) => a.timestamp - b.timestamp);
	const sortedBases = basesWithTimestamp.map((b) => b.hash);

	const firstBase = sortedBases[0]!;
	let virtualCommitHash: ObjectId = firstBase;
	let virtualTree = (await readCommit(ctx, firstBase)).tree;

	for (let i = 1; i < sortedBases.length; i++) {
		const nextBase = sortedBases[i]!;
		const nextTree = (await readCommit(ctx, nextBase)).tree;

		// Find inner merge base
		let innerBaseTree: ObjectId | null = null;
		if (callDepth >= MAX_MERGE_CALL_DEPTH) {
			// Depth limit reached — just use first base (git does this too)
			innerBaseTree = virtualTree;
		} else {
			const innerBases = await findAllMergeBases(ctx, virtualCommitHash, nextBase);
			if (innerBases.length === 0) {
				innerBaseTree = null;
			} else if (innerBases.length === 1) {
				innerBaseTree = (await readCommit(ctx, innerBases[0]!)).tree;
			} else {
				innerBaseTree = await computeRecursiveMergeBase(
					ctx,
					virtualCommitHash,
					nextBase,
					innerBases,
					callDepth + 1,
					mergeDriver,
				);
			}
		}

		// Merge the two base trees (inner merge at callDepth > 0)
		const result = await mergeOrtNonRecursive(
			ctx, innerBaseTree, virtualTree, nextTree, undefined, mergeDriver,
		);

		// Build virtual tree from merge result, resolving conflicts
		virtualTree = await resolveVirtualBaseConflicts(ctx, result, callDepth);

		// Create virtual commit with parents=[prev, next]
		const virtualCommitContent = serializeCommit({
			type: "commit",
			tree: virtualTree,
			parents: [virtualCommitHash, nextBase],
			author: VIRTUAL_IDENTITY,
			committer: VIRTUAL_IDENTITY,
			message: "merged common ancestors",
		});
		virtualCommitHash = await writeObject(ctx, "commit", virtualCommitContent);
	}

	return virtualTree;
}

/**
 * Resolve conflicts in a virtual base tree merge.
 *
 * At callDepth > 0, git writes conflict markers into the virtual base blob
 * for content/add-add conflicts (using "Temporary merge branch 1/2" labels).
 * For delete-modify conflicts, git uses the BASE version (stage 1).
 */
async function resolveVirtualBaseConflicts(
	ctx: GitRepo,
	result: MergeTreeResult,
	callDepth: number,
): Promise<ObjectId> {
	const treeEntries = result.entries.filter((e) => e.stage === 0);

	const stageIndex = new Map<string, IndexEntry>();
	for (const e of result.entries) {
		if (e.stage > 0) stageIndex.set(`${e.path}\0${e.stage}`, e);
	}
	const findStaged = (path: string, stage: number) => stageIndex.get(`${path}\0${stage}`);

	const conflictLabels: MergeLabels = {
		a: "Temporary merge branch 1",
		b: "Temporary merge branch 2",
		markerSize: 7 + callDepth * 2,
	};

	for (const conflict of result.conflicts) {
		if (conflict.reason === "delete-modify" || conflict.reason === "rename-delete") {
			// At callDepth > 0, use base (stage 1)
			const baseEntry = findStaged(conflict.path, 1);
			if (baseEntry) {
				treeEntries.push({ ...baseEntry, stage: 0 });
				continue;
			}
		}

		if (conflict.reason === "rename-rename") {
			// Content merge with conflict markers for rename/rename(1to2)
			const oursPath = conflict.oursPath ?? conflict.path;
			const theirsPath = conflict.theirsPath ?? conflict.path;
			const baseEntry = findStaged(conflict.path, 1);
			const oursEntry = findStaged(oursPath, 2);
			const theirsEntry = findStaged(theirsPath, 3);

			if (oursEntry && theirsEntry) {
				const oursContent = decoder.decode((await readObject(ctx, oursEntry.hash)).content);
				const theirsContent = decoder.decode((await readObject(ctx, theirsEntry.hash)).content);
				const baseContent = baseEntry
					? decoder.decode((await readObject(ctx, baseEntry.hash)).content)
					: "";
				const renameMarkerSize = 7 + 1 + callDepth * 2;
				const baseA = conflictLabels.a ?? "Temporary merge branch 1";
				const baseB = conflictLabels.b ?? "Temporary merge branch 2";
				const mergedText = renderConflictMarkers(oursContent, baseContent, theirsContent, {
					a: `${baseA}:${oursPath}`,
					o: conflictLabels.o,
					b: `${baseB}:${theirsPath}`,
					markerSize: renameMarkerSize,
				});
				const mergedHash = await writeObject(ctx, "blob", encoder.encode(mergedText));
				treeEntries.push({
					path: oursPath,
					mode: oursEntry.mode,
					hash: mergedHash,
					stage: 0,
					stat: defaultStat(),
				});
				treeEntries.push({
					path: theirsPath,
					mode: theirsEntry.mode,
					hash: mergedHash,
					stage: 0,
					stat: defaultStat(),
				});
				continue;
			} else if (oursEntry) {
				treeEntries.push({ ...oursEntry, stage: 0 });
				continue;
			}
		}

		// Content/add-add conflicts: produce blob with conflict markers
		const oursEntry = findStaged(conflict.path, 2);
		const theirsEntry = findStaged(conflict.path, 3);

		if (
			oursEntry &&
			theirsEntry &&
			(conflict.reason === "content" || conflict.reason === "add-add")
		) {
			const oursContent = decoder.decode((await readObject(ctx, oursEntry.hash)).content);
			const theirsContent = decoder.decode((await readObject(ctx, theirsEntry.hash)).content);

			const innerBaseEntry = conflict.reason === "content" ? findStaged(conflict.path, 1) : null;
			const innerBaseContent = innerBaseEntry
				? decoder.decode((await readObject(ctx, innerBaseEntry.hash)).content)
				: "";

			// Include path suffixes for rename-related conflicts
			const hasRenameLabels = conflict.oursOrigPath || conflict.theirsOrigPath;
			const baseA = conflictLabels.a ?? "Temporary merge branch 1";
			const baseB = conflictLabels.b ?? "Temporary merge branch 2";
			const labelA = hasRenameLabels ? `${baseA}:${conflict.oursOrigPath ?? conflict.path}` : baseA;
			const labelB = hasRenameLabels
				? `${baseB}:${conflict.theirsOrigPath ?? conflict.path}`
				: baseB;

			const mergedText = renderConflictMarkers(oursContent, innerBaseContent, theirsContent, {
				a: labelA,
				o: conflictLabels.o,
				b: labelB,
				markerSize: conflictLabels.markerSize,
			});
			const mergedHash = await writeObject(ctx, "blob", encoder.encode(mergedText));
			treeEntries.push({
				path: conflict.path,
				mode: oursEntry.mode,
				hash: mergedHash,
				stage: 0,
				stat: defaultStat(),
			});
		} else if (oursEntry) {
			treeEntries.push({ ...oursEntry, stage: 0 });
		} else if (theirsEntry) {
			treeEntries.push({ ...theirsEntry, stage: 0 });
		}
	}

	treeEntries.sort((a, b) => comparePaths(a.path, b.path));
	return buildTreeFromIndex(ctx, treeEntries);
}

// ── Helpers ─────────────────────────────────────────────────────────

/** Reconstruct merged text from diff3 sentinel-annotated lines and write as a blob. */
async function writeCleanMergeBlob(ctx: GitRepo, sentinelLines: string[]): Promise<ObjectId> {
	const lines = sentinelLines.map(stripSentinel);
	if (lines.length === 0) {
		return writeObject(ctx, "blob", encoder.encode(""));
	}
	const lastRaw = sentinelLines[sentinelLines.length - 1] ?? "";
	const noTrailingNl = lastRaw.endsWith("\u0000");
	const text = noTrailingNl ? lines.join("\n") : `${lines.join("\n")}\n`;
	return writeObject(ctx, "blob", encoder.encode(text));
}

function makeEntry(path: string, hash: ObjectId, mode: string | number, stage = 0): IndexEntry {
	const numericMode = typeof mode === "string" ? parseInt(mode, 8) : mode;
	return { path, mode: numericMode, hash, stage, stat: defaultStat() };
}

/** Get or create a ConflictInfo entry in the paths map. */
function getOrCreate(paths: Map<string, ConflictInfo>, path: string): ConflictInfo {
	let ci = paths.get(path);
	if (!ci) {
		ci = {
			path,
			stages: [null, null, null],
			pathnames: [path, path, path],
			filemask: 0,
			matchMask: 0,
			merged: { result: null, clean: false },
			pathConflict: false,
		};
		paths.set(path, ci);
	}
	return ci;
}

// ── Apply merge result ──────────────────────────────────────────────

/**
 * Format precondition error messages for merge-ort operations.
 *
 * - `git merge`: ort-style (space-separated files, "Merge with strategy ort failed.")
 * - `git cherry-pick` / `git rebase`: sequencer-style (tab-indented, standard unpack message + fatal line)
 */
function formatMergeOrtError(
	files: string[],
	operationName: string,
	callerCommand: string,
	errorType: "local" | "untracked",
	checkPhase: "staged" | "worktree",
): string {
	const header =
		errorType === "untracked"
			? `error: The following untracked working tree files would be overwritten by ${operationName}:`
			: `error: Your local changes to the following files would be overwritten by ${operationName}:`;

	if (callerCommand === "merge") {
		if (checkPhase === "staged") {
			// Staged-change check: pure ort format (space-separated, two-space indent)
			return `${header}\n  ${files.join(" ")}\nMerge with strategy ort failed.\n`;
		}
		// Worktree check: standard unpack-trees message + ort trailer
		const fileList = files.map((f) => `\t${f}`).join("\n");
		const hint =
			errorType === "untracked"
				? `Please move or remove them before you ${operationName}.`
				: `Please commit your changes or stash them before you ${operationName}.`;
		return `${header}\n${fileList}\n${hint}\nAborting\nMerge with strategy ort failed.\n`;
	}

	// Sequencer-style (cherry-pick/rebase): tab-indented + "fatal: <cmd> failed"
	const fileList = files.map((f) => `\t${f}`).join("\n");
	const hint =
		errorType === "untracked"
			? `Please move or remove them before you ${operationName}.`
			: `Please commit your changes or stash them before you ${operationName}.`;
	return `${header}\n${fileList}\n${hint}\nAborting\nfatal: ${callerCommand} failed\n`;
}

/**
 * Format multi-block worktree errors for merge-ort when both local changes
 * and untracked files are present. Produces separate error blocks with a
 * single "Aborting" + trailer at the end.
 */
function formatMergeOrtWorktreeMultiBlock(
	localFiles: string[],
	untrackedFiles: string[],
	operationName: string,
	callerCommand: string,
): string {
	const blocks: string[] = [];

	if (localFiles.length > 0) {
		const fileList = localFiles.map((f) => `\t${f}`).join("\n");
		blocks.push(
			`error: Your local changes to the following files would be overwritten by ${operationName}:\n${fileList}\nPlease commit your changes or stash them before you ${operationName}.\n`,
		);
	}

	if (untrackedFiles.length > 0) {
		const fileList = untrackedFiles.map((f) => `\t${f}`).join("\n");
		blocks.push(
			`error: The following untracked working tree files would be overwritten by ${operationName}:\n${fileList}\nPlease move or remove them before you ${operationName}.\n`,
		);
	}

	const trailer =
		callerCommand === "merge"
			? "Merge with strategy ort failed."
			: `fatal: ${callerCommand} failed`;

	return `${blocks.join("")}Aborting\n${trailer}\n`;
}

interface ApplyMergeOptions {
	/** Labels for conflict marker display. */
	labels: { a: string; b: string };
	/** Error exit code for precondition failures (default 2 for merge, 128 for cherry-pick). */
	errorExitCode?: number;
	/** Operation name for error messages. */
	operationName?: string;
	/** Skip the staged-change check (e.g., for rebase). */
	skipStagedChangeCheck?: boolean;
	/**
	 * The top-level command that initiated this merge (e.g. "merge", "cherry-pick", "rebase").
	 * Controls error message formatting:
	 * - "merge": ort-style (space-separated files, "Merge with strategy ort failed.")
	 * - "cherry-pick"/"rebase": sequencer-style (tab-indented, "Please commit..." + "fatal: <cmd> failed")
	 */
	callerCommand?: string;
	/**
	 * Run an additional oneway merge safety check before the twoway merge.
	 * Real git uses checkout_fast_forward (oneway merge) for cherry-pick -n,
	 * which correctly classifies untracked files vs staged deletions. The
	 * twoway merge is still used for actual worktree ops.
	 */
	preflightOnewayCheck?: boolean;
}

interface ApplyMergeSuccess {
	ok: true;
	/** The final index (merge result + preserved entries). */
	finalIndex: Index;
	/** The tree hash of the merge result (stage-0 entries only). */
	mergedTreeHash: ObjectId;
}

export interface ApplyMergeFailure {
	ok: false;
	stdout: string;
	stderr: string;
	exitCode: number;
	failureKind?: "staged" | "worktree";
}

type ApplyMergeResultType = ApplyMergeSuccess | ApplyMergeFailure;

/**
 * Apply a merge-ort result to the index and worktree.
 *
 * This is the shared application function used by merge, cherry-pick,
 * and rebase. It handles:
 *
 * 1. Staged-change check (index vs HEAD — refuses merge if staged changes exist)
 * 2. Worktree safety via checkoutTrees (refuses if dirty files would be overwritten)
 * 3. Index building (merge result + preserved entries outside merge scope)
 * 4. Worktree update via applyWorktreeOps
 *
 * The result tree from merge-ort includes conflict-marker blobs for
 * conflicted files, so checkoutTrees handles all worktree writes uniformly.
 */
export async function applyMergeResult(
	ctx: GitContext,
	result: MergeOrtResult,
	headTree: ObjectId,
	options: ApplyMergeOptions,
): Promise<ApplyMergeResultType> {
	const currentIndex = await readIndex(ctx);
	const headMap = await flattenTreeToMap(ctx, headTree);

	// ── Step 1: Staged-change check (index vs HEAD) ──
	if (!options.skipStagedChangeCheck && ctx.workTree) {
		const indexMap = new Map(getStage0Entries(currentIndex).map((e) => [e.path, e]));
		const stagedChangeErrors: string[] = [];
		for (const [path, entry] of indexMap) {
			const headEntry = headMap.get(path);
			if (!headEntry || headEntry.hash !== entry.hash) {
				stagedChangeErrors.push(path);
			}
		}
		for (const [path] of headMap) {
			if (!indexMap.has(path)) {
				stagedChangeErrors.push(path);
			}
		}
		if (stagedChangeErrors.length > 0) {
			const sorted = [...stagedChangeErrors].sort();
			await restoreStagedAdditions(ctx, currentIndex, headMap);
			const opName = options.operationName ?? "merge";
			const caller = options.callerCommand ?? "merge";
			return {
				ok: false,
				stdout: "",
				stderr: formatMergeOrtError(sorted, opName, caller, "local", "staged"),
				exitCode: options.errorExitCode ?? 2,
				failureKind: "staged",
			};
		}
	}

	// ── Step 2a: Oneway preflight safety check (cherry-pick -n) ──
	// Real git uses checkout_fast_forward (oneway merge) for cherry-pick -n.
	// This correctly classifies untracked files and catches dirty-worktree
	// cases that twoway merge misses (twoway skips files where HEAD == result).
	if (ctx.workTree && options.preflightOnewayCheck) {
		const preflightResult = await unpackTrees(
			ctx,
			[{ label: "target", treeHash: result.resultTree }],
			currentIndex,
			{
				mergeFn: onewayMerge,
				updateWorktree: false,
				reset: false,
				errorExitCode: options.errorExitCode ?? 2,
				operationName: options.operationName ?? "merge",
			},
		);
		if (!preflightResult.success) {
			await restoreStagedAdditions(ctx, currentIndex, headMap);
			const opName = options.operationName ?? "merge";
			const caller = options.callerCommand ?? "merge";
			const localFiles = preflightResult.errors
				.filter(
					(e) =>
						e.error === UnpackError.WOULD_OVERWRITE || e.error === UnpackError.NOT_UPTODATE_FILE,
				)
				.map((e) => e.path)
				.sort();
			const untrackedFiles = preflightResult.errors
				.filter(
					(e) =>
						e.error === UnpackError.WOULD_LOSE_UNTRACKED_OVERWRITTEN ||
						e.error === UnpackError.WOULD_LOSE_UNTRACKED_REMOVED,
				)
				.map((e) => e.path)
				.sort();
			let stderr: string;
			if (localFiles.length > 0 && untrackedFiles.length > 0) {
				stderr = formatMergeOrtWorktreeMultiBlock(localFiles, untrackedFiles, opName, caller);
			} else if (untrackedFiles.length > 0) {
				stderr = formatMergeOrtError(untrackedFiles, opName, caller, "untracked", "worktree");
			} else {
				stderr = formatMergeOrtError(localFiles, opName, caller, "local", "worktree");
			}
			return {
				ok: false,
				stdout: "",
				stderr,
				exitCode: options.errorExitCode ?? 2,
				failureKind: "worktree",
			};
		}
	}

	// ── Step 2b: Worktree safety check + ops via two-way unpack ──
	if (ctx.workTree) {
		const checkoutResult = await unpackTrees(
			ctx,
			[
				{ label: "current", treeHash: headTree },
				{ label: "target", treeHash: result.resultTree },
			],
			currentIndex,
			{
				mergeFn: twowayMerge,
				updateWorktree: true,
				reset: false,
				errorExitCode: options.errorExitCode ?? 2,
				operationName: options.operationName ?? "merge",
				allowStagedChanges: !!options.preflightOnewayCheck,
			},
		);

		if (!checkoutResult.success) {
			await restoreStagedAdditions(ctx, currentIndex, headMap);
			const opName = options.operationName ?? "merge";
			const caller = options.callerCommand ?? "merge";

			// Separate error types into distinct groups (matching git's display_error_msgs)
			const localFiles = checkoutResult.errors
				.filter(
					(e) =>
						e.error === UnpackError.WOULD_OVERWRITE || e.error === UnpackError.NOT_UPTODATE_FILE,
				)
				.map((e) => e.path)
				.sort();
			const untrackedFiles = checkoutResult.errors
				.filter(
					(e) =>
						e.error === UnpackError.WOULD_LOSE_UNTRACKED_OVERWRITTEN ||
						e.error === UnpackError.WOULD_LOSE_UNTRACKED_REMOVED,
				)
				.map((e) => e.path)
				.sort();

			const blocks: string[] = [];
			if (localFiles.length > 0) {
				blocks.push(formatMergeOrtError(localFiles, opName, caller, "local", "worktree"));
			}
			if (untrackedFiles.length > 0) {
				blocks.push(formatMergeOrtError(untrackedFiles, opName, caller, "untracked", "worktree"));
			}

			// When we have multiple blocks, each already ends with the trailer
			// (e.g., "Aborting\nMerge with strategy ort failed.\n").
			// We want "Aborting" + trailer only once at the end.
			// So strip trailer from all but the last block.
			let stderr: string;
			if (blocks.length > 1) {
				stderr = formatMergeOrtWorktreeMultiBlock(localFiles, untrackedFiles, opName, caller);
			} else {
				stderr = blocks[0] ?? "";
			}

			return {
				ok: false,
				stdout: "",
				stderr,
				exitCode: options.errorExitCode ?? 2,
				failureKind: "worktree",
			};
		}

		// Apply worktree operations (checkout new/changed files, delete removed)
		await applyWorktreeOps(ctx, checkoutResult.worktreeOps);
	}

	// ── Step 3: Compute merge scope and build final index ──
	// For cherry-pick -n (preflightOnewayCheck): preserve the current index
	// state for paths where the merge didn't change the file. This keeps
	// staged deletions and staged modifications intact.
	const unchangedPaths = new Set<string>();
	let mergeEntries = result.entries;

	if (options.preflightOnewayCheck) {
		const filteredEntries: IndexEntry[] = [];
		for (const entry of result.entries) {
			if (entry.stage === 0) {
				const headEntry = headMap.get(entry.path);
				if (headEntry && headEntry.hash === entry.hash) {
					unchangedPaths.add(entry.path);
					continue;
				}
			}
			filteredEntries.push(entry);
		}
		mergeEntries = filteredEntries;
	}

	// Merge scope: all paths touched by the merge result
	const mergeResultPaths = new Set(mergeEntries.map((e) => e.path));
	// Also include paths in head tree that might have been deleted by the merge
	for (const path of headMap.keys()) {
		if (!unchangedPaths.has(path)) {
			mergeResultPaths.add(path);
		}
	}

	// Preserve index entries outside the merge scope
	const preservedEntries = currentIndex.entries.filter((e) => !mergeResultPaths.has(e.path));

	const finalEntries = [...mergeEntries, ...preservedEntries];
	finalEntries.sort((a, b) => comparePaths(a.path, b.path) || a.stage - b.stage);
	const finalIndex: Index = { version: 2, entries: finalEntries };
	await writeIndex(ctx, finalIndex);

	// Compute merged tree hash from stage-0 entries
	const stage0Entries = finalEntries.filter((e) => e.stage === 0);
	const mergedTreeHash = await buildTreeFromIndex(ctx, stage0Entries);

	return { ok: true, finalIndex, mergedTreeHash };
}

/**
 * Restore staged additions that were deleted from the working tree.
 * Called before returning an error to prevent data loss.
 */
async function restoreStagedAdditions(
	ctx: GitContext,
	currentIndex: Index,
	headMap: Map<string, FlatTreeEntry>,
): Promise<void> {
	if (!ctx.workTree) return;

	for (const entry of currentIndex.entries) {
		if (entry.stage !== 0) continue;
		if (headMap.has(entry.path)) continue;
		const fullPath = join(ctx.workTree, entry.path);
		if (await ctx.fs.exists(fullPath)) continue;
		await checkoutEntry(ctx, {
			path: entry.path,
			hash: entry.hash,
			mode: entry.mode,
		});
	}
}
