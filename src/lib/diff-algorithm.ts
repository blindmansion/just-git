// ── Myers diff algorithm + unified diff formatter ──────────────────
//
import { abbreviateHash } from "./command-utils.ts";
import { isBinaryStr } from "./object-db.ts";
// Implements the core diff algorithm from:
//   Eugene W. Myers, "An O(ND) Difference Algorithm and Its Variations"
//
// Preprocessing pipeline ported from Git's xdiff/xprepare.c:
//   - Line classification (equivalence classes)
//   - Trim matching prefix/suffix
//   - Cleanup records (discard unmatched lines, build reference index)
//
// Post-processing ported from Git's xdiff/xdiffi.c:
//   - Change compact (group sliding + indent heuristic)
//
// Public API:
//   - myersDiff(a, b)        -- compute edit script between two line arrays
//   - formatUnifiedDiff(...)  -- format a single file's diff as unified diff
//   - splitLines(text)        -- split text into lines for diffing

// ── Types ───────────────────────────────────────────────────────────

export interface Edit {
	type: "keep" | "insert" | "delete";
	/** Line content (without trailing newline). */
	line: string;
	/** 1-based line number in the old file (0 for inserts). */
	oldLineNo: number;
	/** 1-based line number in the new file (0 for deletes). */
	newLineNo: number;
}

export interface Hunk {
	oldStart: number; // 1-based
	oldCount: number;
	newStart: number; // 1-based
	newCount: number;
	lines: HunkLine[];
}

export interface HunkLine {
	type: "context" | "insert" | "delete";
	content: string;
}

// ── Line splitting ──────────────────────────────────────────────────

/**
 * Split a string into lines suitable for diffing.
 * Preserves the distinction between files that end with a newline and
 * files that don't (Git's "\ No newline at end of file").
 */
export function splitLines(text: string): string[] {
	if (text.length === 0) return [];
	const lines = text.split("\n");
	// A trailing newline produces an empty last element — remove it
	if (lines[lines.length - 1] === "") {
		lines.pop();
	}
	return lines;
}

/**
 * Split text into lines preserving the trailing newline on each line.
 * "a\nb\n" → ["a\n", "b\n"]
 * "a\nb"   → ["a\n", "b"]
 * Ensures myersDiff correctly detects trailing newline changes.
 */
export function splitLinesWithNL(text: string): string[] {
	if (text.length === 0) return [];
	const result: string[] = [];
	let start = 0;
	for (let i = 0; i < text.length; i++) {
		if (text[i] === "\n") {
			result.push(text.slice(start, i + 1));
			start = i + 1;
		}
	}
	if (start < text.length) {
		result.push(text.slice(start));
	}
	return result;
}

// ── Preprocessing (port of xdiff/xprepare.c) ────────────────────────

const KPDIS_RUN = 4;
const MAX_EQLIMIT = 1024;
const SIMSCAN_WINDOW = 100;

const DISCARD_ACTION = 0;
const KEEP_ACTION = 1;
const INVESTIGATE_ACTION = 2;

function bogosqrt(n: number): number {
	let i = 1;
	while (i * i < n) i++;
	return i;
}

interface ClassifyResult {
	classes1: number[];
	classes2: number[];
	classInfo: Array<{ len1: number; len2: number }>;
}

/**
 * Assign each line an equivalence class index. Lines with identical
 * content share a class. Tracks occurrence counts per file.
 * Port of xdl_classify_record.
 */
function classifyLines(lines1: string[], lines2: string[]): ClassifyResult {
	const map = new Map<string, number>();
	const classInfo: Array<{ len1: number; len2: number }> = [];
	const classes1 = new Array<number>(lines1.length);
	const classes2 = new Array<number>(lines2.length);

	for (let i = 0; i < lines1.length; i++) {
		const line = lines1[i]!;
		let idx = map.get(line);
		if (idx === undefined) {
			idx = classInfo.length;
			map.set(line, idx);
			classInfo.push({ len1: 0, len2: 0 });
		}
		classInfo[idx]!.len1++;
		classes1[i] = idx;
	}

	for (let i = 0; i < lines2.length; i++) {
		const line = lines2[i]!;
		let idx = map.get(line);
		if (idx === undefined) {
			idx = classInfo.length;
			map.set(line, idx);
			classInfo.push({ len1: 0, len2: 0 });
		}
		classInfo[idx]!.len2++;
		classes2[i] = idx;
	}

	return { classes1, classes2, classInfo };
}

/**
 * Trim matching prefix and suffix using class indices.
 * Port of xdl_trim_ends.
 */
function trimEnds(
	classes1: number[],
	n1: number,
	classes2: number[],
	n2: number,
): { dstart: number; dend1: number; dend2: number } {
	let i = 0;
	const lim = Math.min(n1, n2);
	while (i < lim && classes1[i] === classes2[i]) i++;
	const dstart = i;

	let j = 0;
	const limBack = lim - dstart;
	while (j < limBack && classes1[n1 - 1 - j] === classes2[n2 - 1 - j]) j++;

	return { dstart, dend1: n1 - j - 1, dend2: n2 - j - 1 };
}

/**
 * Check if an INVESTIGATE line should be discarded because it appears
 * in a run of discarded lines. Port of xdl_clean_mmatch.
 */
