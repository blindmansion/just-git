/**
 * Presentation for commit summaries and `--stat` diffstats.
 *
 * The pure-render half of the commit-summary concern: it turns the data structs
 * gathered by `lib/commit-summary.ts` (`FileStat[]` + `ModeChange[]`) into the
 * byte-exact output git prints after commit/cherry-pick/merge and for
 * `diff`/`log`/`show` `--stat`/`--shortstat`. No I/O.
 */
import type { DiffStats } from "../../../lib/commit-summary.ts";
import { formatDate } from "../../../lib/date.ts";
import {
	formatShortstatParts,
	renderDiffStat,
	renderModeLine,
} from "../../../lib/diff/stat-format.ts";
import { firstLine } from "../../../lib/text-utils.ts";
import type { Identity } from "../../../lib/types.ts";

/**
 * Render git's one-line commit header: `[<branch>[ (root-commit)] <shortHash>] <subject>`.
 *
 * The caller supplies the already-disambiguated short hash (see
 * `lib/abbrev#uniqueAbbrev`) so this stays a pure, synchronous renderer.
 */
export function renderCommitOneLiner(
	branchName: string,
	shortHash: string,
	message: string,
	rootCommit = false,
): string {
	const rootLabel = rootCommit ? " (root-commit)" : "";
	return `[${branchName}${rootLabel} ${shortHash}] ${firstLine(message)}`;
}

export interface CommitSummaryMeta {
	author: Identity;
	committer: Identity;
	showDate: boolean;
	isMerge: boolean;
	/** null for merges (no diffstat) or when the caller skips the gather. */
	stats: DiffStats | null;
}

/**
 * Render the commit summary (Author, Date, shortstat, mode lines).
 *
 * This is git's `print_commit_summary()` output, used after
 * `git commit`, `git cherry-pick`, and `git merge` create a commit.
 */
export function renderCommitSummary(meta: CommitSummaryMeta): string {
	const { author, committer, showDate, isMerge, stats } = meta;
	const lines: string[] = [];

	if (author.name !== committer.name || author.email !== committer.email) {
		lines.push(` Author: ${author.name} <${author.email}>`);
	}

	if (showDate) {
		lines.push(` Date: ${formatDate(author.timestamp, author.timezone)}`);
	}

	if (isMerge || !stats) {
		return lines.join("\n") + (lines.length > 0 ? "\n" : "");
	}

	let totalInsertions = 0;
	let totalDeletions = 0;
	for (const stat of stats.fileStats) {
		totalInsertions += stat.insertions;
		totalDeletions += stat.deletions;
	}

	const shortstat = formatShortstatParts(stats.fileStats.length, totalInsertions, totalDeletions);
	if (shortstat) lines.push(shortstat);
	for (const mc of stats.modeChanges) lines.push(renderModeLine(mc));

	return lines.join("\n") + (lines.length > 0 ? "\n" : "");
}

/**
 * Render git's fast-forward merge output: the `Updating <old>..<new>` line,
 * the `Fast-forward` label (overridable), and the diffstat.
 */
export function renderFastForward(
	oldShort: string,
	newShort: string,
	stats: DiffStats,
	label = "Fast-forward",
): string {
	return `Updating ${oldShort}..${newShort}\n${label}\n${renderDiffStat(stats)}`;
}
