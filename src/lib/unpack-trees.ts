/**
 * lib/unpack-trees.ts
 *
 * Centralized tree-unpacking layer modeled after git's unpack-trees.c.
 * Replaces duplicated dirty-check and tree-application logic across:
 *
 *   - commands/merge.ts   (checkFastForwardOverwrites, checkThreeWayOverwrites)
 *   - commands/checkout.ts (checkForConflicts, updateWorkTreeAndIndex)
 *   - lib/stash.ts         (saveStash reset-to-HEAD, applyStash)
 *   - commands/reset.ts    (hard reset worktree rebuild)
 *
 * Architecture:
 *   1. Gather per-path state (trees, index, worktree)
 *   2. Run a merge function per path to decide the outcome
 *   3. Check preconditions (index clean? worktree up-to-date? untracked?)
 *   4. If all pass, apply the result (update index + worktree)
 *   5. If any fail, collect errors and report them
 */

import { comparePaths, err } from "./command-utils.ts";
import { defaultStat, getStage0Entries } from "./index.ts";
import { isInsideWorkTree, verifyPath } from "./path-safety.ts";
import { dirname, join } from "./path.ts";
import { hashWorktreeEntry, lstatSafe } from "./symlink.ts";
import { flattenTreeToMap } from "./tree-ops.ts";
import type { GitContext, Index, IndexEntry, ObjectId } from "./types.ts";
import { checkoutEntry, cleanEmptyDirs, walkWorkTree } from "./worktree.ts";

// =====================================================================
// SECTION 1: Error Types
// =====================================================================

/**
 * Mirrors git's `enum unpack_trees_error_types`.
 * Each error type maps to a different user-facing message.
 */
export enum UnpackError {
	/** Index entry doesn't match expected tree (reject_merge). */
	WOULD_OVERWRITE = "WOULD_OVERWRITE",

	/** Working tree file is dirty (verify_uptodate). */
	NOT_UPTODATE_FILE = "NOT_UPTODATE_FILE",

	/** Untracked file would be overwritten (verify_absent). */
	WOULD_LOSE_UNTRACKED_OVERWRITTEN = "WOULD_LOSE_UNTRACKED_OVERWRITTEN",

	/** Untracked file would be removed (verify_absent). */
	WOULD_LOSE_UNTRACKED_REMOVED = "WOULD_LOSE_UNTRACKED_REMOVED",
}

/** A single rejected path with its error type. */
export interface RejectedPath {
	path: string;
	error: UnpackError;
}

// =====================================================================
// SECTION 2: Per-Path State
// =====================================================================

/**
 * The full state of a single path across all relevant sources.
 *
 * For a one-way merge:  base=null, head=null, remote=target
 * For a two-way merge:  base=null, head=old, remote=new
 * For a three-way merge: base=merge-base, head=ours, remote=theirs
 */
interface PathState {
	path: string;

	/** Hash in the ancestor/base tree, or null if absent. */
	baseHash: ObjectId | null;

	/** Hash in the "ours" / "old" / "head" tree, or null if absent. */
	headHash: ObjectId | null;

	/** Hash in the "theirs" / "new" / "remote" tree, or null if absent. */
	remoteHash: ObjectId | null;

	/** Hash currently in the index (stage 0), or null if not in index. */
	indexHash: ObjectId | null;

	/** Stage of the current index entry (0 for normal, >0 for conflict). */
	indexStage: number;

	/** Whether a file exists on disk at this path. */
	existsOnDisk: boolean;

	/**
	 * Lazy ignore check — only evaluated when NO_UNTRACKED fires.
	 * Memoized: first call loads gitignore patterns, subsequent calls
	 * return cached result. Avoids a second full worktree walk.
	 */
	isIgnoredOnDisk: () => Promise<boolean>;

	/**
	 * Lazy worktree hash — call only when needed (escape hatches).
	 * Memoized: first call hashes, subsequent calls return cached result.
	 */
	getWorktreeHash: () => Promise<ObjectId | null>;

	/** Mode from the head tree (for entry creation). */
	headMode: string | null;

	/** Mode from the remote tree (for entry creation). */
	remoteMode: string | null;
}

/**
 * A file is "untracked" when it exists on disk but is NOT in the index.
 */
function isUntracked(state: PathState): boolean {
	return state.existsOnDisk && state.indexHash === null;
}

// =====================================================================
// SECTION 3: Merge Decision Types
// =====================================================================

/** What to do with a path after the merge function decides. */
enum MergeAction {
	/** Keep the current index entry as-is. No worktree change needed. */
	KEEP = "KEEP",

	/** Take the entry from a specific tree (head or remote). */
	TAKE = "TAKE",

	/** Delete the entry from the index and worktree. */
	DELETE = "DELETE",

	/** Path not involved — skip entirely. */
	SKIP = "SKIP",
}

/** The result of a merge decision function for a single path. */
interface MergeDecision {
	action: MergeAction;