function cleanMmatch(action: Uint8Array, i: number, s: number, e: number): boolean {
	if (i - s > SIMSCAN_WINDOW) s = i - SIMSCAN_WINDOW;
	if (e - i > SIMSCAN_WINDOW) e = i + SIMSCAN_WINDOW;

	let rdis0 = 0;
	let rpdis0 = 1;
	for (let r = 1; i - r >= s; r++) {
		const a = action[i - r]!;
		if (a === DISCARD_ACTION) rdis0++;
		else if (a === INVESTIGATE_ACTION) rpdis0++;
		else break;
	}
	if (rdis0 === 0) return false;

	let rdis1 = 0;
	let rpdis1 = 1;
	for (let r = 1; i + r <= e; r++) {
		const a = action[i + r]!;
		if (a === DISCARD_ACTION) rdis1++;
		else if (a === INVESTIGATE_ACTION) rpdis1++;
		else break;
	}
	if (rdis1 === 0) return false;

	rdis1 += rdis0;
	rpdis1 += rpdis0;

	return rpdis1 * KPDIS_RUN < rpdis1 + rdis1;
}

interface CleanupResult {
	refIndex1: number[];
	nreff1: number;
	refIndex2: number[];
	nreff2: number;
}

/**
 * Discard lines with no match in the other file. Lines appearing too
 * many times may also be discarded if they're in runs of discarded
 * lines. Builds compact reference indices for the diff algorithm.
 * Port of xdl_cleanup_records.
 */
function cleanupRecords(
	classes1: number[],
	n1: number,
	classes2: number[],
	n2: number,
	classInfo: Array<{ len1: number; len2: number }>,
	dstart: number,
	dend1: number,
	dend2: number,
	changed1: Uint8Array,
	changed2: Uint8Array,
): CleanupResult {
	const action1 = new Uint8Array(n1);
	const action2 = new Uint8Array(n2);

	const mlim1 = Math.min(bogosqrt(n1), MAX_EQLIMIT);
	for (let i = dstart; i <= dend1; i++) {
		const nm = classInfo[classes1[i]!]!.len2;
		if (nm === 0) action1[i] = DISCARD_ACTION;
		else if (nm >= mlim1) action1[i] = INVESTIGATE_ACTION;
		else action1[i] = KEEP_ACTION;
	}

	const mlim2 = Math.min(bogosqrt(n2), MAX_EQLIMIT);
	for (let i = dstart; i <= dend2; i++) {
		const nm = classInfo[classes2[i]!]!.len1;
		if (nm === 0) action2[i] = DISCARD_ACTION;
		else if (nm >= mlim2) action2[i] = INVESTIGATE_ACTION;
		else action2[i] = KEEP_ACTION;
	}

	const refIndex1: number[] = [];
	for (let i = dstart; i <= dend1; i++) {
		if (
			action1[i] === KEEP_ACTION ||
			(action1[i] === INVESTIGATE_ACTION && !cleanMmatch(action1, i, dstart, dend1))
		) {
			refIndex1.push(i);
		} else {
			changed1[i] = 1;
		}
	}

	const refIndex2: number[] = [];
	for (let i = dstart; i <= dend2; i++) {
		if (
			action2[i] === KEEP_ACTION ||
			(action2[i] === INVESTIGATE_ACTION && !cleanMmatch(action2, i, dstart, dend2))
		) {
			refIndex2.push(i);
		} else {
			changed2[i] = 1;
		}
	}

	return {
		refIndex1,
		nreff1: refIndex1.length,
		refIndex2,
		nreff2: refIndex2.length,
	};
}

// ── Myers diff (middle-snake divide-and-conquer) ────────────────────
//
// Matches git's xdiff/xdiffi.c: bidirectional search finds the "middle
// snake" where forward and backward passes cross, then recursively
// solves both halves. Operates on class-index hash arrays derived from
// the reference index (after preprocessing).

const SNAKE_CNT = 20;
const K_HEUR = 4;
const HEUR_MIN_COST = 256;
const MAX_COST_MIN = 256;
const LINE_MAX = 0x7fffffff;

type KV = Record<number, number>;

function kvGet(obj: KV, i: number): number {
	return obj[i] ?? 0;
}

interface SplitResult {
	i1: number;
	i2: number;
	minLo: boolean;
	minHi: boolean;
}

/**
 * Find the middle snake — the point where forward and backward
 * passes cross on the same diagonal. Returns the split point for
 * the divide-and-conquer recursion.
 *
 * ha/hb are class-index arrays (integers) derived from the reference
 * index after preprocessing.
 */
