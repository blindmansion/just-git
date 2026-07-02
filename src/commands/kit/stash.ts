// Command-tier rendering for the stash apply/pop/drop flows: maps the lib-owned
// structured outcomes (`StashApplyError`, drop results) to the git-exact
// `CommandResult` (stderr text + exit code). `lib/stash.ts` surfaces only data;
// this is where the CLI contract is assembled.

import type { StashApplyError } from "../../lib/stash.ts";
import { type CommandResult, err, fatal } from "./command-result.ts";

/** git's "could not restore untracked files from stash" block. */
function renderUntrackedExists(paths: string[]): string {
	return `${paths.map((p) => `${p} already exists, no checkout`).join("\n")}\nerror: could not restore untracked files from stash\n`;
}

/**
 * Render a {@link StashApplyError} to the base `CommandResult` git emits. The
 * stash command handlers layer merge messages / long status / "kept" hints on
 * top of this.
 */
export function renderStashApplyError(error: StashApplyError): CommandResult {
	switch (error.kind) {
		case "noWorkTree":
			return fatal("this operation must be run in a work tree");
		case "invalidStashRef":
			return err(`error: stash@{${error.stashIndex}} is not a valid reference\n`);
		case "noCommits":
			return err("error: your current branch does not have any commits yet\n");
		case "unmergedIndex":
			return {
				stdout: `${error.paths.map((p) => `${p}: needs merge`).join("\n")}\n`,
				stderr: "error: could not write index\n",
				exitCode: 1,
			};
		case "invalidStashCommit":
			return err("error: invalid stash commit (no parent)\n");
		case "wouldOverwrite": {
			let stderr = "";
			if (error.dirty.length > 0) {
				stderr += `error: Your local changes to the following files would be overwritten by merge:\n${error.dirty.map((p) => `\t${p}`).join("\n")}\nPlease commit your changes or stash them before you merge.\n`;
			}
			if (error.untracked.length > 0) {
				stderr += `error: The following untracked working tree files would be overwritten by merge:\n${error.untracked.map((p) => `\t${p}`).join("\n")}\nPlease move or remove them before you merge.\n`;
			}
			stderr += "Aborting\n";
			if (error.untrackedExists.length > 0) {
				stderr += renderUntrackedExists(error.untrackedExists);
			}
			return { stdout: "", stderr, exitCode: 1 };
		}
		case "untrackedExists":
			return { stdout: "", stderr: renderUntrackedExists(error.paths), exitCode: 1 };
	}
}

/** git's invalid-reference error for `stash drop` (no trailing newline). */
export function renderStashDropError(stashIndex: number): CommandResult {
	return err(`error: stash@{${stashIndex}} is not a valid reference`);
}
