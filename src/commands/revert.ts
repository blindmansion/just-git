import type { GitExtensions } from "../git.ts";
import { isRejection } from "../hooks.ts";
import { hasStagedChanges } from "../lib/command-utils.ts";
import { gatherCommitStats } from "../lib/commit-summary.ts";
import { renderCommitOneLiner, renderCommitSummary } from "./kit/format/commit-summary.ts";
import { getStage0Entries, readIndex, writeIndex } from "../lib/index.ts";
import { bindAttributes } from "../lib/attributes/bound-attributes.ts";
import { applyMergeResult, mergeOrtNonRecursive } from "../lib/merge-ort.ts";
import { renderApplyMerge } from "./kit/merge.ts";
import { readCommit } from "../lib/object-db.ts";
import {
	clearAllOperationState,
	clearCherryPickState,
	clearRevertState,
	readStateFile,
	writeStateFile,
} from "../lib/operation-state.ts";
import { logRef } from "../lib/refs/reflog.ts";
import { readHead, resolveHead, resolveRef, updateRef } from "../lib/refs/refs.ts";
import { generateLongFormStatus } from "./kit/status.ts";
import type { Signer } from "../lib/signing.ts";
import { buildTreeFromIndex, flattenTreeToMap } from "../lib/tree-ops.ts";
import type { GitContext, Identity, ObjectId } from "../lib/types.ts";
import { applyWorktreeOps, mergeAbort } from "../lib/worktree/unpack-trees.ts";
import { renderMergeAbortError } from "./kit/format/unpack-trees.ts";
import { a, type Command, f, o } from "./kit/parse/index.ts";
import { fatal, err, isCommandError } from "./kit/command-result.ts";
import { firstLine, stripCommentLines, ensureTrailingNewline } from "../lib/text-utils.ts";
import { uniqueAbbrev } from "../lib/abbrev.ts";
import {
	requireGitContext,
	requireHead,
	requireNoConflicts,
	requireCommit,
	requireCommitter,
	requireAuthor,
} from "./kit/commit-requirements.ts";
import { writeCommitAndAdvance } from "../lib/commit-write.ts";
import { branchNameFromRef } from "../lib/refs/name.ts";
import { getConfigValue } from "../lib/config/store.ts";
import { handleOperationAbort, resolveCommandSigner } from "./kit/command-utils.ts";

type RevertMode = "commit" | "no-commit";

