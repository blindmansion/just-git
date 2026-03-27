import { abbreviateHash, comparePaths } from "./command-utils.ts";
import { isBisectInProgress } from "./bisect.ts";
import { countAheadBehind } from "./commit-walk.ts";
import { type GitConfig, readConfig } from "./config.ts";
import { getStage0Entries, hasConflicts, readIndex } from "./index.ts";
import { readCommit } from "./object-db.ts";
import { readDetachPoint, readStateFile } from "./operation-state.ts";
import { join as joinPath } from "./path.ts";
import { isRebaseInProgress, readRebaseState } from "./rebase.ts";
import { branchNameFromRef, readHead, resolveHead, resolveRef } from "./refs.ts";
import { detectRenames } from "./rename-detection.ts";
import { flattenTreeToMap } from "./tree-ops.ts";
import type { GitContext, GitRepo, Index, ObjectId, TreeDiffEntry } from "./types.ts";
import { diffIndexToWorkTree } from "./worktree.ts";

export interface StatusEntry {
	/** Path used for sorting (new path for renames). */
	path: string;
	status: string;
	/** If set, displayed instead of path (used for renames: "old -> new"). */
	displayPath?: string;
}

/**
 * Generate the full long-form `git status` output.
 * Used by the status command handler and also by commit/cherry-pick
 * failure paths, which output `git status` to stdout on failure.
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
export async function generateLongFormStatus(
	gitCtx: GitContext,
	opts?: {
		fromCommit?: boolean;
		compareHash?: ObjectId | null;
		noWarn?: boolean;
		index?: Index;
	},
): Promise<string> {
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

	return formatLongStatus(
		gitCtx,
		headHash,
		isDetached,
		branchName,
		index,
		staged,
		unstaged,
		unmerged,
		collapsedUntracked,
		{ fromCommit: opts?.fromCommit, noWarn: opts?.noWarn, isInitial },
	);
}

// ── Long-form formatting ────────────────────────────────────────────

function pushRebaseTodoLines(
	lines: string[],
	rebaseState: {
		done: { hash: string; subject: string }[];
		todo: { hash: string; subject: string }[];
	},
): void {
	if (rebaseState.done.length > 0) {
		const n = rebaseState.done.length;
		lines.push(`Last command${n === 1 ? "" : "s"} done (${n} command${n === 1 ? "" : "s"} done):`);
		for (const e of rebaseState.done.slice(-2)) {
			lines.push(`   pick ${abbreviateHash(e.hash)} # ${e.subject}`);
		}
		if (n > 2) {
			lines.push("  (see more in file .git/rebase-merge/done)");
		}
	}
	if (rebaseState.todo.length > 0) {
		const n = rebaseState.todo.length;
		lines.push(
			`Next command${n === 1 ? "" : "s"} to do (${n} remaining command${n === 1 ? "" : "s"}):`,
		);
		for (const e of rebaseState.todo.slice(0, 2)) {
			lines.push(`   pick ${abbreviateHash(e.hash)} # ${e.subject}`);
		}
		lines.push('  (use "git rebase --edit-todo" to view and edit)');
	} else {
		lines.push("No commands remaining.");
	}
}

async function formatLongStatus(
	gitCtx: GitContext,
	headHash: ObjectId | null,
	isDetached: boolean,
	branchName: string,
	index: Index,
	staged: StatusEntry[],
	unstaged: StatusEntry[],
	unmerged: StatusEntry[],
	collapsedUntracked: string[],
	opts?: { fromCommit?: boolean; noWarn?: boolean; isInitial?: boolean },
): Promise<string> {
	const lines: string[] = [];

	let hasIntermediateState = false;
	const cherryPickHeadRef = await resolveRef(gitCtx, "CHERRY_PICK_HEAD");
	const revertHeadRef = await resolveRef(gitCtx, "REVERT_HEAD");
	const mergeHeadRef = await resolveRef(gitCtx, "MERGE_HEAD");
	const whenceIsCommit = !cherryPickHeadRef && !mergeHeadRef;

	const rebaseInProgress = await isRebaseInProgress(gitCtx);
	const rebaseState = rebaseInProgress ? await readRebaseState(gitCtx) : null;

	// Branch header line
	if (isDetached && rebaseState) {
		const ontoShort = abbreviateHash(rebaseState.onto);
		lines.push(`interactive rebase in progress; onto ${ontoShort}`);
	} else if (isDetached) {
		const detachPoint = await readDetachPoint(gitCtx);
		if (detachPoint) {
			const atOrFrom = headHash === detachPoint ? "at" : "from";
			lines.push(`HEAD detached ${atOrFrom} ${abbreviateHash(detachPoint)}`);
		} else {
			lines.push("Not currently on any branch.");
		}
	} else {
		lines.push(`On branch ${branchName}`);
	}

	const showInitial = opts?.isInitial ?? !headHash;

	// Tracking info (only for non-detached, non-rebase, non-initial states)
	if (!isDetached && !rebaseState && !showInitial) {
		const config = await readConfig(gitCtx);
		const tracking = await getTrackingInfo(gitCtx, config, branchName);
		if (tracking) {
			const trackingText = formatLongTrackingInfo(tracking, {
				abbreviated: opts?.fromCommit,
			});
			for (const tl of trackingText.trimEnd().split("\n")) {
				lines.push(tl);
			}
			hasIntermediateState = true;
		}
	}

	// In-progress operation indicators
	// Real git prints a blank line between tracking info and operation-state
	// sections (e.g. during cherry-pick/rebase) in long status output.
	if (hasIntermediateState && (rebaseState || cherryPickHeadRef || revertHeadRef || mergeHeadRef)) {
		lines.push("");
	}
	if (rebaseState && mergeHeadRef) {
		pushRebaseTodoLines(lines, rebaseState);
		lines.push("");
		if (unmerged.length > 0) {
			lines.push("You have unmerged paths.");
			lines.push('  (fix conflicts and run "git commit")');
			lines.push('  (use "git merge --abort" to abort the merge)');
		} else {
			lines.push("All conflicts fixed but you are still merging.");
			lines.push('  (use "git commit" to conclude merge)');
		}
		hasIntermediateState = true;
	} else if (rebaseState) {
		const hasUnmerged = hasConflicts(index);
		const hasMergeMsg = await gitCtx.fs.exists(joinPath(gitCtx.gitDir, "MERGE_MSG"));

		pushRebaseTodoLines(lines, rebaseState);

		const isDetachedRebase = rebaseState.headName === "detached HEAD";
		const origBranch = isDetachedRebase ? null : branchNameFromRef(rebaseState.headName);
		const ontoShort = abbreviateHash(rebaseState.onto);
		const branchSuffix = origBranch ? ` branch '${origBranch}' on '${ontoShort}'` : "";

		if (hasUnmerged) {
			lines.push(`You are currently rebasing${branchSuffix}.`);
			lines.push('  (fix conflicts and then run "git rebase --continue")');
			lines.push('  (use "git rebase --skip" to skip this patch)');
			lines.push('  (use "git rebase --abort" to check out the original branch)');
		} else if (hasMergeMsg) {
			lines.push(`You are currently rebasing${branchSuffix}.`);
			lines.push('  (all conflicts fixed: run "git rebase --continue")');
		} else {
			const editMsg = branchSuffix
				? `You are currently editing a commit while rebasing${branchSuffix}.`
				: "You are currently editing a commit during a rebase.";
			lines.push(editMsg);
			lines.push('  (use "git commit --amend" to amend the current commit)');
			lines.push('  (use "git rebase --continue" once you are satisfied with your changes)');
		}

		hasIntermediateState = true;
	} else {
		if (cherryPickHeadRef) {
			lines.push(`You are currently cherry-picking commit ${abbreviateHash(cherryPickHeadRef)}.`);
			if (unmerged.length > 0) {
				lines.push('  (fix conflicts and run "git cherry-pick --continue")');
			} else {
				lines.push('  (all conflicts fixed: run "git cherry-pick --continue")');
			}
			lines.push('  (use "git cherry-pick --skip" to skip this patch)');
			lines.push('  (use "git cherry-pick --abort" to cancel the cherry-pick operation)');
			hasIntermediateState = true;
		} else if (revertHeadRef) {
			lines.push(`You are currently reverting commit ${abbreviateHash(revertHeadRef)}.`);
			if (unmerged.length > 0) {
				lines.push('  (fix conflicts and run "git revert --continue")');
			} else {
				lines.push('  (all conflicts fixed: run "git revert --continue")');
			}
			lines.push('  (use "git revert --skip" to skip this patch)');
			lines.push('  (use "git revert --abort" to cancel the revert operation)');
			hasIntermediateState = true;
		} else if (mergeHeadRef) {
			if (unmerged.length > 0) {
				lines.push("You have unmerged paths.");
				lines.push('  (fix conflicts and run "git commit")');
				lines.push('  (use "git merge --abort" to abort the merge)');
			} else {
				lines.push("All conflicts fixed but you are still merging.");
				lines.push('  (use "git commit" to conclude merge)');
			}
			hasIntermediateState = true;
		}
	}

	if (await isBisectInProgress(gitCtx)) {
		const bisectStart = await readStateFile(gitCtx, "BISECT_START");
		const ref = bisectStart?.trim() ?? "";
		lines.push(`You are currently bisecting, started from branch '${ref}'.`);
		lines.push('  (use "git bisect reset" to get back to the original branch)');
		hasIntermediateState = true;
	}

	if (showInitial) {
		lines.push("");
		lines.push(opts?.fromCommit ? "Initial commit" : "No commits yet");
		hasIntermediateState = true;
	}

	let unstageHint: string | null = null;
	if (whenceIsCommit) {
		unstageHint = headHash
			? '  (use "git restore --staged <file>..." to unstage)'
			: '  (use "git rm --cached <file>..." to unstage)';
	}

	const hasUnstagedDeletions = unstaged.some((e) => e.status === "deleted");
	const addHint = hasUnstagedDeletions
		? '  (use "git add/rm <file>..." to update what will be committed)'
		: '  (use "git add <file>..." to update what will be committed)';

	let hasSections = false;

	if (staged.length > 0) {
		if (hasIntermediateState) lines.push("");
		lines.push("Changes to be committed:");
		if (unstageHint) lines.push(unstageHint);
		for (const entry of staged) {
			lines.push(`\t${formatStatusEntry(entry.status, entry.path, entry.displayPath)}`);
		}
		lines.push("");
		hasSections = true;
	}

	if (unmerged.length > 0) {
		if (!hasSections && hasIntermediateState) lines.push("");
		lines.push("Unmerged paths:");
		if (whenceIsCommit) {
			if (headHash) {
				lines.push('  (use "git restore --staged <file>..." to unstage)');
			} else {
				lines.push('  (use "git rm --cached <file>..." to unstage)');
			}
		}
		const hasDeleteConflicts = unmerged.some(
			(e) =>
				e.status === "deleted by us" ||
				e.status === "deleted by them" ||
				e.status === "both deleted",
		);
		if (hasDeleteConflicts) {
			lines.push('  (use "git add/rm <file>..." as appropriate to mark resolution)');
		} else {
			lines.push('  (use "git add <file>..." to mark resolution)');
		}
		for (const entry of unmerged) {
			lines.push(`\t${formatMergeStatusEntry(entry.status, entry.path)}`);
		}
		lines.push("");
		hasSections = true;
	}

	if (unstaged.length > 0) {
		if (!hasSections && hasIntermediateState) lines.push("");
		lines.push("Changes not staged for commit:");
		lines.push(addHint);
		lines.push('  (use "git restore <file>..." to discard changes in working directory)');
		for (const entry of unstaged) {
			lines.push(`\t${formatStatusEntry(entry.status, entry.path)}`);
		}
		lines.push("");
		hasSections = true;
	}

	if (collapsedUntracked.length > 0) {
		if (!hasSections && hasIntermediateState) lines.push("");
		lines.push("Untracked files:");
		lines.push('  (use "git add <file>..." to include in what will be committed)');
		for (const path of collapsedUntracked) {
			lines.push(`\t${path}`);
		}
		lines.push("");
		hasSections = true;
	}

	const commitable = staged.length > 0 || (!!mergeHeadRef && unmerged.length === 0);
	if (!hasSections && hasIntermediateState && (opts?.noWarn || commitable)) {
		lines.push("");
	}
	if (!commitable && !opts?.noWarn) {
		if (
			!hasSections &&
			hasIntermediateState &&
			unstaged.length === 0 &&
			unmerged.length === 0 &&
			collapsedUntracked.length === 0
		) {
			lines.push("");
		}
		if (unstaged.length > 0 || unmerged.length > 0) {
			lines.push('no changes added to commit (use "git add" and/or "git commit -a")');
		} else if (collapsedUntracked.length > 0) {
			lines.push('nothing added to commit but untracked files present (use "git add" to track)');
		} else if (showInitial) {
			lines.push('nothing to commit (create/copy files and use "git add" to track)');
		} else {
			lines.push("nothing to commit, working tree clean");
		}
	}

	return `${lines.join("\n")}\n`;
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

function formatStatusEntry(status: string, path: string, displayPath?: string): string {
	const label = `${status}:`;
	return label.padEnd(12) + (displayPath ?? path);
}

function formatMergeStatusEntry(status: string, path: string): string {
	const label = `${status}:`;
	return label.padEnd(17) + path;
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

/**
 * Format tracking info for `git branch -v`/`-vv` display.
 * Returns bracketed format like `[origin/main: ahead 2, behind 1]`.
 */
