import type { GitExtensions } from "../git.ts";
import {
	abbreviateHash,
	type CommandResult,
	comparePaths,
	ensureTrailingNewline,
	err,
	fatal,
	firstLine,
	formatCommitOneLiner,
	hasStagedChanges,
	isCommandError,
	requireCommit,
	requireCommitter,
	requireGitContext,
	requireHead,
	writeCommitAndAdvance,
} from "../lib/command-utils.ts";
import { formatCommitSummary } from "../lib/commit-summary.ts";
import {
	getConflictedPaths,
	getStage0Entries,
	hasConflicts,
	readIndex,
	writeIndex,
} from "../lib/index.ts";
import { mergeOrtNonRecursive } from "../lib/merge-ort.ts";
import { readCommit } from "../lib/object-db.ts";
import {
	clearAllOperationState,
	clearDetachPoint,
	deleteStateFile,
	readStateFile,
	writeStateFile,
} from "../lib/operation-state.ts";
import { computePatchId } from "../lib/patch-id.ts";
import {
	advanceRebaseState,
	cleanupRebaseState,
	collectRebaseSymmetricPlan,
	isRebaseInProgress,
	type RebaseState,
	type RebaseTodoEntry,
	readRebaseState,
	writeRebaseConflictMeta,
	writeRebaseState,
} from "../lib/rebase.ts";
import { logRef } from "../lib/reflog.ts";
import {
	advanceBranchRef,
	branchNameFromRef,
	createSymbolicRef,
	deleteRef,
	readHead,
	resolveHead,
	resolveRef,
	updateRef,
} from "../lib/refs.ts";
import { buildTreeFromIndex, flattenTree, flattenTreeToMap } from "../lib/tree-ops.ts";
import type { GitContext, Index, ObjectId } from "../lib/types.ts";
import {
	applyWorktreeOps,
	checkoutTrees,
	formatErrors,
	type RejectedPath,
	resetHard,
	UnpackError,
} from "../lib/unpack-trees.ts";
import { diffIndexToWorkTree, walkWorkTree } from "../lib/worktree.ts";
import { a, type Command, f, o } from "../parse/index.ts";

/**
 * Return the display label for the current HEAD — either the branch name
 * (e.g. "dev-uxvs") or "detached HEAD".
 */
async function headLabel(gitCtx: GitContext): Promise<string> {
	const head = await readHead(gitCtx);
	if (head?.type === "symbolic") {
		return branchNameFromRef(head.target);
	}
	return "detached HEAD";
}

function upToDateMessage(branchName: string): string {
	if (branchName === "HEAD") return "HEAD is up to date.\n";
	return `Current branch ${branchName} is up to date.\n`;
}

/**
 * Check whether resetting the worktree to targetTree would overwrite
 * untracked files. Returns an error result if so, null if safe.
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
): Promise<CommandResult | null> {
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

	if (rejected.length > 0) {
		const errorOutput = formatErrors(rejected, {
			errorExitCode: 1,
			operationName: "checkout",
			actionHint: "switch branches",
		});
		return err(`${errorOutput.stderr}error: could not detach HEAD\n`);
	}

	return null;
}

/**
 * Check whether aborting (resetting to origHead tree) would overwrite
 * untracked files. Produces the error format git uses for reset_head():
 *
 *   error: The following untracked working tree files would be overwritten by reset:
 *       <file>
 *   Please move or remove them before you reset.
 *   Aborting
 *   fatal: could not move back to <hash>
 */