export function registerRevertCommand(parent: Command, ext?: GitExtensions) {
	parent.command("revert", {
		description: "Revert some existing commits",
		args: [a.string().name("commit").describe("The commit to revert").optional()],
		options: {
			abort: f().describe("Abort the current revert operation"),
			continue: f().describe("Continue the revert after conflict resolution"),
			skip: f().describe("Skip the current commit and continue"),
			"no-commit": f().alias("n").describe("Apply changes without creating a commit"),
			"no-edit": f().describe("Do not edit the commit message"),
			mainline: o.number().alias("m").describe("Select the parent number for reverting merges"),
		},
		handler: async (args, ctx) => {
			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;
			const gitCtx = gitCtxOrError;

			// ── --abort path ──────────────────────────────────────────
			if (args.abort) {
				const preRvAbortRej = await ext?.capabilities?.hooks?.preRevert?.({
					repo: gitCtx,
					mode: "abort",
					commitRef: null,
				});
				if (isRejection(preRvAbortRej)) {
					return { stdout: "", stderr: preRvAbortRej.message ?? "", exitCode: 1 };
				}
				const result = await handleAbort(gitCtx, ctx.env);
				if (result.exitCode === 0) {
					await ext?.capabilities?.hooks?.postRevert?.({
						repo: gitCtx,
						mode: "abort",
						commitHash: null,
						hadConflicts: false,
					});
				}
				return result;
			}

			// ── --continue path ───────────────────────────────────────
			if (args.continue) {
				const preRvContinueRej = await ext?.capabilities?.hooks?.preRevert?.({
					repo: gitCtx,
					mode: "continue",
					commitRef: null,
				});
				if (isRejection(preRvContinueRej)) {
					return { stdout: "", stderr: preRvContinueRej.message ?? "", exitCode: 1 };
				}
				const result = await handleContinue(gitCtx, ctx.env);
				if (result.exitCode === 0) {
					const newHead = await resolveHead(gitCtx);
					await ext?.capabilities?.hooks?.postRevert?.({
						repo: gitCtx,
						mode: "continue",
						commitHash: newHead,
						hadConflicts: false,
					});
				}
				return result;
			}

			// ── --skip path ──────────────────────────────────────────────
			if (args.skip) {
				return handleSkip(gitCtx, ctx.env);
			}

			const commitRef: string | undefined = args.commit;
			if (!commitRef) {
				return fatal("you must specify a commit to revert");
			}
			const preRvRevertRej = await ext?.capabilities?.hooks?.preRevert?.({
				repo: gitCtx,
				mode: "revert",
				commitRef,
			});
			if (isRejection(preRvRevertRej)) {
				return { stdout: "", stderr: preRvRevertRej.message ?? "", exitCode: 1 };
			}

			const revertResult = await requireCommit(gitCtx, commitRef);
			if (isCommandError(revertResult)) return revertResult;
			const resolvedHash = revertResult.hash;
			const revertedCommit = revertResult.commit;

			const headHash = await requireHead(gitCtx);
			if (isCommandError(headHash)) return headHash;

			const revertMode: RevertMode = args["no-commit"] ? "no-commit" : "commit";
			const currentIndex = await readIndex(gitCtx);
			const conflictErr = validateRevertIndexState(currentIndex, revertMode);
			if (conflictErr) return conflictErr;

			const headCommit = await readCommit(gitCtx, headHash);

			// ── Staged-change check (before merge commit check) ──────
			// Match cherry-pick/revert sequencer behavior for the normal
			// path: refuse local staged changes before validating -m for
			// merge commits. The -n path skips this so merge validation and
			// unpack-trees diagnostics can still run.
			if (gitCtx.workTree && revertMode === "commit") {
				const headMap = await flattenTreeToMap(gitCtx, headCommit.tree);
				if (hasStagedChanges(currentIndex, headMap)) {
					return err(
						"error: your local changes would be overwritten by revert.\n" +
							"hint: commit your changes or stash them to proceed.\n" +
							"fatal: revert failed\n",
						128,
					);
				}
			}

			// ── Merge commit handling ─────────────────────────────────
			const mainlineParent: number | undefined = args.mainline;
			let parentTree: string;

			if (revertedCommit.parents.length > 1) {
				if (mainlineParent === undefined) {
					return err(
						`error: commit ${resolvedHash} is a merge but no -m option was given.\nfatal: revert failed\n`,
						128,
					);
				}
				if (mainlineParent < 1 || mainlineParent > revertedCommit.parents.length) {
					return err(
						`error: commit ${resolvedHash} does not have parent ${mainlineParent}\nfatal: revert failed\n`,
						128,
					);
				}
				const selectedParent = revertedCommit.parents[mainlineParent - 1] as string;
				const parentCommit = await readCommit(gitCtx, selectedParent);
				parentTree = parentCommit.tree;
			} else if (revertedCommit.parents.length === 0) {
				parentTree = await buildTreeFromIndex(gitCtx, []);
			} else {
				const parentHash = revertedCommit.parents[0] as string;
				const parentCommit = await readCommit(gitCtx, parentHash);
				parentTree = parentCommit.tree;
			}

			// Build revert commit message
			const shortHash = await uniqueAbbrev(gitCtx, resolvedHash);
			const subject = firstLine(revertedCommit.message);
			const revertMessage = buildRevertMessage(revertedCommit, resolvedHash, mainlineParent);
			const commitMessage = ensureTrailingNewline(revertMessage);

			// Three-way merge: base = commit tree, ours = HEAD tree, theirs = parent tree
			const conflictStyle = ((await getConfigValue(gitCtx, "merge.conflictstyle")) ?? "merge") as
				| "merge"
				| "diff3";
			const labels = {
				a: "HEAD",
				b: subject ? `parent of ${shortHash} (${subject})` : `parent of ${shortHash}`,
				conflictStyle,
			};

			const result = await mergeOrtNonRecursive(
				gitCtx,
				revertedCommit.tree,
				headCommit.tree,
				parentTree,
				labels,
				(await bindAttributes(gitCtx, "revert"))?.merge,
			);

			// ── Empty revert detection ────────────────────────────────
			if (result.conflicts.length === 0) {
				if (result.resultTree === headCommit.tree) {
					if (revertMode === "no-commit") {
						await setPendingRevertState(gitCtx, resolvedHash, revertMessage);
						return { stdout: "", stderr: "", exitCode: 0 };
					}
					// Real git's sequencer writes MERGE_MSG for the revert before it
					// discovers the result is empty and bails out. If another pick or
					// revert is already paused (CHERRY_PICK_HEAD/REVERT_HEAD present), a
					// later `--continue` consumes this MERGE_MSG — so it must hold the
					// revert's message, not whatever the earlier operation left behind.
					await writeStateFile(gitCtx, "MERGE_MSG", revertMessage);
					const mergeOutput = result.messages.length > 0 ? `${result.messages.join("\n")}\n` : "";
					const statusOutput = await generateLongFormStatus(gitCtx, {
						fromCommit: true,
					});
					const cherryPickHead = await resolveRef(gitCtx, "CHERRY_PICK_HEAD");
					return {
						stdout: `${mergeOutput}${statusOutput}`,
						stderr: cherryPickHead
							? "The previous cherry-pick is now empty, possibly due to conflict resolution.\nIf you wish to commit it anyway, use:\n\n    git commit --allow-empty\n\nOtherwise, please use 'git cherry-pick --skip'\n"
							: "",
						exitCode: 1,
					};
				}
			}

			// ── Apply merge result ────────────────────────────────────
			const applyResult = await applyMergeResult(gitCtx, result, headCommit.tree, {
				labels,
				skipStagedChangeCheck: true,
			});

			if (!applyResult.ok) {
				return renderApplyMerge(applyResult, {
					operationName: "merge",
					callerCommand: "revert",
					errorExitCode: 128,
				});
			}

			// ── Handle conflicts ──────────────────────────────────────
			if (result.conflicts.length > 0) {
				await setPendingRevertState(gitCtx, resolvedHash, revertMessage);

				const mergeOutput = result.messages.join("\n");
				await ext?.capabilities?.hooks?.postRevert?.({
					repo: gitCtx,
					mode: "revert",
					commitHash: null,
					hadConflicts: true,
				});

				return {
					stdout: mergeOutput ? `${mergeOutput}\n` : "",
					stderr: buildRevertConflictStderr(
						shortHash,
						firstLine(revertedCommit.message),
						revertMode,
					),
					exitCode: 1,
				};
			}

			// ── --no-commit path ──────────────────────────────────────
			if (revertMode === "no-commit") {
				await setPendingRevertState(gitCtx, resolvedHash, revertMessage);
				return { stdout: "", stderr: "", exitCode: 0 };
			}

			// ── Clean revert — create commit ──────────────────────────
			const treeHash = applyResult.mergedTreeHash;

			const author = await requireAuthor(gitCtx, ctx.env);
			if (isCommandError(author)) return author;
			const committer = await requireCommitter(gitCtx, ctx.env);
			if (isCommandError(committer)) return committer;

			const revertSigner = await resolveCommandSigner(gitCtx, undefined, "commit.gpgsign");
			if (isCommandError(revertSigner)) return revertSigner;

			const commitOutput = await finalizeRevertCommit({
				gitCtx,
				env: ctx.env,
				headHash,
				headTreeHash: headCommit.tree,
				treeHash,
				author,
				committer,
				signer: revertSigner,
				commitMessage,
				displayMessage: revertMessage,
				reflogMessage: `revert: ${firstLine(revertMessage)}`,
				// A clean revert builds the commit directly and never consumes
				// SQUASH_MSG left by an earlier `merge --squash`.
				keepSquashMsg: true,
			});
			const mergeMessages = result.messages.length > 0 ? `${result.messages.join("\n")}\n` : "";
			await ext?.capabilities?.hooks?.postRevert?.({
				repo: gitCtx,
				mode: "revert",
				commitHash: commitOutput.commitHash,
				hadConflicts: false,
			});
			return {
				stdout: `${mergeMessages}${commitOutput.stdout}`,
				stderr: "",
				exitCode: 0,
			};
		},
	});
}

