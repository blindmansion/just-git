import { abbreviateHash, comparePaths, firstLine } from "./command-utils.ts";
import { getAuthor, getCommitter } from "./identity.ts";
import {
	defaultStat,
	getConflictedPaths,
	getStage0Entries,
	readIndex,
	writeIndex,
} from "./index.ts";
import { mergeOrtNonRecursive } from "./merge-ort.ts";
import { hashObject, readCommit, writeObject } from "./object-db.ts";
import { serializeCommit } from "./objects/commit.ts";
import { dirname, join } from "./path.ts";
import {
	appendReflog,
	deleteReflog,
	logRef,
	readReflog,
	writeReflog,
	ZERO_HASH,
} from "./reflog.ts";
import { branchNameFromRef, deleteRef, readHead, resolveHead, updateRef } from "./refs.ts";
import { buildTreeFromIndex, diffTrees, flattenTree, flattenTreeToMap } from "./tree-ops.ts";
import type { GitContext, IndexEntry, ObjectId } from "./types.ts";
import { applyWorktreeOps, resetHard, type WorktreeOp } from "./unpack-trees.ts";
import { checkoutEntry, cleanEmptyDirs, walkWorkTree } from "./worktree.ts";

// ── Constants ───────────────────────────────────────────────────────

const STASH_REF = "refs/stash";

/**
 * Git's overwrite diagnostics sort with directory separators before regular
 * characters, so paths in a directory list before same-prefix flat files.
 */
function compareOverwritePaths(a: string, b: string): number {
	return comparePaths(a.replaceAll("/", "\0"), b.replaceAll("/", "\0"));
}

// ── Types ───────────────────────────────────────────────────────────

interface StashEntry {
	index: number;
	hash: ObjectId;
	message: string;
}

// ── Stash ref management ────────────────────────────────────────────

/**
 * List all stash entries, ordered by index (0 = most recent).
 * Reads the reflog at `.git/logs/refs/stash` and reverses to get
 * newest-first order, matching real git's `stash@{N}` semantics.
 */
export async function listStashEntries(ctx: GitContext): Promise<StashEntry[]> {
	const entries = await readReflog(ctx, STASH_REF);
	const result: StashEntry[] = [];
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (!entry) continue;
		result.push({
			index: entries.length - 1 - i,
			hash: entry.newHash,
			message: entry.message,
		});
	}
	return result;
}

/**
 * Read the stash commit hash at a given index.
 * Index 0 = most recent stash (last reflog entry).
 */
export async function readStashRef(ctx: GitContext, index: number): Promise<ObjectId | null> {
	const entries = await readReflog(ctx, STASH_REF);
	if (entries.length === 0) return null;

	// stash@{N} = entries[entries.length - 1 - N]
	const reflogIdx = entries.length - 1 - index;
	if (reflogIdx < 0 || reflogIdx >= entries.length) return null;

	return entries[reflogIdx]?.newHash ?? null;
}

// ── Core stash operations ───────────────────────────────────────────

/**
 * Create a stash from the current working tree and index state.
 *
 * Stash commit structure (matches real Git):
 *   - Index commit (I): tree = current index, parent = HEAD
 *   - Stash commit (W): tree = working tree state, parents = [HEAD, I]
 *   - With `includeUntracked`: untracked commit (U) as 3rd parent,
 *     a root commit whose tree contains untracked non-ignored files.
 *
 * Returns the stash commit hash, or null if there are no changes to stash.
 */
