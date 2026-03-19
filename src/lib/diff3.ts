// ── 3-way merge algorithm ───────────────────────────────────────────
//
// Three-way merge using Myers middle-snake diff (matching git's xdiff).
// Merge region logic adapted from node-diff3 (MIT), itself based on:
//   Sanjeev Khanna, Keshav Kunal, and Benjamin C. Pierce.
//   "A Formal Investigation of Diff3"
//   FSTTCS 2007
//   http://www.cis.upenn.edu/~bcpierce/papers/diff3-short.pdf

import { computeChangedLines } from "./diff-algorithm.ts";

// ── Types ───────────────────────────────────────────────────────────

/** A stable region where one side (a, o, or b) provides the content. */
interface StableRegion {
	stable: true;
	buffer: "a" | "o" | "b";
	bufferStart: number;
	bufferLength: number;
	content: string[];
}

/** An unstable region where a and b diverge from o. */
interface UnstableRegion {
	stable: false;
	a: string[];
	o: string[];
	b: string[];
}

type MergeRegion = StableRegion | UnstableRegion;

/** A block in the merged result — either clean or conflicted. */
type MergeBlock =
	| { type: "ok"; lines: string[] }
	| { type: "conflict"; a: string[]; o: string[]; b: string[] };

/** Final merge result with conflict flag and formatted lines. */
interface MergeResult {
	conflict: boolean;
	result: string[];
}

/** Labels for conflict markers. */
export interface MergeLabels {
	a?: string;
	o?: string;
	b?: string;
	/** Number of marker characters (default 7). Real git uses 9 for virtual merge bases. */
	markerSize?: number;
	/** Conflict marker style: "merge" (default) or "diff3" (includes base section). */
	conflictStyle?: "merge" | "diff3";
}

/** Options for diff3Merge. */
interface Diff3MergeOptions {
	/** If true (default), treat identical a/b changes as non-conflicts. */
	excludeFalseConflicts?: boolean;
	/** When "diff3", skip conflict refinement to preserve base content in conflict blocks. */
	conflictStyle?: "merge" | "diff3";
}

// ── diffIndices (internal) ──────────────────────────────────────────

interface DiffIndex {
	buffer1: [offset: number, length: number];
	buffer2: [offset: number, length: number];
}

/**
 * Compute mismatch regions between two arrays using Myers middle-snake
 * diff with hunk compaction (matching git's xdiff + xdl_change_compact).
 * Returns offset+length pairs for each changed chunk.
 */
function diffIndices(buffer1: string[], buffer2: string[]): DiffIndex[] {
	const n1 = buffer1.length;
	const n2 = buffer2.length;
	if (n1 === 0 && n2 === 0) return [];
	if (n1 === 0) return [{ buffer1: [0, 0], buffer2: [0, n2] }];
	if (n2 === 0) return [{ buffer1: [0, n1], buffer2: [0, 0] }];

	const { changedOld, changedNew } = computeChangedLines(buffer1, buffer2);

	return buildDiffIndices(changedOld, n1, changedNew, n2);
}

/** Convert changed-line flag arrays into DiffIndex[] change regions. */
function buildDiffIndices(
	changedA: Uint8Array,
	nA: number,
	changedB: Uint8Array,
	nB: number,
): DiffIndex[] {
	const result: DiffIndex[] = [];
	let iA = 0;
	let iB = 0;

	while (iA < nA || iB < nB) {
		// Skip matched lines
		while (iA < nA && iB < nB && !changedA[iA] && !changedB[iB]) {
			iA++;
			iB++;
		}
		if (iA >= nA && iB >= nB) break;

		const startA = iA;
		const startB = iB;

		while (iA < nA && changedA[iA]) iA++;
		while (iB < nB && changedB[iB]) iB++;

		if (iA > startA || iB > startB) {
			result.push({
				buffer1: [startA, iA - startA],
				buffer2: [startB, iB - startB],
			});
		}
	}

	return result;
}

// ── diff3MergeRegions ───────────────────────────────────────────────

interface Hunk {
	ab: "a" | "b";
	oStart: number;
	oLength: number;
	abStart: number;
	abLength: number;
}

/**
 * Given three string arrays (a, o, b) where both a and b are
 * independently derived from o, compute the merge regions.
 * Returns an array of stable and unstable regions.
 */
