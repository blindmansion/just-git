/**
 * Presentation for unpack-trees precondition failures: the git-exact stderr
 * blocks describing paths that would be overwritten/removed. Pure renderers over
 * the structured `RejectedPath[]` gathered in `lib/worktree/unpack-trees.ts`
 * (the lib layer surfaces the rejections; exit codes are decided by the command
 * tier). No I/O.
 */
import { type RejectedPath, UnpackError } from "../../../lib/worktree/unpack-trees.ts";

/** Context needed to word an unpack-trees error block. */
export interface UnpackErrorContext {
	/** Operation name for the "overwritten by <op>" message ("checkout", "merge", ...). */
	operationName: string;
	/** Override for "before you <action>" text (e.g. "switch branches"). Defaults to operationName. */
	actionHint?: string;
}

/**
 * Templates for git's `display_error_msgs()` pattern:
 *   - Each UnpackError type gets its own block (git keeps separate rejection lists)
 *   - WOULD_OVERWRITE (staged changes) and NOT_UPTODATE_FILE (dirty worktree)
 *     both produce "Your local changes..." but as separate blocks
 *   - Paths sorted within each group
 *   - "Aborting" appended once at the end
 */
const ERROR_TEMPLATES: Array<{
	error: UnpackError;
	msg: (op: string) => string;
	fix: (action: string) => string;
}> = [
	{
		error: UnpackError.WOULD_OVERWRITE,
		msg: (op) => `error: Your local changes to the following files would be overwritten by ${op}:`,
		fix: (a) => `Please commit your changes or stash them before you ${a}.`,
	},
	{
		error: UnpackError.NOT_UPTODATE_FILE,
		msg: (op) => `error: Your local changes to the following files would be overwritten by ${op}:`,
		fix: (a) => `Please commit your changes or stash them before you ${a}.`,
	},
	{
		error: UnpackError.WOULD_LOSE_UNTRACKED_OVERWRITTEN,
		msg: (op) => `error: The following untracked working tree files would be overwritten by ${op}:`,
		fix: (a) => `Please move or remove them before you ${a}.`,
	},
	{
		error: UnpackError.WOULD_LOSE_UNTRACKED_REMOVED,
		msg: (op) => `error: The following untracked working tree files would be removed by ${op}:`,
		fix: (a) => `Please move or remove them before you ${a}.`,
	},
];

/**
 * Render collected unpack-trees rejections into git's `display_error_msgs()`
 * stderr block, or `""` when none of the rejections match a template.
 */
export function renderUnpackErrors(rejected: RejectedPath[], ctx: UnpackErrorContext): string {
	const action = ctx.actionHint ?? ctx.operationName;
	const blocks: string[] = [];

	for (const { error, msg, fix } of ERROR_TEMPLATES) {
		const paths = rejected
			.filter((r) => r.error === error)
			.map((r) => r.path)
			.sort();
		if (paths.length > 0) {
			const fileList = paths.map((f) => `\t${f}`).join("\n");
			blocks.push(`${msg(ctx.operationName)}\n${fileList}\n${fix(action)}\n`);
		}
	}

	return blocks.length > 0 ? `${blocks.join("")}Aborting\n` : "";
}

/**
 * Render the `merge --abort` (`mergeAbort`) failure block. Only the two error
 * kinds git surfaces on this path are worded; returns `""` when none apply.
 */
export function renderMergeAbortError(rejected: RejectedPath[], revName: string): string {
	const lines: string[] = [];
	for (const e of rejected) {
		if (e.error === UnpackError.NOT_UPTODATE_FILE) {
			lines.push(`error: Entry '${e.path}' not uptodate. Cannot merge.\n`);
		} else if (e.error === UnpackError.WOULD_LOSE_UNTRACKED_OVERWRITTEN) {
			lines.push(`error: Untracked working tree file '${e.path}' would be overwritten by merge.\n`);
		}
	}
	if (lines.length === 0) return "";
	return `${lines.join("")}fatal: Could not reset index file to revision '${revName}'.\n`;
}
