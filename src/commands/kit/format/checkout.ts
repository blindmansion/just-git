/**
 * Presentation for `git checkout` / `git switch`: the file-change summary,
 * detached-HEAD preamble, cancelled-operation warnings, and tracking-setup
 * message. Pure renderers over the data structs gathered in
 * `lib/worktree/checkout-utils.ts`. No I/O.
 */
import type {
	CheckoutFileChange,
	ClearedOperations,
	DetachPreamble,
	TrackingSetup,
} from "../../../lib/worktree/checkout-utils.ts";

/**
 * Render the file change summary git prints to stdout on `checkout`/`switch`,
 * matching `diff-index HEAD` output (`<status>\t<path>`, sorted by path).
 */
export function renderCheckoutSummary(changes: CheckoutFileChange[]): string {
	if (changes.length === 0) return "";
	const lines = changes.map((c) => `${c.status}\t${c.path}`);
	lines.sort((a, b) => {
		const pathA = a.slice(2);
		const pathB = b.slice(2);
		return pathA < pathB ? -1 : pathA > pathB ? 1 : 0;
	});
	return `${lines.join("\n")}\n`;
}

/**
 * Render the preamble shown when leaving detached HEAD: either the
 * "Warning: you are leaving N commits behind" block (truncated past the
 * threshold) or the "Previous HEAD position was ..." line.
 */
export function renderDetachPreamble(data: DetachPreamble): string {
	switch (data.kind) {
		case "none":
			return "";
		case "prev-head":
			return `Previous HEAD position was ${data.abbrev} ${data.subject}\n`;
		case "orphan": {
			const { count, commits, remaining, branchExample } = data;
			const plural = count === 1 ? "commit" : "commits";
			const keepWord = count === 1 ? "it" : "them";
			const lines = commits.map((c) => `  ${c.abbrev} ${c.subject}`);
			if (remaining > 0) {
				lines.push(` ... and ${remaining} more.`);
			}
			return (
				`Warning: you are leaving ${count} ${plural} behind, not connected to\n` +
				`any of your branches:\n` +
				`\n` +
				`${lines.join("\n")}\n` +
				`\n` +
				`If you want to keep ${keepWord} by creating a new branch, this may be a good time\n` +
				`to do so with:\n` +
				`\n` +
				` git branch <new-branch-name> ${branchExample}\n` +
				`\n`
			);
		}
	}
}

/**
 * Render the warnings git emits when a checkout/switch cancels an
 * in-progress cherry-pick or revert.
 */
export function renderCancelWarnings(cleared: ClearedOperations): string {
	let warning = "";
	if (cleared.cherryPickCancelled) {
		warning += "warning: cancelling a cherry picking in progress\n";
	}
	if (cleared.revertCancelled) {
		warning += "warning: cancelling a revert in progress\n";
	}
	return warning;
}

/**
 * Render the "branch '<name>' set up to track '<remote>/<branch>'." message.
 */
export function renderTrackingSetup(branchName: string, setup: TrackingSetup): string {
	return `branch '${branchName}' set up to track '${setup.remote}/${setup.branch}'.\n`;
}
