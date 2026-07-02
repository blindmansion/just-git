import { isBisectInProgress } from "./bisect.ts";
import { countAheadBehind } from "./commit-walk.ts";
import { getStage0Entries, hasConflicts, readIndex } from "./index.ts";
import { readCommit } from "./object-db.ts";
import { readDetachPoint, readStateFile } from "./operation-state.ts";
import { join as joinPath, comparePaths } from "./path.ts";
import { isRebaseInProgress, readRebaseState } from "./rebase.ts";
import { readHead, resolveHead, resolveRef } from "./refs/refs.ts";
import { detectRenames } from "./diff/rename-detection.ts";
import { flattenTreeToMap } from "./tree-ops.ts";
import type { GitContext, GitRepo, Index, ObjectId, TreeDiffEntry } from "./types.ts";
import { diffIndexToWorkTree } from "./worktree/worktree.ts";
import { uniqueAbbrev } from "./abbrev.ts";
import { branchNameFromRef } from "./refs/name.ts";
import { readConfig } from "./config/store.ts";
import type { GitConfig } from "./config/parse.ts";

export interface StatusEntry {
	/** Path used for sorting (new path for renames). */
	path: string;
	status: string;
	/** If set, displayed instead of path (used for renames: "old -> new"). */
	displayPath?: string;
}

/** One rebase todo/done entry, with its hash already abbreviated for display. */
export interface RebaseTodoView {
	shortHash: string;
	subject: string;
	empty?: boolean;
}

/** Pre-resolved rebase progress used to render the long-status rebase section. */
export interface RebaseStatusView {
	/** Abbreviated `onto` commit. */
	ontoShort: string;
	/** Original branch name, or null when rebasing a detached HEAD. */
	origBranch: string | null;
	/** Total commands already applied. */
	doneCount: number;
	/** Last (up to 2) applied commands, for the "Last commands done" block. */
	doneTail: RebaseTodoView[];
	/** Total commands still to apply. */
	todoCount: number;
	/** First (up to 2) pending commands, for the "Next commands to do" block. */
	todoHead: RebaseTodoView[];
	/** Whether a MERGE_MSG file exists (distinguishes conflict-fixed states). */
	hasMergeMsg: boolean;
}

/**
 * Everything the long-form `git status` renderer needs, fully resolved.
 * All async reads (refs, config, rebase state, abbreviations, …) happen while
 * gathering this struct so the renderer (`format/status#renderLongStatus`)
 * stays pure and synchronous.
 */
export interface LongStatusData {
	headHash: ObjectId | null;
	isDetached: boolean;
	branchName: string;
	/** Whether the index has any stage>0 (conflicted) entries. */
	indexHasConflicts: boolean;
	staged: StatusEntry[];
	unstaged: StatusEntry[];
	unmerged: StatusEntry[];
	collapsedUntracked: string[];
	/** Rebase progress, or null when no rebase is in progress. */
	rebase: RebaseStatusView | null;
	/** Abbreviated CHERRY_PICK_HEAD, or null when not cherry-picking. */
	cherryPickShort: string | null;
	/** Abbreviated REVERT_HEAD, or null when not reverting. */
	revertShort: string | null;
	hasMergeHead: boolean;
	/** Abbreviated detach point, or null when not detached / unknown. */
	detachPointShort: string | null;
	/** True when HEAD is exactly at the detach point ("at" vs "from"). */
	detachedAt: boolean;
	tracking: TrackingInfo | null;
	/** Branch bisecting started from, or null when not bisecting. */
	bisectStartRef: string | null;
	/** Use "Initial commit"/"Initial commit" wording (commit path) over "No commits yet". */
	fromCommit: boolean;
	/** Suppress the trailing footer; the caller appends its own. */
	noWarn: boolean;
	/** Repo has no commit to compare against (initial-commit state). */
	isInitial: boolean;
}

async function abbrevTodoEntries(
	gitCtx: GitRepo,
	entries: { hash: string; subject: string; empty?: boolean }[],
): Promise<RebaseTodoView[]> {
	return Promise.all(
		entries.map(async (e) => ({
			shortHash: await uniqueAbbrev(gitCtx, e.hash),
			subject: e.subject,
			empty: e.empty,
		})),
	);
}