	/** Which tree to take content from, when action is TAKE. */
	takeFrom?: "head" | "remote" | "base";

	/** Case number from the merge table (for debugging). */
	caseNumber?: number;

	/** Preconditions that must hold for this action to proceed. */
	requirements: PreconditionRequirement[];
}

/**
 * Precondition requirements derived from the case table.
 */
export enum PreconditionRequirement {
	/** Index must not have an entry for this path. */
	INDEX_MUST_NOT_EXIST = "INDEX_MUST_NOT_EXIST",

	/** If index entry exists, it must match the head tree. */
	INDEX_MUST_MATCH_HEAD = "INDEX_MUST_MATCH_HEAD",

	/** If index entry exists, it must match the result. */
	INDEX_MUST_MATCH_RESULT = "INDEX_MUST_MATCH_RESULT",

	/** Working tree file must match the index (not dirty). */
	WORKTREE_MUST_BE_UPTODATE = "WORKTREE_MUST_BE_UPTODATE",

	/** No untracked file may exist at this path (would be overwritten). */
	NO_UNTRACKED = "NO_UNTRACKED",

	/** No untracked file may exist at this path (would be removed). */
	NO_UNTRACKED_REMOVED = "NO_UNTRACKED_REMOVED",
}

// =====================================================================
// SECTION 4: Unpack Options
// =====================================================================

/**
 * Configuration for an unpack-trees operation (one-way and two-way merges).
 */
export interface UnpackOptions {
	/** Merge function to apply per path. */
	mergeFn: MergeFn;

	/** Whether to update the working tree. */
	updateWorktree: boolean;

	/** Whether to skip precondition checks (reset --hard, checkout -f). */
	reset: boolean;

	/** Exit code to use on precondition failure. */
	errorExitCode: number;

	/** Operation name for error messages ("checkout", "merge", etc.). */
	operationName: string;

	/** Override for "before you <action>" text (e.g. "switch branches"). Defaults to operationName. */
	actionHint?: string;

	/** Stop at the first precondition error (one-way merge behavior). Real git's tree walk exits early. */
	stopAtFirstError?: boolean;

	/**
	 * Paths stripped from conflict stages before one-way merge (mergeAbort).
	 * These skip NO_UNTRACKED checks — the files on disk are conflict
	 * artifacts, not truly untracked. Mirrors git's CE_REMOVE handling.
	 */
	strippedConflictPaths?: Set<string>;

	/**
	 * Skip INDEX_MUST_MATCH_HEAD precondition checks (cherry-pick -n).
	 * Allows the twoway merge to proceed when the index has staged changes.
	 * Safety is ensured by a separate oneway preflight check.
	 */
	allowStagedChanges?: boolean;
}

/** Configuration for precondition checks (two-way and three-way). */
interface PreconditionCheckOptions {
	errorExitCode: number;
	operationName: string;

	/** Override for "before you <action>" text. Defaults to operationName. */
	actionHint?: string;
}

/** Signature for merge decision functions (one-way and two-way). */
export type MergeFn = (state: PathState, opts: UnpackOptions) => MergeDecision;

// =====================================================================
// SECTION 5: Unpack Result
// =====================================================================

/** The full result of an unpack-trees operation. */
interface UnpackResult {
	/** Whether the operation succeeded. */
	success: boolean;

	/** New index entries (only valid if success=true). */
	newEntries: IndexEntry[];

	/** Worktree operations to perform (only valid if success=true). */
	worktreeOps: WorktreeOp[];

	/** Collected errors (only valid if success=false). */
	errors: RejectedPath[];

	/** Human-readable error output (only valid if success=false). */
	errorOutput: { stdout: string; stderr: string; exitCode: number } | null;
}

/** A worktree operation to perform after the index is updated. */
export interface WorktreeOp {
	path: string;
	type: "checkout" | "delete";
	/** Hash to checkout from object DB (for "checkout" ops). */
	hash?: ObjectId;
	mode?: number;
}

/**
 * Tree input for unpackTrees.
 *   One-way:   [target]
 *   Two-way:   [old/current, new/target]
 *   Three-way: [base, ours/head, theirs/remote]
 */
interface TreeInput {
	label: string;
	treeHash: ObjectId | null;
}

// =====================================================================
// SECTION 6: Path State Builder
// =====================================================================

/**
 * Build a PathState for every path in the union of all trees,
 * the current index, and the working tree.
 */
