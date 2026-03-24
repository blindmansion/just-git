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
	hasStagedChanges,
	isCommandError,
	requireCommit,
	requireCommitter,
	requireGitContext,
	requireHead,
	requireNoConflicts,
	stripCommentLines,
	writeCommitAndAdvance,
} from "../lib/command-utils.ts";
import { formatCommitSummary } from "../lib/commit-summary.ts";
import { getConfigValue } from "../lib/config.ts";
import { getStage0Entries, readIndex, writeIndex } from "../lib/index.ts";
import {
	type ApplyMergeFailure,
	applyMergeResult,
	mergeOrtNonRecursive,
} from "../lib/merge-ort.ts";
import { readCommit } from "../lib/object-db.ts";
import {
	clearCherryPickState,
	clearRevertState,
	deleteStateFile,
	readStateFile,
	writeStateFile,
} from "../lib/operation-state.ts";
import { logRef } from "../lib/reflog.ts";
import { branchNameFromRef, readHead, resolveHead, resolveRef, updateRef } from "../lib/refs.ts";
import { generateLongFormStatus } from "../lib/status-format.ts";
import { buildTreeFromIndex, flattenTreeToMap } from "../lib/tree-ops.ts";
import type { GitContext } from "../lib/types.ts";
import { applyWorktreeOps, mergeAbort } from "../lib/unpack-trees.ts";
import { a, type Command, f, o } from "../parse/index.ts";