function splitMidSnake(
	ha: number[],
	off1: number,
	lim1: number,
	hb: number[],
	off2: number,
	lim2: number,
	kvdf: KV,
	kvdb: KV,
	needMin: boolean,
	mxcost: number,
): SplitResult {
	const dmin = off1 - lim2;
	const dmax = lim1 - off2;
	const fmid = off1 - off2;
	const bmid = lim1 - lim2;
	const odd = (fmid - bmid) & 1;
	let fmin = fmid,
		fmax = fmid;
	let bmin = bmid,
		bmax = bmid;

	kvdf[fmid] = off1;
	kvdb[bmid] = lim1;

	for (let ec = 1; ; ec++) {
		let gotSnake = false;

		if (fmin > dmin) kvdf[--fmin - 1] = -1;
		else ++fmin;
		if (fmax < dmax) kvdf[++fmax + 1] = -1;
		else --fmax;

		for (let d = fmax; d >= fmin; d -= 2) {
			let i1: number;
			if (kvGet(kvdf, d - 1) >= kvGet(kvdf, d + 1)) i1 = kvGet(kvdf, d - 1) + 1;
			else i1 = kvGet(kvdf, d + 1);
			const prev1 = i1;
			let i2 = i1 - d;
			while (i1 < lim1 && i2 < lim2 && ha[i1] === hb[i2]) {
				i1++;
				i2++;
			}
			if (i1 - prev1 > SNAKE_CNT) gotSnake = true;
			kvdf[d] = i1;
			if (odd && bmin <= d && d <= bmax && kvGet(kvdb, d) <= i1) {
				return { i1, i2, minLo: true, minHi: true };
			}
		}

		if (bmin > dmin) kvdb[--bmin - 1] = LINE_MAX;
		else ++bmin;
		if (bmax < dmax) kvdb[++bmax + 1] = LINE_MAX;
		else --bmax;

		for (let d = bmax; d >= bmin; d -= 2) {
			let i1: number;
			if (kvGet(kvdb, d - 1) < kvGet(kvdb, d + 1)) i1 = kvGet(kvdb, d - 1);
			else i1 = kvGet(kvdb, d + 1) - 1;
			const prev1 = i1;
			let i2 = i1 - d;
			while (i1 > off1 && i2 > off2 && ha[i1 - 1] === hb[i2 - 1]) {
				i1--;
				i2--;
			}
			if (prev1 - i1 > SNAKE_CNT) gotSnake = true;
			kvdb[d] = i1;
			if (!odd && fmin <= d && d <= fmax && i1 <= kvGet(kvdf, d)) {
				return { i1, i2, minLo: true, minHi: true };
			}
		}

		if (needMin) continue;

		if (gotSnake && ec > HEUR_MIN_COST) {
			let best = 0;
			let bestSpl: SplitResult | null = null;

			for (let d = fmax; d >= fmin; d -= 2) {
				const dd = d > fmid ? d - fmid : fmid - d;
				const i1 = kvGet(kvdf, d);
				const i2 = i1 - d;
				const v = i1 - off1 + (i2 - off2) - dd;
				if (
					v > K_HEUR * ec &&
					v > best &&
					off1 + SNAKE_CNT <= i1 &&
					i1 < lim1 &&
					off2 + SNAKE_CNT <= i2 &&
					i2 < lim2
				) {
					let ok = true;
					for (let k = 1; k <= SNAKE_CNT; k++) {
						if (ha[i1 - k] !== hb[i2 - k]) {
							ok = false;
							break;
						}
					}
					if (ok) {
						best = v;
						bestSpl = { i1, i2, minLo: true, minHi: false };
					}
				}
			}
			if (bestSpl) return bestSpl;

			best = 0;
			bestSpl = null;
			for (let d = bmax; d >= bmin; d -= 2) {
				const dd = d > bmid ? d - bmid : bmid - d;
				const i1 = kvGet(kvdb, d);
				const i2 = i1 - d;
				const v = lim1 - i1 + (lim2 - i2) - dd;
				if (
					v > K_HEUR * ec &&
					v > best &&
					off1 < i1 &&
					i1 <= lim1 - SNAKE_CNT &&
					off2 < i2 &&
					i2 <= lim2 - SNAKE_CNT
				) {
					let ok = true;
					for (let k = 0; k < SNAKE_CNT; k++) {
						if (ha[i1 + k] !== hb[i2 + k]) {
							ok = false;
							break;
						}
					}
					if (ok) {
						best = v;
						bestSpl = { i1, i2, minLo: false, minHi: true };
					}
				}
			}
			if (bestSpl) return bestSpl;
		}

		if (ec >= mxcost) {
			let fbest = -1,
				fbest1 = -1;
			for (let d = fmax; d >= fmin; d -= 2) {
				let i1 = Math.min(kvGet(kvdf, d), lim1);
				let i2 = i1 - d;
				if (lim2 < i2) {
					i1 = lim2 + d;
					i2 = lim2;
				}
				if (fbest < i1 + i2) {
					fbest = i1 + i2;
					fbest1 = i1;
				}
			}
			let bbest = LINE_MAX,
				bbest1 = LINE_MAX;
			for (let d = bmax; d >= bmin; d -= 2) {
				let i1 = Math.max(off1, kvGet(kvdb, d));
				let i2 = i1 - d;
				if (i2 < off2) {
					i1 = off2 + d;
					i2 = off2;
				}
				if (i1 + i2 < bbest) {
					bbest = i1 + i2;
					bbest1 = i1;
				}
			}
			if (lim1 + lim2 - bbest < fbest - (off1 + off2)) {
				return {
					i1: fbest1,
					i2: fbest - fbest1,
					minLo: true,
					minHi: false,
				};
			}
			return {
				i1: bbest1,
				i2: bbest - bbest1,
				minLo: false,
				minHi: true,
			};
		}
	}
}

/**
 * Recursive divide-and-conquer: mark changed lines by finding the
 * middle snake and processing both halves. Matches git's xdl_recs_cmp.
 *
 * ha/hb are class-index arrays via the reference index.
 * ref1/ref2 map reference-index positions back to original line positions
 * for marking the changed arrays.
 */
function recsCmp(
	ha: number[],
	off1: number,
	lim1: number,
	hb: number[],
	off2: number,
	lim2: number,
	changedA: Uint8Array,
	changedB: Uint8Array,
	ref1: number[],
	ref2: number[],
	kvdf: KV,
	kvdb: KV,
	needMin: boolean,
	mxcost: number,
): void {
	while (off1 < lim1 && off2 < lim2 && ha[off1] === hb[off2]) {
		off1++;
		off2++;
	}
	while (off1 < lim1 && off2 < lim2 && ha[lim1 - 1] === hb[lim2 - 1]) {
		lim1--;
		lim2--;
	}

	if (off1 === lim1) {
		for (let i = off2; i < lim2; i++) changedB[ref2[i]!] = 1;
	} else if (off2 === lim2) {
		for (let i = off1; i < lim1; i++) changedA[ref1[i]!] = 1;
	} else {
		const spl = splitMidSnake(ha, off1, lim1, hb, off2, lim2, kvdf, kvdb, needMin, mxcost);
		recsCmp(
			ha,
			off1,
			spl.i1,
			hb,
			off2,
			spl.i2,
			changedA,
			changedB,
			ref1,
			ref2,
			kvdf,
			kvdb,
			spl.minLo,
			mxcost,
		);
		recsCmp(
			ha,
			spl.i1,
			lim1,
			hb,
			spl.i2,
			lim2,
			changedA,
			changedB,
			ref1,
			ref2,
			kvdf,
			kvdb,
			spl.minHi,
			mxcost,
		);
	}
}

