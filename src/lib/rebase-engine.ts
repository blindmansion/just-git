import type { GitExtensions } from "../git.ts";
import { isAmInProgress } from "./am.ts";
import { isRejection } from "./hooks.ts";
import { getSequencerDirtyState, type SequencerDirtyState } from "./command-utils.ts";
import { bindAttributes } from "./attributes/bound-attributes.ts";
import { type DiffStats, gatherCommitStats } from "./commit-summary.ts";
import {
	getConflictedPaths,
	getStage0Entries,
	hasConflicts,
	readIndex,
	writeIndex,
} from "./index.ts";
import { findAllMergeBases, isAncestor } from "./merge.ts";
import { type ContentMergeFn, mergeOrtNonRecursive } from "./merge-ort.ts";
import { readCommit } from "./object-db.ts";
import { type Signer, resolveConfiguredSigner, SigningError } from "./signing.ts";
import {
	clearAllOperationState,
	clearDetachPoint,
	deleteStateFile,
	readStateFile,
	writeStateFile,
} from "./operation-state.ts";
import {
	advanceRebaseState,
	cleanupRebaseState,
	type RebaseState,
	type RebaseTodoEntry,
	readRebaseState,
	selectRebaseCommits,
	writeRebaseConflictMeta,
	writeRebaseState,
} from "./rebase.ts";
import { getReflogIdentity, resolveIdentityFrom } from "./identity.ts";
import { readConfigView } from "./config/view.ts";
import {
	applyReflogEffects,
	logRef,
	logRefEffects,
	type ReflogEffect,
	type ReflogIdentity,
} from "./refs/reflog.ts";
import {
	advanceBranchRef,
	createSymbolicRef,
	deleteRef,
	readHead,
	resolveHead,
	resolveRef,
	updateRef,
} from "./refs/refs.ts";
import { buildTreeFromIndex, flattenTree, flattenTreeToMap } from "./tree-ops.ts";
import type { GitContext, GitRepo, Identity, Index, ObjectId } from "./types.ts";
import {
	applyWorktreeOps,
	checkoutTrees,
	type RejectedPath,
	resetHard,
	UnpackError,
} from "./worktree/unpack-trees.ts";
import { walkWorkTree } from "./worktree/worktree.ts";
import { comparePaths } from "./path.ts";
import { firstLine, stripCommentLines, ensureTrailingNewline } from "./text-utils.ts";
import { uniqueAbbrev } from "./abbrev.ts";
import { writeCommitAndAdvance } from "./commit-write.ts";
import { branchNameFromRef } from "./refs/name.ts";
import { getConfigValue } from "./config/store.ts";

// ── Structured outcomes ─────────────────────────────────────────────
//
// The rebase engine gathers data and mutates on-disk state, but never
// assembles the CLI stdout/stderr/exit-code contract itself. Every
// entrypoint returns a {@link RebaseOutcome}; `commands/kit/rebase#renderRebaseOutcome`
// maps each variant to a `CommandResult`.

/** Progress marker for one replayed step: "Rebasing (current/total)". */
export interface RebaseProgress {
	current: number;
	total: number;
}

/** Result of replaying a single todo entry, rendered after its progress line. */
export type RebaseStepMessage =
	| { kind: "applied" }
	| { kind: "dropped"; hash: ObjectId; subject: string };

export interface RebaseStep {
	progress: RebaseProgress;
	message: RebaseStepMessage;
}

/** Why a rebase stopped before replaying every commit in the todo list. */
export type RebaseConflict =
	| { kind: "content"; shortHash: string; subject: string; mergeMessages: string[] }
	| { kind: "untracked"; blockedPaths: string[]; entry: RebaseTodoEntry }
	| { kind: "fatal"; message: string };

/**
 * Commit-summary data for a conflict-resolved commit finalized by
 * `git rebase --continue`; the command layer renders it (matches git's
 * `print_commit_summary`).
 */
export interface FinalizedRebaseCommit {
	/** Raw pieces of the one-line header; the command layer renders it. */
	oneLiner: { branchName: string; shortHash: string; message: string };
	author: Identity;
	committer: Identity;
	showDate: boolean;
	stats: DiffStats;
}

/**
 * Structured result of a rebase engine entrypoint. `commands/kit/rebase#renderRebaseOutcome`
 * maps each variant to the stdout/stderr/exit-code contract; `lib` never assembles
 * that CLI text itself.
 */
export type RebaseOutcome =
	| { kind: "upToDate"; branchName: string }
	| { kind: "unmergedPaths"; paths: string[] }
	| { kind: "dirtyWorktree"; state: SequencerDirtyState }
	| { kind: "preRebaseRejected"; message: string }
	| { kind: "signingFailed" }
	| { kind: "checkoutBlocked"; rejected: RejectedPath[]; skipped: string[] }
	| {
			kind: "rebased";
			headName: string;
			skipped: string[];
			steps: RebaseStep[];
			finalizedCommit?: FinalizedRebaseCommit;
	  }
	| {
			kind: "stopped";
			skipped: string[];
			steps: RebaseStep[];
			progress: RebaseProgress;
			conflict: RebaseConflict;
			finalizedCommit?: FinalizedRebaseCommit;
	  }
	| {
			kind: "refLockFailure";
			headName: string;
			actual: ObjectId | null;
			expected: ObjectId;
			skipped: string[];
			steps: RebaseStep[];
	  }
	| { kind: "aborted" }
	| { kind: "abortBlocked"; rejected: RejectedPath[]; origHead: ObjectId }
	| { kind: "skipNoHead" }
	| { kind: "unmergedContinue" }
	| { kind: "stagedChangesContinue" }
	| { kind: "fatal"; message: string };

/**
 * Resolve the committer identity, surfacing "no identity configured" as a
 * structured failure rather than throwing or building a `CommandResult`.
 */
async function resolveCommitter(
	gitCtx: GitRepo,
	env: Map<string, string>,
): Promise<{ ok: true; committer: Identity } | { ok: false; message: string }> {
	try {
		return {
			ok: true,
			committer: resolveIdentityFrom(gitCtx, await readConfigView(gitCtx), env, "committer"),
		};
	} catch (e) {
		return { ok: false, message: (e as Error).message };
	}
}

/**
 * Resolve the signer for a rebase-created commit, mapping the "signing required
 * but unavailable" policy failure to a structured `{ ok: false }`.
 */