export function formatBranchTrackingInfo(info: TrackingInfo, showUpstream: boolean): string {
	if (showUpstream) {
		if (info.gone) return `[${info.upstream}: gone]`;
		if (info.ahead === 0 && info.behind === 0) return `[${info.upstream}]`;
		const parts: string[] = [];
		if (info.ahead > 0) parts.push(`ahead ${info.ahead}`);
		if (info.behind > 0) parts.push(`behind ${info.behind}`);
		return `[${info.upstream}: ${parts.join(", ")}]`;
	}
	if (info.gone) return `[gone]`;
	if (info.ahead === 0 && info.behind === 0) return "";
	const parts: string[] = [];
	if (info.ahead > 0) parts.push(`ahead ${info.ahead}`);
	if (info.behind > 0) parts.push(`behind ${info.behind}`);
	return `[${parts.join(", ")}]`;
}

/**
 * Format tracking info for `git status` / `git checkout` long-form display.
 * Returns multi-line output like:
 *   "Your branch is up to date with 'origin/main'.\n"
 *   "Your branch is ahead of 'origin/main' by 3 commits.\n  (use ...)\n"
 *
 * @param opts.abbreviated - When true, omits the hint for the diverged
 *   case. Real git uses abbreviated tracking in `cmd_commit` (nothing to
 *   commit path) which suppresses the diverged hint but keeps ahead/behind.
 */
