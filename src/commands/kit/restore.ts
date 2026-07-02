import { type CommandResult, err, fatal } from "./command-errors.ts";
import type { RestoreOutcome } from "../../lib/worktree/checkout-utils.ts";

/**
 * Map a lib-owned {@link RestoreOutcome} to a `CommandResult`, owning the
 * git-exact stderr text + exit code for each failure. `restore*` operations
 * gather data and mutate on-disk state in `lib`; this is where their display
 * bytes are assembled.
 */
export function renderRestoreOutcome(outcome: RestoreOutcome): CommandResult {
	switch (outcome.kind) {
		case "ok":
			return { stdout: "", stderr: "", exitCode: 0 };
		case "notWorkTree":
			return fatal("this operation must be run in a work tree");
		case "unmerged":
			return err(`error: path '${outcome.path}' is unmerged\n`);
		case "noMatch":
			return err(`error: pathspec '${outcome.pathspec}' did not match any file(s) known to git\n`);
		case "noVersion":
			return err(`error: path '${outcome.path}' does not have ${outcome.side} version\n`);
	}
}