async function resolveSigner(
	gitCtx: GitRepo,
): Promise<{ ok: true; signer?: Signer } | { ok: false }> {
	try {
		return {
			ok: true,
			signer: resolveConfiguredSigner(
				gitCtx,
				await readConfigView(gitCtx),
				undefined,
				"commit.gpgsign",
			),
		};
	} catch (e) {
		if (e instanceof SigningError) return { ok: false };
		throw e;
	}
}

/**
 * Return the display label for the current HEAD — either the branch name
 * (e.g. "dev-uxvs") or "detached HEAD".
 */
async function headLabel(gitCtx: GitRepo): Promise<string> {
	const head = await readHead(gitCtx);
	if (head?.type === "symbolic") {
		return branchNameFromRef(head.target);
	}
	return "detached HEAD";
}

const EMPTY_TREE_HASH = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * Whether a commit is "empty" the way git's todo generation classifies it:
 * its tree equals its first parent's tree (or the empty tree for a root
 * commit). Git annotates these todo lines with a trailing ` # empty` marker.
 * Merge commits are never emitted as picks, so they are treated as non-empty.
 */
async function isOriginalCommitEmpty(
	gitCtx: GitContext,
	commit: { tree: ObjectId; parents: ObjectId[] },
): Promise<boolean> {
	const firstParent = commit.parents[0];
	if (firstParent === undefined) return commit.tree === EMPTY_TREE_HASH;
	if (commit.parents.length > 1) return false;
	const parent = await readCommit(gitCtx, firstParent);
	return commit.tree === parent.tree;
}

/**
 * Whether the parent chain from `head` down to `onto` is linear (contains no
 * merge commits). Mirrors git's `is_linear_history()` in builtin/rebase.c:
 * walk single parents from `head`, bailing at the first merge, until `onto`
 * (or a root) is reached.
 */
async function isLinearHistory(
	gitCtx: GitContext,
	onto: ObjectId,
	head: ObjectId,
): Promise<boolean> {
	let cur: ObjectId | undefined = head;
	while (cur && cur !== onto) {
		const commit = await readCommit(gitCtx, cur);
		if (commit.parents.length === 0) return true;
		if (commit.parents.length > 1) return false;
		cur = commit.parents[0];
	}
	return true;
}

/**
 * Whether the rebase can be reported as a preemptive "up to date" / fast-forward
 * without replaying any commits. Mirrors git's `can_fast_forward()`
 * (builtin/rebase.c): the single merge-base of (onto, head) must be `onto`, the
 * single merge-base of (upstream, head) must also be `onto`, and the history
 * from `onto` to `head` must be linear. When true, git leaves the branch where
 * it is and prints "Current branch <name> is up to date." (it never replays,
 * even if some commits in the range look already-applied).
 */
async function canRebaseFastForward(
	gitCtx: GitContext,
	ontoHash: ObjectId,
	upstreamHash: ObjectId,
	origHead: ObjectId,
): Promise<boolean> {
	const ontoBases = await findAllMergeBases(gitCtx, ontoHash, origHead);
	if (ontoBases.length !== 1 || ontoBases[0] !== ontoHash) return false;

	const upstreamBases = await findAllMergeBases(gitCtx, upstreamHash, origHead);
	if (upstreamBases.length !== 1 || upstreamBases[0] !== ontoHash) return false;

	return isLinearHistory(gitCtx, ontoHash, origHead);
}

/**
 * Check whether resetting the worktree to targetTree would overwrite untracked
 * files. Returns the rejected paths if so (the caller renders "could not detach
 * HEAD"), or null if safe.
 *
 * This check mirrors real git's behavior: before `reset_head()` with
 * twoway_merge, untracked files that would be overwritten are detected.
 * We perform this check separately so we can still use resetHard (which
 * ensures the worktree exactly matches the target tree for tracked files).
 */
async function checkUntrackedConflicts(
	gitCtx: GitContext,
	targetTree: ObjectId,
	currentIndex: Index,
): Promise<RejectedPath[] | null> {
	if (!gitCtx.workTree) return null;

	// Flatten both trees
	const targetMap = await flattenTreeToMap(gitCtx, targetTree);
	const indexMap = new Map(getStage0Entries(currentIndex).map((e) => [e.path, e]));

	const untrackedFiles = new Set(await walkWorkTree(gitCtx, gitCtx.workTree, ""));

	// Check for untracked files that would be overwritten
	const rejected: RejectedPath[] = [];
	for (const [path] of targetMap) {
		// File in target but not in current tree AND not in index = new file
		if (!indexMap.has(path)) {
			// If a non-ignored untracked file exists on disk at this path, block.
			// Real git rejects these checkouts/rebase picks even when content
			// happens to match, because the file is untracked in the current
			// branch and would be clobbered by checkout/merge.
			if (untrackedFiles.has(path)) {
				rejected.push({
					path,
					error: UnpackError.WOULD_LOSE_UNTRACKED_OVERWRITTEN,
				});
			}
		}
	}

	return rejected.length > 0 ? rejected : null;
}

/**
 * Check whether aborting (resetting to origHead tree) would overwrite untracked
 * files. Returns the rejected paths if so (the caller renders the reset error),
 * or null if safe.
 */
async function checkAbortUntrackedConflicts(
	gitCtx: GitContext,
	targetTree: ObjectId,
	currentIndex: Index,
): Promise<RejectedPath[] | null> {
	if (!gitCtx.workTree) return null;

	const targetMap = await flattenTreeToMap(gitCtx, targetTree);
	// Include ALL index entries (stage 0 and conflict stages 1/2/3) as
	// "tracked". During conflicts, files only have stage 1/2/3 entries
	// and no stage 0 entry — they must not be treated as untracked.
	const trackedPaths = new Set(currentIndex.entries.map((e) => e.path));

	const untrackedFiles = new Set(await walkWorkTree(gitCtx, gitCtx.workTree, ""));

	const rejected: RejectedPath[] = [];
	for (const [path] of targetMap) {
		if (!trackedPaths.has(path) && untrackedFiles.has(path)) {
			rejected.push({
				path,
				error: UnpackError.WOULD_LOSE_UNTRACKED_OVERWRITTEN,
			});
		}
	}

	return rejected.length > 0 ? rejected : null;
}