/**
 * Convert changed-line arrays into an Edit[] script.
 */
function changedToEdits(
	a: string[],
	b: string[],
	changedA: Uint8Array,
	changedB: Uint8Array,
): Edit[] {
	const edits: Edit[] = [];
	let ia = 0,
		ib = 0;
	let oldLine = 1,
		newLine = 1;

	while (ia < a.length || ib < b.length) {
		if (ia < a.length && ib < b.length && !changedA[ia] && !changedB[ib]) {
			edits.push({
				type: "keep",
				line: a[ia] ?? "",
				oldLineNo: oldLine++,
				newLineNo: newLine++,
			});
			ia++;
			ib++;
			continue;
		}
		while (ia < a.length && changedA[ia]) {
			edits.push({
				type: "delete",
				line: a[ia] ?? "",
				oldLineNo: oldLine++,
				newLineNo: 0,
			});
			ia++;
		}
		while (ib < b.length && changedB[ib]) {
			edits.push({
				type: "insert",
				line: b[ib] ?? "",
				oldLineNo: 0,
				newLineNo: newLine++,
			});
			ib++;
		}
	}
	return edits;
}

// ── Change compact (port of xdiff/xdiffi.c) ─────────────────────────

const MAX_INDENT = 200;
const MAX_BLANKS = 20;
const INDENT_HEURISTIC_MAX_SLIDING = 100;

const START_OF_FILE_PENALTY = 1;
const END_OF_FILE_PENALTY = 21;
const TOTAL_BLANK_WEIGHT = -30;
const POST_BLANK_WEIGHT = 6;
const RELATIVE_INDENT_PENALTY = -4;
const RELATIVE_INDENT_WITH_BLANK_PENALTY = 10;
const RELATIVE_OUTDENT_PENALTY = 24;
const RELATIVE_OUTDENT_WITH_BLANK_PENALTY = 17;
const RELATIVE_DEDENT_PENALTY = 23;
const RELATIVE_DEDENT_WITH_BLANK_PENALTY = 17;
const INDENT_WEIGHT = 60;

function getIndent(line: string): number {
	let ret = 0;
	for (let i = 0; i < line.length; i++) {
		const c = line.charCodeAt(i);
		if (c === 0x20) {
			ret += 1;
		} else if (c === 0x09) {
			ret += 8 - (ret % 8);
		} else if (c === 0x0a || c === 0x0d || c === 0x0b || c === 0x0c) {
			// whitespace chars: \n \r \v \f — keep scanning
		} else {
			return ret;
		}
		if (ret >= MAX_INDENT) return MAX_INDENT;
	}
	return -1;
}

interface SplitMeasurement {
	endOfFile: boolean;
	indent: number;
	preBlank: number;
	preIndent: number;
	postBlank: number;
	postIndent: number;
}

function measureSplit(lines: string[], nrec: number, split: number): SplitMeasurement {
	const m: SplitMeasurement = {
		endOfFile: false,
		indent: -1,
		preBlank: 0,
		preIndent: -1,
		postBlank: 0,
		postIndent: -1,
	};

	if (split >= nrec) {
		m.endOfFile = true;
		m.indent = -1;
	} else {
		m.endOfFile = false;
		m.indent = getIndent(lines[split]!);
	}

	for (let i = split - 1; i >= 0; i--) {
		m.preIndent = getIndent(lines[i]!);
		if (m.preIndent !== -1) break;
		m.preBlank += 1;
		if (m.preBlank === MAX_BLANKS) {
			m.preIndent = 0;
			break;
		}
	}

	for (let i = split + 1; i < nrec; i++) {
		m.postIndent = getIndent(lines[i]!);
		if (m.postIndent !== -1) break;
		m.postBlank += 1;
		if (m.postBlank === MAX_BLANKS) {
			m.postIndent = 0;
			break;
		}
	}

	return m;
}

interface SplitScore {
	effectiveIndent: number;
	penalty: number;
}

function scoreAddSplit(m: SplitMeasurement, s: SplitScore): void {
	if (m.preIndent === -1 && m.preBlank === 0) s.penalty += START_OF_FILE_PENALTY;
	if (m.endOfFile) s.penalty += END_OF_FILE_PENALTY;

	const postBlank = m.indent === -1 ? 1 + m.postBlank : 0;
	const totalBlank = m.preBlank + postBlank;

	s.penalty += TOTAL_BLANK_WEIGHT * totalBlank;
	s.penalty += POST_BLANK_WEIGHT * postBlank;

	const indent = m.indent !== -1 ? m.indent : m.postIndent;
	const anyBlanks = totalBlank !== 0;

	s.effectiveIndent += indent;

	if (indent === -1) {
		// no adjustments
	} else if (m.preIndent === -1) {
		// no adjustments
	} else if (indent > m.preIndent) {
		s.penalty += anyBlanks ? RELATIVE_INDENT_WITH_BLANK_PENALTY : RELATIVE_INDENT_PENALTY;
	} else if (indent === m.preIndent) {
		// no adjustments
	} else {
		if (m.postIndent !== -1 && m.postIndent > indent) {
			s.penalty += anyBlanks ? RELATIVE_OUTDENT_WITH_BLANK_PENALTY : RELATIVE_OUTDENT_PENALTY;
		} else {
			s.penalty += anyBlanks ? RELATIVE_DEDENT_WITH_BLANK_PENALTY : RELATIVE_DEDENT_PENALTY;
		}
	}
}

