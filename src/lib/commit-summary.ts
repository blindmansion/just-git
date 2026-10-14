/**
 * Shared commit summary formatting (shortstat, diffstat and --summary
 * lines). Used by git commit, cherry-pick and merge, and by the --stat
 * and --summary output of show, log and diff.
 */
import { formatDate } from "./date.ts";
import { myersDiff, splitLinesWithNL } from "./diff-algorithm.ts";
import { isBinaryBytes, isBinaryStr, readBlobBytes, readBlobContent } from "./object-db.ts";
import {
	detectRenames,
	formatRenamePath,
	type RenamePair,
	resolveRenameLimit,
} from "./rename-detection.ts";
import { diffTrees } from "./tree-ops.ts";
import type { GitRepo, Identity, ObjectId, TreeDiffEntry } from "./types.ts";

const textDecoder = new TextDecoder();

/** Count lines in content. Empty string = 0 lines. */
function countLines(content: string): number {
	if (content.length === 0) return 0;
	let count = 0;
	for (let i = 0; i < content.length; i++) {
		if (content[i] === "\n") count++;
	}
	if (content[content.length - 1] !== "\n") count++;
	return count;
}

/**
 * Format the shortstat insertions/deletions parts using git's
 * exact logic from `print_stat_summary()` in diff.c:
 *   show insertions if: insertions > 0 || deletions == 0
 *   show deletions if:  deletions > 0 || insertions == 0
 * This ensures "0 insertions(+), 0 deletions(-)" appears for pure renames.
 */
export function formatShortstatParts(
	filesChanged: number,
	totalInsertions: number,
	totalDeletions: number,
): string {
	if (filesChanged === 0) return "";
	const parts: string[] = [];
	parts.push(`${filesChanged} file${filesChanged !== 1 ? "s" : ""} changed`);
	if (totalInsertions > 0 || totalDeletions === 0) {
		parts.push(`${totalInsertions} insertion${totalInsertions !== 1 ? "s" : ""}(+)`);
	}
	if (totalDeletions > 0 || totalInsertions === 0) {
		parts.push(`${totalDeletions} deletion${totalDeletions !== 1 ? "s" : ""}(-)`);
	}
	return ` ${parts.join(", ")}`;
}

/**
 * Compute per-file diff stats (insertions/deletions/binary info) for a
 * set of tree diffs and renames.
 */
export async function computeDiffStats(
	ctx: GitRepo,
	diffs: TreeDiffEntry[],
	renames: RenamePair[],
): Promise<FileStat[]> {
	const fileStats: FileStat[] = [];

	for (const diff of diffs) {
		if (diff.status === "added" && diff.newHash && diff.newMode) {
			const bytes = await readBlobBytes(ctx, diff.newHash);
			if (isBinaryBytes(bytes)) {
				fileStats.push({
					path: diff.path,
					sortKey: diff.path,
					insertions: 0,
					deletions: 0,
					isBinary: true,
					oldSize: 0,
					newSize: bytes.byteLength,
				});
			} else {
				fileStats.push({
					path: diff.path,
					sortKey: diff.path,
					insertions: countLines(textDecoder.decode(bytes)),
					deletions: 0,
				});
			}
		} else if (diff.status === "deleted" && diff.oldHash && diff.oldMode) {
			const bytes = await readBlobBytes(ctx, diff.oldHash);
			if (isBinaryBytes(bytes)) {
				fileStats.push({
					path: diff.path,
					sortKey: diff.path,
					insertions: 0,
					deletions: 0,
					isBinary: true,
					oldSize: bytes.byteLength,
					newSize: 0,
				});
			} else {
				fileStats.push({
					path: diff.path,
					sortKey: diff.path,
					insertions: 0,
					deletions: countLines(textDecoder.decode(bytes)),
				});
			}
		} else if (diff.status === "modified" && diff.oldHash && diff.newHash) {
			const oldBytes = await readBlobBytes(ctx, diff.oldHash);
			const newBytes = await readBlobBytes(ctx, diff.newHash);
			if (isBinaryBytes(oldBytes) || isBinaryBytes(newBytes)) {
				fileStats.push({
					path: diff.path,
					sortKey: diff.path,
					insertions: 0,
					deletions: 0,
					isBinary: true,
					oldSize: oldBytes.byteLength,
					newSize: newBytes.byteLength,
				});
			} else {
				const oldLines = splitLinesWithNL(textDecoder.decode(oldBytes));
				const newLines = splitLinesWithNL(textDecoder.decode(newBytes));
				const edits = myersDiff(oldLines, newLines);
				let ins = 0;
				let del = 0;
				for (const edit of edits) {
					if (edit.type === "insert") ins++;
					else if (edit.type === "delete") del++;
				}
				fileStats.push({
					path: diff.path,
					sortKey: diff.path,
					insertions: ins,
					deletions: del,
				});
			}
		}
	}

	for (const rename of renames) {
		const display = formatRenamePath(rename.oldPath, rename.newPath);
		let ins = 0;
		let del = 0;
		if (rename.similarity < 100 && rename.oldHash && rename.newHash) {
			const oldContent = await readBlobContent(ctx, rename.oldHash);
			const newContent = await readBlobContent(ctx, rename.newHash);
			if (!isBinaryStr(oldContent) && !isBinaryStr(newContent)) {
				const oldLines = splitLinesWithNL(oldContent);
				const newLines = splitLinesWithNL(newContent);
				const edits = myersDiff(oldLines, newLines);
				for (const edit of edits) {
					if (edit.type === "insert") ins++;
					else if (edit.type === "delete") del++;
				}
			}
		}
		fileStats.push({
			path: display,
			sortKey: rename.newPath,
			insertions: ins,
			deletions: del,
		});
	}

	return fileStats;
}