async function checkUntrackedConflictsForPick(
	gitCtx: GitContext,
	currentIndex: Index,
	writeTargets: Map<string, ObjectId | null>,
): Promise<string[] | null> {
	if (!gitCtx.workTree) return null;
	const indexMap = new Map(getStage0Entries(currentIndex).map((e) => [e.path, e]));
	const untrackedFiles = new Set(await walkWorkTree(gitCtx, gitCtx.workTree, ""));

	const blockedPaths: string[] = [];
	for (const [path] of writeTargets) {
		if (!indexMap.has(path) && untrackedFiles.has(path)) {
			// Real git rejects non-ignored untracked files that would be
			// overwritten by a merge/pick, regardless of content match.
			blockedPaths.push(path);
		}
	}

	return blockedPaths.length > 0 ? blockedPaths : null;
}

/**
 * Pure builder for the reflog entries a rebase/pull fast-forward writes:
 * a `(start): checkout` on HEAD, and (unless detached) a `(finish)` pair on
 * the branch ref and HEAD. Takes an already-materialized {@link ReflogIdentity}
 * and returns {@link ReflogEffect}s for the shell to apply.
 */
function rebaseFfReflogEffects(
	identity: ReflogIdentity,
	origHead: ObjectId,
	targetHash: ObjectId,
	headName: string,
	upstreamArg: string,
	reflogAction: "rebase" | "pull",
	ontoHash: ObjectId,
): ReflogEffect[] {
	const effects: ReflogEffect[] = [
		...logRefEffects(
			identity,
			"HEAD",
			origHead,
			targetHash,
			`${reflogAction} (start): checkout ${upstreamArg}`,
		),
	];
	if (headName !== "detached HEAD") {
		// git only logs the branch ref when its tip actually moves; a no-op
		// rebase (the branch ends up where it started) still logs the HEAD
		// start/finish pair but leaves the branch reflog untouched.
		if (origHead !== targetHash) {
			// git records the resolved `onto` base in the finish message, which
			// can differ from the ref's new tip when leading picks were
			// fast-forwarded past `onto`.
			effects.push(
				...logRefEffects(
					identity,
					headName,
					origHead,
					targetHash,
					`${reflogAction} (finish): ${headName} onto ${ontoHash}`,
				),
			);
		}
		effects.push(
			...logRefEffects(
				identity,
				"HEAD",
				targetHash,
				targetHash,
				`${reflogAction} (finish): returning to ${headName}`,
			),
		);
	}
	return effects;
}

async function writeRebaseFfReflog(
	gitCtx: GitContext,
	env: Map<string, string>,
	origHead: ObjectId,
	targetHash: ObjectId,
	headName: string,
	upstreamArg: string,
	reflogAction: "rebase" | "pull",
	ontoHash: ObjectId,
): Promise<void> {
	const identity = await getReflogIdentity(gitCtx, env);
	await applyReflogEffects(
		gitCtx,
		rebaseFfReflogEffects(
			identity,
			origHead,
			targetHash,
			headName,
			upstreamArg,
			reflogAction,
			ontoHash,
		),
	);
}

/**
 * Fast-forward the worktree, index, and branch ref to a target commit.
 * Checks for untracked file conflicts first. Returns the rejected paths if
 * the checkout is blocked, null on success.
 */
async function fastForwardTo(
	gitCtx: GitContext,
	targetHash: ObjectId,
	currentIndex: Index,
	headName: string,
): Promise<RejectedPath[] | null> {
	const targetCommit = await readCommit(gitCtx, targetHash);

	const rejected = await checkUntrackedConflicts(gitCtx, targetCommit.tree, currentIndex);
	if (rejected) return rejected;

	const result = await resetHard(gitCtx, targetCommit.tree, currentIndex);
	if (result.success) {
		await writeIndex(gitCtx, { version: 2, entries: result.newEntries });
		await applyWorktreeOps(gitCtx, result.worktreeOps);
	}

	if (headName !== "detached HEAD") {
		await updateRef(gitCtx, headName, targetHash);
	} else {
		await updateRef(gitCtx, "HEAD", targetHash);
	}

	return null;
}

/**
 * Core rebase engine used by both `git rebase` and `git pull --rebase`.
 * Caller is responsible for resolving upstream/onto hashes and checking
 * for concurrent rebase. This function handles worktree cleanliness,
 * pre-rebase hook, commit collection, and the pick loop.
 */