async function buildPathStates(
	ctx: GitContext,
	trees: TreeInput[],
	currentIndex: Index,
): Promise<PathState[]> {
	const treeMaps = await Promise.all(trees.map((t) => flattenTreeToMap(ctx, t.treeHash)));

	const stage0Map = new Map<string, IndexEntry>();
	const conflictPaths = new Set<string>();
	for (const entry of currentIndex.entries) {
		if (entry.stage === 0) {
			stage0Map.set(entry.path, entry);
		} else {
			conflictPaths.add(entry.path);
		}
	}

	// Single worktree walk (ignore check is deferred to lazy getter)
	const worktreeFiles = ctx.workTree
		? new Set(await walkWorkTree(ctx, ctx.workTree, "", { skipIgnore: true }))
		: new Set<string>();

	// Lazy-loaded visible file set — only materialized if an NO_UNTRACKED
	// precondition actually fires (rare: only for untracked files).
	let visibleFiles: Set<string> | null = null;
	const getVisibleFiles = async (): Promise<Set<string>> => {
		if (visibleFiles === null) {
			visibleFiles = ctx.workTree
				? new Set(await walkWorkTree(ctx, ctx.workTree, ""))
				: new Set<string>();
		}
		return visibleFiles;
	};

	// Collect paths, separating tree-present from index/worktree-only.
	// Git's unpack_trees processes tree entries during the tree walk,
	// then handles remaining index-only entries afterward. With
	// stopAtFirstError, an early tree-entry failure prevents index-only
	// entries from ever being checked. We replicate this by sorting
	// tree-present paths first.
	const treePaths = new Set<string>();
	for (const m of treeMaps) {
		for (const k of m.keys()) treePaths.add(k);
	}
	const nonTreePaths = new Set<string>();
	for (const entry of currentIndex.entries) {
		if (!treePaths.has(entry.path)) nonTreePaths.add(entry.path);
	}
	for (const f of worktreeFiles) {
		if (!treePaths.has(f)) nonTreePaths.add(f);
	}

	const sortedPaths = Array.from(treePaths).sort().concat(Array.from(nonTreePaths).sort());

	const getEntry = (i: number, p: string) => treeMaps[i]?.get(p);

	const states: PathState[] = [];
	for (const path of sortedPaths) {
		let baseHash: ObjectId | null = null;
		let headHash: ObjectId | null = null;
		let remoteHash: ObjectId | null = null;
		let headMode: string | null = null;
		let remoteMode: string | null = null;

		if (treeMaps.length === 1) {
			const r = getEntry(0, path);
			remoteHash = r?.hash ?? null;
			remoteMode = r?.mode ?? null;
		} else if (treeMaps.length === 2) {
			const h = getEntry(0, path);
			const r = getEntry(1, path);
			headHash = h?.hash ?? null;
			headMode = h?.mode ?? null;
			remoteHash = r?.hash ?? null;
			remoteMode = r?.mode ?? null;
		} else if (treeMaps.length >= 3) {
			const b = getEntry(0, path);
			const h = getEntry(1, path);
			const r = getEntry(2, path);
			baseHash = b?.hash ?? null;
			headHash = h?.hash ?? null;
			headMode = h?.mode ?? null;
			remoteHash = r?.hash ?? null;
			remoteMode = r?.mode ?? null;
		}

		const indexEntry = stage0Map.get(path);
		const indexHash = indexEntry?.hash ?? null;
		const indexStage = conflictPaths.has(path) ? 1 : 0;
		const existsOnDisk = worktreeFiles.has(path);

		// Memoized lazy ignore check — avoids second worktree walk
		let cachedIgnored: boolean | undefined;
		const isIgnoredOnDisk = async (): Promise<boolean> => {
			if (cachedIgnored !== undefined) return cachedIgnored;
			if (!existsOnDisk) {
				cachedIgnored = false;
				return false;
			}
			const visible = await getVisibleFiles();
			cachedIgnored = !visible.has(path);
			return cachedIgnored;
		};

		let cachedHash: ObjectId | null | undefined;
		const getWorktreeHash = async (): Promise<ObjectId | null> => {
			if (cachedHash !== undefined) return cachedHash;
			if (!existsOnDisk || !ctx.workTree) {
				cachedHash = null;
				return null;
			}
			const fullPath = join(ctx.workTree, path);
			try {
				cachedHash = await hashWorktreeEntry(ctx.fs, fullPath);
			} catch {
				cachedHash = null;
			}
			return cachedHash;
		};

		states.push({
			path,
			baseHash,
			headHash,
			remoteHash,
			indexHash,
			indexStage,
			existsOnDisk,
			isIgnoredOnDisk,
			getWorktreeHash,
			headMode,
			remoteMode,
		});
	}

	return states;
}

// =====================================================================
// SECTION 7: One-Way Merge
// =====================================================================

/**
 * One-way merge: replace the index with a target tree.
 * Used by: git reset --hard, git merge --abort
 *
 * Case table:
 *   index   tree    result
 *   -----------------------
 *   *       (empty) (empty)
 *   (empty) tree    tree
 *   index+  tree    tree
 *   index+  index   index+    ← keep stat info when content matches
 */
