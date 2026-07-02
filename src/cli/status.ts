import { renderLongStatus } from "../format/status.ts";
import { gatherLongStatus } from "../lib/status-format.ts";
import type { GitContext, Index, ObjectId } from "../lib/types.ts";

/**
 * Produce the full long-form `git status` output as a string: gather the
 * status data in `lib`, then render it with the pure `format` renderer.
 *
 * Used by the status command handler and by commit/cherry-pick/revert/stash
 * paths that print `git status` output. See `gatherLongStatus` for `opts`.
 */
export async function generateLongFormStatus(
	gitCtx: GitContext,
	opts?: {
		fromCommit?: boolean;
		compareHash?: ObjectId | null;
		noWarn?: boolean;
		index?: Index;
	},
): Promise<string> {
	return renderLongStatus(await gatherLongStatus(gitCtx, opts));
}