export async function saveStash(
	ctx: GitContext,
	env: Map<string, string>,
	message?: string,
	options?: { includeUntracked?: boolean },
): Promise<ObjectId | null> {
	if (!ctx.workTree) throw new Error("Cannot stash in a bare repository");
	const workTree = ctx.workTree;

	const headHash = await resolveHead(ctx);
	if (!headHash) return null; // No commits yet

	const headCommit = await readCommit(ctx, headHash);
	const index = await readIndex(ctx);
	const stage0Entries = getStage0Entries(index);

	// ── Check for changes ──────────────────────────────────────────

	// Staged changes: index tree differs from HEAD tree
	const indexTreeHash = await buildTreeFromIndex(ctx, stage0Entries);
	const stagedDiffs = await diffTrees(ctx, headCommit.tree, indexTreeHash);

	// Unstaged changes: working tree differs from index
	const indexMap = new Map(stage0Entries.map((e) => [e.path, e]));
	const workTreeFiles = await walkWorkTree(ctx, workTree, "", {
		skipIgnore: true,
	});
	let hasWorkTreeChanges = false;

	for (const filePath of workTreeFiles) {
		const indexEntry = indexMap.get(filePath);
		if (!indexEntry) continue; // skip untracked

		const fullPath = join(workTree, filePath);
		const content = await ctx.fs.readFileBuffer(fullPath);
		const blobHash = await hashObject("blob", content);
		if (blobHash !== indexEntry.hash) {
			hasWorkTreeChanges = true;
			break;
		}
	}

	// Check for deleted tracked files
	if (!hasWorkTreeChanges) {
		for (const [path] of indexMap) {
			const fullPath = join(workTree, path);
			if (!(await ctx.fs.exists(fullPath))) {
				hasWorkTreeChanges = true;
				break;
			}
		}
	}

	// Collect untracked, non-ignored files when --include-untracked is set.
	// Uses the default ignore-respecting walk so .gitignore'd files are excluded.
	const untrackedPaths: string[] = [];
	if (options?.includeUntracked) {
		const visibleFiles = await walkWorkTree(ctx, workTree, "");
		for (const filePath of visibleFiles) {
			if (!indexMap.has(filePath)) {
				untrackedPaths.push(filePath);
			}
		}
	}

	if (stagedDiffs.length === 0 && !hasWorkTreeChanges && untrackedPaths.length === 0) {
		return null; // No changes
	}

	// ── Get identity ───────────────────────────────────────────────
	const author = await getAuthor(ctx, env);
	const committer = await getCommitter(ctx, env);

	// ── Branch info for default message ────────────────────────────
	const head = await readHead(ctx);
	const branchName = head?.type === "symbolic" ? branchNameFromRef(head.target) : "(no branch)";
	const headShort = abbreviateHash(headHash);
	const headFirstLine = firstLine(headCommit.message);

	// ── 1. Create index commit (I) ─────────────────────────────────
	const indexCommitMessage = `index on ${branchName}: ${headShort} ${headFirstLine}\n`;
	const indexCommitContent = serializeCommit({
		type: "commit",
		tree: indexTreeHash,
		parents: [headHash],
		author,
		committer,
		message: indexCommitMessage,
	});
	const indexCommitHash = await writeObject(ctx, "commit", indexCommitContent);

	// ── 2. Create working tree tree ────────────────────────────────
	// Include worktree content for files tracked by the index OR HEAD tree.
	// This captures files removed with `git rm --cached` (still in HEAD, on
	// disk, but not in the index) which real git includes in the stash tree.
	const headTreeMap = await flattenTreeToMap(ctx, headCommit.tree);

	const wtEntries: IndexEntry[] = [];
	const seenPaths = new Set<string>();

	for (const filePath of workTreeFiles) {
		const indexEntry = indexMap.get(filePath);
		const headEntry = headTreeMap.get(filePath);
		if (!indexEntry && !headEntry) continue; // truly untracked

		const fullPath = join(workTree, filePath);
		const content = await ctx.fs.readFileBuffer(fullPath);
		const blobHash = await writeObject(ctx, "blob", content);

		const mode = indexEntry ? indexEntry.mode : parseInt(headEntry?.mode ?? "100644", 8);
		wtEntries.push({
			path: filePath,
			mode,
			hash: blobHash,
			stage: 0,
			stat: defaultStat(),
		});
		seenPaths.add(filePath);
	}

	// Include index entries for files NOT on disk and NOT in HEAD.
	// These are staged-only new files that diff-index (HEAD vs worktree)
	// wouldn't touch, so they keep their index value in the stash tree.
	// Files NOT on disk but IN HEAD are "deleted from worktree" and get
	// removed by diff-index, so they're excluded from the stash tree.
	for (const [path, entry] of indexMap) {
		if (seenPaths.has(path)) continue;
		if (headTreeMap.has(path)) continue;
		wtEntries.push({
			path,
			mode: entry.mode,
			hash: entry.hash,
			stage: 0,
			stat: defaultStat(),
		});
	}

	const wtTreeHash = await buildTreeFromIndex(ctx, wtEntries);

	// ── 2b. Create untracked files commit (U) if --include-untracked ──
	let untrackedCommitHash: ObjectId | null = null;
	if (options?.includeUntracked) {
		const uEntries: IndexEntry[] = [];
		for (const filePath of untrackedPaths) {
			const fullPath = join(workTree, filePath);
			const content = await ctx.fs.readFileBuffer(fullPath);
			const blobHash = await writeObject(ctx, "blob", content);
			uEntries.push({
				path: filePath,
				mode: 0o100644,
				hash: blobHash,
				stage: 0,
				stat: defaultStat(),
			});
		}
		// Real git always creates the U commit when -u is used, even with
		// an empty tree (no untracked files). This ensures the 3-parent
		// stash structure is consistent.
		const uTreeHash = await buildTreeFromIndex(ctx, uEntries);
		const uMessage = `untracked files on ${branchName}: ${headShort} ${headFirstLine}\n`;
		const uCommitContent = serializeCommit({
			type: "commit",
			tree: uTreeHash,
			parents: [],
			author,
			committer,
			message: uMessage,
		});
		untrackedCommitHash = await writeObject(ctx, "commit", uCommitContent);
	}

	// ── 3. Create stash commit (W) ─────────────────────────────────
	const stashMessage = message
		? `On ${branchName}: ${message}`
		: `WIP on ${branchName}: ${headShort} ${headFirstLine}`;

	const parents: ObjectId[] = [headHash, indexCommitHash];
	if (untrackedCommitHash) {
		parents.push(untrackedCommitHash);
	}

	const stashCommitContent = serializeCommit({
		type: "commit",
		tree: wtTreeHash,
		parents,
		author,
		committer,
		message: stashMessage,
	});
	const stashHash = await writeObject(ctx, "commit", stashCommitContent);

	// ── 4. Push onto stash stack (reflog) ─────────────────────────
	// Read current refs/stash value as oldHash (or zero hash if first stash)
	const oldHash = (await readStashRef(ctx, 0)) ?? ZERO_HASH;

	await appendReflog(ctx, STASH_REF, {
		oldHash,
		newHash: stashHash,
		name: committer.name,
		email: committer.email,
		timestamp: committer.timestamp,
		tz: committer.timezone,
		message: stashMessage.trimEnd(),
	});
	await updateRef(ctx, STASH_REF, stashHash);

	// ── 5. Reset working tree and index to HEAD ────────────────────
	const resetResult = await resetHard(ctx, headCommit.tree, index);
	await writeIndex(ctx, { version: 2, entries: resetResult.newEntries });
	await applyWorktreeOps(ctx, resetResult.worktreeOps);

	const headState = await readHead(ctx);
	if (headState?.type === "symbolic") {
		await logRef(ctx, env, "HEAD", headHash, headHash, "reset: moving to HEAD");
	}

	// Clear in-progress operation state — stash saves the dirty state and
	// resets to a clean HEAD, so any active merge/cherry-pick/rebase is gone.
	for (const refName of ["CHERRY_PICK_HEAD", "MERGE_HEAD", "ORIG_HEAD", "REVERT_HEAD"]) {
		await deleteRef(ctx, refName);
	}
	for (const fileName of ["MERGE_MSG", "MERGE_MODE"]) {
		const p = join(ctx.gitDir, fileName);
		if (await ctx.fs.exists(p)) {
			await ctx.fs.rm(p);
		}
	}

	// Delete untracked files when --include-untracked was used.
	// Only delete files that are truly untracked after the reset — files that
	// were in HEAD get restored by resetHard and are now tracked again.
	if (untrackedPaths.length > 0) {
		for (const filePath of untrackedPaths) {
			if (headTreeMap.has(filePath)) continue;
			const fullPath = join(workTree, filePath);
			if (await ctx.fs.exists(fullPath)) {
				await ctx.fs.rm(fullPath);
				await cleanEmptyDirs(ctx.fs, dirname(fullPath), workTree);
			}
		}
	}

	return stashHash;
}

