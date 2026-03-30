import type { GitExtensions } from "../git.ts";
import { isRejection } from "../hooks.ts";
import {
	abbreviateHash,
	ensureTrailingNewline,
	err,
	fatal,
	firstLine,
	formatCommitOneLiner,
	handleOperationAbort,
	isCommandError,
	requireAuthor,
	requireCommitter,
	requireGitContext,
	requireHead,
	requireNoConflicts,
	stripCommentLines,
	writeCommitAndAdvance,
} from "../lib/command-utils.ts";
import { walkCommits } from "../lib/commit-walk.ts";
import { formatDiffStat } from "../lib/commit-summary.ts";
import { getConfigValue } from "../lib/config.ts";
import { formatDate } from "../lib/date.ts";
import { getConflictedPaths, getStage0Entries, readIndex } from "../lib/index.ts";
import { buildMergeMessage, findAllMergeBases, handleFastForward } from "../lib/merge.ts";
import { type ApplyMergeFailure, applyMergeResult, mergeOrtRecursive } from "../lib/merge-ort.ts";
import { peelToCommit, readCommit } from "../lib/object-db.ts";
import {
	clearMergeState,
	clearRevertState,
	deleteStateFile,
	readStateFile,
	writeStateFile,
} from "../lib/operation-state.ts";
import { logRef } from "../lib/reflog.ts";
import { branchNameFromRef, readHead, resolveRef, updateRef } from "../lib/refs.ts";
import { resolveRevision } from "../lib/rev-parse.ts";
import { buildTreeFromIndex } from "../lib/tree-ops.ts";
import type { GitContext, ObjectId } from "../lib/types.ts";
import { a, type Command, f, o } from "../parse/index.ts";