export async function performRebase(
	gitCtx: GitContext,
	env: Map<string, string>,
	origHead: ObjectId,
	headName: string,
	upstreamHash: ObjectId,
	ontoHash: ObjectId,
	upstreamLabel: string,
	checkoutLabel: string,
	ext?: GitExtensions,
	options?: { reapplyCherryPicks?: boolean; reflogAction?: "rebase" | "pull" },
): Promise<RebaseOutcome> {
	const branchName = headName.startsWith("refs/heads/") ? branchNameFromRef(headName) : "HEAD";
	const reflogAction = options?.reflogAction ?? "rebase";

	// ── Clean worktree check ─────────────────────────────────
	const currentIndex = await readIndex(gitCtx);

	const unmergedPaths = getConflictedPaths(currentIndex).sort();
	if (unmergedPaths.length > 0) {
		return { kind: "unmergedPaths", paths: unmergedPaths };
	}

	const dirtyState = await getSequencerDirtyState(gitCtx, origHead, currentIndex);
	if (dirtyState) {
		return { kind: "dirtyWorktree", state: dirtyState };
	}

	// pre-rebase hook
	const preRebaseRej = await ext?.capabilities?.hooks?.preRebase?.({
		repo: gitCtx,
		upstream: upstreamLabel,
		branch: headName !== "detached HEAD" ? branchName : null,
	});
	if (isRejection(preRebaseRej)) {
		return { kind: "preRebaseRejected", message: preRebaseRej.message ?? "" };
	}

	// ── Preemptive up-to-date check ──────────────────────────
	// git decides "Current branch is up to date" up front via can_fast_forward()
	// — before any cherry-pick/already-applied filtering. If the branch is
	// already a linear extension of `onto` and `onto` is the merge-base with
	// `upstream`, git leaves the branch untouched and reports up-to-date. Any
	// other outcome runs the rebase machinery and reports "Successfully rebased"
	// (even when the replay turns out to be a no-op), so this is the *only* path
	// that yields the up-to-date message.
	if (await canRebaseFastForward(gitCtx, ontoHash, upstreamHash, origHead)) {
		return { kind: "upToDate", branchName };
	}

	// ── Compute commit range (+ cherry-pick dedup) ──────────
	const selection = await selectRebaseCommits(gitCtx, upstreamHash, origHead, {
		reapplyCherryPicks: options?.reapplyCherryPicks,
	});

	// ── Empty range: up-to-date or fast-forward ─────────────
	if (selection.rawCount === 0) {
		if (ontoHash !== origHead) {
			const rejected = await fastForwardTo(gitCtx, ontoHash, currentIndex, headName);
			if (rejected) return { kind: "checkoutBlocked", rejected, skipped: [] };
			await writeRebaseFfReflog(
				gitCtx,
				env,
				origHead,
				ontoHash,
				headName,
				checkoutLabel,
				reflogAction,
				ontoHash,
			);
			return { kind: "rebased", headName, skipped: [], steps: [] };
		}
		// onto === HEAD with an empty range: not fast-forwardable (the preemptive
		// check already handled that), so git runs a no-op replay and reports
		// success, leaving the branch where it is.
		await writeRebaseFfReflog(
			gitCtx,
			env,
			origHead,
			origHead,
			headName,
			checkoutLabel,
			reflogAction,
			ontoHash,
		);
		return { kind: "rebased", headName, skipped: [], steps: [] };
	}

	// ── Cherry-pick skip detection ──────────────────────────
	const skipped = await Promise.all(selection.skipped.map((hash) => uniqueAbbrev(gitCtx, hash)));
	const filteredCommits = selection.commits;

	if (filteredCommits.length === 0) {
		// Every commit in the range was already applied on the target. The
		// preemptive up-to-date check already returned for the fast-forwardable
		// case, so here git still runs the (no-op) replay and reports success
		// with any skip warnings. If `onto` is already contained in HEAD, HEAD
		// *is* the rebased result: git keeps it where it is — fast-forwarding to
		// `onto` here would move HEAD backwards and drop commits.
		if (await isAncestor(gitCtx, ontoHash, origHead)) {
			// HEAD stays put, but git still ran the rebase: it logs the HEAD
			// start/finish pair (the branch reflog is left alone since the tip
			// didn't move — handled inside writeRebaseFfReflog).
			await writeRebaseFfReflog(
				gitCtx,
				env,
				origHead,
				origHead,
				headName,
				checkoutLabel,
				reflogAction,
				ontoHash,
			);
			return { kind: "rebased", headName, skipped, steps: [] };
		}
		const rejected = await fastForwardTo(gitCtx, ontoHash, currentIndex, headName);
		if (rejected) return { kind: "checkoutBlocked", rejected, skipped };
		await writeRebaseFfReflog(
			gitCtx,
			env,
			origHead,
			ontoHash,
			headName,
			checkoutLabel,
			reflogAction,
			ontoHash,
		);
		return { kind: "rebased", headName, skipped, steps: [] };
	}

	// ── Build todo list ──────────────────────────────────────
	const todo: RebaseTodoEntry[] = [];
	for (const c of filteredCommits) {
		const entry: RebaseTodoEntry = {
			hash: c.hash,
			subject: firstLine(c.commit.message),
		};
		if (await isOriginalCommitEmpty(gitCtx, c.commit)) entry.empty = true;
		todo.push(entry);
	}

	// ── Skip unnecessary picks (fast-forward optimization) ───
	let checkoutTarget = ontoHash;
	let skippedCount = 0;
	for (const entry of todo) {
		const commit = await readCommit(gitCtx, entry.hash);
		if (commit.parents.length > 1) break;
		if (commit.parents.length === 0) break;
		if (commit.parents[0] !== checkoutTarget) break;
		checkoutTarget = entry.hash;
		skippedCount++;
	}
	const done: RebaseTodoEntry[] = todo.splice(0, skippedCount);

	if (todo.length === 0) {
		// The preemptive up-to-date check already handled the fast-forwardable
		// case; a no-op landing here (checkoutTarget === origHead) still reports
		// "Successfully rebased", matching git.
		if (checkoutTarget !== origHead) {
			const rejected = await fastForwardTo(gitCtx, checkoutTarget, currentIndex, headName);
			if (rejected) return { kind: "checkoutBlocked", rejected, skipped };
		}
		// git logs the HEAD start/finish pair whenever it reports a successful
		// rebase — including the no-op case (checkoutTarget === origHead) reached
		// only when cherry-picks were skipped. writeRebaseFfReflog leaves the
		// branch reflog alone when the tip doesn't move.
		await writeRebaseFfReflog(
			gitCtx,
			env,
			origHead,
			checkoutTarget,
			headName,
			checkoutLabel,
			reflogAction,
			ontoHash,
		);
		return { kind: "rebased", headName, skipped, steps: [] };
	}

	// ── Detach HEAD onto target ──────────────────────────────
	const detachRejected = await fastForwardTo(gitCtx, checkoutTarget, currentIndex, "detached HEAD");
	if (detachRejected) return { kind: "checkoutBlocked", rejected: detachRejected, skipped };

	// Match git's rebase startup: it clears CHERRY_PICK_HEAD (the sequencer
	// reuses that pseudo-ref for its own picks) but deliberately leaves a
	// lingering REVERT_HEAD untouched. A revert paused before the rebase began
	// stays resumable with `git revert --continue` even while the rebase owns
	// the worktree (REVERT_HEAD is a top-level pseudo-ref, invisible to the
	// rebase's own state, so it survives until the revert is continued/aborted).
	await deleteRef(gitCtx, "CHERRY_PICK_HEAD");
	await deleteStateFile(gitCtx, "MERGE_MSG");
	await deleteStateFile(gitCtx, "MERGE_MODE");

	await logRef(
		gitCtx,
		env,
		"HEAD",
		origHead,
		checkoutTarget,
		`${reflogAction} (start): checkout ${checkoutLabel}`,
	);

	// ── Initialize rebase state ──────────────────────────────
	const state: RebaseState = {
		headName,
		origHead,
		onto: ontoHash,
		todo,
		done,
		msgnum: skippedCount,
		end: skippedCount + todo.length,
		reflogAction,
	};
	await writeRebaseState(gitCtx, state);
	await updateRef(gitCtx, "ORIG_HEAD", origHead);

	// ── Run the pick loop ────────────────────────────────────
	const signerResult = await resolveSigner(gitCtx);
	if (!signerResult.ok) return { kind: "signingFailed" };
	const loop = await runPickLoop(
		gitCtx,
		env,
		(await bindAttributes(gitCtx, "rebase"))?.merge,
		signerResult.signer,
	);
	return buildLoopOutcome(gitCtx, env, loop, skipped);
}