export function onewayMerge(state: PathState, opts: UnpackOptions): MergeDecision {
	const target = state.remoteHash;

	// Target absent
	if (target === null) {
		// Not in index (stage 0 or conflict stages) → skip (untracked files preserved)
		if (state.indexHash === null && state.indexStage === 0) {
			return { action: MergeAction.SKIP, requirements: [] };
		}
		// In index (or has conflict-stage entries) → delete
		return {
			action: MergeAction.DELETE,
			requirements: opts.reset ? [] : [PreconditionRequirement.WORKTREE_MUST_BE_UPTODATE],
		};
	}

	// Target present, index matches: keep (preserves stat info)
	if (state.indexHash === target) {
		return {
			action: MergeAction.KEEP,
			requirements: [],
		};
	}

	// Target present, index absent: take target.
	// In git's C code, !old → merged_entry(target, NULL), which calls
	// verify_absent to prevent overwriting untracked worktree files.
	// Skip the check for stripped conflict paths (conflict artifacts on
	// disk, not truly untracked) and for reset mode.
	if (state.indexHash === null) {
		const skipAbsentCheck = opts.reset || !!opts.strippedConflictPaths?.has(state.path);
		return {
			action: MergeAction.TAKE,
			takeFrom: "remote",
			requirements: skipAbsentCheck ? [] : [PreconditionRequirement.NO_UNTRACKED],
		};
	}

	// Target present, index differs: take target (check worktree is clean)
	return {
		action: MergeAction.TAKE,
		takeFrom: "remote",
		requirements: opts.reset ? [] : [PreconditionRequirement.WORKTREE_MUST_BE_UPTODATE],
	};
}

// =====================================================================
// SECTION 8: Two-Way Merge
// =====================================================================

/**
 * Two-way merge: transition from old tree to new tree, respecting the index.
 * Used by: git checkout <branch>, git merge (fast-forward)
 *
 * Case table from trivial-merge.adoc:
 *   case  index   old     new     result
 *   0/2   (empty) *       (empty) (empty)
 *   1/3   (empty) *       new     new
 *   4/5   index+  (empty) (empty) index+
 *   6/7   index+  (empty) index   index+
 *   10    index+  index   (empty) (empty)
 *   14/15 index+  old     old     index+
 *   18/19 index+  old     index   index+
 *   20    index+  index   new     new
 */
export function twowayMerge(state: PathState, opts: UnpackOptions): MergeDecision {
	const { headHash: old, remoteHash: nu, indexHash: idx } = state;

	// Handle conflicted index entry (stages > 0)
	if (state.indexStage > 0) {
		if (old === nu) {
			// Trees agree — resolve conflict
			if (nu === null) {
				return { action: MergeAction.DELETE, requirements: [] };
			}
			return {
				action: MergeAction.TAKE,
				takeFrom: "remote",
				requirements: [],
			};
		}
		// Trees disagree and index is conflicted — reject
		return {
			action: MergeAction.KEEP,
			requirements: [PreconditionRequirement.INDEX_MUST_MATCH_HEAD],
			caseNumber: -1,
		};
	}

	// No index entry
	if (idx === null) {
		if (nu === null) {
			if (old === null) {
				// Case 0: all absent → nothing to do
				return {
					action: MergeAction.SKIP,
					caseNumber: 0,
					requirements: [],
				};
			}
			// Case 2: old present, new absent, index absent
			// git calls deleted_entry → verify_absent (WOULD_LOSE_UNTRACKED_REMOVED)
			return {
				action: MergeAction.SKIP,
				caseNumber: 2,
				requirements: [PreconditionRequirement.NO_UNTRACKED_REMOVED],
			};
		}
		// New is present
		if (old !== null) {
			// Staged deletion: file was in old tree but removed from index.
			// git: if (oldtree && !o->initial_checkout) { ... }
			if (old === nu) {
				// Old == new: trees unchanged, preserve staged deletion
				return {
					action: MergeAction.SKIP,
					caseNumber: 3,
					requirements: [],
				};
			}
			// Old != new: staged deletion conflicts with incoming change.
			// With allowStagedChanges (cherry-pick -n): take the merge result
			// content — the oneway preflight already validated safety.
			if (opts.allowStagedChanges) {
				return {
					action: MergeAction.TAKE,
					takeFrom: "remote",
					caseNumber: 3,
					requirements: [],
				};
			}
			return {
				action: MergeAction.KEEP,
				caseNumber: 3,
				requirements: [PreconditionRequirement.INDEX_MUST_MATCH_HEAD],
			};
		}
		// Case 1: old absent, new present → take new
		return {
			action: MergeAction.TAKE,
			takeFrom: "remote",
			caseNumber: 1,
			requirements: [PreconditionRequirement.NO_UNTRACKED],
		};
	}

	// Index entry exists

	// Cases 4/5: old absent, new absent → keep index (staged addition)
	if (old === null && nu === null) {
		return { action: MergeAction.KEEP, caseNumber: 4, requirements: [] };
	}

	// Cases 6/7: old absent, new matches index → keep index
	if (old === null && nu === idx) {
		return { action: MergeAction.KEEP, caseNumber: 6, requirements: [] };
	}

	// Case 10: old matches index, new absent → delete
	if (old === idx && nu === null) {
		return {
			action: MergeAction.DELETE,
			caseNumber: 10,
			requirements: [PreconditionRequirement.WORKTREE_MUST_BE_UPTODATE],
		};
	}

	// Cases 14/15: old==new (trees unchanged) → keep index
	if (old !== null && old === nu) {
		return { action: MergeAction.KEEP, caseNumber: 14, requirements: [] };
	}

	// Cases 18/19: index already matches new → keep index
	if (old !== null && nu !== null && idx === nu) {
		return { action: MergeAction.KEEP, caseNumber: 18, requirements: [] };
	}

	// Case 20: index matches old, new differs → take new
	if (old !== null && nu !== null && idx === old && idx !== nu) {
		return {
			action: MergeAction.TAKE,
			takeFrom: "remote",
			caseNumber: 20,
			requirements: [PreconditionRequirement.WORKTREE_MUST_BE_UPTODATE],
		};
	}

	// Fallthrough: index doesn't match old AND doesn't match new → reject.
	// With allowStagedChanges (cherry-pick -n): take the merge result
	// content so the worktree reflects the merge outcome. The oneway
	// preflight already validated safety.
	if (opts.allowStagedChanges) {
		if (nu === null) {
			return {
				action: MergeAction.DELETE,
				caseNumber: -1,
				requirements: [],
			};
		}
		return {
			action: MergeAction.TAKE,
			takeFrom: "remote",
			caseNumber: -1,
			requirements: [],
		};
	}
	return {
		action: MergeAction.KEEP,
		requirements: [PreconditionRequirement.INDEX_MUST_MATCH_HEAD],
		caseNumber: -1,
	};
}