const C_QUOTE_ESCAPES: Record<number, string> = {
	0x07: "\\a",
	0x08: "\\b",
	0x09: "\\t",
	0x0a: "\\n",
	0x0b: "\\v",
	0x0c: "\\f",
	0x0d: "\\r",
	0x22: '\\"',
	0x5c: "\\\\",
};

/** Quote a path the way git's `quote_c_style` does with `core.quotePath` on. */
function quoteCPath(path: string): string {
	let out = "";
	let quoted = false;
	for (const byte of new TextEncoder().encode(path)) {
		const escape = C_QUOTE_ESCAPES[byte];
		if (escape) {
			out += escape;
			quoted = true;
		} else if (byte < 0x20 || byte >= 0x7f) {
			out += `\\${byte.toString(8).padStart(3, "0")}`;
			quoted = true;
		} else {
			out += String.fromCharCode(byte);
		}
	}
	return quoted ? `"${out}"` : path;
}

/** The parts of a rename that `--summary` prints. */
export type SummaryRename = Pick<
	RenamePair,
	"oldPath" | "newPath" | "similarity" | "oldMode" | "newMode"
>;

/**
 * Format git's `--summary` lines: one line per created, deleted or
 * mode-changed path, and a rename line (followed by a pathless mode
 * line when the mode changed too) per rename. Sorted by path, with
 * renames at their new path. Shared by `show`, `log`, `diff` and the
 * summaries printed after `commit` and `merge`.
 */
export function formatSummaryLines(
	diffs: readonly TreeDiffEntry[],
	renames: readonly SummaryRename[],
): string {
	const modeChange = (oldMode?: string, newMode?: string) =>
		oldMode && newMode && oldMode !== newMode ? ` mode change ${oldMode} => ${newMode}` : null;

	const entries: { sortKey: string; text: string }[] = [];
	for (const diff of diffs) {
		const path = quoteCPath(diff.path);
		let text: string | null = null;
		if (diff.status === "added") {
			text = ` create mode ${diff.newMode} ${path}\n`;
		} else if (diff.status === "deleted") {
			text = ` delete mode ${diff.oldMode} ${path}\n`;
		} else {
			const line = modeChange(diff.oldMode, diff.newMode);
			if (line) text = `${line} ${path}\n`;
		}
		if (text) entries.push({ sortKey: diff.path, text });
	}
	for (const rename of renames) {
		const oldQuoted = quoteCPath(rename.oldPath);
		const newQuoted = quoteCPath(rename.newPath);
		const display =
			oldQuoted !== rename.oldPath || newQuoted !== rename.newPath
				? `${oldQuoted} => ${newQuoted}`
				: formatRenamePath(rename.oldPath, rename.newPath);
		const line = modeChange(rename.oldMode, rename.newMode);
		entries.push({
			sortKey: rename.newPath,
			text: ` rename ${display} (${rename.similarity}%)\n${line ? `${line}\n` : ""}`,
		});
	}
	entries.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
	return entries.map((e) => e.text).join("");
}