export function diff3MergeRegions(a: string[], o: string[], b: string[]): MergeRegion[] {
	// Build hunks: regions where a or b differ from o
	const hunks: Hunk[] = [];

	for (const item of diffIndices(o, a)) {
		hunks.push({
			ab: "a",
			oStart: item.buffer1[0],
			oLength: item.buffer1[1],
			abStart: item.buffer2[0],
			abLength: item.buffer2[1],
		});
	}
	for (const item of diffIndices(o, b)) {
		hunks.push({
			ab: "b",
			oStart: item.buffer1[0],
			oLength: item.buffer1[1],
			abStart: item.buffer2[0],
			abLength: item.buffer2[1],
		});
	}

	hunks.sort((x, y) => x.oStart - y.oStart);

	const results: MergeRegion[] = [];
	let currOffset = 0;

	function advanceTo(endOffset: number): void {
		if (endOffset > currOffset) {
			results.push({
				stable: true,
				buffer: "o",
				bufferStart: currOffset,
				bufferLength: endOffset - currOffset,
				content: o.slice(currOffset, endOffset),
			});
			currOffset = endOffset;
		}
	}

	let hi = 0;
	while (hi < hunks.length) {
		const hunk = hunks[hi++]!;
		const regionStart = hunk.oStart;
		let regionEnd = hunk.oStart + hunk.oLength;
		const regionHunks: Hunk[] = [hunk];
		advanceTo(regionStart);

		// Pull in overlapping hunks
		while (hi < hunks.length) {
			const nextHunk = hunks[hi]!;
			if (nextHunk.oStart > regionEnd) break;
			regionEnd = Math.max(regionEnd, nextHunk.oStart + nextHunk.oLength);
			regionHunks.push(nextHunk);
			hi++;
		}

		if (regionHunks.length === 1) {
			// Single hunk: no conflict — one side changed, other didn't
			if (hunk.abLength > 0) {
				const buffer = hunk.ab === "a" ? a : b;
				results.push({
					stable: true,
					buffer: hunk.ab,
					bufferStart: hunk.abStart,
					bufferLength: hunk.abLength,
					content: buffer.slice(hunk.abStart, hunk.abStart + hunk.abLength),
				});
			}
		} else {
			// True conflict: compute bounds for a, o, and b
			const bounds = {
				a: { abMin: a.length, abMax: -1, oMin: o.length, oMax: -1 },
				b: { abMin: b.length, abMax: -1, oMin: o.length, oMax: -1 },
			};

			for (const h of regionHunks) {
				const oStart = h.oStart;
				const oEnd = oStart + h.oLength;
				const abStart = h.abStart;
				const abEnd = abStart + h.abLength;
				const bnd = bounds[h.ab];
				bnd.abMin = Math.min(abStart, bnd.abMin);
				bnd.abMax = Math.max(abEnd, bnd.abMax);
				bnd.oMin = Math.min(oStart, bnd.oMin);
				bnd.oMax = Math.max(oEnd, bnd.oMax);
			}

			const aStart = bounds.a.abMin + (regionStart - bounds.a.oMin);
			const aEnd = bounds.a.abMax + (regionEnd - bounds.a.oMax);
			const bStart = bounds.b.abMin + (regionStart - bounds.b.oMin);
			const bEnd = bounds.b.abMax + (regionEnd - bounds.b.oMax);

			results.push({
				stable: false,
				a: a.slice(aStart, aEnd),
				o: o.slice(regionStart, regionEnd),
				b: b.slice(bStart, bEnd),
			});
		}

		currOffset = regionEnd;
	}

	advanceTo(o.length);

	return results;
}

// ── diff3Merge ──────────────────────────────────────────────────────

/**
 * Three-way merge producing ok/conflict blocks.
 * A "false conflict" is where both a and b make the same change from o.
 */