export function registerMergeCommand(parent: Command, ext?: GitExtensions) {
	parent.command("merge", {
		description: "Join two or more development histories together",
		args: [
			a.string().name("branch").describe("Branch to merge into the current branch").optional(),
		],
		options: {
			abort: f().describe("Abort the current in-progress merge"),
			continue: f().describe("Continue the merge after conflict resolution"),
			noFf: f().describe("Create a merge commit even when fast-forward is possible"),
			ffOnly: f().describe("Refuse to merge unless fast-forward is possible"),
			squash: f().describe("Apply merge result to worktree/index without creating a merge commit"),
			edit: f().describe("Edit the merge message (no-op, accepted for compatibility)"),
			message: o.string().alias("m").describe("Merge commit message"),
		},
		transformArgs: (tokens) => tokens.filter((t) => t !== "--ff"),
		handler: async (args, ctx) => {
			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;
			const gitCtx = gitCtxOrError;

			// ── --abort path ──────────────────────────────────────────
			if (args.abort) {
				return handleAbort(gitCtx, ctx.env);
			}

			// ── --continue path ──────────────────────────────────────
			if (args.continue) {
				return handleContinue(gitCtx, ctx.env, ext);
			}

			const branch: string | undefined = args.branch;
			if (!branch) {
				return fatal("you must specify a branch to merge");
			}

			// Resolve current HEAD first
			const headHash = await requireHead(gitCtx);
			if (isCommandError(headHash)) return headHash;

			// Check for unmerged index entries first (matches real git order)
			const currentIndex = await readIndex(gitCtx);
			const conflictErr = requireNoConflicts(currentIndex, "Merging");
			if (conflictErr) return conflictErr;

			// Check for in-progress merge (no unmerged entries, but MERGE_HEAD still present)
			const existingMergeHead = await resolveRef(gitCtx, "MERGE_HEAD");
			if (existingMergeHead) {
				return fatal(
					"You have not concluded your merge (MERGE_HEAD exists).\nPlease, commit your changes before you merge.",
				);
			}

			// Check for in-progress cherry-pick
			const existingCherryPick = await resolveRef(gitCtx, "CHERRY_PICK_HEAD");
			if (existingCherryPick) {
				return fatal(
					"You have not concluded your cherry-pick (CHERRY_PICK_HEAD exists).\nPlease, commit your changes before you merge.",
				);
			}

			// Note: real git does NOT block merge during an active rebase.

			// Resolve the branch to merge (peel tags to commit)
			const resolvedHash = await resolveRevision(gitCtx, branch);
			if (!resolvedHash) {
				return err(`merge: ${branch} - not something we can merge\n`);
			}
			const theirsHash = await peelToCommit(gitCtx, resolvedHash);

			// Find merge bases for already-up-to-date / fast-forward checks
			const bases = await findAllMergeBases(gitCtx, headHash, theirsHash);
			const baseCommit = bases[0] ?? null;

			// Reject unrelated histories (no common ancestor)
			if (bases.length === 0) {
				return fatal("refusing to merge unrelated histories");
			}

			// Already up to date: base == theirs (or both are the same)
			if (baseCommit === theirsHash) {
				await deleteStateFile(gitCtx, "MERGE_MSG");
				const suffix = args.squash ? " (nothing to squash)" : "";
				return {
					stdout: `Already up to date.${suffix}\n`,
					stderr: "",
					exitCode: 0,
				};
			}

			// Resolve effective FF mode: CLI flags override merge.ff config
			let noFf = !!args.noFf;
			let ffOnly = !!args.ffOnly;
			if (!args.noFf && !args.ffOnly) {
				const mergeFFConfig = await getConfigValue(gitCtx, "merge.ff");
				if (mergeFFConfig === "false") noFf = true;
				else if (mergeFFConfig === "only") ffOnly = true;
			}

			if (noFf && ffOnly) {
				return fatal("--no-ff and --ff-only are incompatible");
			}

			const isFastForward = baseCommit === headHash && !noFf;

			if (ffOnly && !isFastForward) {
				return err(
					"hint: Diverging branches can't be fast-forwarded, you need to either:\n" +
						"hint:\n" +
						"hint: \tgit merge --no-ff\n" +
						"hint:\n" +
						"hint: or:\n" +
						"hint:\n" +
						"hint: \tgit rebase\n" +
						"hint:\n" +
						'hint: Disable this message with "git config set advice.diverging false"\n' +
						"fatal: Not possible to fast-forward, aborting.\n",
					128,
				);
			}

			// Real git clears revert state once it commits to attempting
			// the merge (past unrelated-histories, already-up-to-date,
			// and --ff-only rejection).
			if (await resolveRef(gitCtx, "REVERT_HEAD")) {
				await clearRevertState(gitCtx);
			}

			if (isFastForward && !args.squash) {
				const head = await readHead(gitCtx);
				const result = await handleFastForward(gitCtx, headHash, theirsHash);
				if (result.exitCode === 0 && args.message) {
					result.stdout = result.stdout.replace(
						/^Fast-forward$/m,
						"Fast-forward (no commit created; -m option ignored)",
					);
				}
				if (result.exitCode === 0) {
					await deleteStateFile(gitCtx, "MERGE_MSG");
					const refName = head?.type === "symbolic" ? head.target : "HEAD";
					await logRef(
						gitCtx,
						ctx.env,
						refName,
						headHash,
						theirsHash,
						`merge ${branch}: Fast-forward${args.message ? " (no commit created; -m option ignored)" : ""}`,
						head?.type === "symbolic",
					);
					await ext?.hooks?.postMerge?.({
						repo: gitCtx,
						headHash,
						theirsHash,
						strategy: "fast-forward",
						commitHash: null,
					});
				}
				return result;
			}

			const rawMessage = args.message;
			const customMessage = rawMessage
				? rawMessage.endsWith("\n")
					? rawMessage
					: `${rawMessage}\n`
				: undefined;

			if (args.squash) {
				return handleSquashMerge(gitCtx, headHash, theirsHash, branch, ctx.env, ext, customMessage);
			}

			return handleThreeWayMerge(
				gitCtx,
				headHash,
				theirsHash,
				branch,
				ctx.env,
				noFf,
				ext,
				customMessage,
			);
		},
	});
}

// ── Three-way merge ─────────────────────────────────────────────────