/**
 * Combine a diff's main output with its `--summary` lines in git's
 * order: the summary follows the stat formats, and comes before a patch
 * with a blank line between them.
 */
export function withSummary(main: string, summary: string, mainIsPatch: boolean): string {
	if (mainIsPatch && summary) return `${summary}\n${main}`;
	return main + summary;
}

/**
 * Format the commit summary (Author, Date, shortstat, mode lines).
 *
 * This is git's `print_commit_summary()` output, used after
 * `git commit`, `git cherry-pick`, and `git merge` create a commit.
 */
export async function formatCommitSummary(
	ctx: GitRepo,
	parentTree: ObjectId | null,
	newTree: ObjectId,
	author: Identity,
	committer: Identity,
	showDate = false,
	isMerge = false,
): Promise<string> {
	const lines: string[] = [];

	if (author.name !== committer.name || author.email !== committer.email) {
		lines.push(` Author: ${author.name} <${author.email}>`);
	}

	if (showDate) {
		lines.push(` Date: ${formatDate(author.timestamp, author.timezone)}`);
	}

	if (isMerge) {
		return lines.join("\n") + (lines.length > 0 ? "\n" : "");
	}

	const rawDiffs = await diffTrees(ctx, parentTree, newTree);
	const renameLimit = await resolveRenameLimit(ctx, "diff");
	const { remaining: diffs, renames } = await detectRenames(ctx, rawDiffs, {
		limit: renameLimit,
	});
	const fileStats = await computeDiffStats(ctx, diffs, renames);

	let totalInsertions = 0;
	let totalDeletions = 0;
	for (const stat of fileStats) {
		totalInsertions += stat.insertions;
		totalDeletions += stat.deletions;
	}

	const shortstat = formatShortstatParts(fileStats.length, totalInsertions, totalDeletions);
	if (shortstat) lines.push(shortstat);

	const head = lines.join("\n") + (lines.length > 0 ? "\n" : "");
	return head + formatSummaryLines(diffs, renames);
}

// ── Diffstat formatting (for merge/FF output) ───────────────────

const STAT_WIDTH = 80;

export interface FileStat {
	/** Display path (e.g. rename format "{old => new}/file"). */
	path: string;
	/** Key for sorting — new path for renames, same as path otherwise. */
	sortKey: string;
	insertions: number;
	deletions: number;
	/** Binary file — show "Bin X -> Y bytes" instead of line counts. */
	isBinary?: boolean;
	oldSize?: number;
	newSize?: number;
	/** Unmerged file — show "Unmerged" instead of line counts. */
	isUnmerged?: boolean;
}

/**
 * Abbreviate a path by stripping leading directory components and
 * prepending "..." until it fits within maxWidth. Matches git's
 * `show_name()` behavior in `diff.c`.
 */
function abbreviatePath(path: string, maxWidth: number): string {
	if (path.length <= maxWidth) return path;
	let rest = path;
	while (rest.length + 4 > maxWidth) {
		const slashIdx = rest.indexOf("/");
		if (slashIdx === -1) break;
		rest = rest.slice(slashIdx + 1);
	}
	const abbreviated = `.../${rest}`;
	if (abbreviated.length <= maxWidth) return abbreviated;
	// Even the filename alone is too long — truncate from the left
	return `...${path.slice(path.length - (maxWidth - 3))}`;
}

/**
 * Render pre-computed file stats into diffstat output lines.
 * Handles column sizing, path abbreviation, bar scaling, and the
 * shortstat summary line.
 *
 * Callers must sort `fileStats` before calling. This function mutates
 * `stat.path` via `abbreviatePath` to fit column width constraints.
 */