// ── Pick loop — replays commits from the todo list ──────────────────

interface PickLoopResult {
	steps: RebaseStep[];
	terminal:
		| { kind: "done" }
		| { kind: "conflict"; progress: RebaseProgress; conflict: RebaseConflict };
}

async function runPickLoop(
	gitCtx: GitContext,
	env: Map<string, string>,
	mergeDriver?: ContentMergeFn,
	signer?: Signer,
): Promise<PickLoopResult> {
	const steps: RebaseStep[] = [];

	for (;;) {
		const state = await readRebaseState(gitCtx);
		if (!state || state.todo.length === 0) break;

		const entry = state.todo[0];
		if (!entry) break;

		// Progress marker (rendered with \r so the terminal overwrites the line).
		const progress: RebaseProgress = { current: state.msgnum + 1, total: state.end };

		// Advance state BEFORE the pick (matching real git: the done file
		// records attempted picks, not just successful ones).
		await advanceRebaseState(gitCtx);

		const result = await pickOneCommit(gitCtx, entry, env, mergeDriver, signer);

		if (result.kind === "conflict") {
			if (result.rescheduleCurrent) {
				// Put the entry back in todo for retry, but keep it in done.
				// Real git's save_todo appends to done before the pick, then
				// on reschedule calls save_todo again with reschedule=1 which
				// puts the item back in todo without touching done. So the
				// entry appears in both done and todo.
				const latest = await readRebaseState(gitCtx);
				if (latest) {
					latest.todo = [entry, ...latest.todo];
					await writeRebaseState(gitCtx, latest);
				}
			}
			return { steps, terminal: { kind: "conflict", progress, conflict: result.conflict } };
		}

		if (result.kind === "dropped") {
			steps.push({
				progress,
				message: { kind: "dropped", hash: result.hash, subject: result.subject },
			});
		} else {
			steps.push({ progress, message: { kind: "applied" } });
		}
	}

	// All commits applied — finish
	return { steps, terminal: { kind: "done" } };
}

/**
 * Map a completed pick loop to a terminal {@link RebaseOutcome}: a conflict
 * stops the rebase; otherwise finalize and report success (or a ref-lock
 * failure).
 */
async function buildLoopOutcome(
	gitCtx: GitContext,
	env: Map<string, string>,
	loop: PickLoopResult,
	skipped: string[],
): Promise<RebaseOutcome> {
	if (loop.terminal.kind === "conflict") {
		return {
			kind: "stopped",
			skipped,
			steps: loop.steps,
			progress: loop.terminal.progress,
			conflict: loop.terminal.conflict,
		};
	}
	const finish = await finishRebase(gitCtx, env);
	if (finish.kind === "finished") {
		return { kind: "rebased", headName: finish.headName, skipped, steps: loop.steps };
	}
	if (finish.kind === "refLockFailure") {
		return {
			kind: "refLockFailure",
			headName: finish.headName,
			actual: finish.actual,
			expected: finish.expected,
			skipped,
			steps: loop.steps,
		};
	}
	return { kind: "fatal", message: finish.message };
}

// ── Pick a single commit (three-way merge) ──────────────────────────

type PickResult =
	| { kind: "applied" }
	| { kind: "dropped"; hash: ObjectId; subject: string }
	| { kind: "conflict"; conflict: RebaseConflict; rescheduleCurrent?: boolean };

