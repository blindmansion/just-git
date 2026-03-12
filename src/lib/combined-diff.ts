import { abbreviateHash } from "./command-utils.ts";
import { type Edit, myersDiff, splitLines } from "./diff-algorithm.ts";

/** A line in the combined diff output with per-parent column markers. */
interface CombinedLine {
	/** One character per parent: '+', '-', or ' ' */
	columns: string[];
	text: string;
	/** 1-based line number in result (0 = not a result line, i.e. deletion) */
	resultLineNo: number;
	/** 1-based line number in each parent (0 if line doesn't come from that parent) */
	parentLineNos: number[];
}

interface CombinedDiffEntryOpts {
	path: string;
	parentHashes: (string | null)[];
	parentModes: (string | null)[];
	parentContents: string[];
	resultHash: string | null;
	resultMode: string | null;
	resultContent: string;
}

/**
 * Format a single file's combined diff (`diff --cc`) entry.
 * Takes pre-read content strings for parents and result.
 */
export function formatCombinedDiffEntry(opts: CombinedDiffEntryOpts): string {
	const { path, parentHashes, parentModes, resultHash, resultMode } = opts;

	const lines: string[] = [];

	lines.push(`diff --cc ${path}`);

	const parentHashAbbrevs = parentHashes.map((h) => (h ? abbreviateHash(h) : "0000000"));
	const resultHashAbbrev = resultHash ? abbreviateHash(resultHash) : "0000000";
	lines.push(`index ${parentHashAbbrevs.join(",")}..${resultHashAbbrev}`);

	const hasResultContent = opts.resultContent.length > 0;
	const isNewFile = parentHashes.every((h) => h === null);
	const isDeletedFile = !hasResultContent && parentHashes.some((h) => h !== null);
	if (isNewFile && resultMode) {
		lines.push(`new file mode ${resultMode}`);
	} else if (isDeletedFile) {
		const modeStr = parentModes.map((m) => m || "000000").join(",");
		lines.push(`deleted file mode ${modeStr}`);
	} else {
		const normalizedParentModes = parentModes.map((m) => m || "000000");
		const normalizedResultMode = resultMode || "000000";
		const hasDifferentModes = normalizedParentModes.some((m) => m !== normalizedResultMode);
		if (hasDifferentModes) {
			lines.push(`mode ${normalizedParentModes.join(",")}..${normalizedResultMode}`);
		}
	}

	const hasOldContent = parentHashes.some((h) => h !== null);
	lines.push(hasOldContent ? `--- a/${path}` : "--- /dev/null");
	lines.push(hasResultContent ? `+++ b/${path}` : "+++ /dev/null");

	if (isDeletedFile || isNewFile) {
		return `${lines.join("\n")}\n`;
	}

	const parentContentLines = opts.parentContents.map((c) => (c.length > 0 ? splitLines(c) : []));
	const resultContentLines = opts.resultContent.length > 0 ? splitLines(opts.resultContent) : [];

	const edits = parentContentLines.map((pc) => myersDiff(pc, resultContentLines));

	const combinedLines = buildCombinedLines(parentContentLines, resultContentLines, edits);

	const hunks = buildCombinedHunks(combinedLines, parentContentLines.length, resultContentLines);
	if (hunks.length === 0) return "";
	for (const hunk of hunks) {
		lines.push(hunk);
	}

	return `${lines.join("\n")}\n`;
}

