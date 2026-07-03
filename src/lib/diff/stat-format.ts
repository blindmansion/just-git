/**
 * Pure `--stat` diffstat rendering.
 *
 * Turns the data structs gathered by `lib/commit-summary.ts` (`FileStat[]` +
 * `ModeChange[]`) into git's byte-exact diffstat block: the per-file
 * `<path> | <count> <bar>` lines, the `N files changed, …` shortstat summary,
 * and the `create/delete/rename mode` lines. No I/O.
 *
 * Lives in `lib` (not the command kit) because the diffstat is part of the git
 * patch wire format — `format-patch` embeds it between the `---` separator and
 * the diff — so lib-side patch code must be able to render it without reaching
 * up into the command tier.
 */
import type { DiffStats, FileStat, ModeChange } from "../commit-summary.ts";
import { formatRenamePath } from "./rename-detection.ts";

const STAT_WIDTH = 80;

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

/** The display path git shows for a file stat — "{old => new}" form for renames. */
function displayPath(f: FileStat): string {
	return f.rename ? formatRenamePath(f.rename.oldPath, f.rename.newPath) : f.path;
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

/** Render one create/delete/rename mode line (no trailing newline). */
export function renderModeLine(mc: ModeChange): string {
	switch (mc.kind) {
		case "create":
			return ` create mode ${mc.mode} ${mc.path}`;
		case "delete":
			return ` delete mode ${mc.mode} ${mc.path}`;
		case "rename":
			return ` rename ${formatRenamePath(mc.oldPath, mc.newPath)} (${mc.similarity}%)`;
	}
}

/**
 * Render pre-computed file stats into diffstat output lines.
 * Handles column sizing, path abbreviation, bar scaling, and the
 * shortstat summary line.
 *
 * Callers must sort `fileStats` by `sortKey` before calling.
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
	const maxNameLen = Math.max(...fileStats.map((f) => displayPath(f).length));

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

	const padWidth = nameWidth;

	const lines: string[] = [];
	let totalInsertions = 0;
	let totalDeletions = 0;
	let changedFiles = 0;

	for (const stat of fileStats) {
		const paddedPath = abbreviatePath(displayPath(stat), nameWidth).padEnd(padWidth);

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
 * Render the full `--stat` style diffstat output used by merge and
 * fast-forward commands. Matches git's column sizing, path abbreviation,
 * and bar scaling.
 *
 * Format:
 *   <path>  | <count> <bar>
 *   N files changed, N insertions(+), N deletions(-)
 *   create mode 100644 <path>
 */
export function renderDiffStat(stats: DiffStats, statWidth = STAT_WIDTH): string {
	const { fileStats, modeChanges } = stats;
	if (fileStats.length === 0 && modeChanges.length === 0) return "";

	const sorted = [...fileStats].sort((a, b) =>
		a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0,
	);
	let output = renderStatLines(sorted, statWidth);
	for (const mc of modeChanges) {
		output += `${renderModeLine(mc)}\n`;
	}
	return output;
}