// =====================================================================
// SECTION 10: Precondition Verification
// =====================================================================

/**
 * Determine the hash of the merge result for a given decision.
 * Used by escape hatch evaluation.
 */
function resolveResultHash(decision: MergeDecision, state: PathState): ObjectId | null {
	switch (decision.action) {
		case MergeAction.TAKE:
			if (decision.takeFrom === "head") return state.headHash;
			if (decision.takeFrom === "remote") return state.remoteHash;
			if (decision.takeFrom === "base") return state.baseHash;
			return null;
		case MergeAction.DELETE:
			return null;
		case MergeAction.KEEP:
			return state.indexHash;
		default:
			return null;
	}
}

/**
 * Check all preconditions for one-way/two-way merge decisions.
 * Collects all failures.
 */
async function checkDecisionPreconditions(
	decisions: Map<string, MergeDecision>,
	pathStates: Map<string, PathState>,
	opts: UnpackOptions,
): Promise<RejectedPath[]> {
	const rejected: RejectedPath[] = [];

	if (opts.reset) return rejected; // Force mode — skip all checks

	for (const [path, decision] of decisions) {
		if (decision.requirements.length === 0) continue;

		const state = pathStates.get(path);
		if (!state) continue;
		const resultHash = resolveResultHash(decision, state);

		for (const req of decision.requirements) {
			if (opts.allowStagedChanges && req === PreconditionRequirement.INDEX_MUST_MATCH_HEAD)
				continue;
			const error = await checkSingleRequirement(req, state, resultHash);
			if (error) {
				rejected.push({ path, error });
				break; // One error per path
			}
		}

		// Real git's one-way merge exits the tree walk at the first error
		if (opts.stopAtFirstError && rejected.length > 0) break;
	}

	return rejected;
}

/**
 * Check a single precondition requirement for one path.
 * Returns the error type if the check fails, or null if it passes.
 *
 * This is where all content-aware escape hatches live.
 * Async because getWorktreeHash() is lazy/async.
 */
