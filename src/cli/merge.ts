// Command-tier rendering for `applyMergeResult` precondition failures: maps the
// lib-owned structured `ApplyMergeFailure` (which phase refused + the sorted path
// lists) to the git-exact `CommandResult` (stderr text + exit code). `lib/merge-ort.ts`
// surfaces only data; this is where the CLI contract is assembled.

import type { ApplyMergeFailure } from "../lib/merge-ort.ts";
import { renderMergeOrtError, renderMergeOrtWorktreeMultiBlock } from "../format/merge-ort.ts";
import type { CommandResult } from "./command-errors.ts";

/** Presentation context for wording an {@link ApplyMergeFailure}. */
export interface ApplyMergeRenderContext {
	/** Operation name for the "overwritten by <op>" message (git uses "merge"). */
	operationName: string;
	/**
	 * The top-level command that initiated the merge ("merge", "cherry-pick",
	 * "revert", "rebase"). Controls the trailer:
	 * - "merge": ort-style ("Merge with strategy ort failed.")
	 * - otherwise: sequencer-style ("fatal: <cmd> failed")
	 */
	callerCommand: string;
	/** Exit code for the precondition failure (2 for merge/pull, 128 for cherry-pick/revert). */
	errorExitCode: number;
}

/**
 * Render an {@link ApplyMergeFailure} to the base `CommandResult` git emits.
 * Callers layer any additional chrome (fetch output, reflog side effects) on top.
 */
export function renderApplyMerge(
	failure: ApplyMergeFailure,
	ctx: ApplyMergeRenderContext,
): CommandResult {
	const { operationName, callerCommand, errorExitCode } = ctx;

	if (failure.kind === "staged") {
		return {
			stdout: "",
			stderr: renderMergeOrtError(
				failure.localFiles,
				operationName,
				callerCommand,
				"local",
				"staged",
			),
			exitCode: errorExitCode,
		};
	}

	const { localFiles, untrackedFiles } = failure;
	let stderr: string;
	if (localFiles.length > 0 && untrackedFiles.length > 0) {
		stderr = renderMergeOrtWorktreeMultiBlock(
			localFiles,
			untrackedFiles,
			operationName,
			callerCommand,
		);
	} else if (untrackedFiles.length > 0) {
		stderr = renderMergeOrtError(
			untrackedFiles,
			operationName,
			callerCommand,
			"untracked",
			"worktree",
		);
	} else {
		stderr = renderMergeOrtError(localFiles, operationName, callerCommand, "local", "worktree");
	}
	return { stdout: "", stderr, exitCode: errorExitCode };
}