async function pickOneCommit(
	gitCtx: GitContext,
	entry: RebaseTodoEntry,
	env: Map<string, string>,
	mergeDriver?: ContentMergeFn,
	signer?: Signer,
): Promise<PickResult> {
	const theirsHash = entry.hash;
	const theirsCommit = await readCommit(gitCtx, theirsHash);
	const parentHash = theirsCommit.parents.length > 0 ? theirsCommit.parents[0] : null;
	const parentCommit = parentHash ? await readCommit(gitCtx, parentHash) : null;

	const headHash = await resolveHead(gitCtx);
	if (!headHash) {
		return {
			kind: "conflict",
			conflict: { kind: "fatal", message: "no HEAD commit during rebase" },
		};
	}

	// ── Per-commit fast-forward optimization ─────────────────────
	// If the commit's parent IS the current HEAD, we can just advance
	// HEAD to point at the original commit object — no need to create
	// a new one. This reuses the original commit (preserving its
	// timestamps), matching real git's allow_ff in do_pick_commit
	// (sequencer.c). Real git uses twoway_merge (checkout_fast_forward)
	// here, not oneway/reset-hard.
	if (parentHash && parentHash === headHash) {
		const currentIndex = await readIndex(gitCtx);
		if (!parentCommit) {
			return {
				kind: "conflict",
				conflict: { kind: "fatal", message: "missing parent commit during rebase" },
			};
		}

		const parentEntries = await flattenTree(gitCtx, parentCommit.tree);
		const theirsEntries = await flattenTree(gitCtx, theirsCommit.tree);
		const parentMap = new Map(parentEntries.map((e) => [e.path, e.hash]));
		const writeTargets = new Map<string, ObjectId | null>();
		for (const e of theirsEntries) {
			const baseHash = parentMap.get(e.path);
			if (!baseHash || baseHash !== e.hash) {
				writeTargets.set(e.path, e.hash);
			}
		}

		const blockedPaths = await checkUntrackedConflictsForPick(gitCtx, currentIndex, writeTargets);
		if (blockedPaths) {
			await updateRef(gitCtx, "REBASE_HEAD", theirsHash);
			await writeRebaseConflictMeta(gitCtx, theirsHash, theirsCommit.author);
			return {
				kind: "conflict",
				conflict: { kind: "untracked", blockedPaths, entry },
				rescheduleCurrent: true,
			};
		}

		const result = await resetHard(gitCtx, theirsCommit.tree, currentIndex);
		if (result.success) {
			await writeIndex(gitCtx, {
				version: 2,
				entries: result.newEntries,
			});
			await applyWorktreeOps(gitCtx, result.worktreeOps);
		}
		await advanceBranchRef(gitCtx, theirsHash);
		await logRef(gitCtx, env, "HEAD", headHash, theirsHash, "rebase: fast-forward");

		return { kind: "applied" };
	}

	const headCommit = await readCommit(gitCtx, headHash);

	// Three-way merge: base = parent, ours = HEAD, theirs = commit
	const baseTree = parentCommit ? parentCommit.tree : null;
	const shortHash = await uniqueAbbrev(gitCtx, theirsHash);
	const subject = firstLine(theirsCommit.message);
	const conflictStyle = ((await getConfigValue(gitCtx, "merge.conflictstyle")) ?? "merge") as
		| "merge"
		| "diff3";
	const labels = {
		a: "HEAD",
		b: subject ? `${shortHash} (${subject})` : shortHash,
		conflictStyle,
	};

	const mergeResult = await mergeOrtNonRecursive(
		gitCtx,
		baseTree,
		headCommit.tree,
		theirsCommit.tree,
		labels,
		mergeDriver,
	);

	// Build final index
	const currentIndex = await readIndex(gitCtx);

	// Compute merge scope
	const [headEntries, baseEntries, theirsEntries] = await Promise.all([
		flattenTree(gitCtx, headCommit.tree),
		baseTree ? flattenTree(gitCtx, baseTree) : Promise.resolve([]),
		flattenTree(gitCtx, theirsCommit.tree),
	]);

	const mergeScope = new Set<string>();
	for (const e of baseEntries) mergeScope.add(e.path);
	for (const e of headEntries) mergeScope.add(e.path);
	for (const e of theirsEntries) mergeScope.add(e.path);

	const preservedEntries = currentIndex.entries.filter((e) => !mergeScope.has(e.path));

	const finalEntries = [...mergeResult.entries, ...preservedEntries];
	finalEntries.sort((a, b) => comparePaths(a.path, b.path) || a.stage - b.stage);
	const finalIndex: Index = { version: 2, entries: finalEntries };
	const stage0Entries = finalEntries.filter((e) => e.stage === 0);
	const mergedTreeHash = await buildTreeFromIndex(gitCtx, stage0Entries);

	const oursMap = new Map(headEntries.map((e) => [e.path, e]));
	const writeTargets = new Map<string, ObjectId | null>();
	for (const e of stage0Entries) {
		const ours = oursMap.get(e.path);
		if (!ours || ours.hash !== e.hash) {
			writeTargets.set(e.path, e.hash);
		}
	}
	for (const c of mergeResult.conflicts) {
		if (c.reason === "content" || c.reason === "add-add") {
			writeTargets.set(c.path, null);
			continue;
		}
		if (c.reason === "delete-modify") {
			const stages = mergeResult.entries.filter((e) => e.path === c.path && e.stage > 0);
			const oursStage = stages.find((e) => e.stage === 2);
			const theirsStage = stages.find((e) => e.stage === 3);
			if (theirsStage && !oursStage) {
				writeTargets.set(c.path, theirsStage.hash);
			}
		}
	}

	const blockedPaths = await checkUntrackedConflictsForPick(gitCtx, currentIndex, writeTargets);
	if (blockedPaths) {
		await updateRef(gitCtx, "REBASE_HEAD", theirsHash);
		await writeRebaseConflictMeta(gitCtx, theirsHash, theirsCommit.author);
		return {
			kind: "conflict",
			conflict: { kind: "untracked", blockedPaths, entry },
			rescheduleCurrent: true,
		};
	}

	await writeIndex(gitCtx, finalIndex);

	// Update working tree using merge-ort's result tree via checkoutTrees
	if (gitCtx.workTree) {
		const checkResult = await checkoutTrees(
			gitCtx,
			headCommit.tree,
			mergeResult.resultTree,
			currentIndex,
		);
		if (checkResult.success) {
			await applyWorktreeOps(gitCtx, checkResult.worktreeOps);
		}
	}

	// Handle conflicts
	if (mergeResult.conflicts.length > 0) {
		await updateRef(gitCtx, "REBASE_HEAD", theirsHash);
		await writeRebaseConflictMeta(gitCtx, theirsHash, theirsCommit.author);

		// Write MERGE_MSG with the original commit message
		await writeStateFile(gitCtx, "MERGE_MSG", theirsCommit.message);

		// Write rebase-merge/message (used by --continue to detect
		// whether staged changes are from conflict resolution vs random edits)
		await writeStateFile(gitCtx, "rebase-merge/message", theirsCommit.message);

		return {
			kind: "conflict",
			conflict: {
				kind: "content",
				shortHash,
				subject: entry.subject,
				mergeMessages: mergeResult.messages,
			},
		};
	}

	// ── Clean pick — create commit ───────────────────────────────

	// Distinguish commits that become empty during rebase from commits that
	// were intentionally empty in the original history. Real git preserves the
	// latter and only drops the former, including empty root commits created on
	// orphan branches.
	const originallyEmpty =
		parentHash === null ? theirsCommit.tree === EMPTY_TREE_HASH : theirsCommit.tree === baseTree;
	if (mergedTreeHash === headCommit.tree && !originallyEmpty) {
		return { kind: "dropped", hash: theirsHash, subject: entry.subject };
	}

	const committerResult = await resolveCommitter(gitCtx, env);
	if (!committerResult.ok) {
		return { kind: "conflict", conflict: { kind: "fatal", message: committerResult.message } };
	}

	const pickCommitHash = await writeCommitAndAdvance(
		gitCtx,
		mergedTreeHash,
		[headHash],
		theirsCommit.author,
		committerResult.committer,
		theirsCommit.message,
		signer,
	);

	await logRef(gitCtx, env, "HEAD", headHash, pickCommitHash, `rebase (pick): ${entry.subject}`);

	return { kind: "applied" };
}

// ── Finish rebase ───────────────────────────────────────────────────

type FinishResult =
	| { kind: "finished"; headName: string }
	| { kind: "refLockFailure"; headName: string; actual: ObjectId | null; expected: ObjectId }
	| { kind: "fatal"; message: string };