export async function checkSingleRequirement(
	req: PreconditionRequirement,
	state: PathState,
	resultHash: ObjectId | null,
	options?: { allowContentEscapeHatch?: boolean },
): Promise<UnpackError | null> {
	switch (req) {
		case PreconditionRequirement.INDEX_MUST_NOT_EXIST:
			// Index must not have an entry. Also no untracked file on disk.
			if (state.indexHash !== null) return UnpackError.WOULD_OVERWRITE;
			if (isUntracked(state)) return UnpackError.WOULD_LOSE_UNTRACKED_REMOVED;
			return null;

		case PreconditionRequirement.INDEX_MUST_MATCH_HEAD:
			// Index must match the head tree for this path.
			// No escape hatch: three-way case 14's "index matches B" escape
			// is handled at the classification level (empty requirements).
			// Two-way cases 18/19 (index matches new) are handled by
			// explicit branches returning KEEP with no requirements.
			if (state.indexHash !== state.headHash) {
				return UnpackError.WOULD_OVERWRITE;
			}
			return null;

		case PreconditionRequirement.INDEX_MUST_MATCH_RESULT:
			// If index exists, it must match the merge result.
			if (state.indexHash !== null && state.indexHash !== resultHash) {
				return UnpackError.WOULD_OVERWRITE;
			}
			return null;

		case PreconditionRequirement.WORKTREE_MUST_BE_UPTODATE: {
			// Working tree must match index (file is not dirty).
			// If file doesn't exist on disk, it's considered up-to-date.
			// Real git's verify_uptodate: lstat ENOENT → return 0.
			// An unstaged deletion has no content to lose.
			if (!state.existsOnDisk) return null;
			// Need the actual worktree hash — lazy fetch here
			const wtHash = await state.getWorktreeHash();
			if (wtHash !== state.indexHash) {
				if (options?.allowContentEscapeHatch) {
					// Escape hatch: worktree already matches the result
					if (resultHash !== null && wtHash === resultHash) return null;
					// Escape hatch: worktree deleted and result also deletes
					if (wtHash === null && resultHash === null) return null;
				}
				return UnpackError.NOT_UPTODATE_FILE;
			}
			return null;
		}

		case PreconditionRequirement.NO_UNTRACKED:
			// No untracked file at this path.
			// Ignored files are allowed to be overwritten by checkout-like paths
			// (matches git's default --overwrite-ignore behavior).
			if (isUntracked(state)) {
				if (await state.isIgnoredOnDisk()) return null;
				return UnpackError.WOULD_LOSE_UNTRACKED_OVERWRITTEN;
			}
			return null;

		case PreconditionRequirement.NO_UNTRACKED_REMOVED:
			// No untracked file at this path (path is being removed).
			// Same check as NO_UNTRACKED but with REMOVED error type.
			if (isUntracked(state)) {
				if (await state.isIgnoredOnDisk()) return null;
				return UnpackError.WOULD_LOSE_UNTRACKED_REMOVED;
			}
			return null;
	}
}

// =====================================================================
// SECTION 11: Result Builder
// =====================================================================

/**
 * Convert merge decisions into concrete IndexEntry[] and WorktreeOp[].
 */
function buildResult(
	decisions: Map<string, MergeDecision>,
	pathStates: Map<string, PathState>,
	currentIndex: Index,
	opts: UnpackOptions,
): { newEntries: IndexEntry[]; worktreeOps: WorktreeOp[] } {
	const newEntries: IndexEntry[] = [];
	const worktreeOps: WorktreeOp[] = [];
	const mergeScope = new Set(decisions.keys());

	const stage0Map = new Map<string, IndexEntry>();
	for (const entry of currentIndex.entries) {
		if (!mergeScope.has(entry.path)) {
			newEntries.push(entry);
		}
		if (entry.stage === 0) {
			stage0Map.set(entry.path, entry);
		}
	}

	for (const [path, decision] of decisions) {
		const state = pathStates.get(path);
		if (!state) continue;

		switch (decision.action) {
			case MergeAction.KEEP: {
				const existing = stage0Map.get(path);
				if (existing) {
					newEntries.push(existing);
					// In reset mode, force worktree to match even for KEEP entries.
					// This handles dirty worktrees (e.g., `git reset --hard` when
					// a file was edited but not staged — index matches target but
					// worktree doesn't).
					if (opts.reset && opts.updateWorktree) {
						worktreeOps.push({
							path,
							type: "checkout",
							hash: existing.hash,
							mode: existing.mode,
						});
					}
				}
				break;
			}

			case MergeAction.TAKE: {
				const hash = (decision.takeFrom === "head" ? state.headHash : state.remoteHash) as ObjectId;
				const mode = decision.takeFrom === "head" ? state.headMode : state.remoteMode;
				const numericMode = mode ? Number.parseInt(mode, 8) : 0o100644;

				newEntries.push({
					path,
					mode: numericMode,
					hash,
					stage: 0,
					stat: defaultStat(),
				});

				if (opts.updateWorktree) {
					worktreeOps.push({
						path,
						type: "checkout",
						hash,
						mode: numericMode,
					});
				}
				break;
			}

			case MergeAction.DELETE: {
				// Don't add to newEntries (removes from index)
				if (opts.updateWorktree && state.existsOnDisk) {
					worktreeOps.push({ path, type: "delete" });
				}
				break;
			}

			case MergeAction.SKIP:
				break;
		}
	}

	// Sort entries by path, then stage
	newEntries.sort((a, b) => comparePaths(a.path, b.path) || a.stage - b.stage);

	return { newEntries, worktreeOps };
}

// =====================================================================
// SECTION 12: Error Formatting
// =====================================================================

/**
 * Format collected errors into user-facing error output.
 *
 * Matches git's display_error_msgs() pattern:
 *   - Each UnpackError type gets its own block (git keeps separate rejection lists)
 *   - WOULD_OVERWRITE (staged changes) and NOT_UPTODATE_FILE (dirty worktree)
 *     both produce "Your local changes..." but as separate blocks
 *   - Paths sorted within each group
 *   - "Aborting" appended once at the end
 */
