import { renderCommitOneLiner, renderCommitSummary } from "./format/commit-summary.ts";
import type { CommandResult } from "./command-result.ts";
import { err, fatal } from "./command-result.ts";
import type { SequencerDirtyState } from "../../lib/command-utils.ts";
import type {
	FinalizedRebaseCommit,
	RebaseConflict,
	RebaseOutcome,
	RebaseProgress,
	RebaseStep,
} from "../../lib/rebase-engine.ts";
import type { RebaseTodoEntry } from "../../lib/rebase.ts";
import { renderUnpackErrors } from "./format/unpack-trees.ts";
import type { RejectedPath } from "../../lib/worktree/unpack-trees.ts";

/**
 * Map a {@link RebaseOutcome} produced by the rebase engine to the CLI
 * `CommandResult` contract (stdout/stderr/exit code). All human-readable rebase
 * text lives here; `lib/rebase-engine.ts` only gathers data and mutates state.
 */
export function renderRebaseOutcome(outcome: RebaseOutcome): CommandResult {
	switch (outcome.kind) {
		case "upToDate":
			return { stdout: upToDateMessage(outcome.branchName), stderr: "", exitCode: 0 };

		case "unmergedPaths":
			return {
				stdout: outcome.paths.map((p) => `${p}: needs merge\n`).join(""),
				stderr:
					"error: cannot rebase: You have unstaged changes.\n" +
					"error: additionally, your index contains uncommitted changes.\n" +
					"error: Please commit or stash them.\n",
				exitCode: 1,
			};

		case "dirtyWorktree":
			return renderDirtyWorktree(outcome.state);

		case "preRebaseRejected":
			return { stdout: "", stderr: outcome.message, exitCode: 1 };

		case "signingFailed":
			return err("error: gpg failed to sign the data\n", 128);

		case "checkoutBlocked": {
			const errorOutput = renderCheckoutBlocked(outcome.rejected);
			return {
				stdout: "",
				stderr: renderSkip(outcome.skipped) + errorOutput,
				exitCode: 1,
			};
		}

		case "rebased":
			return {
				stdout: renderFinalizedStdout(outcome.finalizedCommit),
				stderr:
					renderSkip(outcome.skipped) +
					renderSteps(outcome.steps) +
					`Successfully rebased and updated ${outcome.headName}.\n`,
				exitCode: 0,
			};

		case "stopped":
			return {
				stdout:
					renderFinalizedStdout(outcome.finalizedCommit) + renderConflictStdout(outcome.conflict),
				stderr:
					renderSkip(outcome.skipped) +
					renderSteps(outcome.steps) +
					renderProgress(outcome.progress) +
					renderConflictStderr(outcome.conflict),
				exitCode: 1,
			};

		case "refLockFailure":
			return {
				stdout: "",
				stderr:
					renderSkip(outcome.skipped) +
					renderSteps(outcome.steps) +
					`error: update_ref failed for ref '${outcome.headName}': cannot lock ref '${outcome.headName}': ` +
					`is at ${outcome.actual ?? "(null)"} but expected ${outcome.expected}\n` +
					`error: could not update ${outcome.headName}\n`,
				exitCode: 1,
			};

		case "aborted":
			return { stdout: "", stderr: "", exitCode: 0 };

		case "abortBlocked": {
			const errorText = renderUnpackErrors(outcome.rejected, {
				operationName: "reset",
				actionHint: "reset",
			});
			return {
				stdout: "",
				stderr: `${errorText}fatal: could not move back to ${outcome.origHead}\n`,
				exitCode: 128,
			};
		}

		case "skipNoHead":
			return {
				stdout: "",
				stderr:
					"error: could not determine HEAD revision\n" +
					"fatal: could not discard worktree changes\n",
				exitCode: 128,
			};

		case "unmergedContinue":
			return err(
				"error: Committing is not possible because you have unmerged files.\nhint: Fix them up in the work tree, and then use 'git add <file>'\nhint: as appropriate to mark resolution and make a commit.\nfatal: Exiting because of an unresolved conflict.\n",
				128,
			);

		case "stagedChangesContinue":
			return err(
				"error: you have staged changes in your working tree\n" +
					"If these changes are meant to be squashed into the previous commit, run:\n\n" +
					"  git commit --amend \n\n" +
					"If they are meant to go into a new commit, run:\n\n" +
					"  git commit \n\n" +
					"In both cases, once you're done, continue with:\n\n" +
					"  git rebase --continue\n\n",
			);

		case "fatal":
			return fatal(outcome.message);
	}
}