export function renderStatLines(fileStats: FileStat[], statWidth = STAT_WIDTH): string {
	if (fileStats.length === 0) return "";

	const nonUnmerged = fileStats.filter((f) => !f.isUnmerged);
	const maxTotal =
		nonUnmerged.length > 0 ? Math.max(...nonUnmerged.map((f) => f.insertions + f.deletions)) : 0;
	const hasBinary = fileStats.some((f) => f.isBinary);
	let numberWidth = maxTotal > 0 ? String(maxTotal).length : 1;
	// Binary lines render "Bin" in the numeric column, so git keeps at least
	// width 3 when any binary entry is present.
	if (hasBinary && numberWidth < 3) {
		numberWidth = 3;
	}
	const maxNameLen = Math.max(...fileStats.map((f) => f.path.length));

	let graphWidth = maxTotal;
	let nameWidth = maxNameLen;

	if (nameWidth + numberWidth + 6 + graphWidth > statWidth) {
		const graphCap = Math.floor((statWidth * 3) / 8) - numberWidth - 6;
		if (graphWidth > graphCap) {
			graphWidth = Math.max(graphCap, 6);
		}
		const nameCap = statWidth - numberWidth - 6 - graphWidth;
		if (nameWidth > nameCap) {
			nameWidth = nameCap;
		} else {
			graphWidth = statWidth - numberWidth - 6 - nameWidth;
		}
	}

	for (const stat of fileStats) {
		stat.path = abbreviatePath(stat.path, nameWidth);
	}
	const padWidth = nameWidth;

	const lines: string[] = [];
	let totalInsertions = 0;
	let totalDeletions = 0;
	let changedFiles = 0;

	for (const stat of fileStats) {
		const paddedPath = stat.path.padEnd(padWidth);

		if (stat.isUnmerged) {
			lines.push(` ${paddedPath} | Unmerged`);
			continue;
		}

		changedFiles++;
		totalInsertions += stat.insertions;
		totalDeletions += stat.deletions;

		if (stat.isBinary) {
			const binLabel = "Bin".padStart(numberWidth);
			const binStr = `${binLabel} ${stat.oldSize ?? 0} -> ${stat.newSize ?? 0} bytes`;
			lines.push(` ${paddedPath} | ${binStr}`);
			continue;
		}

		const total = stat.insertions + stat.deletions;
		const paddedCount = String(total).padStart(numberWidth);

		let barIns: number;
		let barDel: number;
		if (maxTotal <= graphWidth) {
			barIns = stat.insertions;
			barDel = stat.deletions;
		} else {
			const scaleLinear = (it: number): number =>
				it === 0 ? 0 : 1 + Math.floor((it * (graphWidth - 1)) / maxTotal);

			const scaledTotal = scaleLinear(total);
			const barTotal =
				scaledTotal < 2 && stat.insertions > 0 && stat.deletions > 0 ? 2 : scaledTotal;

			if (stat.insertions < stat.deletions) {
				barIns = scaleLinear(stat.insertions);
				barDel = barTotal - barIns;
			} else {
				barDel = scaleLinear(stat.deletions);
				barIns = barTotal - barDel;
			}
		}

		const bar = "+".repeat(barIns) + "-".repeat(barDel);
		const barStr = bar ? ` ${bar}` : "";
		lines.push(` ${paddedPath} | ${paddedCount}${barStr}`);
	}

	const shortstat = formatShortstatParts(changedFiles, totalInsertions, totalDeletions);
	if (shortstat) {
		lines.push(shortstat);
	} else if (fileStats.some((f) => f.isUnmerged)) {
		lines.push(" 0 files changed");
	}

	return `${lines.join("\n")}\n`;
}

/**
 * Format the full `--stat` style diffstat output used by merge and
 * fast-forward commands. Matches git's column sizing, path abbreviation,
 * and bar scaling.
 *
 * Format:
 *   <path>  | <count> <bar>
 *   N files changed, N insertions(+), N deletions(-)
 *   create mode 100644 <path>
 */
export async function formatDiffStat(
	ctx: GitRepo,
	oldTree: ObjectId | null,
	newTree: ObjectId,
): Promise<string> {
	const rawDiffs = await diffTrees(ctx, oldTree, newTree);
	const renameLimit = await resolveRenameLimit(ctx, "diff");
	const { remaining: diffs, renames } = await detectRenames(ctx, rawDiffs, {
		limit: renameLimit,
	});
	if (diffs.length === 0 && renames.length === 0) return "";

	const fileStats = await computeDiffStats(ctx, diffs, renames);

	fileStats.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));

	return renderStatLines(fileStats) + formatSummaryLines(diffs, renames);
}