const ERROR_TEMPLATES: Array<{
	error: UnpackError;
	msg: (op: string) => string;
	fix: (action: string) => string;
}> = [
	{
		error: UnpackError.WOULD_OVERWRITE,
		msg: (op) => `error: Your local changes to the following files would be overwritten by ${op}:`,
		fix: (a) => `Please commit your changes or stash them before you ${a}.`,
	},
	{
		error: UnpackError.NOT_UPTODATE_FILE,
		msg: (op) => `error: Your local changes to the following files would be overwritten by ${op}:`,
		fix: (a) => `Please commit your changes or stash them before you ${a}.`,
	},
	{
		error: UnpackError.WOULD_LOSE_UNTRACKED_OVERWRITTEN,
		msg: (op) => `error: The following untracked working tree files would be overwritten by ${op}:`,
		fix: (a) => `Please move or remove them before you ${a}.`,
	},
	{
		error: UnpackError.WOULD_LOSE_UNTRACKED_REMOVED,
		msg: (op) => `error: The following untracked working tree files would be removed by ${op}:`,
		fix: (a) => `Please move or remove them before you ${a}.`,
	},
];

export function formatErrors(
	rejected: RejectedPath[],
	opts: UnpackOptions | PreconditionCheckOptions,
): { stdout: string; stderr: string; exitCode: number } {
	const action = opts.actionHint ?? opts.operationName;
	const blocks: string[] = [];

	for (const { error, msg, fix } of ERROR_TEMPLATES) {
		const paths = rejected
			.filter((r) => r.error === error)
			.map((r) => r.path)
			.sort();
		if (paths.length > 0) {
			const fileList = paths.map((f) => `\t${f}`).join("\n");
			blocks.push(`${msg(opts.operationName)}\n${fileList}\n${fix(action)}\n`);
		}
	}

	const stderr = blocks.length > 0 ? `${blocks.join("")}Aborting\n` : "";
	return { stdout: "", stderr, exitCode: opts.errorExitCode };
}

// =====================================================================
// SECTION 13: Main Entry Point — unpackTrees()
// =====================================================================

/**
 * Main entry point. Mirrors git's unpack_trees() function.
 *
 * Flow:
 *   1. Build PathState for every path in the union of all trees + index + worktree
 *   2. Call opts.mergeFn(state) for each path → MergeDecision
 *   3. Check preconditions for each decision → collect RejectedPaths
 *   4. If any errors: format and return failure
 *   5. If all clear: build new index entries + WorktreeOps, return success
 */
export async function unpackTrees(
	ctx: GitContext,
	trees: TreeInput[],
	currentIndex: Index,
	opts: UnpackOptions,
): Promise<UnpackResult> {
	// Step 1: Gather path states
	const pathStates = await buildPathStates(ctx, trees, currentIndex);
	const pathStateMap = new Map(pathStates.map((s) => [s.path, s]));

	// Step 2: Run merge function on each path
	const decisions = new Map<string, MergeDecision>();
	for (const state of pathStates) {
		const decision = opts.mergeFn(state, opts);
		decisions.set(state.path, decision);
	}

	// Step 3: Check preconditions
	const rejected = await checkDecisionPreconditions(decisions, pathStateMap, opts);

	// Step 4: If errors, format and return
	if (rejected.length > 0) {
		return {
			success: false,
			newEntries: [],
			worktreeOps: [],
			errors: rejected,
			errorOutput: formatErrors(rejected, opts),
		};
	}

	// Step 5: Build result
	const { newEntries, worktreeOps } = buildResult(decisions, pathStateMap, currentIndex, opts);

	return {
		success: true,
		newEntries,
		worktreeOps,
		errors: [],
		errorOutput: null,
	};
}

// =====================================================================
// SECTION 14: Worktree Op Executor
// =====================================================================

/**
 * Apply worktree operations produced by unpackTrees.
 *
 * Separated from unpackTrees so the caller can write the index first,
 * then update the worktree — matching git's two-phase approach.
 */
export async function applyWorktreeOps(ctx: GitContext, ops: WorktreeOp[]): Promise<void> {
	if (!ctx.workTree) return;

	const workTree = ctx.workTree;
	const deletedPaths: string[] = [];

	for (const op of ops) {
		if (!verifyPath(op.path)) {
			throw new Error(`refusing to apply worktree operation on unsafe path '${op.path}'`);
		}
		const fullPath = join(workTree, op.path);
		if (!isInsideWorkTree(workTree, fullPath)) {
			throw new Error(`refusing to apply worktree operation outside worktree: '${op.path}'`);
		}

		if (op.type === "delete") {
			const present = await lstatSafe(ctx.fs, fullPath)
				.then(() => true)
				.catch(() => false);
			if (present) {
				await ctx.fs.rm(fullPath);
				deletedPaths.push(fullPath);
			}
		} else if (op.type === "checkout" && op.hash) {
			await checkoutEntry(ctx, {
				path: op.path,
				hash: op.hash,
				mode: op.mode,
			});
		}
	}

	// Clean up empty parent directories left behind by deletions,
	// matching real git's behavior.
	for (const fullPath of deletedPaths) {
		await cleanEmptyDirs(ctx.fs, dirname(fullPath), workTree);
	}
}