async function checkAbortUntrackedConflicts(
	gitCtx: GitContext,
	targetTree: ObjectId,
	currentIndex: Index,
	origHead: ObjectId,
): Promise<CommandResult | null> {
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

	if (rejected.length > 0) {
		const errorOutput = formatErrors(rejected, {
			errorExitCode: 128,
			operationName: "reset",
			actionHint: "reset",
		});
		return {
			stdout: "",
			stderr: `${errorOutput.stderr}fatal: could not move back to ${origHead}\n`,
			exitCode: 128,
		};
	}

	return null;
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
 * Format the error message for untracked files blocking a rebase pick.
 * Matches real git's sequencer output for this case.
 */
function formatUntrackedMergeError(blockedPaths: string[], entry: RebaseTodoEntry): string {
	const fileList = blockedPaths.map((p) => `\t${p}`).join("\n");
	return (
		`error: The following untracked working tree files would be overwritten by merge:\n${fileList}\n` +
		"Please move or remove them before you merge.\nAborting\n" +
		`hint: Could not execute the todo command\nhint:\nhint:     pick ${entry.hash} # ${entry.subject}\nhint:\n` +
		"hint: It has been rescheduled; To edit the command before continuing, please\n" +
		"hint: edit the todo list first:\nhint:\n" +
		"hint:     git rebase --edit-todo\nhint:     git rebase --continue\n"
	);
}

async function writeRebaseFfReflog(
	gitCtx: GitContext,
	env: Map<string, string>,
	origHead: ObjectId,
	targetHash: ObjectId,
	headName: string,
	upstreamArg: string,
): Promise<void> {
	await logRef(
		gitCtx,
		env,
		"HEAD",
		origHead,
		targetHash,
		`rebase (start): checkout ${upstreamArg}`,
	);
	if (headName !== "detached HEAD") {
		await logRef(
			gitCtx,
			env,
			headName,
			origHead,
			targetHash,
			`rebase (finish): ${headName} onto ${targetHash}`,
		);
		await logRef(
			gitCtx,
			env,
			"HEAD",
			targetHash,
			targetHash,
			`rebase (finish): returning to ${headName}`,
		);
	}
}

/**
 * Fast-forward the worktree, index, and branch ref to a target commit.
 * Checks for untracked file conflicts first. Returns an error result
 * if the checkout is blocked, null on success.
 */
async function fastForwardTo(
	gitCtx: GitContext,
	targetHash: ObjectId,
	currentIndex: Index,
	headName: string,
): Promise<CommandResult | null> {
	const targetCommit = await readCommit(gitCtx, targetHash);

	const untrackedErr = await checkUntrackedConflicts(gitCtx, targetCommit.tree, currentIndex);
	if (untrackedErr) return untrackedErr;

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

export function registerRebaseCommand(parent: Command, ext?: GitExtensions) {
	parent.command("rebase", {
		description: "Reapply commits on top of another base tip",
		args: [a.string().name("upstream").describe("Upstream branch to rebase onto").optional()],
		options: {
			onto: o.string().describe("Starting point at which to create new commits"),
			abort: f().describe("Abort the current rebase operation"),
			continue: f().describe("Continue the rebase after conflict resolution"),
			skip: f().describe("Skip the current patch and continue"),
		},
		handler: async (args, ctx) => {
			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;
			const gitCtx = gitCtxOrError;

			// ── Resume operations ────────────────────────────────────
			if (args.abort) {
				return handleAbort(gitCtx, ctx.env);
			}
			if (args.continue) {
				return handleContinue(gitCtx, ctx.env);
			}
			if (args.skip) {
				return handleSkip(gitCtx, ctx.env);
			}

			// ── Starting a new rebase ────────────────────────────────

			const upstreamArg: string | undefined = args.upstream;
			if (!upstreamArg) {
				return fatal("no upstream configured and no upstream argument given");
			}

			// Block if concurrent operations are in progress
			if (await isRebaseInProgress(gitCtx)) {
				return fatal(
					'It seems that there is already a rebase-merge directory, and\nI wonder if you are in the middle of another rebase.  If that is the\ncase, please try\n\tgit rebase (--continue | --abort | --skip)\nIf that is not the case, please\n\trm -fr ".git/rebase-merge"\nand run me again.  I am stopping in case you still have something\nvaluable there.\n',
				);
			}

			// Note: real git does NOT explicitly check for MERGE_HEAD or
			// CHERRY_PICK_HEAD here. The worktree check below (staged/unstaged
			// changes) handles those cases naturally — conflict entries (stages
			// 1-3) are skipped by the diff machinery, so an index with only
			// conflict entries is considered "clean". This allows rebase to
			// start even during an in-progress cherry-pick with conflicts.

			// Resolve current HEAD
			const origHead = await requireHead(gitCtx);
			if (isCommandError(origHead)) return origHead;

			// Save head_name (the symbolic branch, or "detached HEAD")
			const head = await readHead(gitCtx);
			const headName = head?.type === "symbolic" ? head.target : "detached HEAD";
			const branchName = head?.type === "symbolic" ? branchNameFromRef(head.target) : "HEAD";

			// Resolve upstream (peel tags to commit)
			const upstreamResult = await requireCommit(
				gitCtx,
				upstreamArg,
				`invalid upstream '${upstreamArg}'`,
			);
			if (isCommandError(upstreamResult)) return upstreamResult;
			const upstreamHash = upstreamResult.hash;

			// Resolve onto (defaults to upstream)
			let ontoHash: ObjectId;
			const ontoArg: string | undefined = args.onto;
			if (ontoArg) {
				const ontoResult = await requireCommit(
					gitCtx,
					ontoArg,
					`Does not point to a valid commit: '${ontoArg}'`,
				);
				if (isCommandError(ontoResult)) return ontoResult;
				ontoHash = ontoResult.hash;
			} else {
				ontoHash = upstreamHash;
			}

			// ── Clean worktree check ─────────────────────────────────
			// Real git checks this before up-to-date detection.
			// Only staged changes and unstaged tracked-file changes matter;
			// untracked files are ignored.
			const currentIndex = await readIndex(gitCtx);

			// Block if the index has unmerged entries (stages 1-3).
			// Real git's refresh_index reports these as "<path>: needs merge"
			// on stdout and then require_clean_work_tree bails.
			const unmergedPaths = getConflictedPaths(currentIndex).sort();
			if (unmergedPaths.length > 0) {
				return {
					stdout: unmergedPaths.map((p) => `${p}: needs merge\n`).join(""),
					stderr:
						"error: cannot rebase: You have unstaged changes.\n" +
						"error: additionally, your index contains uncommitted changes.\n" +
						"error: Please commit or stash them.\n",
					exitCode: 1,
				};
			}

			const headCommit = await readCommit(gitCtx, origHead);
			const headMap = await flattenTreeToMap(gitCtx, headCommit.tree);

			if (gitCtx.workTree) {
				const hasStaged = hasStagedChanges(currentIndex, headMap);

				// Check for unstaged changes (worktree differs from index)
				// Only tracked files (modified/deleted), NOT untracked files
				const wtDiffs = await diffIndexToWorkTree(gitCtx, currentIndex);
				const hasUnstaged = wtDiffs.some((d) => d.status === "modified" || d.status === "deleted");

				if (hasStaged || hasUnstaged) {
					const lines: string[] = [];
					if (hasUnstaged) {
						lines.push("error: cannot rebase: You have unstaged changes.");
					}
					if (hasStaged) {
						if (hasUnstaged) {
							lines.push("error: additionally, your index contains uncommitted changes.");
						} else {
							lines.push("error: cannot rebase: Your index contains uncommitted changes.");
						}
					}
					lines.push("error: Please commit or stash them.");
					return err(`${lines.join("\n")}\n`);
				}
			}

			// pre-rebase hook
			if (ext?.hooks) {
				const abort = await ext.hooks.emitPre("pre-rebase", {
					upstream: upstreamArg,
					branch: head?.type === "symbolic" ? branchNameFromRef(head.target) : null,
				});
				if (abort) {
					return { stdout: "", stderr: abort.message ?? "", exitCode: 1 };
				}
			}

			// ── Compute commit range ─────────────────────────────────
			const plan = await collectRebaseSymmetricPlan(gitCtx, upstreamHash, origHead);
			const commits = plan.right;

			// ── Empty range: up-to-date or fast-forward ─────────────
			if (commits.length === 0) {
				if (ontoHash !== origHead) {
					const ffErr = await fastForwardTo(gitCtx, ontoHash, currentIndex, headName);
					if (ffErr) return ffErr;
					await writeRebaseFfReflog(gitCtx, ctx.env, origHead, ontoHash, headName, upstreamArg);
					return {
						stdout: "",
						stderr: `Successfully rebased and updated ${headName}.\n`,
						exitCode: 0,
					};
				}
				return {
					stdout: upToDateMessage(branchName),
					stderr: "",
					exitCode: 0,
				};
			}

			// ── Cherry-pick skip detection ──────────────────────────
			// Filter out commits whose patches already exist in the upstream.
			// Git uses symmetric difference: the "left side" is commits
			// reachable from upstream but NOT from HEAD (origHead).
			const skippedWarnings: string[] = [];

			// Collect commits in HEAD..upstream (the "left side")
			const leftSideCommits = plan.left;

			// Compute patch-ids for the left side
			const leftPatchIds = new Set<string>();
			for (const c of leftSideCommits) {
				const pid = await computePatchId(gitCtx, c.hash);
				if (pid) leftPatchIds.add(pid);
			}

			// Filter commits: skip those whose patch-id matches a left-side commit
			const filteredCommits: typeof commits = [];
			if (leftPatchIds.size > 0) {
				for (const c of commits) {
					const pid = await computePatchId(gitCtx, c.hash);
					if (pid && leftPatchIds.has(pid)) {
						skippedWarnings.push(
							`warning: skipped previously applied commit ${abbreviateHash(c.hash)}`,
						);
					} else {
						filteredCommits.push(c);
					}
				}
			} else {
				filteredCommits.push(...commits);
			}

			// Build stderr with skip warnings + hint
			let skipStderr = "";
			if (skippedWarnings.length > 0) {
				skipStderr =
					`${skippedWarnings.join("\n")}\n` +
					"hint: use --reapply-cherry-picks to include skipped commits\n" +
					'hint: Disable this message with "git config set advice.skippedCherryPicks false"\n';
			}

			// If all commits were skipped (cherry-pick equivalents),
			// fast-forward to onto if needed and report success.
			if (filteredCommits.length === 0) {
				if (ontoHash !== origHead) {
					const ffErr = await fastForwardTo(gitCtx, ontoHash, currentIndex, headName);
					if (ffErr) {
						ffErr.stderr = skipStderr + ffErr.stderr;
						return ffErr;
					}
					await writeRebaseFfReflog(gitCtx, ctx.env, origHead, ontoHash, headName, upstreamArg);
				}
				return {
					stdout: "",
					stderr: `${skipStderr}Successfully rebased and updated ${headName}.\n`,
					exitCode: 0,
				};
			}

			// ── Build todo list ──────────────────────────────────────
			const todo: RebaseTodoEntry[] = filteredCommits.map((c) => ({
				hash: c.hash,
				subject: firstLine(c.commit.message),
			}));

			// ── Skip unnecessary picks (fast-forward optimization) ───
			// Mirrors git's skip_unnecessary_picks() in sequencer.c.
			// Scan the todo list from the beginning. While each pick's
			// parent matches the current base, advance the base to that
			// commit (avoiding a cherry-pick that would produce an
			// identical result). This changes the checkout target from
			// the original onto to the last fast-forwardable commit.
			let checkoutTarget = ontoHash;
			let skippedCount = 0;
			for (const entry of todo) {
				const commit = await readCommit(gitCtx, entry.hash);
				// Stop at merge commits (they can't be fast-forwarded)
				if (commit.parents.length > 1) break;
				// Stop at root commits
				if (commit.parents.length === 0) break;
				// Stop if parent doesn't match current base
				if (commit.parents[0] !== checkoutTarget) break;
				checkoutTarget = entry.hash;
				skippedCount++;
			}
			// Remove skipped entries from the front of the todo list
			const done: RebaseTodoEntry[] = todo.splice(0, skippedCount);

			// If we skipped all commits, the rebase is just a fast-forward
			if (todo.length === 0) {
				if (checkoutTarget === origHead) {
					return {
						stdout: upToDateMessage(branchName),
						stderr: skipStderr,
						exitCode: 0,
					};
				}
				const ffErr = await fastForwardTo(gitCtx, checkoutTarget, currentIndex, headName);
				if (ffErr) {
					ffErr.stderr = skipStderr + ffErr.stderr;
					return ffErr;
				}
				await writeRebaseFfReflog(gitCtx, ctx.env, origHead, checkoutTarget, headName, upstreamArg);
				return {
					stdout: "",
					stderr: `${skipStderr}Successfully rebased and updated ${headName}.\n`,
					exitCode: 0,
				};
			}

			// ── Detach HEAD onto target ──────────────────────────────
			// Checkout the target tree and detach HEAD. If untracked files
			// would be overwritten, bail before creating rebase state.
			// Note: we write directly to HEAD (not the branch ref) to detach.
			const ffErr = await fastForwardTo(gitCtx, checkoutTarget, currentIndex, "detached HEAD");
			if (ffErr) {
				ffErr.stderr = skipStderr + ffErr.stderr;
				return ffErr;
			}

			await logRef(
				gitCtx,
				ctx.env,
				"HEAD",
				origHead,
				checkoutTarget,
				`rebase (start): checkout ${upstreamArg}`,
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
			};
			await writeRebaseState(gitCtx, state);
			await updateRef(gitCtx, "ORIG_HEAD", origHead);

			// ── Run the pick loop ────────────────────────────────────
			const pickResult = await runPickLoop(gitCtx, ctx.env);

			// Prepend skip warnings to stderr
			if (skipStderr) {
				pickResult.stderr = skipStderr + pickResult.stderr;
			}
			return pickResult;
		},
	});
}

// ── Pick loop — replays commits from the todo list ──────────────────

async function runPickLoop(gitCtx: GitContext, env: Map<string, string>): Promise<CommandResult> {
	const stderrLines: string[] = [];
	const stdoutLines: string[] = [];

	for (;;) {
		const state = await readRebaseState(gitCtx);
		if (!state || state.todo.length === 0) break;

		const entry = state.todo[0];
		if (!entry) break;

		// Emit progress (uses \r so terminal overwrites the line)
		stderrLines.push(`Rebasing (${state.msgnum + 1}/${state.end})\r`);

		// Advance state BEFORE the pick (matching real git: the done file
		// records attempted picks, not just successful ones).
		await advanceRebaseState(gitCtx);

		const result = await pickOneCommit(gitCtx, entry, env);

		if (result.conflict) {
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
			// Stop — write conflict info
			if (result.stdout) stdoutLines.push(result.stdout);
			stderrLines.push(result.stderr);
			return {
				stdout: stdoutLines.join(""),
				stderr: stderrLines.join(""),
				exitCode: 1,
			};
		}

		if (result.stdout) {
			stdoutLines.push(result.stdout);
		}
		if (result.stderr) {
			stderrLines.push(result.stderr);
		}
	}

	// All commits applied — finish
	return finishRebase(gitCtx, stderrLines, env);
}

// ── Pick a single commit (three-way merge) ──────────────────────────

interface PickResult {
	conflict: boolean;
	stdout: string;
	stderr: string;
	rescheduleCurrent?: boolean;
}

async function pickOneCommit(
	gitCtx: GitContext,
	entry: RebaseTodoEntry,
	env: Map<string, string>,
): Promise<PickResult> {
	const theirsHash = entry.hash;
	const theirsCommit = await readCommit(gitCtx, theirsHash);
	const parentHash = theirsCommit.parents.length > 0 ? theirsCommit.parents[0] : null;
	const parentCommit = parentHash ? await readCommit(gitCtx, parentHash) : null;

	const headHash = await resolveHead(gitCtx);
	if (!headHash) {
		return {
			conflict: true,
			stdout: "",
			stderr: "fatal: no HEAD commit during rebase\n",
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
				conflict: true,
				stdout: "",
				stderr: "fatal: missing parent commit during rebase\n",
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
				conflict: true,
				stdout: "",
				stderr: formatUntrackedMergeError(blockedPaths, entry),
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
		await logRef(gitCtx, env, "HEAD", headHash, theirsHash, `rebase (pick): ${entry.subject}`);

		return { conflict: false, stdout: "", stderr: "" };
	}

	const headCommit = await readCommit(gitCtx, headHash);

	// Three-way merge: base = parent, ours = HEAD, theirs = commit
	const baseTree = parentCommit ? parentCommit.tree : null;
	const shortHash = abbreviateHash(theirsHash);
	const subject = firstLine(theirsCommit.message);
	const labels = {
		a: "HEAD",
		b: subject ? `${shortHash} (${subject})` : shortHash,
	};

	const mergeResult = await mergeOrtNonRecursive(
		gitCtx,
		baseTree,
		headCommit.tree,
		theirsCommit.tree,
		labels,
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
			conflict: true,
			stdout: "",
			stderr: formatUntrackedMergeError(blockedPaths, entry),
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

		const mergeOutput = mergeResult.messages.join("\n");

		return {
			conflict: true,
			stdout: mergeOutput ? `${mergeOutput}\n` : "",
			stderr:
				`error: could not apply ${shortHash}... ${entry.subject}\n` +
				"hint: Resolve all conflicts manually, mark them as resolved with\n" +
				'hint: "git add/rm <conflicted_files>", then run "git rebase --continue".\n' +
				'hint: You can instead skip this commit: run "git rebase --skip".\n' +
				'hint: To abort and get back to the state before "git rebase", run "git rebase --abort".\n' +
				'hint: Disable this message with "git config set advice.mergeConflict false"\n' +
				`Could not apply ${shortHash}... # ${entry.subject}\n`,
		};
	}

	// ── Clean pick — create commit ───────────────────────────────

	// Check if this commit would be empty (tree matches HEAD)
	if (mergedTreeHash === headCommit.tree) {
		return {
			conflict: false,
			stdout: "",
			stderr: `dropping ${theirsHash} ${entry.subject} -- patch contents already upstream\n`,
		};
	}

	const committerResult = await requireCommitter(gitCtx, env);
	if (isCommandError(committerResult)) {
		return { conflict: true, stdout: "", stderr: committerResult.stderr };
	}

	const pickCommitHash = await writeCommitAndAdvance(
		gitCtx,
		mergedTreeHash,
		[headHash],
		theirsCommit.author,
		committerResult,
		theirsCommit.message,
	);

	await logRef(gitCtx, env, "HEAD", headHash, pickCommitHash, `rebase (pick): ${entry.subject}`);

	return {
		conflict: false,
		stdout: "",
		stderr: "",
	};
}

// ── Finish rebase ───────────────────────────────────────────────────

async function finishRebase(
	gitCtx: GitContext,
	stderrLines: string[],
	env: Map<string, string>,
): Promise<CommandResult> {
	const state = await readRebaseState(gitCtx);
	if (!state) {
		return fatal("no rebase in progress");
	}

	const currentHead = await resolveHead(gitCtx);
	if (!currentHead) {
		return fatal("no HEAD during rebase finish");
	}

	// Update the original branch ref and re-attach HEAD
	if (state.headName !== "detached HEAD") {
		await updateRef(gitCtx, state.headName, currentHead);
		await createSymbolicRef(gitCtx, "HEAD", state.headName);
		await clearDetachPoint(gitCtx);

		await logRef(
			gitCtx,
			env,
			state.headName,
			state.origHead,
			currentHead,
			`rebase (finish): ${state.headName} onto ${state.onto}`,
		);
		await logRef(
			gitCtx,
			env,
			"HEAD",
			currentHead,
			currentHead,
			`rebase (finish): returning to ${state.headName}`,
		);
	}

	const refLabel = state.headName;
	const successMsg = `Successfully rebased and updated ${refLabel}.\n`;

	// Clean up all state (including any cherry-pick/merge started mid-rebase)
	await deleteRef(gitCtx, "REBASE_HEAD");
	await clearAllOperationState(gitCtx);
	await cleanupRebaseState(gitCtx);

	return {
		stdout: "",
		stderr: stderrLines.join("") + successMsg,
		exitCode: 0,
	};
}

// ── --abort ─────────────────────────────────────────────────────────

async function handleAbort(gitCtx: GitContext, env: Map<string, string>): Promise<CommandResult> {
	const state = await readRebaseState(gitCtx);
	if (!state) {
		return fatal("no rebase in progress");
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
	const untrackedErr = await checkAbortUntrackedConflicts(
		gitCtx,
		origCommit.tree,
		currentIndex,
		origHead,
	);
	if (untrackedErr) return untrackedErr;

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

	return {
		stdout: "",
		stderr: "",
		exitCode: 0,
	};
}

// ── --continue ──────────────────────────────────────────────────────

async function handleContinue(
	gitCtx: GitContext,
	env: Map<string, string>,
): Promise<CommandResult> {
	let continueStdout = "";

	const state = await readRebaseState(gitCtx);
	if (!state) {
		return fatal("no rebase in progress");
	}

	const index = await readIndex(gitCtx);

	// Check for unresolved conflicts
	if (hasConflicts(index)) {
		return err(
			"error: Committing is not possible because you have unmerged files.\nhint: Fix them up in the work tree, and then use 'git add <file>'\nhint: as appropriate to mark resolution and make a commit.\nfatal: Exiting because of an unresolved conflict.\n",
			128,
		);
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
			return fatal("Cannot read HEAD");
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
			return err(
				"error: you have staged changes in your working tree\n" +
					"If these changes are meant to be squashed into the previous commit, run:\n\n" +
					"  git commit --amend \n\n" +
					"If they are meant to go into a new commit, run:\n\n" +
					"  git commit \n\n" +
					"In both cases, once you're done, continue with:\n\n" +
					"  git rebase --continue\n\n",
			);
		}

		if (needsCommit) {
			// User resolved conflicts but didn't finalize replayed commit yet.
			const originalCommit = await readCommit(gitCtx, rebaseHeadHash);

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
			if (!messageText) {
				messageText = originalCommit.message;
			}

			const committer = await requireCommitter(gitCtx, env);
			if (isCommandError(committer)) return committer;

			const message = ensureTrailingNewline(messageText);

			// Include MERGE_HEAD as additional parent if a merge was
			// started during the rebase (e.g. user ran `git merge`
			// between conflict resolution and `rebase --continue`).
			const parents: ObjectId[] = [headHash];
			const mergeHeadHash = await resolveRef(gitCtx, "MERGE_HEAD");
			if (mergeHeadHash) {
				parents.push(mergeHeadHash);
			}

			const commitHash = await writeCommitAndAdvance(
				gitCtx,
				indexTree,
				parents,
				originalCommit.author,
				committer,
				message,
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

			// Output commit summary (matches git's print_commit_summary)
			const label = await headLabel(gitCtx);
			const summary = await formatCommitSummary(
				gitCtx,
				headCommit.tree,
				indexTree,
				originalCommit.author,
				committer,
				false, // showDate — rebase does not show Date line
			);
			continueStdout = `${formatCommitOneLiner(label, commitHash, message)}\n${summary}`;
		}

		// Clean up step state (including any cherry-pick/revert started mid-rebase)
		await deleteRef(gitCtx, "REBASE_HEAD");
		await deleteRef(gitCtx, "CHERRY_PICK_HEAD");
		await deleteRef(gitCtx, "REVERT_HEAD");
		await deleteStateFile(gitCtx, "MERGE_MSG");
		await deleteStateFile(gitCtx, "rebase-merge/message");
	}

	// State was already advanced when the pick was attempted (before
	// conflict), so no need to advance again. Just continue.
	const pickResult = await runPickLoop(gitCtx, env);
	if (continueStdout) {
		pickResult.stdout = continueStdout + pickResult.stdout;
	}
	return pickResult;
}

// ── --skip ──────────────────────────────────────────────────────────

async function handleSkip(gitCtx: GitContext, env: Map<string, string>): Promise<CommandResult> {
	const state = await readRebaseState(gitCtx);
	if (!state) {
		return fatal("no rebase in progress");
	}

	// Hard reset to current HEAD (discard in-progress merge)
	const headHash = await resolveHead(gitCtx);
	if (!headHash) {
		return {
			stdout: "",
			stderr:
				"error: could not determine HEAD revision\n" +
				"fatal: could not discard worktree changes\n",
			exitCode: 128,
		};
	}

	const headCommit = await readCommit(gitCtx, headHash);
	const currentIndex = await readIndex(gitCtx);
	const result = await resetHard(gitCtx, headCommit.tree, currentIndex);
	if (result.success) {
		await writeIndex(gitCtx, { version: 2, entries: result.newEntries });
		await applyWorktreeOps(gitCtx, result.worktreeOps);
	}

	// Clean up step refs (including any cherry-pick/revert started mid-rebase)
	await deleteRef(gitCtx, "REBASE_HEAD");
	await deleteRef(gitCtx, "CHERRY_PICK_HEAD");
	await deleteRef(gitCtx, "REVERT_HEAD");
	await deleteStateFile(gitCtx, "MERGE_MSG");
	await deleteStateFile(gitCtx, "rebase-merge/message");

	// State was already advanced when the pick was attempted (before
	// conflict), so no need to advance again. Just continue.
	return runPickLoop(gitCtx, env);
}