function scoreCmp(s1: SplitScore, s2: SplitScore): number {
	const cmpIndents =
		(s1.effectiveIndent > s2.effectiveIndent ? 1 : 0) -
		(s1.effectiveIndent < s2.effectiveIndent ? 1 : 0);
	return INDENT_WEIGHT * cmpIndents + (s1.penalty - s2.penalty);
}

/**
 * Slide change groups for alignment with the other file and apply
 * the indent heuristic for aesthetically better diffs.
 * Port of xdl_change_compact. Called once per file.
 */
function changeCompact(
	changed: Uint8Array,
	classIndices: number[],
	lines: string[],
	nrec: number,
	otherChanged: Uint8Array,
	otherNrec: number,
): void {
	// Group state for primary file
	let gStart = 0;
	let gEnd = 0;
	while (changed[gEnd]) gEnd++;

	// Group state for other file
	let goStart = 0;
	let goEnd = 0;
	while (otherChanged[goEnd]) goEnd++;

	// Helper to match class indices (port of recs_match)
	const recsMatch = (i: number, j: number) => classIndices[i] === classIndices[j];

	while (true) {
		if (gEnd === gStart) {
			// Empty group, skip
		} else {
			let groupsize: number;
			let endMatchingOther: number;
			let earliestEnd: number;

			do {
				groupsize = gEnd - gStart;
				endMatchingOther = -1;

				// Slide up as far as possible
				while (gStart > 0 && recsMatch(gStart - 1, gEnd - 1)) {
					changed[--gStart] = 1;
					changed[--gEnd] = 0;
					while (changed[gStart - 1]) gStart--;

					// Sync other group backward
					if (goStart === 0) {
						// BUG in real git, shouldn't happen
						break;
					}
					goEnd = goStart - 1;
					for (goStart = goEnd; otherChanged[goStart - 1]; goStart--);
				}

				earliestEnd = gEnd;
				if (goEnd > goStart) endMatchingOther = gEnd;

				// Slide down as far as possible
				while (true) {
					if (gEnd >= nrec || !recsMatch(gStart, gEnd)) {
						break;
					}
					changed[gStart++] = 0;
					changed[gEnd++] = 1;
					while (changed[gEnd]) gEnd++;

					// Sync other group forward
					if (goEnd >= otherNrec) break;
					goStart = goEnd + 1;
					for (goEnd = goStart; otherChanged[goEnd]; goEnd++);

					if (goEnd > goStart) endMatchingOther = gEnd;
				}
			} while (groupsize !== gEnd - gStart);

			if (gEnd === earliestEnd) {
				// No shifting possible
			} else if (endMatchingOther !== -1) {
				// Slide back to align with other file's changes
				while (goEnd === goStart) {
					changed[--gEnd] = 0;
					changed[--gStart] = 1;
					while (changed[gStart - 1]) gStart--;

					goEnd = goStart - 1;
					for (goStart = goEnd; otherChanged[goStart - 1]; goStart--);
				}
			} else {
				// Indent heuristic
				let bestShift = -1;
				let bestScore: SplitScore = { effectiveIndent: 0, penalty: 0 };

				let shift = earliestEnd;
				if (gEnd - groupsize - 1 > shift) shift = gEnd - groupsize - 1;
				if (gEnd - INDENT_HEURISTIC_MAX_SLIDING > shift)
					shift = gEnd - INDENT_HEURISTIC_MAX_SLIDING;

				for (; shift <= gEnd; shift++) {
					const score: SplitScore = { effectiveIndent: 0, penalty: 0 };
					const m1 = measureSplit(lines, nrec, shift);
					scoreAddSplit(m1, score);
					const m2 = measureSplit(lines, nrec, shift - groupsize);
					scoreAddSplit(m2, score);

					if (bestShift === -1 || scoreCmp(score, bestScore) <= 0) {
						bestScore = {
							effectiveIndent: score.effectiveIndent,
							penalty: score.penalty,
						};
						bestShift = shift;
					}
				}

				while (gEnd > bestShift) {
					changed[--gEnd] = 0;
					changed[--gStart] = 1;
					while (changed[gStart - 1]) gStart--;

					goEnd = goStart - 1;
					for (goStart = goEnd; otherChanged[goStart - 1]; goStart--);
				}
			}
		}

		// Move to next group
		if (gEnd >= nrec) break;
		gStart = gEnd + 1;
		for (gEnd = gStart; changed[gEnd]; gEnd++);

		if (goEnd >= otherNrec) break;
		goStart = goEnd + 1;
		for (goEnd = goStart; otherChanged[goEnd]; goEnd++);
	}
}

// ── Public diff API ─────────────────────────────────────────────────

/**
 * Run the full xdiff pipeline and return raw per-line changed flags.
 * changedOld[i]=1 means oldLines[i] was deleted/replaced.
 * changedNew[i]=1 means newLines[i] was inserted/replaced.
 */