export function diff3Merge(
	a: string[],
	o: string[],
	b: string[],
	options?: Diff3MergeOptions,
): MergeBlock[] {
	const excludeFalseConflicts = options?.excludeFalseConflicts ?? true;
	const regions = diff3MergeRegions(a, o, b);
	const results: MergeBlock[] = [];
	let okBuffer: string[] = [];

	function flushOk(): void {
		if (okBuffer.length) {
			results.push({ type: "ok", lines: okBuffer });
			okBuffer = [];
		}
	}

	for (const region of regions) {
		if (region.stable) {
			okBuffer.push(...region.content);
		} else {
			if (excludeFalseConflicts && arraysEqual(region.a, region.b)) {
				// Both sides made the same change — not a real conflict
				okBuffer.push(...region.a);
			} else {
				flushOk();
				results.push({
					type: "conflict",
					a: region.a,
					o: region.o,
					b: region.b,
				});
			}
		}
	}

	flushOk();
	if (options?.conflictStyle === "diff3") {
		return simplifyNonConflicts(results);
	}
	return simplifyNonConflicts(refineConflicts(results));
}

// ── merge (conflict markers) ────────────────────────────────────────

/**
 * Three-way merge with conflict markers.
 *
 * Default (merge style):
 *     <<<<<<< ours
 *     ...
 *     =======
 *     ...
 *     >>>>>>> theirs
 *
 * diff3 style (conflictStyle: "diff3"):
 *     <<<<<<< ours
 *     ...
 *     ||||||| base
 *     ...
 *     =======
 *     ...
 *     >>>>>>> theirs
 */
export function merge(a: string[], o: string[], b: string[], labels?: MergeLabels): MergeResult {
	const size = labels?.markerSize ?? 7;
	const style = labels?.conflictStyle ?? "merge";
	const aMarker = `${"<".repeat(size)}${labels?.a ? ` ${labels.a}` : ""}`;
	const oMarker = `${"|".repeat(size)}${labels?.o ? ` ${labels.o}` : ""}`;
	const separator = "=".repeat(size);
	const bMarker = `${">".repeat(size)}${labels?.b ? ` ${labels.b}` : ""}`;

	const blocks = diff3Merge(a, o, b, { conflictStyle: style });
	let conflict = false;
	const result: string[] = [];

	for (const block of blocks) {
		if (block.type === "ok") {
			result.push(...block.lines);
		} else {
			conflict = true;
			if (style === "diff3") {
				result.push(aMarker, ...block.a, oMarker, ...block.o, separator, ...block.b, bMarker);
			} else {
				result.push(aMarker, ...block.a, separator, ...block.b, bMarker);
			}
		}
	}

	return { conflict, result };
}

// ── Conflict refinement (zealous merge) ─────────────────────────────

/**
 * Minimum contiguous matching run length for splitting an *interior*
 * match within a conflict. Leading and trailing common lines are always
 * peeled off regardless of length (matching git's xdl_refine_conflicts).
 * Matching git's xdl_refine_conflicts: diff determines alignment and
 * all matching regions create ok blocks. simplifyNonConflicts merges
 * back small gaps afterward.
 */

/**
 * Refine conflict blocks by diffing the two sides (a vs b) and splitting
 * at every matching run. The diff (with hunk compaction) determines
 * alignment; all matching regions become ok blocks regardless of length.
 */
function refineConflicts(blocks: MergeBlock[]): MergeBlock[] {
	const result: MergeBlock[] = [];
	for (const block of blocks) {
		if (block.type === "ok") {
			result.push(block);
		} else {
			result.push(...refineConflictBlock(block));
		}
	}
	return result;
}

function refineConflictBlock(block: {
	type: "conflict";
	a: string[];
	o: string[];
	b: string[];
}): MergeBlock[] {
	const { a, b } = block;

	if (a.length === 0 || b.length === 0) {
		return [block];
	}

	if (arraysEqual(a, b)) {
		return [block];
	}

	const diffs = diffIndices(a, b);

	if (diffs.length === 0) {
		return [{ type: "ok", lines: a }];
	}

	const result: MergeBlock[] = [];
	let aPos = 0;

	for (const diff of diffs) {
		const aStart = diff.buffer1[0];
		const matchLen = aStart - aPos;

		if (matchLen > 0) {
			result.push({
				type: "ok",
				lines: a.slice(aPos, aStart),
			});
		}

		const aEnd = aStart + diff.buffer1[1];
		const bEnd = diff.buffer2[0] + diff.buffer2[1];
		result.push({
			type: "conflict",
			a: a.slice(aStart, aEnd),
			o: [],
			b: b.slice(diff.buffer2[0], bEnd),
		});

		aPos = aEnd;
	}

	const trailingLen = a.length - aPos;
	if (trailingLen > 0) {
		result.push({
			type: "ok",
			lines: a.slice(aPos),
		});
	}

	if (result.length === 1 && result[0]!.type === "conflict") {
		return [block];
	}

	return result;
}