interface StashApplySuccess {
	ok: true;
	hasConflicts: boolean;
	messages: string[];
}

interface StashApplyFailure {
	ok: false;
	stdout: string;
	stderr: string;
	exitCode: number;
	messages?: string[];
}

type StashApplyResult = StashApplySuccess | StashApplyFailure;

/**
 * Restore untracked files from a stash's 3rd parent commit.
 * Errors if any target paths already exist in the worktree.
 */
async function restoreUntrackedFiles(
	ctx: GitContext,
	untrackedCommitHash: ObjectId,
): Promise<StashApplyResult> {
	const workTree = ctx.workTree as string;
	const uCommit = await readCommit(ctx, untrackedCommitHash);
	const uEntries = await flattenTree(ctx, uCommit.tree);

	const alreadyExist: string[] = [];
	for (const entry of uEntries) {
		const fullPath = join(workTree, entry.path);
		if (await ctx.fs.exists(fullPath)) {
			alreadyExist.push(entry.path);
		} else {
			await checkoutEntry(ctx, entry);
		}
	}

	if (alreadyExist.length > 0) {
		alreadyExist.sort(compareOverwritePaths);
		return {
			ok: false,
			stdout: "",
			stderr: `${alreadyExist.map((p) => `${p} already exists, no checkout`).join("\n")}\nerror: could not restore untracked files from stash\n`,
			exitCode: 1,
		};
	}

	return { ok: true, hasConflicts: false, messages: [] };
}