async function handleThreeWayMerge(
	gitCtx: GitContext,
	headHash: ObjectId,
	theirsHash: ObjectId,
	branchName: string,
	env: Map<string, string>,
	noFf = false,
	ext?: GitExtensions,
	customMessage?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const headCommit = await readCommit(gitCtx, headHash);

	// Determine current branch name for labels
	const head = await readHead(gitCtx);
	const currentBranch = head?.type === "symbolic" ? branchNameFromRef(head.target) : "HEAD";

	const conflictStyle = ((await getConfigValue(gitCtx, "merge.conflictstyle")) ?? "merge") as
		| "merge"
		| "diff3";
	const labels = { a: "HEAD", b: branchName, conflictStyle };

	// Step 1: Run merge-ort (recursive — handles criss-cross merges)
	const result = await mergeOrtRecursive(gitCtx, headHash, theirsHash, labels, ext?.mergeDriver);

	// Step 2: Apply merge result to index and worktree
	const applyResult = await applyMergeResult(gitCtx, result, headCommit.tree, {
		labels,
		errorExitCode: 2,
		operationName: "merge",
	});

	if (!applyResult.ok) {
		await deleteStateFile(gitCtx, "MERGE_MSG");
		// Real git writes a no-op reflog entry for three-way merge failures
		// (dirty worktree) because the reflog is written before the worktree
		// update is attempted. Squash merges don't write one because they
		// never update HEAD.
		if (applyResult.failureKind === "staged" && head?.type === "symbolic") {
			await logRef(gitCtx, env, "HEAD", headHash, headHash, `merge ${branchName}: updating HEAD`);
		}
		return applyResult as ApplyMergeFailure;
	}

	// Step 3: Handle conflicts or create merge commit
	if (result.conflicts.length > 0) {
		await updateRef(gitCtx, "MERGE_HEAD", theirsHash);
		await updateRef(gitCtx, "ORIG_HEAD", headHash);

		let mergeMsg = customMessage ?? (await buildMergeMessage(gitCtx, branchName, currentBranch));
		const msgEventConflict = {
			repo: gitCtx,
			message: mergeMsg,
			treeHash: applyResult.mergedTreeHash,
			headHash,
			theirsHash,
		};
		const msgRejConflict = await ext?.hooks?.mergeMsg?.(msgEventConflict);
		if (isRejection(msgRejConflict))
			return { stdout: "", stderr: msgRejConflict.message ?? "", exitCode: 1 };
		mergeMsg = msgEventConflict.message;
		// Build conflict list from index entries with non-zero stages (same as Git)
		const conflictPaths = getConflictedPaths({
			version: 2,
			entries: result.entries,
		}).sort();
		mergeMsg += `\n# Conflicts:\n${conflictPaths.map((p) => `#\t${p}`).join("\n")}\n`;
		await writeStateFile(gitCtx, "MERGE_MSG", mergeMsg);

		await writeStateFile(gitCtx, "MERGE_MODE", noFf ? "no-ff" : "");

		const mergeOutput = [
			...result.messages,
			"Automatic merge failed; fix conflicts and then commit the result.",
		];

		return {
			stdout: `${mergeOutput.join("\n")}\n`,
			stderr: "",
			exitCode: 1,
		};
	}

	// Clean merge — create merge commit
	await deleteStateFile(gitCtx, "MERGE_MSG");
	const treeHash = applyResult.mergedTreeHash;

	const author = await requireAuthor(gitCtx, env);
	if (isCommandError(author)) return author;
	const committer = await requireCommitter(gitCtx, env);
	if (isCommandError(committer)) return committer;

	let mergeMsg = customMessage ?? (await buildMergeMessage(gitCtx, branchName, currentBranch));
	const msgEvent = {
		repo: gitCtx,
		message: mergeMsg,
		treeHash,
		headHash,
		theirsHash,
	};
	const msgRej = await ext?.hooks?.mergeMsg?.(msgEvent);
	if (isRejection(msgRej)) return { stdout: "", stderr: msgRej.message ?? "", exitCode: 1 };
	mergeMsg = msgEvent.message;

	const mcRej = await ext?.hooks?.preMergeCommit?.({
		repo: gitCtx,
		message: mergeMsg,
		treeHash,
		headHash,
		theirsHash,
	});
	if (isRejection(mcRej)) return { stdout: "", stderr: mcRej.message ?? "", exitCode: 1 };

	const commitHash = await writeCommitAndAdvance(
		gitCtx,
		treeHash,
		[headHash, theirsHash],
		author,
		committer,
		mergeMsg,
	);

	const refName = head?.type === "symbolic" ? head.target : "HEAD";
	await logRef(
		gitCtx,
		env,
		refName,
		headHash,
		commitHash,
		`merge ${branchName}: Merge made by the 'ort' strategy.`,
		head?.type === "symbolic",
	);

	await ext?.hooks?.postMerge?.({
		repo: gitCtx,
		headHash,
		theirsHash,
		strategy: "three-way",
		commitHash,
	});

	const diffstat = await formatDiffStat(gitCtx, headCommit.tree, treeHash);
	const mergeMessages = result.messages.length > 0 ? `${result.messages.join("\n")}\n` : "";
	return {
		stdout: `${mergeMessages}Merge made by the 'ort' strategy.\n${diffstat}`,
		stderr: "",
		exitCode: 0,
	};
}

// ── Squash merge ────────────────────────────────────────────────────

/**
 * Build the SQUASH_MSG content matching real git's `squash_message()`:
 * lists each commit in HEAD..theirs in medium format (hash, author, date,
 * indented message).
 */