export function computeChangedLines(
	oldLines: string[],
	newLines: string[],
): { changedOld: Uint8Array; changedNew: Uint8Array } {
	const n = oldLines.length;
	const m = newLines.length;
	const changedOld = new Uint8Array(n);
	const changedNew = new Uint8Array(m);

	if (n > 0 && m > 0) {
		// 1. Classify lines into equivalence classes
		const { classes1, classes2, classInfo } = classifyLines(oldLines, newLines);

		// 2. Trim matching prefix/suffix
		const { dstart, dend1, dend2 } = trimEnds(classes1, n, classes2, m);

		if (dstart > dend1) {
			// All old lines consumed by trim — remaining new lines are inserts
			for (let i = dstart; i < m - (n - 1 - dend1); i++) changedNew[i] = 1;
		} else if (dstart > dend2) {
			// All new lines consumed by trim — remaining old lines are deletes
			for (let i = dstart; i < n - (m - 1 - dend2); i++) changedOld[i] = 1;
		} else {
			// 3. Cleanup records (discard unmatched, build reference index)
			const { refIndex1, nreff1, refIndex2, nreff2 } = cleanupRecords(
				classes1,
				n,
				classes2,
				m,
				classInfo,
				dstart,
				dend1,
				dend2,
				changedOld,
				changedNew,
			);

			if (nreff1 > 0 && nreff2 > 0) {
				// 4. Build hash arrays for the diff algorithm
				const ha = new Array<number>(nreff1);
				for (let i = 0; i < nreff1; i++) ha[i] = classes1[refIndex1[i]!]!;

				const hb = new Array<number>(nreff2);
				for (let i = 0; i < nreff2; i++) hb[i] = classes2[refIndex2[i]!]!;

				// 5. Run Myers on the reference indices
				const kvdf: KV = {};
				const kvdb: KV = {};
				const ndiags = nreff1 + nreff2 + 3;
				const mxcost = Math.max(MAX_COST_MIN, bogosqrt(ndiags));

				recsCmp(
					ha,
					0,
					nreff1,
					hb,
					0,
					nreff2,
					changedOld,
					changedNew,
					refIndex1,
					refIndex2,
					kvdf,
					kvdb,
					false,
					mxcost,
				);
			} else if (nreff1 === 0) {
				// All remaining old lines already marked changed by cleanup;
				// mark remaining new lines
				for (let i = 0; i < nreff2; i++) changedNew[refIndex2[i]!] = 1;
			} else {
				// All remaining new lines already marked changed by cleanup;
				// mark remaining old lines
				for (let i = 0; i < nreff1; i++) changedOld[refIndex1[i]!] = 1;
			}

			// 6. Change compact (slide groups for alignment + indent heuristic)
			changeCompact(changedOld, classes1, oldLines, n, changedNew, m);
			changeCompact(changedNew, classes2, newLines, m, changedOld, n);
		}
	} else if (n === 0) {
		changedNew.fill(1);
	} else {
		changedOld.fill(1);
	}

	return { changedOld, changedNew };
}

/**
 * Compute the shortest edit script between two arrays of lines
 * using the Myers middle-snake algorithm (matching git's xdiff).
 */
export function myersDiff(oldLines: string[], newLines: string[]): Edit[] {
	const n = oldLines.length;
	const m = newLines.length;

	if (n === 0 && m === 0) return [];
	if (n === 0) {
		return newLines.map((line, i) => ({
			type: "insert" as const,
			line,
			oldLineNo: 0,
			newLineNo: i + 1,
		}));
	}
	if (m === 0) {
		return oldLines.map((line, i) => ({
			type: "delete" as const,
			line,
			oldLineNo: i + 1,
			newLineNo: 0,
		}));
	}

	const { changedOld, changedNew } = computeChangedLines(oldLines, newLines);
	return changedToEdits(oldLines, newLines, changedOld, changedNew);
}

// ── Hunk building ───────────────────────────────────────────────────

/** Number of context lines around each change (Git default). */
const CONTEXT_LINES = 3;

/**
 * Group an edit script into hunks with surrounding context lines.
 */
export function buildHunks(edits: Edit[], contextLines = CONTEXT_LINES): Hunk[] {
	contextLines = Math.max(0, contextLines);
	if (edits.length === 0) return [];

	// Find the indices of non-"keep" edits
	const changeIndices: number[] = [];
	for (let i = 0; i < edits.length; i++) {
		const edit = edits[i];
		if (edit && edit.type !== "keep") {
			changeIndices.push(i);
		}
	}

	if (changeIndices.length === 0) return [];

	const firstChange = changeIndices[0] ?? 0;

	// Group changes into hunk ranges, merging when context overlaps
	const groups: { start: number; end: number }[] = [];
	let groupStart = Math.max(0, firstChange - contextLines);
	let groupEnd = Math.min(edits.length - 1, firstChange + contextLines);

	for (let i = 1; i < changeIndices.length; i++) {
		const ci = changeIndices[i] ?? 0;
		const changeStart = Math.max(0, ci - contextLines);
		const changeEnd = Math.min(edits.length - 1, ci + contextLines);

		if (changeStart <= groupEnd + 1) {
			// Merge into current group
			groupEnd = changeEnd;
		} else {
			// Start a new group
			groups.push({ start: groupStart, end: groupEnd });
			groupStart = changeStart;
			groupEnd = changeEnd;
		}
	}
	groups.push({ start: groupStart, end: groupEnd });

	// Convert groups to hunks
	return groups.map((group) => buildOneHunk(edits, group.start, group.end));
}