// =====================================================================
// SECTION 15: Caller Convenience Functions
// =====================================================================

/**
 * Perform a checkout (branch switch) via two-way merge.
 *
 * Replaces: commands/checkout.ts → checkForConflicts + updateWorkTreeAndIndex
 */
export async function checkoutTrees(
	ctx: GitContext,
	currentTree: ObjectId | null,
	targetTree: ObjectId,
	currentIndex: Index,
): Promise<UnpackResult> {
	return unpackTrees(
		ctx,
		[
			{ label: "current", treeHash: currentTree },
			{ label: "target", treeHash: targetTree },
		],
		currentIndex,
		{
			mergeFn: twowayMerge,
			updateWorktree: true,
			reset: false,
			errorExitCode: 1,
			operationName: "checkout",
			actionHint: "switch branches",
		},
	);
}

/**
 * Perform a fast-forward merge via two-way merge.
 *
 * Replaces: commands/merge.ts → checkFastForwardOverwrites + FF worktree update
 */
export async function fastForwardMerge(
	ctx: GitContext,
	currentTree: ObjectId,
	targetTree: ObjectId,
	currentIndex: Index,
): Promise<UnpackResult> {
	return unpackTrees(
		ctx,
		[
			{ label: "HEAD", treeHash: currentTree },
			{ label: "target", treeHash: targetTree },
		],
		currentIndex,
		{
			mergeFn: twowayMerge,
			updateWorktree: true,
			reset: false,
			errorExitCode: 1,
			operationName: "merge",
		},
	);
}

/**
 * Perform a hard reset via one-way merge.
 *
 * Replaces: commands/reset.ts → hard reset worktree rebuild
 * All precondition checks are skipped (reset=true).
 */
export async function resetHard(
	ctx: GitContext,
	targetTree: ObjectId,
	currentIndex: Index,
): Promise<UnpackResult> {
	return unpackTrees(ctx, [{ label: "target", treeHash: targetTree }], currentIndex, {
		mergeFn: onewayMerge,
		updateWorktree: true,
		reset: true,
		errorExitCode: 128,
		operationName: "reset",
	});
}

/**
 * Perform a merge --abort via one-way merge with selective checks.
 *
 * Conflict-stage entries are stripped from the index before the merge,
 * matching git's read_index_unmerged() behavior. Real git marks these
 * as CE_REMOVE (keeping them in the index), so oneway_merge sees them
 * as "index present" and generates DELETE ops. We strip them entirely
 * and post-process to add DELETE ops for orphaned conflict paths.
 */
export async function mergeAbort(
	ctx: GitContext,
	origHeadTree: ObjectId,
	currentIndex: Index,
	targetRevName?: string,
): Promise<UnpackResult> {
	// Collect paths that have conflict-stage entries
	const conflictPaths = new Set<string>();
	for (const entry of currentIndex.entries) {
		if (entry.stage > 0) {
			conflictPaths.add(entry.path);
		}
	}

	// Strip conflict-stage entries before the one-way merge
	const cleanedIndex: Index = {
		version: currentIndex.version,
		entries: getStage0Entries(currentIndex),
	};

	const result = await unpackTrees(
		ctx,
		[{ label: "ORIG_HEAD", treeHash: origHeadTree }],
		cleanedIndex,
		{
			mergeFn: onewayMerge,
			updateWorktree: true,
			reset: false,
			errorExitCode: 128,
			operationName: "merge",
			stopAtFirstError: true,
			strippedConflictPaths: conflictPaths,
		},
	);

	if (!result.success) {
		const revName = targetRevName ?? "HEAD";
		const lines: string[] = [];
		for (const e of result.errors) {
			if (e.error === UnpackError.NOT_UPTODATE_FILE) {
				lines.push(`error: Entry '${e.path}' not uptodate. Cannot merge.\n`);
			} else if (e.error === UnpackError.WOULD_LOSE_UNTRACKED_OVERWRITTEN) {
				lines.push(
					`error: Untracked working tree file '${e.path}' would be overwritten by merge.\n`,
				);
			}
		}
		if (lines.length > 0) {
			result.errorOutput = err(
				lines.join("") + `fatal: Could not reset index file to revision '${revName}'.\n`,
				128,
			);
		}
		return result;
	}

	// Post-process: add DELETE ops for conflict paths not in ORIG_HEAD.
	// After stripping, these paths have no index entry and no target tree
	// entry, so onewayMerge returns SKIP (preserving untracked files).
	// But these files were created by the merge and should be cleaned up.
	if (ctx.workTree && conflictPaths.size > 0) {
		const origPaths = await flattenTreeToMap(ctx, origHeadTree);
		const newEntryPaths = new Set(result.newEntries.map((e) => e.path));

		for (const path of conflictPaths) {
			if (!origPaths.has(path) && !newEntryPaths.has(path)) {
				result.worktreeOps.push({ path, type: "delete" });
			}
		}
	}

	return result;
}

export { MergeAction };
export type { PathState };