async function buildSquashMessageLog(
	gitCtx: GitContext,
	headHash: ObjectId,
	theirsHash: ObjectId,
): Promise<string> {
	const lines: string[] = [];
	for await (const entry of walkCommits(gitCtx, theirsHash, { exclude: [headHash] })) {
		lines.push(`commit ${entry.hash}`);
		if (entry.commit.parents.length > 1) {
			lines.push(`Merge: ${entry.commit.parents.map((p) => p.slice(0, 7)).join(" ")}`);
		}
		const a = entry.commit.author;
		lines.push(`Author: ${a.name} <${a.email}>`);
		lines.push(`Date:   ${formatDate(a.timestamp, a.timezone)}`);
		lines.push("");
		for (const msgLine of entry.commit.message.replace(/\n+$/, "").split("\n")) {
			lines.push(`    ${msgLine}`);
		}
		lines.push("");
	}
	return lines.join("\n");
}

async function handleSquashMerge(
	gitCtx: GitContext,
	headHash: ObjectId,
	theirsHash: ObjectId,
	branchName: string,
	env: Map<string, string>,
	_ext?: GitExtensions,
	customMessage?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const headCommit = await readCommit(gitCtx, headHash);
	const head = await readHead(gitCtx);

	const conflictStyle = ((await getConfigValue(gitCtx, "merge.conflictstyle")) ?? "merge") as
		| "merge"
		| "diff3";
	const labels = { a: "HEAD", b: branchName, conflictStyle };

	const bases = await findAllMergeBases(gitCtx, headHash, theirsHash);
	const isFF = bases.length > 0 && bases[0] === headHash;
	const ffPrefix = isFF
		? `Updating ${abbreviateHash(headHash)}..${abbreviateHash(theirsHash)}\n`
		: "";

	const result = await mergeOrtRecursive(gitCtx, headHash, theirsHash, labels, _ext?.mergeDriver);

	const applyResult = await applyMergeResult(gitCtx, result, headCommit.tree, {
		labels,
		errorExitCode: isFF ? 1 : 2,
		operationName: "merge",
		skipStagedChangeCheck: isFF,
	});

	if (!applyResult.ok) {
		await deleteStateFile(gitCtx, "MERGE_MSG");
		// Real git writes a no-op reflog for non-FF squash merge failures
		// but not for FF ones (the worktree check happens after the reflog
		// write point in git's merge path for non-FF merges).
		if (!isFF && applyResult.failureKind === "staged" && head?.type === "symbolic") {
			await logRef(gitCtx, env, "HEAD", headHash, headHash, `merge ${branchName}: updating HEAD`);
		}
		const failure = applyResult as ApplyMergeFailure;
		if (isFF) {
			// FF squash merges use checkout_fast_forward() in real git (unpack-trees),
			// which doesn't produce the merge-ort strategy trailer.
			failure.stderr = failure.stderr.replace(/Merge with strategy ort failed\.\n$/, "");
		}
		if (ffPrefix) {
			failure.stdout = ffPrefix + failure.stdout;
		}
		return failure;
	}

	// Real git always persists the generated squash log in SQUASH_MSG.
	// A user-provided -m affects only the user-facing status line, not the
	// message buffer later consumed by commit/cherry-pick --continue.
	const commitLog = await buildSquashMessageLog(gitCtx, headHash, theirsHash);
	const squashMsg = `Squashed commit of the following:\n\n${commitLog}`;
	await writeStateFile(gitCtx, "SQUASH_MSG", squashMsg);

	if (result.conflicts.length > 0) {
		// Real git does NOT call write_merge_state() for squash merges, so
		// MERGE_HEAD, MERGE_MSG, and MERGE_MODE are not written. Instead,
		// suggest_conflicts() appends conflict hints to MERGE_MSG.
		const conflictPaths = getConflictedPaths({
			version: 2,
			entries: result.entries,
		}).sort();
		const conflictHints = `\n# Conflicts:\n${conflictPaths.map((p) => `#\t${p}`).join("\n")}\n`;
		const existingMsg = await readStateFile(gitCtx, "MERGE_MSG");
		await writeStateFile(gitCtx, "MERGE_MSG", (existingMsg ?? "") + conflictHints);

		const mergeOutput = [
			...result.messages,
			"Squash commit -- not updating HEAD",
			"Automatic merge failed; fix conflicts and then commit the result.",
		];

		return {
			stdout: `${mergeOutput.join("\n")}\n`,
			stderr: "",
			exitCode: 1,
		};
	}

	const treeHash = applyResult.mergedTreeHash;
	const diffstat = await formatDiffStat(gitCtx, headCommit.tree, treeHash);
	const mergeMessages = result.messages.length > 0 ? `${result.messages.join("\n")}\n` : "";

	const ffLabel = customMessage
		? "Fast-forward (no commit created; -m option ignored)"
		: "Fast-forward";
	const ffSuccessPrefix = isFF ? `${ffPrefix}${ffLabel}\n` : "";

	return {
		stdout: `${ffSuccessPrefix}${mergeMessages}Squash commit -- not updating HEAD\n${isFF ? diffstat : ""}`,
		stderr: isFF ? "" : "Automatic merge went well; stopped before committing as requested\n",
		exitCode: 0,
	};
}