/**
 * Gather all data needed to render the full long-form `git status` output.
 * Used by the status command handler and also by commit/cherry-pick failure
 * paths (via `cli/status#generateLongFormStatus`), which output `git status`
 * to stdout on failure.
 *
 * @param opts.fromCommit - When true, uses "Initial commit" instead of
 *   "No commits yet" for repos with no commits, matching real git's
 *   behavior when status is printed from the commit command path.
 * @param opts.compareHash - Override the hash used to compute staged
 *   changes. Defaults to HEAD. For `git commit --amend`, pass HEAD^'s
 *   hash so staged changes are shown relative to the grandparent.
 * @param opts.noWarn - When true, suppresses the footer ("nothing to
 *   commit...", etc.). Matches real git's `nowarn` flag. The caller
 *   can then append its own footer (e.g., "No changes" for amend).
 * @param opts.index - Pre-loaded index to use instead of reading from
 *   disk. Used by `commit -a` to show status after auto-staging.
 */
export async function gatherLongStatus(
	gitCtx: GitContext,
	opts?: {
		fromCommit?: boolean;
		compareHash?: ObjectId | null;
		noWarn?: boolean;
		index?: Index;
	},
): Promise<LongStatusData> {
	const head = await readHead(gitCtx);
	const headHash = await resolveHead(gitCtx);
	let branchName: string;
	let isDetached = false;
	if (head && head.type === "symbolic") {
		branchName = branchNameFromRef(head.target);
	} else {
		isDetached = true;
		branchName = "HEAD detached";
	}
	const index = opts?.index ?? (await readIndex(gitCtx));
	const unmerged = getUnmergedPaths(index);
	const stagedRef = opts?.compareHash !== undefined ? opts.compareHash : headHash;
	const isInitial = opts?.compareHash !== undefined ? !opts.compareHash : !headHash;
	const staged = await getStagedChanges(gitCtx, stagedRef, index, unmerged);
	const workTreeDiffs = await diffIndexToWorkTree(gitCtx, index);
	const unstaged: StatusEntry[] = [];
	const untracked: string[] = [];
	for (const diff of workTreeDiffs) {
		if (diff.status === "untracked") {
			untracked.push(diff.path);
		} else {
			unstaged.push({ path: diff.path, status: diff.status });
		}
	}
	unstaged.sort((a, b) => comparePaths(a.path, b.path));
	const trackedPaths = new Set(index.entries.map((e) => e.path));
	const collapsedUntracked = collapseUntrackedDirs(untracked, trackedPaths);

	// ── operation state ──
	const cherryPickHeadRef = await resolveRef(gitCtx, "CHERRY_PICK_HEAD");
	const revertHeadRef = await resolveRef(gitCtx, "REVERT_HEAD");
	const mergeHeadRef = await resolveRef(gitCtx, "MERGE_HEAD");

	const rebaseInProgress = await isRebaseInProgress(gitCtx);
	const rebaseRaw = rebaseInProgress ? await readRebaseState(gitCtx) : null;

	let rebase: RebaseStatusView | null = null;
	if (rebaseRaw) {
		const isDetachedRebase = rebaseRaw.headName === "detached HEAD";
		rebase = {
			ontoShort: await uniqueAbbrev(gitCtx, rebaseRaw.onto),
			origBranch: isDetachedRebase ? null : branchNameFromRef(rebaseRaw.headName),
			doneCount: rebaseRaw.done.length,
			doneTail: await abbrevTodoEntries(gitCtx, rebaseRaw.done.slice(-2)),
			todoCount: rebaseRaw.todo.length,
			todoHead: await abbrevTodoEntries(gitCtx, rebaseRaw.todo.slice(0, 2)),
			hasMergeMsg: await gitCtx.fs.exists(joinPath(gitCtx.gitDir, "MERGE_MSG")),
		};
	}

	// Tracking info (only for non-detached, non-rebase, non-initial states).
	let tracking: TrackingInfo | null = null;
	if (!isDetached && !rebaseRaw && !isInitial) {
		const config = await readConfig(gitCtx);
		tracking = await getTrackingInfo(gitCtx, config, branchName);
	}

	let detachPointShort: string | null = null;
	let detachedAt = false;
	if (isDetached && !rebaseRaw) {
		const detachPoint = await readDetachPoint(gitCtx);
		if (detachPoint) {
			detachPointShort = await uniqueAbbrev(gitCtx, detachPoint);
			detachedAt = headHash === detachPoint;
		}
	}

	let bisectStartRef: string | null = null;
	if (await isBisectInProgress(gitCtx)) {
		const bisectStart = await readStateFile(gitCtx, "BISECT_START");
		bisectStartRef = bisectStart?.trim() ?? "";
	}

	return {
		headHash,
		isDetached,
		branchName,
		indexHasConflicts: hasConflicts(index),
		staged,
		unstaged,
		unmerged,
		collapsedUntracked,
		rebase,
		cherryPickShort: cherryPickHeadRef ? await uniqueAbbrev(gitCtx, cherryPickHeadRef) : null,
		revertShort: revertHeadRef ? await uniqueAbbrev(gitCtx, revertHeadRef) : null,
		hasMergeHead: !!mergeHeadRef,
		detachPointShort,
		detachedAt,
		tracking,
		bisectStartRef,
		fromCommit: opts?.fromCommit ?? false,
		noWarn: opts?.noWarn ?? false,
		isInitial,
	};
}