function upToDateMessage(branchName: string): string {
	if (branchName === "HEAD") return "HEAD is up to date.\n";
	return `Current branch ${branchName} is up to date.\n`;
}

function renderDirtyWorktree(state: SequencerDirtyState): CommandResult {
	const lines: string[] = [];
	if (state.hasUnstaged) lines.push("error: cannot rebase: You have unstaged changes.");
	if (state.hasStaged) {
		lines.push(
			state.hasUnstaged
				? "error: additionally, your index contains uncommitted changes."
				: "error: cannot rebase: Your index contains uncommitted changes.",
		);
	}
	lines.push("error: Please commit or stash them.");
	return err(`${lines.join("\n")}\n`, 1);
}

/** The cherry-pick skip warning block prepended to rebase output. */
function renderSkip(skipped: string[]): string {
	if (skipped.length === 0) return "";
	const warnings = skipped.map((h) => `warning: skipped previously applied commit ${h}`);
	return (
		`${warnings.join("\n")}\n` +
		"hint: use --reapply-cherry-picks to include skipped commits\n" +
		'hint: Disable this message with "git config set advice.skippedCherryPicks false"\n'
	);
}

function renderProgress(progress: RebaseProgress): string {
	// \r so the terminal overwrites the progress line.
	return `Rebasing (${progress.current}/${progress.total})\r`;
}

function renderSteps(steps: RebaseStep[]): string {
	let out = "";
	for (const step of steps) {
		out += renderProgress(step.progress);
		if (step.message.kind === "dropped") {
			out += `dropping ${step.message.hash} ${step.message.subject} -- patch contents already upstream\n`;
		}
	}
	return out;
}

function renderCheckoutBlocked(rejected: RejectedPath[]): string {
	const errorText = renderUnpackErrors(rejected, {
		operationName: "checkout",
		actionHint: "switch branches",
	});
	return `${errorText}error: could not detach HEAD\n`;
}

function renderConflictStdout(conflict: RebaseConflict): string {
	if (conflict.kind === "content") {
		const mergeOutput = conflict.mergeMessages.join("\n");
		return mergeOutput ? `${mergeOutput}\n` : "";
	}
	return "";
}

function renderConflictStderr(conflict: RebaseConflict): string {
	switch (conflict.kind) {
		case "content":
			return (
				`error: could not apply ${conflict.shortHash}... ${conflict.subject}\n` +
				"hint: Resolve all conflicts manually, mark them as resolved with\n" +
				'hint: "git add/rm <conflicted_files>", then run "git rebase --continue".\n' +
				'hint: You can instead skip this commit: run "git rebase --skip".\n' +
				'hint: To abort and get back to the state before "git rebase", run "git rebase --abort".\n' +
				'hint: Disable this message with "git config set advice.mergeConflict false"\n' +
				`Could not apply ${conflict.shortHash}... # ${conflict.subject}\n`
			);
		case "untracked":
			return formatUntrackedMergeError(conflict.blockedPaths, conflict.entry);
		case "fatal":
			return `fatal: ${conflict.message}\n`;
	}
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

function renderFinalizedStdout(finalized?: FinalizedRebaseCommit): string {
	if (!finalized) return "";
	const header = renderCommitOneLiner(
		finalized.oneLiner.branchName,
		finalized.oneLiner.shortHash,
		finalized.oneLiner.message,
	);
	const summary = renderCommitSummary({
		author: finalized.author,
		committer: finalized.committer,
		showDate: finalized.showDate,
		isMerge: false,
		stats: finalized.stats,
	});
	return `${header}\n${summary}`;
}