// ── --abort ─────────────────────────────────────────────────────────

async function handleAbort(
	gitCtx: GitContext,
	env: Map<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const revertHead = await resolveRef(gitCtx, "REVERT_HEAD");
	if (revertHead) {
		return handleOperationAbort(gitCtx, env, {
			operationRef: "REVERT_HEAD",
			noOpError: err("error: no cherry-pick or revert in progress\nfatal: revert failed\n", 128),
			operationName: "revert",
			// The sequencer abort path ends in remove_branch_state(), which clears
			// operation refs/messages but preserves the shared ORIG_HEAD pseudo-ref.
			// An enclosing am session may still need it for its own later --abort.
			clearState: clearAllOperationState,
			origHeadAsTargetRev: true,
		});
	}
	const cpHead = await resolveRef(gitCtx, "CHERRY_PICK_HEAD");
	if (cpHead) {
		return handleOperationAbort(gitCtx, env, {
			operationRef: "CHERRY_PICK_HEAD",
			noOpError: err("error: no cherry-pick or revert in progress\nfatal: revert failed\n", 128),
			operationName: "revert",
			// remove_branch_state() clears every operation ref/message (including a
			// stray MERGE_HEAD/MERGE_MODE), preserving only ORIG_HEAD.
			clearState: clearAllOperationState,
			origHeadAsTargetRev: true,
		});
	}
	return err("error: no cherry-pick or revert in progress\nfatal: revert failed\n", 128);
}