export function formatLongTrackingInfo(
	info: TrackingInfo,
	opts?: { abbreviated?: boolean },
): string {
	if (info.gone) {
		return `Your branch is based on '${info.upstream}', but the upstream is gone.\n  (use "git branch --unset-upstream" to fixup)\n`;
	}
	if (info.ahead === 0 && info.behind === 0) {
		return `Your branch is up to date with '${info.upstream}'.\n`;
	}
	if (info.ahead > 0 && info.behind === 0) {
		const plural = info.ahead === 1 ? "commit" : "commits";
		return (
			`Your branch is ahead of '${info.upstream}' by ${info.ahead} ${plural}.\n` +
			`  (use "git push" to publish your local commits)\n`
		);
	}
	if (info.behind > 0 && info.ahead === 0) {
		const plural = info.behind === 1 ? "commit" : "commits";
		return (
			`Your branch is behind '${info.upstream}' by ${info.behind} ${plural}, and can be fast-forwarded.\n` +
			`  (use "git pull" to update your local branch)\n`
		);
	}
	const header =
		`Your branch and '${info.upstream}' have diverged,\n` +
		`and have ${info.ahead} and ${info.behind} different commits each, respectively.\n`;
	if (opts?.abbreviated) return header;
	return header + `  (use "git pull" if you want to integrate the remote branch with yours)\n`;
}