/**
 * Apply a stash to the current working tree without removing it.
 *
 * Matches real git's approach: three-way merge where
 *   base  = stash parent tree
 *   ours  = current INDEX tree (NOT HEAD — this is the key insight from
 *           git's do_apply_stash which calls write_index_as_tree first)
 *   theirs = stash working-tree snapshot
 *
 * Using the index tree as "ours" means the merge inherently accounts for
 * staged changes. The merge result entries become the new index directly,
 * and worktree ops are computed by diffing index-tree → result-tree.
 */
export async function applyStash(
	ctx: GitContext,
	stashIndex: number = 0,
): Promise<StashApplyResult> {
	if (!ctx.workTree)
		return {
			ok: false,
			stdout: "",
			stderr: "fatal: this operation must be run in a work tree\n",
			exitCode: 128,
		};

	const stashHash = await readStashRef(ctx, stashIndex);
	if (!stashHash)
		return {
			ok: false,
			stdout: "",
			stderr: `error: stash@{${stashIndex}} is not a valid reference\n`,
			exitCode: 1,
		};

	const headHash = await resolveHead(ctx);
	if (!headHash)
		return {
			ok: false,
			stdout: "",
			stderr: "error: your current branch does not have any commits yet\n",
			exitCode: 1,
		};

	// Refuse to apply when the index has unresolved conflicts
	const currentIndex = await readIndex(ctx);
	const unmergedPaths = getConflictedPaths(currentIndex).sort();
	if (unmergedPaths.length > 0) {
		const msgs = unmergedPaths.map((p) => `${p}: needs merge`);
		return {
			ok: false,
			stdout: `${msgs.join("\n")}\n`,
			stderr: "error: could not write index\n",
			exitCode: 1,
		};
	}

	const stashCommit = await readCommit(ctx, stashHash);
	const stashParentHash = stashCommit.parents[0];
	if (!stashParentHash)
		return {
			ok: false,
			stdout: "",
			stderr: "error: invalid stash commit (no parent)\n",
			exitCode: 1,
		};

	const stashParent = await readCommit(ctx, stashParentHash);
	const untrackedParentHash = stashCommit.parents[2];

	// Build a tree from the current index — this is "ours" for the merge,
	// matching real git's write_index_as_tree() call in do_apply_stash.
	const stage0Entries = getStage0Entries(currentIndex);
	const oursTreeHash = await buildTreeFromIndex(ctx, stage0Entries);

	const labels = { a: "Updated upstream", b: "Stashed changes" };

	// Fast path matching real git's merge_ort_nonrecursive wrapper:
	// if base == theirs, the stash made no tracked changes.
	// Still need to handle untracked files from the 3rd parent if present.
	if (stashParent.tree === stashCommit.tree) {
		if (untrackedParentHash) {
			const uResult = await restoreUntrackedFiles(ctx, untrackedParentHash);
			if (!uResult.ok) return { ...uResult, messages: ["Already up to date."] };
		}
		return {
			ok: true,
			hasConflicts: false,
			messages: ["Already up to date."],
		};
	}

	const result = await mergeOrtNonRecursive(
		ctx,
		stashParent.tree,
		oursTreeHash,
		stashCommit.tree,
		labels,
	);

	// Compute worktree ops by diffing index tree → merge result tree.
	const oursMap = await flattenTreeToMap(ctx, oursTreeHash);
	const resultMap = await flattenTreeToMap(ctx, result.resultTree);

	const ops: WorktreeOp[] = [];
	for (const [path, re] of resultMap) {
		const oe = oursMap.get(path);
		if (!oe || oe.hash !== re.hash) {
			ops.push({
				path,
				type: "checkout",
				hash: re.hash,
				mode: parseInt(re.mode, 8),
			});
		}
	}
	for (const [path] of oursMap) {
		if (!resultMap.has(path)) {
			ops.push({ path, type: "delete" });
		}
	}

	// Check for dirty worktree files that would be overwritten.
	// Both checkout (update) and delete ops must be checked — real git's
	// merge-ort blocks any merge that would overwrite local modifications.
	const indexStage0 = new Map(stage0Entries.map((e) => [e.path, e]));
	const dirtyOverwritten: string[] = [];
	const untrackedOverwritten: string[] = [];
	for (const op of ops) {
		const ie = indexStage0.get(op.path);
		const fullPath = join(ctx.workTree, op.path);

		if (ie) {
			if (!(await ctx.fs.exists(fullPath))) continue;
			const content = await ctx.fs.readFileBuffer(fullPath);
			const blobHash = await hashObject("blob", content);
			if (blobHash !== ie.hash) {
				dirtyOverwritten.push(op.path);
			}
		} else if (op.type === "checkout") {
			if (await ctx.fs.exists(fullPath)) {
				untrackedOverwritten.push(op.path);
			}
		}
	}

	if (dirtyOverwritten.length > 0 || untrackedOverwritten.length > 0) {
		dirtyOverwritten.sort(compareOverwritePaths);
		untrackedOverwritten.sort(compareOverwritePaths);
		let stderr = "";
		if (dirtyOverwritten.length > 0) {
			stderr += `error: Your local changes to the following files would be overwritten by merge:\n${dirtyOverwritten.map((p) => `\t${p}`).join("\n")}\nPlease commit your changes or stash them before you merge.\n`;
		}
		if (untrackedOverwritten.length > 0) {
			stderr += `error: The following untracked working tree files would be overwritten by merge:\n${untrackedOverwritten.map((p) => `\t${p}`).join("\n")}\nPlease move or remove them before you merge.\n`;
		}
		stderr += "Aborting\n";

		// Real git still attempts untracked file restoration even when the
		// tracked merge is blocked, appending any untracked errors.
		if (untrackedParentHash) {
			const uResult = await restoreUntrackedFiles(ctx, untrackedParentHash);
			if (!uResult.ok) {
				stderr += uResult.stderr;
			}
		}

		return {
			ok: false,
			stdout: "",
			stderr,
			exitCode: 1,
		};
	}

	// Apply worktree changes
	await applyWorktreeOps(ctx, ops);

	// ── Index update ──────────────────────────────────────────────
	// Mirrors real git's post-merge index handling in do_apply_stash:
	//
	// Conflicts: write merge result entries (stages 1/2/3 for conflicts,
	//   stage 0 for cleanly resolved paths) — the full merge index.
	//
	// Clean merge: call the equivalent of unstage_changes_unless_new().
	//   The merge updated the worktree, but the index should be restored
	//   to its pre-merge state for files that already existed. Only NEW
	//   files (not in the original index tree) stay staged.
	const conflictPaths = new Set(result.conflicts.map((c) => c.path));
	// For rename/rename(1to2), stage 2/3 entries live at the rename
	// destination paths, not the conflict's base path. Collect all
	// paths that carry conflict-stage entries so we don't clobber them
	// with stage-0 entries from the result tree.
	const conflictEntryPaths = new Set<string>();
	for (const entry of result.entries) {
		if (entry.stage > 0) conflictEntryPaths.add(entry.path);
	}
	const hasAnyConflicts = conflictPaths.size > 0;

	if (hasAnyConflicts) {
		const newEntries: IndexEntry[] = [];

		for (const [path, re] of resultMap) {
			if (conflictPaths.has(path) || conflictEntryPaths.has(path)) continue;
			const existing = indexStage0.get(path);
			newEntries.push({
				path,
				mode: parseInt(re.mode, 8),
				hash: re.hash,
				stage: 0,
				stat: existing?.stat ?? defaultStat(),
			});
		}

		for (const entry of result.entries) {
			if (entry.stage > 0) {
				newEntries.push(entry);
			}
		}

		newEntries.sort((a, b) => comparePaths(a.path, b.path) || a.stage - b.stage);
		await writeIndex(ctx, { version: 2, entries: newEntries });
	} else {
		// unstage_changes_unless_new: restore index to pre-merge state
		// for all paths that existed in the original index tree. Only
		// truly new files (in merge result but not in original index)
		// stay staged. Files deleted by the merge keep their original
		// index entries — the deletion shows as an unstaged worktree
		// change, matching real git's behavior.
		const kept = [...currentIndex.entries];
		const existingPaths = new Set(kept.map((e) => e.path));

		for (const [path, re] of resultMap) {
			if (oursMap.has(path)) continue;
			if (existingPaths.has(path)) continue;
			kept.push({
				path,
				mode: parseInt(re.mode, 8),
				hash: re.hash,
				stage: 0,
				stat: defaultStat(),
			});
		}

		kept.sort((a, b) => comparePaths(a.path, b.path) || a.stage - b.stage);
		await writeIndex(ctx, { version: 2, entries: kept });
	}

	// ── Restore untracked files from 3rd parent ─────────────────
	if (untrackedParentHash) {
		const uResult = await restoreUntrackedFiles(ctx, untrackedParentHash);
		if (!uResult.ok) {
			return { ...uResult, messages: result.messages };
		}
	}

	return {
		ok: true,
		hasConflicts: hasAnyConflicts,
		messages: result.messages,
	};
}