// ── Conflict simplification (matching git's xdl_simplify_non_conflicts) ──

/**
 * Merge adjacent conflict blocks when separated by ≤3 ok-lines.
 * Matches git's xdl_simplify_non_conflicts at XDL_MERGE_ZEALOUS level.
 *
 * First coalesces adjacent ok blocks (which can appear after refinement
 * splits a conflict into [ok, conflict] fragments) so the
 * conflict-ok-conflict absorption pattern works across them.
 */
function simplifyNonConflicts(blocks: MergeBlock[]): MergeBlock[] {
	if (blocks.length < 3) return blocks;

	// Coalesce adjacent ok blocks so they form a single ok block.
	const coalesced: MergeBlock[] = [blocks[0]!];
	for (let i = 1; i < blocks.length; i++) {
		const prev = coalesced[coalesced.length - 1]!;
		const curr = blocks[i]!;
		if (prev.type === "ok" && curr.type === "ok") {
			(prev as { lines: string[] }).lines = [...prev.lines, ...curr.lines];
		} else {
			coalesced.push(curr);
		}
	}

	if (coalesced.length < 3) return coalesced;

	const result: MergeBlock[] = [coalesced[0]!];

	for (let i = 1; i < coalesced.length; i++) {
		const prev = result[result.length - 1]!;
		const curr = coalesced[i]!;

		if (
			prev.type === "conflict" &&
			curr.type === "ok" &&
			curr.lines.length <= 3 &&
			i + 1 < coalesced.length &&
			coalesced[i + 1]!.type === "conflict"
		) {
			const next = coalesced[i + 1]! as typeof prev;
			const p = prev as { a: string[]; b: string[]; o: string[] };
			p.a = [...prev.a, ...curr.lines, ...next.a];
			p.b = [...prev.b, ...curr.lines, ...next.b];
			p.o = [...prev.o, ...curr.lines, ...next.o];
			i++; // skip the next conflict (already absorbed)
		} else {
			result.push(curr);
		}
	}

	return result;
}

// ── Conflict marker rendering ───────────────────────────────────────

interface MergeFileLabels {
	a: string;
	o?: string;
	b: string;
	markerSize?: number;
	conflictStyle?: "merge" | "diff3";
}

/**
 * Render conflict markers using git merge-file semantics.
 *
 * Uses the in-tree diff3 renderer to produce standard conflict markers.
 */
export function renderConflictMarkers(
	oursText: string,
	baseText: string,
	theirsText: string,
	labels: MergeFileLabels,
): string {
	const merged = merge(
		splitLinesWithSentinel(oursText),
		splitLinesWithSentinel(baseText),
		splitLinesWithSentinel(theirsText),
		{
			a: labels.a,
			o: labels.o,
			b: labels.b,
			markerSize: labels.markerSize,
			conflictStyle: labels.conflictStyle,
		},
	);

	const lastRawLine = merged.result[merged.result.length - 1] ?? "";
	const lastLineHadNoTrailingNl = lastRawLine.endsWith("\u0000");
	const resultLines = merged.result.map(stripSentinel);
	const lastLine = resultLines[resultLines.length - 1] ?? "";
	const endsWithMarker = lastLine.startsWith(">>>>>>>");
	const needsTrailingNewline = endsWithMarker || !lastLineHadNoTrailingNl;
	return needsTrailingNewline ? `${resultLines.join("\n")}\n` : resultLines.join("\n");
}

export function splitLinesWithSentinel(text: string): string[] {
	if (text === "") return [];
	const lines = text.split("\n");
	if (lines[lines.length - 1] === "") {
		lines.pop();
	} else {
		const last = lines[lines.length - 1] ?? "";
		lines[lines.length - 1] = `${last}\u0000`;
	}
	return lines;
}

export function stripSentinel(line: string): string {
	return line.endsWith("\u0000") ? line.slice(0, -1) : line;
}

// ── Utilities (internal) ────────────────────────────────────────────

function arraysEqual(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}
