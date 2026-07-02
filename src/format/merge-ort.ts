/**
 * Presentation for merge-ort precondition failures: the git-exact stderr blocks
 * describing files that would be overwritten when applying a merge result. Pure
 * renderers over the structured file lists gathered in `lib/merge-ort.ts` (the
 * lib layer surfaces the paths; exit codes are decided by the command tier). No
 * I/O.
 */

/**
 * Format precondition error messages for merge-ort operations.
 *
 * - `git merge`: ort-style (space-separated files, "Merge with strategy ort failed.")
 * - `git cherry-pick` / `git rebase`: sequencer-style (tab-indented, standard unpack message + fatal line)
 */
export function renderMergeOrtError(
	files: string[],
	operationName: string,
	callerCommand: string,
	errorType: "local" | "untracked",
	checkPhase: "staged" | "worktree",
): string {
	const header =
		errorType === "untracked"
			? `error: The following untracked working tree files would be overwritten by ${operationName}:`
			: `error: Your local changes to the following files would be overwritten by ${operationName}:`;

	if (callerCommand === "merge") {
		if (checkPhase === "staged") {
			// Staged-change check: pure ort format (space-separated, two-space indent)
			return `${header}\n  ${files.join(" ")}\nMerge with strategy ort failed.\n`;
		}
		// Worktree check: standard unpack-trees message + ort trailer
		const fileList = files.map((f) => `\t${f}`).join("\n");
		const hint =
			errorType === "untracked"
				? `Please move or remove them before you ${operationName}.`
				: `Please commit your changes or stash them before you ${operationName}.`;
		return `${header}\n${fileList}\n${hint}\nAborting\nMerge with strategy ort failed.\n`;
	}

	// Sequencer-style (cherry-pick/rebase): tab-indented + "fatal: <cmd> failed"
	const fileList = files.map((f) => `\t${f}`).join("\n");
	const hint =
		errorType === "untracked"
			? `Please move or remove them before you ${operationName}.`
			: `Please commit your changes or stash them before you ${operationName}.`;
	return `${header}\n${fileList}\n${hint}\nAborting\nfatal: ${callerCommand} failed\n`;
}

/**
 * Format multi-block worktree errors for merge-ort when both local changes
 * and untracked files are present. Produces separate error blocks with a
 * single "Aborting" + trailer at the end.
 */
export function renderMergeOrtWorktreeMultiBlock(
	localFiles: string[],
	untrackedFiles: string[],
	operationName: string,
	callerCommand: string,
): string {
	const blocks: string[] = [];

	if (localFiles.length > 0) {
		const fileList = localFiles.map((f) => `\t${f}`).join("\n");
		blocks.push(
			`error: Your local changes to the following files would be overwritten by ${operationName}:\n${fileList}\nPlease commit your changes or stash them before you ${operationName}.\n`,
		);
	}

	if (untrackedFiles.length > 0) {
		const fileList = untrackedFiles.map((f) => `\t${f}`).join("\n");
		blocks.push(
			`error: The following untracked working tree files would be overwritten by ${operationName}:\n${fileList}\nPlease move or remove them before you ${operationName}.\n`,
		);
	}

	const trailer =
		callerCommand === "merge"
			? "Merge with strategy ort failed."
			: `fatal: ${callerCommand} failed`;

	return `${blocks.join("")}Aborting\n${trailer}\n`;
}