// ── --skip ──────────────────────────────────────────────────────────

async function handleSkip(
	gitCtx: GitContext,
	env: Map<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const revertHead = await resolveRef(gitCtx, "REVERT_HEAD");
	if (!revertHead) {
		return err("error: no revert in progress\nfatal: revert failed\n", 128);
	}

	const headHash = await resolveHead(gitCtx);
	if (!headHash) {
		return fatal("unable to resolve HEAD");
	}

	const headCommit = await readCommit(gitCtx, headHash);
	const currentIndex = await readIndex(gitCtx);
	const result = await mergeAbort(gitCtx, headCommit.tree, currentIndex);
	if (!result.success) {
		return {
			stdout: "",
			stderr:
				renderMergeAbortError(result.errors, headHash) +
				"error: failed to skip the commit\nfatal: revert failed\n",
			exitCode: 128,
		};
	}

	await writeIndex(gitCtx, { version: 2, entries: result.newEntries });
	await applyWorktreeOps(gitCtx, result.worktreeOps);

	await logRef(gitCtx, env, "HEAD", headHash, headHash, `reset: moving to ${headHash}`);

	await clearRevertState(gitCtx);

	return { stdout: "", stderr: "", exitCode: 0 };
}

// ── --continue ──────────────────────────────────────────────────────