function buildOneHunk(edits: Edit[], start: number, end: number): Hunk {
	let oldStart = 0;
	let oldCount = 0;
	let newStart = 0;
	let newCount = 0;
	const lines: HunkLine[] = [];
	let oldStartSet = false;
	let newStartSet = false;

	for (let i = start; i <= end; i++) {
		const edit = edits[i];
		if (!edit) continue;

		switch (edit.type) {
			case "keep":
				if (!oldStartSet) {
					oldStart = edit.oldLineNo;
					oldStartSet = true;
				}
				if (!newStartSet) {
					newStart = edit.newLineNo;
					newStartSet = true;
				}
				oldCount++;
				newCount++;
				lines.push({ type: "context", content: edit.line });
				break;
			case "delete":
				if (!oldStartSet) {
					oldStart = edit.oldLineNo;
					oldStartSet = true;
				}
				oldCount++;
				lines.push({ type: "delete", content: edit.line });
				break;
			case "insert":
				if (!newStartSet) {
					newStart = edit.newLineNo;
					newStartSet = true;
				}
				newCount++;
				lines.push({ type: "insert", content: edit.line });
				break;
		}
	}

	// If oldStart was never set (all inserts), derive from context
	if (!oldStartSet) {
		oldStart = newStart > 0 ? newStart : 1;
	}
	if (!newStartSet) {
		newStart = oldStart > 0 ? oldStart : 1;
	}

	// When old or new count is 0, adjust start per Git convention
	if (oldCount === 0) {
		for (let i = start; i <= end; i++) {
			const edit = edits[i];
			if (edit && edit.type === "insert") {
				oldStart = edit.newLineNo > 1 ? edit.newLineNo - 1 : 0;
				break;
			}
		}
	}
	if (newCount === 0) {
		for (let i = start; i <= end; i++) {
			const edit = edits[i];
			if (edit && edit.type === "delete") {
				newStart = edit.oldLineNo > 1 ? edit.oldLineNo - 1 : 0;
				break;
			}
		}
	}

	return { oldStart, oldCount, newStart, newCount, lines };
}

// ── Unified diff formatting ─────────────────────────────────────────

interface FormatOptions {
	/** File path (used in header). */
	path: string;
	/** Old content as a string. Empty string for new files. */
	oldContent: string;
	/** New content as a string. Empty string for deleted files. */
	newContent: string;
	/** Old file mode (e.g. "100644"). Shown for new/deleted files. */
	oldMode?: string;
	/** New file mode (e.g. "100644"). Shown for new/deleted files. */
	newMode?: string;
	/** Old blob hash (abbreviated in the index line). */
	oldHash?: string;
	/** New blob hash (abbreviated in the index line). */
	newHash?: string;
	/** If set, this is a rename. The new path. */
	renameTo?: string;
	/** Similarity percentage for renames. */
	similarity?: number;
	/** Explicit new-file flag (overrides empty-oldContent heuristic). */
	isNew?: boolean;
	/** Explicit deleted-file flag (overrides empty-newContent heuristic). */
	isDeleted?: boolean;
	/** Number of context lines around each change (default 3). */
	contextLines?: number;
}

function formatHashForIndexLine(hash?: string): string {
	if (!hash) return "0000000";
	if (hash.length < 40) return hash;
	return abbreviateHash(hash);
}

function pushDiffGitHeader(
	out: string[],
	opts: FormatOptions,
	newPath: string,
	isNew: boolean,
	isDeleted: boolean,
	isRename: boolean,
): void {
	const { path, oldMode, newMode } = opts;
	out.push(`diff --git a/${path} b/${newPath}`);
	if (isRename) {
		out.push(`similarity index ${opts.similarity ?? 100}%`);
		out.push(`rename from ${path}`);
		out.push(`rename to ${newPath}`);
	} else if (isNew) {
		out.push(`new file mode ${newMode || "100644"}`);
	} else if (isDeleted) {
		out.push(`deleted file mode ${oldMode || "100644"}`);
	} else if (oldMode && newMode && oldMode !== newMode) {
		out.push(`old mode ${oldMode}`);
		out.push(`new mode ${newMode}`);
	}
}

function formatBinaryDiff(opts: FormatOptions, oldIsBinary: boolean, newIsBinary: boolean): string {
	const { path, oldContent, newContent, oldMode, oldHash, newHash } = opts;
	const isRename = opts.renameTo !== undefined;
	const newPath = opts.renameTo ?? path;
	const isNew = opts.isNew ?? oldContent === "";
	const isDeleted = opts.isDeleted ?? newContent === "";
	if (oldContent === newContent && !isRename) return "";

	const out: string[] = [];
	pushDiffGitHeader(out, opts, newPath, isNew, isDeleted, isRename);

	if (oldContent !== newContent) {
		if (oldHash || newHash) {
			const oAbbrev = formatHashForIndexLine(oldHash);
			const nAbbrev = formatHashForIndexLine(newHash);
			if (isNew || isDeleted || isRename) {
				out.push(`index ${oAbbrev}..${nAbbrev}`);
			} else {
				out.push(`index ${oAbbrev}..${nAbbrev} ${oldMode || "100644"}`);
			}
		}

		if (oldIsBinary && newIsBinary) {
			out.push(`Binary files a/${path} and b/${newPath} differ`);
		} else if (isNew) {
			out.push(`Binary files /dev/null and b/${newPath} differ`);
		} else if (isDeleted) {
			out.push(`Binary files a/${path} and /dev/null differ`);
		} else {
			out.push(`Binary files a/${path} and b/${newPath} differ`);
		}
	}

	return `${out.join("\n")}\n`;
}

/**
 * Format a file diff as unified diff output matching Git's format.
 * Returns an empty string if the contents are identical.
 */
