import type { GitExtensions } from "../git.ts";
import { isRejection } from "../hooks.ts";
import { walkCommits } from "../lib/commit-walk.ts";
import { gatherCommitStats } from "../lib/commit-summary.ts";
import { renderCommitOneLiner, renderFastForward } from "./kit/format/commit-summary.ts";
import { renderUnpackErrors } from "./kit/format/unpack-trees.ts";
import { formatDate } from "../lib/date.ts";
import { getConflictedPaths, getStage0Entries, readIndex } from "../lib/index.ts";
import {
	buildMergeMessage,
	findAllMergeBases,
	handleFastForward,
	squashFastForward,
} from "../lib/merge.ts";
import { bindAttributes } from "../lib/attributes/bound-attributes.ts";
import { applyMergeResult, mergeOrtRecursive } from "../lib/merge-ort.ts";
import { renderApplyMerge } from "./kit/merge.ts";
import { peelToCommit, readCommit } from "../lib/object-db.ts";
import {
	clearMergeState,
	clearRevertState,
	deleteStateFile,
	readStateFile,
	writeStateFile,
} from "../lib/operation-state.ts";
import { logRef } from "../lib/refs/reflog.ts";
import { readHead, resolveRef, updateRef } from "../lib/refs/refs.ts";
import { resolveRevision } from "../lib/refs/rev-parse.ts";
import { buildTreeFromIndex } from "../lib/tree-ops.ts";
import type { GitContext, ObjectId } from "../lib/types.ts";
import { a, type Command, f, o } from "./kit/parse/index.ts";
import { fatal, err, isCommandError } from "./kit/command-result.ts";
import { firstLine, stripCommentLines, ensureTrailingNewline } from "../lib/text-utils.ts";
import { uniqueAbbrev } from "../lib/abbrev.ts";
import {
	requireGitContext,
	requireHead,
	requireNoConflicts,
	requireCommitter,
	requireAuthor,
	requireVerifiedCommit,
} from "./kit/commit-requirements.ts";
import { writeCommitAndAdvance } from "../lib/commit-write.ts";
import { branchNameFromRef } from "../lib/refs/name.ts";
import { getConfigValue } from "../lib/config/store.ts";
import { handleOperationAbort, resolveCommandSigner } from "./kit/command-utils.ts";
import { renderDiffStat } from "../lib/diff/stat-format.ts";

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
			verifySignatures: f().describe("Verify the tip commit of the side branch is signed"),
			noVerifySignatures: f().describe("Do not verify the side branch signature"),
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

			// Resolve effective FF mode: CLI flags override merge.ff config.
			// Git resolves merge.ff into an implicit --no-ff and validates the
			// --squash/--no-ff incompatibility here — before resolving the branch
			// argument — so an invalid branch name still reports the option
			// conflict (exit 128) rather than "not something we can merge".
			let noFf = !!args.noFf;
			let ffOnly = !!args.ffOnly;
			if (!args.noFf && !args.ffOnly) {
				const mergeFFConfig = await getConfigValue(gitCtx, "merge.ff");
				if (mergeFFConfig === "false") noFf = true;
				else if (mergeFFConfig === "only") ffOnly = true;
			}
			if (args.squash && noFf) {
				return fatal("options '--squash' and '--no-ff.' cannot be used together");
			}

			// Resolve the branch to merge (peel tags to commit)
			const resolvedHash = await resolveRevision(gitCtx, branch);
			if (!resolvedHash) {
				return err(`merge: ${branch} - not something we can merge\n`);
			}
			const theirsHash = await peelToCommit(gitCtx, resolvedHash);

			// --verify-signatures: the side branch tip must carry a valid signature.
			const cliVerify = args.verifySignatures ? true : args.noVerifySignatures ? false : undefined;
			const verifyErr = await requireVerifiedCommit(
				gitCtx,
				theirsHash,
				cliVerify,
				"merge.verifysignatures",
			);
			if (verifyErr) return verifyErr;

			// Real git records the pre-merge HEAD in `ORIG_HEAD` as soon as it
			// commits to a merge attempt — after the "concluded merge",
			// cherry-pick, and invalid-branch guards, but before the
			// unrelated-histories / already-up-to-date / --ff-only decisions and
			// the merge itself (git's `update_ref("updating ORIG_HEAD", …)` in
			// `cmd_merge`). Every outcome from here on — up-to-date, fast-forward,
			// squash, clean, conflict, and even the exit-2 "local changes would be
			// overwritten" failure — leaves `ORIG_HEAD` at this commit, which is
			// what a later `git merge --abort` / `git am --abort` rewinds to.
			await updateRef(gitCtx, "ORIG_HEAD", headHash);

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
				const ff = await handleFastForward(gitCtx, headHash, theirsHash);
				if (!ff.ok) {
					return {
						stdout: `Updating ${ff.oldShort}..${ff.newShort}\n`,
						stderr: renderUnpackErrors(ff.rejected, { operationName: "merge" }),
						exitCode: 1,
					};
				}
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
				await ext?.capabilities?.hooks?.postMerge?.({
					repo: gitCtx,
					headHash,
					theirsHash,
					strategy: "fast-forward",
					commitHash: null,
				});
				const ffLabel = args.message
					? "Fast-forward (no commit created; -m option ignored)"
					: "Fast-forward";
				return {
					stdout: renderFastForward(ff.oldShort, ff.newShort, ff.stats, ffLabel),
					stderr: "",
					exitCode: 0,
				};
			}

			const rawMessage = args.message;
			const customMessage = rawMessage
				? rawMessage.endsWith("\n")
					? rawMessage
					: `${rawMessage}\n`
				: undefined;

			if (args.squash) {
				return handleSquashMerge(gitCtx, headHash, theirsHash, branch, ctx.env, customMessage);
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
	const result = await mergeOrtRecursive(
		gitCtx,
		headHash,
		theirsHash,
		labels,
		(await bindAttributes(gitCtx, "merge"))?.merge,
	);

	// Step 2: Apply merge result to index and worktree
	const applyResult = await applyMergeResult(gitCtx, result, headCommit.tree, { labels });

	if (!applyResult.ok) {
		await deleteStateFile(gitCtx, "MERGE_MSG");
		// Real git writes a no-op reflog entry for three-way merge failures
		// (dirty worktree) because the reflog is written before the worktree
		// update is attempted. Squash merges don't write one because they
		// never update HEAD.
		if (applyResult.kind === "staged" && head?.type === "symbolic") {
			await logRef(gitCtx, env, "HEAD", headHash, headHash, `merge ${branchName}: updating HEAD`);
		}
		return renderApplyMerge(applyResult, {
			operationName: "merge",
			callerCommand: "merge",
			errorExitCode: 2,
		});
	}

	// Step 3: Handle conflicts or create merge commit
	if (result.conflicts.length > 0) {
		await updateRef(gitCtx, "MERGE_HEAD", theirsHash);
		// `ORIG_HEAD` was already recorded up front (see the merge entrypoint),
		// covering conflict, clean, and the exit-2 apply-failure paths alike.

		let mergeMsg = customMessage ?? (await buildMergeMessage(gitCtx, branchName, currentBranch));
		const msgEventConflict = {
			repo: gitCtx,
			message: mergeMsg,
			treeHash: applyResult.mergedTreeHash,
			headHash,
			theirsHash,
		};
		const msgRejConflict = await ext?.capabilities?.hooks?.mergeMsg?.(msgEventConflict);
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
	const msgRej = await ext?.capabilities?.hooks?.mergeMsg?.(msgEvent);
	if (isRejection(msgRej)) return { stdout: "", stderr: msgRej.message ?? "", exitCode: 1 };
	mergeMsg = msgEvent.message;

	const mcRej = await ext?.capabilities?.hooks?.preMergeCommit?.({
		repo: gitCtx,
		message: mergeMsg,
		treeHash,
		headHash,
		theirsHash,
	});
	if (isRejection(mcRej)) return { stdout: "", stderr: mcRej.message ?? "", exitCode: 1 };

	const signer = await resolveCommandSigner(gitCtx, undefined, "commit.gpgsign");
	if (isCommandError(signer)) return signer;

	const commitHash = await writeCommitAndAdvance(
		gitCtx,
		treeHash,
		[headHash, theirsHash],
		author,
		committer,
		mergeMsg,
		signer,
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

	await ext?.capabilities?.hooks?.postMerge?.({
		repo: gitCtx,
		headHash,
		theirsHash,
		strategy: "three-way",
		commitHash,
	});

	const diffstat = renderDiffStat(await gatherCommitStats(gitCtx, headCommit.tree, treeHash));
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
	customMessage?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const headCommit = await readCommit(gitCtx, headHash);
	const head = await readHead(gitCtx);

	const bases = await findAllMergeBases(gitCtx, headHash, theirsHash);
	const isFF = bases.length > 0 && bases[0] === headHash;

	// A fast-forward `merge --squash` uses git's checkout_fast_forward (a 2-way
	// merge that keeps local index/worktree changes where HEAD == target), not
	// a 3-way merge, and prints the plain HEAD..target diffstat. HEAD is never
	// moved. Routing it through the 3-way path below would discard local
	// modifications and diff against the merged tree instead.
	if (isFF) {
		const ffPrefix = `Updating ${await uniqueAbbrev(gitCtx, headHash)}..${await uniqueAbbrev(gitCtx, theirsHash)}\n`;
		const ff = await squashFastForward(gitCtx, headHash, theirsHash);
		if (!ff.ok) {
			await deleteStateFile(gitCtx, "MERGE_MSG");
			return {
				stdout: ffPrefix,
				stderr: renderUnpackErrors(ff.rejected, { operationName: "merge" }),
				exitCode: 1,
			};
		}
		const ffLog = await buildSquashMessageLog(gitCtx, headHash, theirsHash);
		await writeStateFile(gitCtx, "SQUASH_MSG", `Squashed commit of the following:\n\n${ffLog}`);
		const ffLabel = customMessage
			? "Fast-forward (no commit created; -m option ignored)"
			: "Fast-forward";
		return {
			stdout: `${ffPrefix}${ffLabel}\nSquash commit -- not updating HEAD\n${renderDiffStat(ff.stats)}`,
			stderr: "",
			exitCode: 0,
		};
	}

	const conflictStyle = ((await getConfigValue(gitCtx, "merge.conflictstyle")) ?? "merge") as
		| "merge"
		| "diff3";
	const labels = { a: "HEAD", b: branchName, conflictStyle };

	const result = await mergeOrtRecursive(
		gitCtx,
		headHash,
		theirsHash,
		labels,
		(await bindAttributes(gitCtx, "merge"))?.merge,
	);

	const applyResult = await applyMergeResult(gitCtx, result, headCommit.tree, { labels });

	if (!applyResult.ok) {
		await deleteStateFile(gitCtx, "MERGE_MSG");
		// Real git writes a no-op `updating HEAD` reflog entry for a non-FF
		// squash merge failure: the reflog write precedes the worktree update.
		if (applyResult.kind === "staged" && head?.type === "symbolic") {
			await logRef(gitCtx, env, "HEAD", headHash, headHash, `merge ${branchName}: updating HEAD`);
		}
		return renderApplyMerge(applyResult, {
			operationName: "merge",
			callerCommand: "merge",
			errorExitCode: 2,
		});
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

	const mergeMessages = result.messages.length > 0 ? `${result.messages.join("\n")}\n` : "";

	return {
		stdout: `${mergeMessages}Squash commit -- not updating HEAD\n`,
		stderr: "Automatic merge went well; stopped before committing as requested\n",
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
	if (!messageText) {
		const headForMsg = await readHead(gitCtx);
		const currentBranch =
			headForMsg?.type === "symbolic" ? branchNameFromRef(headForMsg.target) : "HEAD";
		messageText = await buildMergeMessage(gitCtx, "unknown", currentBranch);
	}

	// Real git's prepare_to_commit() prepends a lingering SQUASH_MSG (left by an
	// earlier `merge --squash`) ahead of MERGE_MSG before --cleanup strips
	// comment lines. clearMergeState() below removes SQUASH_MSG afterwards.
	const squashMsg = await readStateFile(gitCtx, "SQUASH_MSG");
	if (squashMsg) {
		messageText = squashMsg + messageText;
	}
	messageText = stripCommentLines(messageText);

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
	const msgRejContinue = await ext?.capabilities?.hooks?.mergeMsg?.(msgEventContinue);
	if (isRejection(msgRejContinue))
		return { stdout: "", stderr: msgRejContinue.message ?? "", exitCode: 1 };
	message = msgEventContinue.message;

	const mcRejContinue = await ext?.capabilities?.hooks?.preMergeCommit?.({
		repo: gitCtx,
		message: message,
		treeHash,
		headHash,
		theirsHash: mergeHeadHash,
	});
	if (isRejection(mcRejContinue))
		return { stdout: "", stderr: mcRejContinue.message ?? "", exitCode: 1 };

	const signer = await resolveCommandSigner(gitCtx, undefined, "commit.gpgsign");
	if (isCommandError(signer)) return signer;

	const commitHash = await writeCommitAndAdvance(
		gitCtx,
		treeHash,
		[headHash, mergeHeadHash],
		author,
		committer,
		message,
		signer,
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

	await ext?.capabilities?.hooks?.postMerge?.({
		repo: gitCtx,
		headHash,
		theirsHash: mergeHeadHash,
		strategy: "three-way",
		commitHash,
	});

	const diffstat = renderDiffStat(await gatherCommitStats(gitCtx, headCommit.tree, treeHash));
	const branchName = head?.type === "symbolic" ? branchNameFromRef(head.target) : "detached HEAD";
	const shortHash = await uniqueAbbrev(gitCtx, commitHash);
	const header = renderCommitOneLiner(branchName, shortHash, messageText);

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