async function handleContinue(
	gitCtx: GitContext,
	env: Map<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const revertHeadHash = await resolveRef(gitCtx, "REVERT_HEAD");
	if (!revertHeadHash) {
		return err("error: no cherry-pick or revert in progress\nfatal: revert failed\n", 128);
	}

	const index = await readIndex(gitCtx);

	const conflictErr = requireNoConflicts(index, "Committing");
	if (conflictErr) return conflictErr;

	let messageText = await readStateFile(gitCtx, "MERGE_MSG");
	if (!messageText) {
		return err("Aborting commit due to empty commit message.\n", 1);
	}

	// Real git's revert --continue runs `git commit` internally.
	// prepare_to_commit() reads both SQUASH_MSG and MERGE_MSG when
	// present — SQUASH_MSG is prepended to the message buffer.
	const squashMsg = await readStateFile(gitCtx, "SQUASH_MSG");
	if (squashMsg) {
		messageText = squashMsg + messageText;
	}
	messageText = stripCommentLines(messageText);
	if (!messageText) {
		return err("Aborting commit due to empty commit message.\n", 1);
	}

	const stage0Entries = getStage0Entries(index);
	const treeHash = await buildTreeFromIndex(gitCtx, stage0Entries);

	const headHash = await requireHead(gitCtx);
	if (isCommandError(headHash)) return headHash;

	const headCommit = await readCommit(gitCtx, headHash);

	let author = await requireAuthor(gitCtx, env);
	if (isCommandError(author)) return author;
	const committer = await requireCommitter(gitCtx, env);
	if (isCommandError(committer)) return committer;

	// Real git's revert --continue runs `git commit` internally, which
	// preserves the original author when CHERRY_PICK_HEAD exists.
	const cherryPickHeadHash = await resolveRef(gitCtx, "CHERRY_PICK_HEAD");
	if (cherryPickHeadHash) {
		const originalCommit = await readCommit(gitCtx, cherryPickHeadHash);
		author = originalCommit.author;
	}

	const message = ensureTrailingNewline(messageText);

	const continueSigner = await resolveCommandSigner(gitCtx, undefined, "commit.gpgsign");
	if (isCommandError(continueSigner)) return continueSigner;

	const commitOutput = await finalizeRevertCommit({
		gitCtx,
		env,
		headHash,
		headTreeHash: headCommit.tree,
		treeHash,
		author,
		committer,
		signer: continueSigner,
		commitMessage: message,
		displayMessage: messageText,
		reflogMessage: `commit: ${firstLine(message)}`,
	});
	return {
		stdout: commitOutput.stdout,
		stderr: "",
		exitCode: 0,
	};
}

function validateRevertIndexState(
	index: Awaited<ReturnType<typeof readIndex>>,
	revertMode: RevertMode,
) {
	if (revertMode === "commit") {
		return requireNoConflicts(index, "Reverting", "fatal: revert failed\n");
	}

	const unmerged = index.entries.filter((e) => e.stage > 0);
	if (unmerged.length === 0) return null;

	const MAX_UNMERGED_ENTRIES = 10;
	const shown = unmerged.slice(0, MAX_UNMERGED_ENTRIES);
	const lines = shown.map((e) => `${e.path}: unmerged (${e.hash})`).join("\n");
	const ellipsis = unmerged.length > MAX_UNMERGED_ENTRIES ? "\n..." : "";
	return err(
		`${lines}${ellipsis}\nerror: your index file is unmerged.\nfatal: revert failed\n`,
		128,
	);
}

async function setPendingRevertState(
	gitCtx: GitContext,
	revertHeadHash: ObjectId,
	message: string,
) {
	await updateRef(gitCtx, "REVERT_HEAD", revertHeadHash);
	await writeStateFile(gitCtx, "MERGE_MSG", message);
}