// ── Shared helpers ──────────────────────────────────────────────────

/**
 * Compare HEAD tree against the index to find staged changes.
 * Includes rename detection — collapses add+delete pairs into "renamed" entries.
 */
export async function getStagedChanges(
	ctx: GitRepo,
	headHash: ObjectId | null,
	index: Index,
	unmergedEntries?: StatusEntry[],
): Promise<StatusEntry[]> {
	const unmergedPaths = new Set(unmergedEntries?.map((e) => e.path));
	let headTreeHash: ObjectId | null = null;
	if (headHash) {
		const headCommit = await readCommit(ctx, headHash);
		headTreeHash = headCommit.tree;
	}

	const headMap = await flattenTreeToMap(ctx, headTreeHash);
	const indexMap = new Map(getStage0Entries(index).map((e) => [e.path, e]));

	const rawDiffs: TreeDiffEntry[] = [];

	for (const [path, entry] of indexMap) {
		if (unmergedPaths.has(path)) continue;
		const headEntry = headMap.get(path);
		if (!headEntry) {
			rawDiffs.push({
				path,
				status: "added",
				newHash: entry.hash,
				newMode: entry.mode.toString(8).padStart(6, "0"),
			});
		} else if (headEntry.hash !== entry.hash) {
			rawDiffs.push({
				path,
				status: "modified",
				oldHash: headEntry.hash,
				newHash: entry.hash,
				oldMode: headEntry.mode,
				newMode: entry.mode.toString(8).padStart(6, "0"),
			});
		}
	}

	for (const [path, headEntry] of headMap) {
		if (unmergedPaths.has(path)) continue;
		if (!indexMap.has(path)) {
			rawDiffs.push({
				path,
				status: "deleted",
				oldHash: headEntry.hash,
				oldMode: headEntry.mode,
			});
		}
	}

	const { remaining, renames } = await detectRenames(ctx, rawDiffs);

	const stagedStatusMap: Record<string, string> = {
		added: "new file",
		deleted: "deleted",
		modified: "modified",
	};
	const staged: StatusEntry[] = [];

	for (const diff of remaining) {
		const s = stagedStatusMap[diff.status];
		if (s) staged.push({ path: diff.path, status: s });
	}

	for (const rename of renames) {
		staged.push({
			path: rename.newPath,
			status: "renamed",
			displayPath: `${rename.oldPath} -> ${rename.newPath}`,
		});
	}

	return staged.sort((a, b) => comparePaths(a.path, b.path));
}

/**
 * Detect unmerged (conflicted) paths from index entries with stage > 0.
 * Groups by path and determines the conflict type from which stages are present.
 */