/**
 * Drop a stash entry and renumber the reflog.
 * Returns an error message string, or null on success.
 */
export async function dropStash(ctx: GitContext, stashIndex: number = 0): Promise<string | null> {
	const entries = await readReflog(ctx, STASH_REF);
	if (entries.length === 0) return `error: stash@{${stashIndex}} is not a valid reference`;

	// stash@{N} = entries[entries.length - 1 - N]
	const reflogIdx = entries.length - 1 - stashIndex;
	if (reflogIdx < 0 || reflogIdx >= entries.length)
		return `error: stash@{${stashIndex}} is not a valid reference`;

	// Remove the entry
	entries.splice(reflogIdx, 1);

	if (entries.length === 0) {
		// No stashes left — remove both the ref and reflog
		await deleteRef(ctx, STASH_REF);
		await deleteReflog(ctx, STASH_REF);
	} else {
		// Rewrite the reflog
		await writeReflog(ctx, STASH_REF, entries);
		// Update refs/stash to point to the new top (last entry)
		const newTop = entries[entries.length - 1];
		if (newTop) {
			await updateRef(ctx, STASH_REF, newTop.newHash);
		}
	}

	return null;
}

/**
 * Remove all stash entries.
 */
export async function clearStashes(ctx: GitContext): Promise<void> {
	await deleteRef(ctx, STASH_REF);
	await deleteReflog(ctx, STASH_REF);
}