function buildRevertConflictStderr(
	shortHash: string,
	subject: string,
	revertMode: RevertMode,
): string {
	const prefix = `error: could not revert ${shortHash}... ${subject}\n`;
	if (revertMode === "no-commit") {
		return (
			prefix +
			"hint: after resolving the conflicts, mark the corrected paths\n" +
			"hint: with 'git add <paths>' or 'git rm <paths>'\n" +
			'hint: Disable this message with "git config set advice.mergeConflict false"\n'
		);
	}
	return (
		prefix +
		"hint: After resolving the conflicts, mark them with\n" +
		'hint: "git add/rm <pathspec>", then run\n' +
		'hint: "git revert --continue".\n' +
		'hint: You can instead skip this commit with "git revert --skip".\n' +
		'hint: To abort and get back to the state before "git revert",\n' +
		'hint: run "git revert --abort".\n' +
		'hint: Disable this message with "git config set advice.mergeConflict false"\n'
	);
}

async function finalizeRevertCommit(options: {
	gitCtx: GitContext;
	env: Map<string, string>;
	headHash: ObjectId;
	headTreeHash: ObjectId;
	treeHash: ObjectId;
	author: Identity;
	committer: Identity;
	commitMessage: string;
	displayMessage: string;
	reflogMessage: string;
	signer?: Signer;
	keepSquashMsg?: boolean;
}): Promise<{ commitHash: ObjectId; stdout: string }> {
	const {
		gitCtx,
		env,
		headHash,
		headTreeHash,
		treeHash,
		author,
		committer,
		commitMessage,
		displayMessage,
		reflogMessage,
		signer,
		keepSquashMsg = false,
	} = options;

	const commitHash = await writeCommitAndAdvance(
		gitCtx,
		treeHash,
		[headHash],
		author,
		committer,
		commitMessage,
		signer,
	);

	await clearRevertState(gitCtx, { keepSquashMsg });
	await clearCherryPickState(gitCtx, { keepSquashMsg });

	const updatedHead = await readHead(gitCtx);
	const refName = updatedHead?.type === "symbolic" ? updatedHead.target : "HEAD";
	await logRef(
		gitCtx,
		env,
		refName,
		headHash,
		commitHash,
		reflogMessage,
		updatedHead?.type === "symbolic",
	);
	const branchName =
		updatedHead?.type === "symbolic" ? branchNameFromRef(updatedHead.target) : "detached HEAD";
	const showDate =
		author.name !== committer.name ||
		author.email !== committer.email ||
		author.timestamp !== committer.timestamp ||
		author.timezone !== committer.timezone;
	const stats = await gatherCommitStats(gitCtx, headTreeHash, treeHash);
	const summary = renderCommitSummary({
		author,
		committer,
		showDate,
		isMerge: false,
		stats,
	});
	const shortHash = await uniqueAbbrev(gitCtx, commitHash);
	const header = renderCommitOneLiner(branchName, shortHash, displayMessage);
	return { commitHash, stdout: `${header}\n${summary}` };
}

// ── Commit message ──────────────────────────────────────────────────

function buildRevertMessage(
	commit: { message: string; parents: string[] },
	hash: string,
	mainlineParent?: number,
): string {
	const subject = firstLine(commit.message);

	// Git 2.46+: reverting a revert produces "Reapply" instead of nested "Revert"
	const revertPrefix = 'Revert "';
	const isRevertOfRevert = subject.startsWith(revertPrefix) && subject.endsWith('"');
	const title = isRevertOfRevert
		? `Reapply "${subject.slice(revertPrefix.length, -1)}"`
		: `Revert "${subject}"`;

	let msg = `${title}\n\nThis reverts commit ${hash}`;
	if (mainlineParent !== undefined && commit.parents.length > 1 && mainlineParent >= 1) {
		const mainlineHash = commit.parents[mainlineParent - 1] ?? (commit.parents[0] as string);
		msg += `, reversing\nchanges made to ${mainlineHash}`;
	}
	msg += ".\n";
	return msg;
}