export function formatUnifiedDiff(opts: FormatOptions): string {
	const { path, oldContent, newContent, oldMode, newMode, oldHash, newHash } = opts;
	const isRename = opts.renameTo !== undefined;
	const newPath = opts.renameTo ?? path;

	const oldIsBinary = isBinaryStr(oldContent);
	const newIsBinary = isBinaryStr(newContent);

	if (oldIsBinary || newIsBinary) {
		return formatBinaryDiff(opts, oldIsBinary, newIsBinary);
	}

	const oldLines = splitLines(oldContent);
	const newLines = splitLines(newContent);

	// Check for missing newline at end of file (needed for markers)
	const oldHasNewline = oldContent.length > 0 && oldContent.endsWith("\n");
	const newHasNewline = newContent.length > 0 && newContent.endsWith("\n");

	// Git's xdiff includes the line terminator in comparisons, so a line
	// without a trailing newline (last line of a file not ending with \n)
	// never matches the same text WITH a trailing newline.  Our splitLines
	// strips newlines, so we add a sentinel to the last line when the file
	// has no trailing newline.  This prevents Myers from matching that line
	// to non-final lines in the other file, producing the same alignment
	// as Git's xdiff.
	const NOEOL_SENTINEL = "\x00NOEOL";
	let oldDiffLines = oldLines;
	if (!oldHasNewline && oldLines.length > 0) {
		oldDiffLines = oldLines.slice();
		oldDiffLines[oldDiffLines.length - 1] += NOEOL_SENTINEL;
	}
	let newDiffLines = newLines;
	if (!newHasNewline && newLines.length > 0) {
		newDiffLines = newLines.slice();
		newDiffLines[newDiffLines.length - 1] += NOEOL_SENTINEL;
	}

	const edits = myersDiff(oldDiffLines, newDiffLines);
	if (!oldHasNewline || !newHasNewline) {
		for (const edit of edits) {
			if (edit.line.includes(NOEOL_SENTINEL)) {
				edit.line = edit.line.replace(NOEOL_SENTINEL, "");
			}
		}
	}
	const hunks = buildHunks(edits, opts.contextLines);

	if (hunks.length === 0 && !isRename) return "";

	const isNew = opts.isNew ?? oldContent === "";
	const isDeleted = opts.isDeleted ?? newContent === "";

	const out: string[] = [];
	pushDiffGitHeader(out, opts, newPath, isNew, isDeleted, isRename);

	// For exact renames with no content change, stop here
	if (hunks.length === 0) {
		return `${out.join("\n")}\n`;
	}

	// index line: abbreviated hashes + mode
	if (oldHash || newHash) {
		const oAbbrev = formatHashForIndexLine(oldHash);
		const nAbbrev = formatHashForIndexLine(newHash);
		if (isNew || isDeleted) {
			// Mode is already shown on the new/deleted file mode line
			out.push(`index ${oAbbrev}..${nAbbrev}`);
		} else if (isRename) {
			// Rename: show mode on the index line
			out.push(`index ${oAbbrev}..${nAbbrev} ${oldMode || "100644"}`);
		} else if (oldMode && newMode && oldMode !== newMode) {
			// Mode change — modes shown on separate lines
			out.push(`index ${oAbbrev}..${nAbbrev}`);
		} else {
			// Normal: show mode on the index line
			out.push(`index ${oAbbrev}..${nAbbrev} ${oldMode || "100644"}`);
		}
	}

	// --- / +++ headers
	// Real git appends a trailing tab when the path contains a space
	const tabSuffix = (p: string) => (p.includes(" ") ? "\t" : "");
	if (isNew) {
		out.push("--- /dev/null");
		out.push(`+++ b/${newPath}${tabSuffix(newPath)}`);
	} else if (isDeleted) {
		out.push(`--- a/${path}${tabSuffix(path)}`);
		out.push("+++ /dev/null");
	} else {
		out.push(`--- a/${path}${tabSuffix(path)}`);
		out.push(`+++ b/${newPath}${tabSuffix(newPath)}`);
	}
	const oldLastLine = oldLines.length; // 1-based
	const newLastLine = newLines.length; // 1-based

	// Hunks
	for (const hunk of hunks) {
		const oldRange = hunk.oldCount === 1 ? `${hunk.oldStart}` : `${hunk.oldStart},${hunk.oldCount}`;
		const newRange = hunk.newCount === 1 ? `${hunk.newStart}` : `${hunk.newStart},${hunk.newCount}`;

		// Funcname context: scan backward from hunk start for a line
		// that begins with a letter, $, or _ (git's default funcname pattern).
		// Git uses XDL_MAX_FUNCNAME (80), showing up to 79 chars.
		let funcCtx = "";
		const scanFrom = hunk.oldCount === 0 ? hunk.oldStart - 1 : hunk.oldStart - 2;
		for (let i = scanFrom; i >= 0; i--) {
			const line = oldLines[i];
			if (line && /^[a-zA-Z$_]/.test(line)) {
				funcCtx = ` ${line.trimEnd().slice(0, 79)}`;
				break;
			}
		}
		out.push(`@@ -${oldRange} +${newRange} @@${funcCtx}`);

		// Track running line numbers within the hunk
		let curOld = hunk.oldStart;
		let curNew = hunk.newStart;

		for (const line of hunk.lines) {
			switch (line.type) {
				case "context":
					out.push(` ${line.content}`);
					// Context line advances both old and new; if either side
					// is at its last line and lacks a trailing newline, add
					// the marker ONCE (not twice even if both sides lack it).
					if (
						(!oldHasNewline && curOld === oldLastLine) ||
						(!newHasNewline && curNew === newLastLine)
					) {
						out.push("\\ No newline at end of file");
					}
					curOld++;
					curNew++;
					break;
				case "delete":
					out.push(`-${line.content}`);
					if (!oldHasNewline && curOld === oldLastLine) {
						out.push("\\ No newline at end of file");
					}
					curOld++;
					break;
				case "insert":
					out.push(`+${line.content}`);
					if (!newHasNewline && curNew === newLastLine) {
						out.push("\\ No newline at end of file");
					}
					curNew++;
					break;
			}
		}
	}

	return `${out.join("\n")}\n`;
}