async function finishRebase(gitCtx: GitContext, env: Map<string, string>): Promise<FinishResult> {
	const state = await readRebaseState(gitCtx);
	if (!state) {
		return { kind: "fatal", message: "no rebase in progress" };
	}

	const currentHead = await resolveHead(gitCtx);
	if (!currentHead) {
		return { kind: "fatal", message: "no HEAD during rebase finish" };
	}

	// Update the original branch ref and re-attach HEAD
	if (state.headName !== "detached HEAD") {
		const currentBranchHash = await resolveRef(gitCtx, state.headName);
		if (currentBranchHash !== state.origHead) {
			return {
				kind: "refLockFailure",
				headName: state.headName,
				actual: currentBranchHash ?? null,
				expected: state.origHead,
			};
		}
		await updateRef(gitCtx, state.headName, currentHead);
		await createSymbolicRef(gitCtx, "HEAD", state.headName);
		await clearDetachPoint(gitCtx);

		// git only logs the branch ref when its tip actually moves. A rebase
		// that lands back on the original commit still logs the HEAD "returning
		// to" entry below, but leaves the branch reflog untouched.
		if (state.origHead !== currentHead) {
			await logRef(
				gitCtx,
				env,
				state.headName,
				state.origHead,
				currentHead,
				`${state.reflogAction ?? "rebase"} (finish): ${state.headName} onto ${state.onto}`,
			);
		}
		await logRef(
			gitCtx,
			env,
			"HEAD",
			currentHead,
			currentHead,
			`${state.reflogAction ?? "rebase"} (finish): returning to ${state.headName}`,
		);
	}

	// Clean up all state (including any cherry-pick/merge started mid-rebase).
	// Preserve a pre-existing SQUASH_MSG: real git's rebase finish leaves it in
	// place, so a later commit/cherry-pick/revert --continue still consumes it.
	// Likewise leave a lingering REVERT_HEAD alone — a revert paused before the
	// rebase began stays resumable with `git revert --continue`; git only clears
	// it on the reset-based `--abort`/`--skip` paths, not on finish.
	await deleteRef(gitCtx, "REBASE_HEAD");
	await clearAllOperationState(gitCtx, { keepSquashMsg: true, keepRevertHead: true });
	await cleanupRebaseState(gitCtx);

	return { kind: "finished", headName: state.headName };
}

/**
 * The `fatal` outcome for a rebase resume verb (`--abort`/`--skip`/`--continue`)
 * invoked with no rebase in progress. Real git shares `rebase-apply/` between
 * `git am` and `rebase --apply`, giving `am` precedence: when only an `am`
 * session exists, these verbs report the am guard (`die`, exit 128) rather than
 * `no rebase in progress`.
 */
async function noRebaseInProgress(gitCtx: GitContext): Promise<RebaseOutcome> {
	if (await isAmInProgress(gitCtx)) {
		return { kind: "fatal", message: "It looks like 'git am' is in progress. Cannot rebase." };
	}
	return { kind: "fatal", message: "no rebase in progress" };
}

// ── --abort ─────────────────────────────────────────────────────────

export async function handleAbort(
	gitCtx: GitContext,
	env: Map<string, string>,
): Promise<RebaseOutcome> {
	const state = await readRebaseState(gitCtx);
	if (!state) {
		return noRebaseInProgress(gitCtx);
	}

	const headBeforeAbort = await resolveHead(gitCtx);
	const origHead = state.origHead;
	const origCommit = await readCommit(gitCtx, origHead);
	const currentIndex = await readIndex(gitCtx);

	// Check for untracked files that would be overwritten by restoring
	// the pre-rebase state. Real git's reset_head() runs unpack_trees
	// with oneway_merge which blocks on untracked file conflicts.
	// We do a targeted pre-check, then resetHard for the actual restore
	// (which forcibly overwrites dirty tracked files, as expected).
	const rejected = await checkAbortUntrackedConflicts(gitCtx, origCommit.tree, currentIndex);
	if (rejected) return { kind: "abortBlocked", rejected, origHead };

	const abortResult = await resetHard(gitCtx, origCommit.tree, currentIndex);
	if (abortResult.success) {
		await writeIndex(gitCtx, { version: 2, entries: abortResult.newEntries });
		await applyWorktreeOps(gitCtx, abortResult.worktreeOps);
	}

	// Restore HEAD to original branch
	if (state.headName !== "detached HEAD") {
		await updateRef(gitCtx, state.headName, origHead);
		await createSymbolicRef(gitCtx, "HEAD", state.headName);
		await clearDetachPoint(gitCtx);
	} else {
		// Even for "detached HEAD", if the user checked out a branch
		// mid-rebase, advance that branch (real git follows symrefs).
		await advanceBranchRef(gitCtx, origHead);
	}

	const abortTarget = state.headName === "detached HEAD" ? origHead : state.headName;
	await logRef(
		gitCtx,
		env,
		"HEAD",
		headBeforeAbort,
		origHead,
		`rebase (abort): returning to ${abortTarget}`,
	);

	// Clean up all state (including any cherry-pick/merge started mid-rebase)
	await deleteRef(gitCtx, "REBASE_HEAD");
	await clearAllOperationState(gitCtx);
	await cleanupRebaseState(gitCtx);

	return { kind: "aborted" };
}

// ── --continue ──────────────────────────────────────────────────────