// ── --continue ──────────────────────────────────────────────────────

async function handleContinue(
	gitCtx: GitContext,
	env: Map<string, string>,
	ext?: GitExtensions,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const mergeHeadHash = await resolveRef(gitCtx, "MERGE_HEAD");
	if (!mergeHeadHash) {
		return fatal("There is no merge in progress (MERGE_HEAD missing).");
	}

	const index = await readIndex(gitCtx);

	const conflictErr = requireNoConflicts(index, "Committing");
	if (conflictErr) return conflictErr;

	const headHash = await requireHead(gitCtx);
	if (isCommandError(headHash)) return headHash;

	const headCommit = await readCommit(gitCtx, headHash);

	let messageText = await readStateFile(gitCtx, "MERGE_MSG");
	if (messageText) {
		messageText = stripCommentLines(messageText);
	} else {
		const head = await readHead(gitCtx);
		const currentBranch = head?.type === "symbolic" ? branchNameFromRef(head.target) : "HEAD";
		messageText = await buildMergeMessage(gitCtx, "unknown", currentBranch);
	}

	const stage0Entries = getStage0Entries(index);
	const treeHash = await buildTreeFromIndex(gitCtx, stage0Entries);

	const author = await requireAuthor(gitCtx, env);
	if (isCommandError(author)) return author;
	const committer = await requireCommitter(gitCtx, env);
	if (isCommandError(committer)) return committer;

	let message = ensureTrailingNewline(messageText);

	const msgEventContinue = {
		repo: gitCtx,
		message,
		treeHash,
		headHash,
		theirsHash: mergeHeadHash,
	};
	const msgRejContinue = await ext?.hooks?.mergeMsg?.(msgEventContinue);
	if (isRejection(msgRejContinue))
		return { stdout: "", stderr: msgRejContinue.message ?? "", exitCode: 1 };
	message = msgEventContinue.message;

	const mcRejContinue = await ext?.hooks?.preMergeCommit?.({
		repo: gitCtx,
		message: message,
		treeHash,
		headHash,
		theirsHash: mergeHeadHash,
	});
	if (isRejection(mcRejContinue))
		return { stdout: "", stderr: mcRejContinue.message ?? "", exitCode: 1 };

	const commitHash = await writeCommitAndAdvance(
		gitCtx,
		treeHash,
		[headHash, mergeHeadHash],
		author,
		committer,
		message,
	);
	await clearMergeState(gitCtx);

	const head = await readHead(gitCtx);
	const subject = firstLine(message);
	const continueRefName = head?.type === "symbolic" ? head.target : "HEAD";
	await logRef(
		gitCtx,
		env,
		continueRefName,
		headHash,
		commitHash,
		`commit (merge): ${subject}`,
		head?.type === "symbolic",
	);

	await ext?.hooks?.postMerge?.({
		repo: gitCtx,
		headHash,
		theirsHash: mergeHeadHash,
		strategy: "three-way",
		commitHash,
	});

	const diffstat = await formatDiffStat(gitCtx, headCommit.tree, treeHash);
	const branchName = head?.type === "symbolic" ? branchNameFromRef(head.target) : "detached HEAD";
	const header = formatCommitOneLiner(branchName, commitHash, messageText);

	return {
		stdout: `${header}\n${diffstat}`,
		stderr: "",
		exitCode: 0,
	};
}

// ── --abort ─────────────────────────────────────────────────────────

async function handleAbort(
	gitCtx: GitContext,
	env: Map<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	return handleOperationAbort(gitCtx, env, {
		operationRef: "MERGE_HEAD",
		noOpError: fatal("There is no merge to abort (MERGE_HEAD missing)."),
		operationName: "merge",
		clearState: clearMergeState,
	});
}