function buildCombinedLines(
	parentContents: string[][],
	resultContent: string[],
	editSets: Edit[][],
): CombinedLine[] {
	const numParents = parentContents.length;

	interface DiffMapping {
		resultStatus: ("keep" | "insert")[];
		deletions: Map<number, { text: string; parentLineNo: number }[]>;
	}

	const mappings: DiffMapping[] = editSets.map((edits) => {
		const resultStatus: ("keep" | "insert")[] = [];
		const deletions = new Map<number, { text: string; parentLineNo: number }[]>();
		let resultIdx = 0;

		for (const edit of edits) {
			if (edit.type === "keep") {
				resultStatus[edit.newLineNo - 1] = "keep";
				resultIdx = edit.newLineNo;
			} else if (edit.type === "insert") {
				resultStatus[edit.newLineNo - 1] = "insert";
				resultIdx = edit.newLineNo;
			} else if (edit.type === "delete") {
				const existing = deletions.get(resultIdx) ?? [];
				existing.push({ text: edit.line, parentLineNo: edit.oldLineNo });
				deletions.set(resultIdx, existing);
			}
		}

		return { resultStatus, deletions };
	});

	const combined: CombinedLine[] = [];

	for (let resultIdx = 0; resultIdx <= resultContent.length; resultIdx++) {
		const parentDels: { text: string; parentLineNo: number }[][] = [];
		for (let p = 0; p < numParents; p++) {
			const mapping = mappings[p];
			parentDels.push(mapping?.deletions.get(resultIdx) ?? []);
		}

		const mergedDels = mergeParentDeletions(parentDels, numParents);
		for (const del of mergedDels) {
			combined.push(del);
		}

		if (resultIdx < resultContent.length) {
			const columns: string[] = [];
			const parentLineNos = Array(numParents).fill(0) as number[];
			for (let p = 0; p < numParents; p++) {
				const mapping = mappings[p];
				const status = mapping?.resultStatus[resultIdx];
				columns.push(status === "insert" ? "+" : " ");
				if (status === "keep") {
					const parentEdits = editSets[p];
					if (parentEdits) {
						for (const edit of parentEdits) {
							if (edit.type === "keep" && edit.newLineNo === resultIdx + 1) {
								parentLineNos[p] = edit.oldLineNo;
								break;
							}
						}
					}
				}
			}
			combined.push({
				columns,
				text: resultContent[resultIdx] ?? "",
				resultLineNo: resultIdx + 1,
				parentLineNos,
			});
		}
	}

	return combined;
}

/**
 * Merge deletion blocks from multiple parents at the same result position.
 * When both parents delete the same line, it appears once with '--'.
 * Lines only in one parent get '- ' or ' -' respectively.
 */
function mergeParentDeletions(
	parentDels: { text: string; parentLineNo: number }[][],
	numParents: number,
): CombinedLine[] {
	const hasAny = parentDels.some((d) => d.length > 0);
	if (!hasAny) return [];

	if (numParents === 2) {
		const dels0 = parentDels[0] ?? [];
		const dels1 = parentDels[1] ?? [];

		if (dels0.length === 0) {
			return dels1.map((d) => ({
				columns: [" ", "-"],
				text: d.text,
				resultLineNo: 0,
				parentLineNos: [0, d.parentLineNo],
			}));
		}
		if (dels1.length === 0) {
			return dels0.map((d) => ({
				columns: ["-", " "],
				text: d.text,
				resultLineNo: 0,
				parentLineNos: [d.parentLineNo, 0],
			}));
		}

		const lines0 = dels0.map((d) => d.text);
		const lines1 = dels1.map((d) => d.text);
		const edits = myersDiff(lines0, lines1);

		const result: CombinedLine[] = [];
		for (const edit of edits) {
			if (edit.type === "keep") {
				const d0 = dels0.find((d) => d.text === edit.line && d.parentLineNo === edit.oldLineNo);
				const d1 = dels1.find((d) => d.text === edit.line && d.parentLineNo === edit.newLineNo);
				result.push({
					columns: ["-", "-"],
					text: edit.line,
					resultLineNo: 0,
					parentLineNos: [d0?.parentLineNo ?? 0, d1?.parentLineNo ?? 0],
				});
			} else if (edit.type === "delete") {
				const d0 = dels0.find((d) => d.parentLineNo === edit.oldLineNo);
				result.push({
					columns: ["-", " "],
					text: edit.line,
					resultLineNo: 0,
					parentLineNos: [d0?.parentLineNo ?? 0, 0],
				});
			} else if (edit.type === "insert") {
				const d1 = dels1.find((d) => d.parentLineNo === edit.newLineNo);
				result.push({
					columns: [" ", "-"],
					text: edit.line,
					resultLineNo: 0,
					parentLineNos: [0, d1?.parentLineNo ?? 0],
				});
			}
		}
		return result;
	}

	const result: CombinedLine[] = [];
	for (let p = 0; p < numParents; p++) {
		const dels = parentDels[p] ?? [];
		for (const del of dels) {
			const columns = Array(numParents).fill(" ") as string[];
			columns[p] = "-";
			const parentLineNos = Array(numParents).fill(0) as number[];
			parentLineNos[p] = del.parentLineNo;
			result.push({
				columns,
				text: del.text,
				resultLineNo: 0,
				parentLineNos,
			});
		}
	}
	return result;
}