export async function handleContinue(
	gitCtx: GitContext,
	env: Map<string, string>,
	mergeDriver?: ContentMergeFn,
): Promise<RebaseOutcome> {
	let finalizedCommit: FinalizedRebaseCommit | undefined;

	const state = await readRebaseState(gitCtx);
	if (!state) {
		return noRebaseInProgress(gitCtx);
	}

	const index = await readIndex(gitCtx);

	// Check for unresolved conflicts
	if (hasConflicts(index)) {
		return { kind: "unmergedContinue" };
	}

	// Check if REBASE_HEAD still exists (user hasn't committed yet)
	const rebaseHeadHash = await resolveRef(gitCtx, "REBASE_HEAD");

	if (rebaseHeadHash) {
		// If REBASE_HEAD exists, decide whether we need to create the current
		// replayed commit now (index differs from HEAD) or only advance state.
		// Note: the conflicting entry has already been moved from todo to done
		// (state is advanced before pick), so don't check todo.length.
		const headHash = await resolveHead(gitCtx);
		if (!headHash) {
			return { kind: "fatal", message: "Cannot read HEAD" };
		}
		const headCommit = await readCommit(gitCtx, headHash);
		const stage0Entries = getStage0Entries(index);
		const indexTree = await buildTreeFromIndex(gitCtx, stage0Entries);
		const needsCommit = indexTree !== headCommit.tree;

		// Check for staged changes without a pending conflict resolution.
		// Mirrors git's sequencer.c: if there are uncommitted changes but
		// no rebase-merge/message file (meaning no conflict was in
		// progress — e.g. the pick was rescheduled due to untracked
		// files), show the "staged changes" advisory error.
		// Note: this checks rebase-merge/message, NOT .git/MERGE_MSG.
		// MERGE_MSG is deleted by `git commit` during conflict resolution,
		// but rebase-merge/message persists until --continue processes it.
		const hasRebaseMsg = (await readStateFile(gitCtx, "rebase-merge/message")) !== null;
		if (needsCommit && !hasRebaseMsg) {
			return { kind: "stagedChangesContinue" };
		}

		if (needsCommit) {
			// User resolved conflicts but didn't finalize replayed commit yet.
			const originalCommit = await readCommit(gitCtx, rebaseHeadHash);

			// When CHERRY_PICK_HEAD exists (from a standalone cherry-pick
			// run mid-rebase), real git's sequencer uses its author info
			// instead of REBASE_HEAD's, because the internal `git commit`
			// sees CHERRY_PICK_HEAD and preserves that commit's author.
			const cherryPickHead = await resolveRef(gitCtx, "CHERRY_PICK_HEAD");
			const authorSource = cherryPickHead
				? await readCommit(gitCtx, cherryPickHead)
				: originalCommit;

			// Prefer rebase-merge/message (the authoritative source for the
			// replayed commit's message), then MERGE_MSG, then original.
			// MERGE_MSG may contain a stale message from an unrelated
			// command (e.g. `git merge` run mid-rebase), so it must NOT
			// take priority over the rebase-specific message file.
			let messageText: string | undefined;
			messageText =
				(await readStateFile(gitCtx, "rebase-merge/message")) ??
				(await readStateFile(gitCtx, "MERGE_MSG")) ??
				undefined;

			if (messageText) {
				messageText = stripCommentLines(messageText);
			}
			if (!messageText) {
				messageText = originalCommit.message;
			}

			const committerResult = await resolveCommitter(gitCtx, env);
			if (!committerResult.ok) return { kind: "fatal", message: committerResult.message };
			const committer = committerResult.committer;

			const message = ensureTrailingNewline(messageText);

			// Include MERGE_HEAD as additional parent if a merge was
			// started during the rebase (e.g. user ran `git merge`
			// between conflict resolution and `rebase --continue`).
			const parents: ObjectId[] = [headHash];
			const mergeHeadHash = await resolveRef(gitCtx, "MERGE_HEAD");
			if (mergeHeadHash) {
				parents.push(mergeHeadHash);
			}

			const signerResult = await resolveSigner(gitCtx);
			if (!signerResult.ok) return { kind: "signingFailed" };

			const commitHash = await writeCommitAndAdvance(
				gitCtx,
				indexTree,
				parents,
				authorSource.author,
				committer,
				message,
				signerResult.signer,
			);

			// Clean up merge state if present
			if (mergeHeadHash) {
				await deleteRef(gitCtx, "MERGE_HEAD");
				await deleteStateFile(gitCtx, "MERGE_MODE");
			}

			const continueSubject = firstLine(message);
			await logRef(
				gitCtx,
				env,
				"HEAD",
				headHash,
				commitHash,
				`rebase (continue): ${continueSubject}`,
			);

			// Gather the commit-summary data (matches git's print_commit_summary);
			// the command layer renders it and prepends it to stdout.
			const label = await headLabel(gitCtx);
			const showDate =
				authorSource.author.timestamp !== committer.timestamp ||
				authorSource.author.timezone !== committer.timezone;
			const shortHash = await uniqueAbbrev(gitCtx, commitHash);
			const stats = await gatherCommitStats(gitCtx, headCommit.tree, indexTree);
			finalizedCommit = {
				oneLiner: { branchName: label, shortHash, message },
				author: authorSource.author,
				committer,
				showDate,
				stats,
			};
		}

		const finishingFinalStep = state.todo.length === 0;

		// Clean up step state. A `--continue` commits the resolved pick without
		// resetting, so (unlike `--skip`/`--abort`) it leaves a lingering
		// REVERT_HEAD in place — real git keeps that revert resumable across the
		// rest of the rebase and after it finishes.
		if (!finishingFinalStep) {
			await deleteRef(gitCtx, "REBASE_HEAD");
		}
		await deleteRef(gitCtx, "CHERRY_PICK_HEAD");
		await deleteStateFile(gitCtx, "MERGE_MSG");
		await deleteStateFile(gitCtx, "rebase-merge/message");
	}

	// State was already advanced when the pick was attempted (before
	// conflict), so no need to advance again. Just continue.
	const loop = await runPickLoop(gitCtx, env, mergeDriver);
	const outcome = await buildLoopOutcome(gitCtx, env, loop, []);
	if (finalizedCommit && (outcome.kind === "rebased" || outcome.kind === "stopped")) {
		outcome.finalizedCommit = finalizedCommit;
	}
	return outcome;
}

// ── --skip ──────────────────────────────────────────────────────────

export async function handleSkip(
	gitCtx: GitContext,
	env: Map<string, string>,
	mergeDriver?: ContentMergeFn,
): Promise<RebaseOutcome> {
	const state = await readRebaseState(gitCtx);
	if (!state) {
		return noRebaseInProgress(gitCtx);
	}

	// Hard reset to current HEAD (discard in-progress merge)
	const headHash = await resolveHead(gitCtx);
	if (!headHash) {
		return { kind: "skipNoHead" };
	}

	const headCommit = await readCommit(gitCtx, headHash);
	const currentIndex = await readIndex(gitCtx);
	const result = await resetHard(gitCtx, headCommit.tree, currentIndex);
	if (result.success) {
		await writeIndex(gitCtx, { version: 2, entries: result.newEntries });
		await applyWorktreeOps(gitCtx, result.worktreeOps);
	}

	// Clean up step refs (including any merge/cherry-pick/revert started mid-rebase)
	await deleteRef(gitCtx, "REBASE_HEAD");
	await deleteRef(gitCtx, "CHERRY_PICK_HEAD");
	await deleteRef(gitCtx, "REVERT_HEAD");
	await deleteRef(gitCtx, "MERGE_HEAD");
	await deleteStateFile(gitCtx, "MERGE_MSG");
	await deleteStateFile(gitCtx, "MERGE_MODE");
	await deleteStateFile(gitCtx, "rebase-merge/message");

	// State was already advanced when the pick was attempted (before
	// conflict), so no need to advance again. Just continue.
	const loop = await runPickLoop(gitCtx, env, mergeDriver);
	return buildLoopOutcome(gitCtx, env, loop, []);
}