export function registerCherryPickCommand(parent: Command, ext?: GitExtensions) {
	parent.command("cherry-pick", {
		description: "Apply the changes introduced by some existing commits",
		args: [a.string().name("commit").describe("The commit to cherry-pick").optional()],
		options: {
			abort: f().describe("Abort the current cherry-pick operation"),
			continue: f().describe("Continue the cherry-pick after conflict resolution"),
			skip: f().describe("Skip the current cherry-pick and continue with the rest"),
			"record-origin": f()
				.alias("x")
				.describe('Append "(cherry picked from commit ...)" to the commit message'),
			mainline: o.number().alias("m").describe("Select parent number for merge commit (1-based)"),
			noCommit: f().alias("n").describe("Apply changes without creating a commit"),
		},
		handler: async (args, ctx) => {
			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;
			const gitCtx = gitCtxOrError;

			// ── --abort path ──────────────────────────────────────────
			if (args.abort) {
				const preCpAbortRej = await ext?.hooks?.preCherryPick?.({
					repo: gitCtx,
					mode: "abort",
					commitRef: null,
				});
				if (isRejection(preCpAbortRej)) {
					return { stdout: "", stderr: preCpAbortRej.message ?? "", exitCode: 1 };
				}
				const result = await handleAbort(gitCtx, ctx.env);
				if (result.exitCode === 0) {
					await ext?.hooks?.postCherryPick?.({
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
				const preCpContinueRej = await ext?.hooks?.preCherryPick?.({
					repo: gitCtx,
					mode: "continue",
					commitRef: null,
				});
				if (isRejection(preCpContinueRej)) {
					return { stdout: "", stderr: preCpContinueRej.message ?? "", exitCode: 1 };
				}
				const result = await handleContinue(gitCtx, ctx.env);
				if (result.exitCode === 0) {
					const newHead = await resolveHead(gitCtx);
					await ext?.hooks?.postCherryPick?.({
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
				return fatal("you must specify a commit to cherry-pick");
			}
			const preCpPickRej = await ext?.hooks?.preCherryPick?.({
				repo: gitCtx,
				mode: "pick",
				commitRef,
			});
			if (isRejection(preCpPickRej)) {
				return { stdout: "", stderr: preCpPickRej.message ?? "", exitCode: 1 };
			}

			// Resolve the commit to cherry-pick first (real git validates the
			// revision before checking for unmerged entries)
			const theirsResult = await requireCommit(gitCtx, commitRef);
			if (isCommandError(theirsResult)) return theirsResult;
			const theirsHash = theirsResult.hash;
			const theirsCommit = theirsResult.commit;

			// Resolve current HEAD
			const headHash = await requireHead(gitCtx);
			if (isCommandError(headHash)) return headHash;

			// Check for unmerged index entries (matching real git behavior).
			// -n uses read_cache_unmerged() which outputs per-file lines;
			// the normal path uses the sequencer's error_resolve_conflict().
			const currentIndex = await readIndex(gitCtx);
			if (args.noCommit) {
				const unmerged = currentIndex.entries.filter((e) => e.stage > 0);
				if (unmerged.length > 0) {
					const MAX_UNMERGED_ENTRIES = 10;
					const shown = unmerged.slice(0, MAX_UNMERGED_ENTRIES);
					const lines = shown.map((e) => `${e.path}: unmerged (${e.hash})`).join("\n");
					const ellipsis = unmerged.length > MAX_UNMERGED_ENTRIES ? "\n..." : "";
					return err(
						`${lines}${ellipsis}\nerror: your index file is unmerged.\nfatal: cherry-pick failed\n`,
						128,
					);
				}
			} else {
				const conflictErr = requireNoConflicts(
					currentIndex,
					"Cherry-picking",
					"fatal: cherry-pick failed\n",
				);
				if (conflictErr) return conflictErr;
			}

			const headCommit = await readCommit(gitCtx, headHash);

			const recordOrigin = !!args["record-origin"];
			const cherryPickMessage = recordOrigin
				? appendCherryPickedFrom(theirsCommit.message, theirsHash)
				: theirsCommit.message;

			// ── Staged-change check (before merge commit check) ──────
			// Real git's sequencer checks repo_index_has_changes() before
			// checking if the commit is a merge. For -n (--no-commit), the
			// check is deferred to applyMergeResult which uses unpack-trees
			// to produce per-file error messages matching real git's format.
			if (gitCtx.workTree && !args.noCommit) {
				const headMap = await flattenTreeToMap(gitCtx, headCommit.tree);
				if (hasStagedChanges(currentIndex, headMap)) {
					return err(
						"error: your local changes would be overwritten by cherry-pick.\n" +
							"hint: commit your changes or stash them to proceed.\n" +
							"fatal: cherry-pick failed\n",
						128,
					);
				}
			}

			// Merge commits require -m to select a parent
			if (theirsCommit.parents.length > 1) {
				if (!args.mainline) {
					return err(
						`error: commit ${theirsHash} is a merge but no -m option was given.\nfatal: cherry-pick failed\n`,
						128,
					);
				}
				const parentIdx = (args.mainline as number) - 1;
				if (parentIdx < 0 || parentIdx >= theirsCommit.parents.length) {
					return err(
						`error: commit ${theirsHash} does not have parent ${args.mainline}\nfatal: cherry-pick failed\n`,
						128,
					);
				}
			} else if (args.mainline) {
				return err(
					"error: mainline was specified but commit is not a merge.\nfatal: cherry-pick failed\n",
					128,
				);
			}

			// Three-way merge: base = parent tree, ours = HEAD tree, theirs = commit tree
			let baseTree: string | null;
			if (theirsCommit.parents.length === 0) {
				baseTree = await buildTreeFromIndex(gitCtx, []);
			} else {
				const parentIdx = theirsCommit.parents.length > 1 ? (args.mainline as number) - 1 : 0;
				const parentHash = theirsCommit.parents[parentIdx];
				if (!parentHash) throw new Error("unreachable: parent must exist");
				const parentCommit = await readCommit(gitCtx, parentHash);
				baseTree = parentCommit.tree;
			}
			const shortHash = abbreviateHash(theirsHash);
			const subject = firstLine(theirsCommit.message);
			const conflictStyle = ((await getConfigValue(gitCtx, "merge.conflictstyle")) ?? "merge") as
				| "merge"
				| "diff3";
			const labels = {
				a: "HEAD",
				b: subject ? `${shortHash} (${subject})` : shortHash,
				conflictStyle,
			};

			// Run merge-ort (non-recursive — cherry-pick uses single base)
			const result = await mergeOrtNonRecursive(
				gitCtx,
				baseTree,
				headCommit.tree,
				theirsCommit.tree,
				labels,
			);

			// ── Empty cherry-pick detection ───────────────────────────
			// Use the merge result tree directly — it already includes the
			// correct resolution for ALL paths covered by the three-way merge.
			if (result.conflicts.length === 0) {
				if (result.resultTree === headCommit.tree) {
					// -n with empty result: nothing to apply, succeed silently
					if (args.noCommit) {
						return { stdout: "", stderr: "", exitCode: 0 };
					}

					await updateRef(gitCtx, "CHERRY_PICK_HEAD", theirsHash);
					await updateRef(gitCtx, "ORIG_HEAD", headHash);

					await writeStateFile(gitCtx, "MERGE_MSG", cherryPickMessage);

					const mergeOutput = result.messages.length > 0 ? `${result.messages.join("\n")}\n` : "";
					const statusOutput = await generateLongFormStatus(gitCtx, {
						fromCommit: true,
					});
					return {
						stdout: `${mergeOutput}${statusOutput}`,
						stderr:
							"The previous cherry-pick is now empty, possibly due to conflict resolution.\nIf you wish to commit it anyway, use:\n\n    git commit --allow-empty\n\nOtherwise, please use 'git cherry-pick --skip'\n",
						exitCode: 1,
					};
				}
			}

			// ── Apply merge result (worktree safety + index) ─────────
			const applyResult = await applyMergeResult(gitCtx, result, headCommit.tree, {
				labels,
				errorExitCode: 128,
				operationName: "merge",
				callerCommand: "cherry-pick",
				skipStagedChangeCheck: true,
				preflightOnewayCheck: !!args.noCommit,
			});

			if (!applyResult.ok) {
				return applyResult as ApplyMergeFailure;
			}

			// ── Handle conflicts ──────────────────────────────────────
			if (result.conflicts.length > 0) {
				const mergeOutput = result.messages.join("\n");
				await ext?.hooks?.postCherryPick?.({
					repo: gitCtx,
					mode: "pick",
					commitHash: null,
					hadConflicts: true,
				});

				if (args.noCommit) {
					// -n: no cherry-pick state, just leave conflicts in index
					return {
						stdout: mergeOutput ? `${mergeOutput}\n` : "",
						stderr:
							`error: could not apply ${shortHash}... ${firstLine(theirsCommit.message)}\n` +
							"hint: after resolving the conflicts, mark the corrected paths\n" +
							"hint: with 'git add <paths>' or 'git rm <paths>'\n" +
							'hint: Disable this message with "git config set advice.mergeConflict false"\n',
						exitCode: 1,
					};
				}

				await updateRef(gitCtx, "CHERRY_PICK_HEAD", theirsHash);
				await updateRef(gitCtx, "ORIG_HEAD", headHash);
				await writeStateFile(gitCtx, "MERGE_MSG", cherryPickMessage);

				return {
					stdout: mergeOutput ? `${mergeOutput}\n` : "",
					stderr:
						`error: could not apply ${shortHash}... ${firstLine(theirsCommit.message)}\n` +
						"hint: After resolving the conflicts, mark them with\n" +
						'hint: "git add/rm <pathspec>", then run\n' +
						'hint: "git cherry-pick --continue".\n' +
						'hint: You can instead skip this commit with "git cherry-pick --skip".\n' +
						'hint: To abort and get back to the state before "git cherry-pick",\n' +
						'hint: run "git cherry-pick --abort".\n' +
						'hint: Disable this message with "git config set advice.mergeConflict false"\n',
					exitCode: 1,
				};
			}

			// ── Clean cherry-pick ─────────────────────────────────────
			const treeHash = applyResult.mergedTreeHash;

			// --no-commit: apply changes to worktree/index but skip commit.
			// Real git produces no stdout on success.
			if (args.noCommit) {
				return { stdout: "", stderr: "", exitCode: 0 };
			}

			const committer = await requireCommitter(gitCtx, ctx.env);
			if (isCommandError(committer)) return committer;

			const commitHash = await writeCommitAndAdvance(
				gitCtx,
				treeHash,
				[headHash],
				theirsCommit.author,
				committer,
				cherryPickMessage,
			);

			await clearCherryPickState(gitCtx);
			await clearRevertState(gitCtx);

			const head2 = await readHead(gitCtx);
			const cpSubject = cherryPickMessage.split("\n")[0] ?? "";
			const cpRefName = head2?.type === "symbolic" ? head2.target : "HEAD";
			await logRef(
				gitCtx,
				ctx.env,
				cpRefName,
				headHash,
				commitHash,
				`cherry-pick: ${cpSubject}`,
				head2?.type === "symbolic",
			);
			const branchName =
				head2?.type === "symbolic" ? branchNameFromRef(head2.target) : "detached HEAD";
			const parentTree = headCommit.tree;
			const summary = await formatCommitSummary(
				gitCtx,
				parentTree,
				treeHash,
				theirsCommit.author,
				committer,
				true,
			);

			const header = formatCommitOneLiner(branchName, commitHash, cherryPickMessage);
			const mergeMessages = result.messages.length > 0 ? `${result.messages.join("\n")}\n` : "";
			await ext?.hooks?.postCherryPick?.({
				repo: gitCtx,
				mode: "pick",
				commitHash,
				hadConflicts: false,
			});
			return {
				stdout: `${mergeMessages}${header}\n${summary}`,
				stderr: "",
				exitCode: 0,
			};
		},
	});
}

// ── --skip ──────────────────────────────────────────────────────────

async function handleSkip(
	gitCtx: GitContext,
	env: Map<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const cpHead = await resolveRef(gitCtx, "CHERRY_PICK_HEAD");
	if (!cpHead) {
		return err("error: no cherry-pick in progress\nfatal: cherry-pick failed\n", 128);
	}

	const headHash = await resolveHead(gitCtx);
	if (!headHash) {
		return fatal("unable to resolve HEAD");
	}

	const headCommit = await readCommit(gitCtx, headHash);
	const currentIndex = await readIndex(gitCtx);
	const result = await mergeAbort(gitCtx, headCommit.tree, currentIndex, headHash);
	if (!result.success) {
		const out = result.errorOutput as {
			stdout: string;
			stderr: string;
			exitCode: number;
		};
		return {
			...out,
			stderr: out.stderr + "error: failed to skip the commit\nfatal: cherry-pick failed\n",
		};
	}

	await writeIndex(gitCtx, { version: 2, entries: result.newEntries });
	await applyWorktreeOps(gitCtx, result.worktreeOps);

	await logRef(gitCtx, env, "HEAD", headHash, headHash, `reset: moving to ${headHash}`);

	await clearCherryPickState(gitCtx);

	return { stdout: "", stderr: "", exitCode: 0 };
}

// ── --abort ─────────────────────────────────────────────────────────

async function handleAbort(
	gitCtx: GitContext,
	env: Map<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const cpHead = await resolveRef(gitCtx, "CHERRY_PICK_HEAD");
	if (cpHead) {
		return handleOperationAbort(gitCtx, env, {
			operationRef: "CHERRY_PICK_HEAD",
			noOpError: err(
				"error: no cherry-pick or revert in progress\nfatal: cherry-pick failed\n",
				128,
			),
			operationName: "cherry-pick",
			clearState: clearCherryPickState,
			origHeadAsTargetRev: true,
		});
	}
	const revertHead = await resolveRef(gitCtx, "REVERT_HEAD");
	if (revertHead) {
		return handleOperationAbort(gitCtx, env, {
			operationRef: "REVERT_HEAD",
			noOpError: err(
				"error: no cherry-pick or revert in progress\nfatal: cherry-pick failed\n",
				128,
			),
			operationName: "cherry-pick",
			clearState: clearRevertState,
			origHeadAsTargetRev: true,
		});
	}
	return err("error: no cherry-pick or revert in progress\nfatal: cherry-pick failed\n", 128);
}

// ── --continue ──────────────────────────────────────────────────────

async function handleContinue(
	gitCtx: GitContext,
	env: Map<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const cherryPickHeadHash = await resolveRef(gitCtx, "CHERRY_PICK_HEAD");
	if (!cherryPickHeadHash) {
		return err("error: no cherry-pick or revert in progress\nfatal: cherry-pick failed\n", 128);
	}

	const index = await readIndex(gitCtx);

	// Check for unresolved conflicts
	const conflictErr = requireNoConflicts(index, "Committing");
	if (conflictErr) return conflictErr;

	const originalCommit = await readCommit(gitCtx, cherryPickHeadHash);

	let messageText = await readStateFile(gitCtx, "MERGE_MSG");
	if (!messageText) {
		return err("Aborting commit due to empty commit message.\n", 1);
	}

	// Real git's sequencer runs `git commit --no-edit --cleanup=strip`
	// (without -F). In prepare_to_commit(), both SQUASH_MSG and MERGE_MSG
	// are read if present — SQUASH_MSG is prepended to the message buffer.
	// Then --cleanup=strip removes comment lines.
	const squashMsg = await readStateFile(gitCtx, "SQUASH_MSG");
	if (squashMsg) {
		messageText = squashMsg + messageText;
	}
	messageText = stripCommentLines(messageText);

	const stage0Entries = getStage0Entries(index);
	const treeHash = await buildTreeFromIndex(gitCtx, stage0Entries);

	const headHash = await requireHead(gitCtx);
	if (isCommandError(headHash)) return headHash;

	const headCommit = await readCommit(gitCtx, headHash);
	const parentTree = headCommit.tree;

	const committer = await requireCommitter(gitCtx, env);
	if (isCommandError(committer)) return committer;

	const message = ensureTrailingNewline(messageText);

	const commitHash = await writeCommitAndAdvance(
		gitCtx,
		treeHash,
		[headHash],
		originalCommit.author,
		committer,
		message,
	);

	await clearCherryPickState(gitCtx);
	await clearRevertState(gitCtx);
	await deleteStateFile(gitCtx, "SQUASH_MSG");

	const head = await readHead(gitCtx);
	const cpSubject = firstLine(message);
	const cpRefName = head?.type === "symbolic" ? head.target : "HEAD";
	await logRef(
		gitCtx,
		env,
		cpRefName,
		headHash,
		commitHash,
		`commit (cherry-pick): ${cpSubject}`,
		head?.type === "symbolic",
	);
	const branchName = head?.type === "symbolic" ? branchNameFromRef(head.target) : "detached HEAD";
	const summary = await formatCommitSummary(
		gitCtx,
		parentTree,
		treeHash,
		originalCommit.author,
		committer,
		true,
	);

	const header = formatCommitOneLiner(branchName, commitHash, messageText);
	return {
		stdout: `${header}\n${summary}`,
		stderr: "",
		exitCode: 0,
	};
}

// ── -x trailer ──────────────────────────────────────────────────────

function appendCherryPickedFrom(message: string, hash: string): string {
	const trailer = `(cherry picked from commit ${hash})`;
	const trimmed = message.replace(/\n+$/, "");
	// If the message already ends with a cherry-pick trailer, append
	// directly (single \n) to match git's conforming-footer behavior.
	// Otherwise insert a blank line (\n\n) to separate body from trailers.
	const lastNl = trimmed.lastIndexOf("\n");
	const lastLine = lastNl === -1 ? trimmed : trimmed.slice(lastNl + 1);
	const hasTrailer = /^\(cherry picked from commit [0-9a-f]+\)$/.test(lastLine);
	return hasTrailer ? `${trimmed}\n${trailer}\n` : `${trimmed}\n\n${trailer}\n`;
}