export function getUnmergedPaths(index: Index): StatusEntry[] {
	const conflictStages = new Map<string, Set<number>>();

	for (const entry of index.entries) {
		if (entry.stage > 0) {
			let stages = conflictStages.get(entry.path);
			if (!stages) {
				stages = new Set();
				conflictStages.set(entry.path, stages);
			}
			stages.add(entry.stage);
		}
	}

	const results: StatusEntry[] = [];
	for (const [path, stages] of conflictStages) {
		let status: string;
		const hasBase = stages.has(1);
		const hasOurs = stages.has(2);
		const hasTheirs = stages.has(3);

		if (hasOurs && hasTheirs) {
			status = hasBase ? "both modified" : "both added";
		} else if (hasBase && !hasOurs && !hasTheirs) {
			status = "both deleted";
		} else if (hasBase && hasTheirs) {
			status = "deleted by us";
		} else if (hasBase && hasOurs) {
			status = "deleted by them";
		} else if (hasOurs && !hasBase && !hasTheirs) {
			status = "added by us";
		} else if (hasTheirs && !hasBase && !hasOurs) {
			status = "added by them";
		} else {
			status = "unmerged";
		}

		results.push({ path, status });
	}

	return results.sort((a, b) => comparePaths(a.path, b.path));
}

/**
 * Collapse untracked file paths into directory entries where possible.
 * Real git shows "dir/" when no tracked files exist under that directory.
 * For nested dirs (e.g. src/util/file.ts), it finds the shallowest
 * directory that has no tracked files and collapses to that level.
 */
export function collapseUntrackedDirs(
	untrackedFiles: string[],
	trackedPaths: Set<string>,
): string[] {
	if (untrackedFiles.length === 0) return [];

	const trackedDirPrefixes = new Set<string>();
	for (const p of trackedPaths) {
		let idx = p.indexOf("/");
		while (idx !== -1) {
			trackedDirPrefixes.add(p.slice(0, idx + 1));
			idx = p.indexOf("/", idx + 1);
		}
	}

	const result = new Set<string>();
	for (const filePath of untrackedFiles) {
		const parts = filePath.split("/");
		if (parts.length === 1) {
			result.add(filePath);
			continue;
		}

		let collapsed = false;
		for (let i = 1; i < parts.length; i++) {
			const dirPrefix = `${parts.slice(0, i).join("/")}/`;
			if (!trackedDirPrefixes.has(dirPrefix)) {
				result.add(dirPrefix);
				collapsed = true;
				break;
			}
		}
		if (!collapsed) {
			result.add(filePath);
		}
	}

	return [...result].sort();
}

// ── Tracking info ───────────────────────────────────────────────────

export interface TrackingInfo {
	upstream: string;
	ahead: number;
	behind: number;
	gone: boolean;
}

/**
 * Resolve tracking info for a local branch from git config.
 * Reads `branch.<name>.remote` and `branch.<name>.merge` to find
 * the upstream ref and compute ahead/behind counts.
 */
export async function getTrackingInfo(
	ctx: GitRepo,
	config: GitConfig,
	branchName: string,
): Promise<TrackingInfo | null> {
	const section = config[`branch "${branchName}"`];
	if (!section?.remote || !section?.merge) return null;

	const remote = section.remote;
	const merge = section.merge;
	const trackingRef = merge.replace(/^refs\/heads\//, `refs/remotes/${remote}/`);
	const displayName = `${remote}/${merge.replace(/^refs\/heads\//, "")}`;

	const upstreamHash = await resolveRef(ctx, trackingRef);
	if (!upstreamHash) {
		return { upstream: displayName, ahead: 0, behind: 0, gone: true };
	}

	const branchHash = await resolveRef(ctx, `refs/heads/${branchName}`);
	if (!branchHash) return null;

	if (branchHash === upstreamHash) {
		return { upstream: displayName, ahead: 0, behind: 0, gone: false };
	}

	const { ahead, behind } = await countAheadBehind(ctx, branchHash, upstreamHash);
	return { upstream: displayName, ahead, behind, gone: false };
}