function buildCombinedHunks(
	combinedLines: CombinedLine[],
	numParents: number,
	resultContent: string[],
): string[] {
	const CONTEXT = 3;

	const interesting: number[] = [];
	for (let i = 0; i < combinedLines.length; i++) {
		const line = combinedLines[i];
		if (line?.columns.some((c) => c !== " ")) {
			interesting.push(i);
		}
	}

	if (interesting.length === 0) return [];

	const hunkGroups: { start: number; end: number }[] = [];
	const firstInteresting = interesting[0] ?? 0;
	let groupStart = Math.max(0, firstInteresting - CONTEXT);
	let groupEnd = Math.min(combinedLines.length - 1, firstInteresting + CONTEXT);

	for (let i = 1; i < interesting.length; i++) {
		const lineIdx = interesting[i] ?? 0;
		const newStart = Math.max(0, lineIdx - CONTEXT);
		const newEnd = Math.min(combinedLines.length - 1, lineIdx + CONTEXT);

		if (newStart <= groupEnd + 1) {
			groupEnd = newEnd;
		} else {
			hunkGroups.push({ start: groupStart, end: groupEnd });
			groupStart = newStart;
			groupEnd = newEnd;
		}
	}
	hunkGroups.push({ start: groupStart, end: groupEnd });

	const output: string[] = [];
	for (const group of hunkGroups) {
		const hunkLines = combinedLines.slice(group.start, group.end + 1);

		const parentRanges: { start: number; count: number }[] = [];
		for (let p = 0; p < numParents; p++) {
			const parentLines = hunkLines.filter(
				(l) => (l.parentLineNos[p] ?? 0) > 0 || l.columns[p] === "-",
			);
			if (parentLines.length === 0) {
				parentRanges.push({ start: 1, count: 0 });
			} else {
				const firstParentLine = parentLines.find((l) => (l.parentLineNos[p] ?? 0) > 0);
				const firstLine = firstParentLine?.parentLineNos[p] ?? 1;
				parentRanges.push({
					start: firstLine,
					count: parentLines.length,
				});
			}
		}

		const resultLines = hunkLines.filter((l) => l.resultLineNo > 0);
		const firstResultLine = resultLines[0];
		const resultStart = firstResultLine ? firstResultLine.resultLineNo : 1;
		const resultCount = resultLines.length;

		let funcCtx = "";
		for (let i = resultStart - 2; i >= 0; i--) {
			const line = resultContent[i];
			if (line && /^[a-zA-Z$_]/.test(line)) {
				funcCtx = ` ${line.trimEnd().slice(0, 79)}`;
				break;
			}
		}

		const rangeStrs = parentRanges.map((r) => `-${r.start},${r.count}`);
		const header = `${"@".repeat(numParents + 1)} ${rangeStrs.join(" ")} +${resultStart},${resultCount} ${"@".repeat(numParents + 1)}${funcCtx}`;
		output.push(header);

		for (const line of hunkLines) {
			output.push(`${line.columns.join("")}${line.text}`);
		}
	}

	return output;
}
