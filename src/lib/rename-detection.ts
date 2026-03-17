/**
 * Rename detection for git diff output.
 *
 * Runs as a post-processing filter on TreeDiffEntry lists, collapsing
 * add+delete pairs into renames. Supports both exact matching (same
 * blob hash) and similarity-based matching (content threshold).
 *
 * Similarity scoring ported from git's diffcore-delta.c — uses the same
 * chunk-hashing algorithm so scores match exactly.
 *
 * Used by: git status, git diff --cached, commit summary, merge diffstat.
 */
import { readBlobBytes } from "./object-db.ts";
import type { GitRepo, TreeDiffEntry } from "./types.ts";

// ── Types ────────────────────────────────────────────────────────────

export interface RenamePair {
	oldPath: string;
	newPath: string;
	/** Hash of the old (deleted) blob. */
	oldHash: string;
	/** Hash of the new (added) blob. */
	newHash: string;
	/** Similarity percentage 0–100. 100 = exact rename. */
	similarity: number;
	/** Old file mode. */
	oldMode?: string;
	/** New file mode. */
	newMode?: string;
}

interface RenameResult {
	/** Diffs that were NOT collapsed into renames. */
	remaining: TreeDiffEntry[];
	/** Matched rename pairs. */
	renames: RenamePair[];
}

// ── Helpers ──────────────────────────────────────────────────────────

function pathBasename(p: string): string {
	const slash = p.lastIndexOf("/");
	return slash >= 0 ? p.slice(slash + 1) : p;
}

/**
 * Pick the best exact match from a list of deleted entries sharing the
 * same blob hash. Matches git's find_identical_files() tie-breaking:
 * prefer a deleted entry whose basename matches the added file's basename.
 * On tie, first entry in the list wins. Removes and returns the match.
 */
function pickBestExactMatch(
	deletedList: TreeDiffEntry[],
	addPath: string,
): TreeDiffEntry | undefined {
	if (deletedList.length === 0) return undefined;
	if (deletedList.length === 1) return deletedList.shift();

	const addBase = pathBasename(addPath);
	let bestIdx = 0;
	for (let i = 0; i < deletedList.length; i++) {
		const entry = deletedList[i];
		if (entry && pathBasename(entry.path) === addBase) {
			bestIdx = i;
			break;
		}
	}
	return deletedList.splice(bestIdx, 1)[0];
}

// ── Main entry point ─────────────────────────────────────────────────

/** Default similarity threshold (matches git's -M50%). */
const DEFAULT_THRESHOLD = 50;

/**
 * Detect renames in a list of tree diff entries.
 *
 * Phase 1: Exact matching — pairs add/delete entries with identical blob hash.
 * Phase 2: Similarity matching — for remaining unmatched pairs, computes
 *          content similarity and pairs entries above the threshold.
 *
 * @param ctx Git context (needed for reading blobs in phase 2)
 * @param diffs Raw diff entries from diffTrees or manual construction
 * @param threshold Minimum similarity percentage (0–100). Default 50.
 */
export async function detectRenames(
	ctx: GitRepo,
	diffs: TreeDiffEntry[],
	threshold = DEFAULT_THRESHOLD,
): Promise<RenameResult> {
	// Partition into deleted, added, and other
	const deletedByHash = new Map<string, TreeDiffEntry[]>();
	const deleted: TreeDiffEntry[] = [];
	const added: TreeDiffEntry[] = [];
	const other: TreeDiffEntry[] = [];

	for (const diff of diffs) {
		if (diff.status === "deleted" && diff.oldHash) {
			const list = deletedByHash.get(diff.oldHash) ?? [];
			list.push(diff);
			deletedByHash.set(diff.oldHash, list);
			deleted.push(diff);
		} else if (diff.status === "added" && diff.newHash) {
			added.push(diff);
		} else {
			other.push(diff);
		}
	}

	// ── Phase 1: Exact matching (same blob hash) ─────────────────
	// Matches git's find_identical_files(): when multiple deleted files
	// share the same hash, prefer one whose basename matches the added
	// file's basename (score = basename_same). On tie, first in list wins.
	const renames: RenamePair[] = [];
	let unmatchedAdded: TreeDiffEntry[] = [];

	for (const add of added) {
		const hash = add.newHash;
		if (!hash) {
			unmatchedAdded.push(add);
			continue;
		}
		const deletedList = deletedByHash.get(hash);
		if (deletedList && deletedList.length > 0) {
			const del = pickBestExactMatch(deletedList, add.path);
			if (del) {
				renames.push({
					oldPath: del.path,
					newPath: add.path,
					oldHash: del.oldHash ?? hash,
					newHash: hash,
					similarity: 100,
					oldMode: del.oldMode,
					newMode: add.newMode,
				});
			}
		} else {
			unmatchedAdded.push(add);
		}
	}

	// Collect remaining unmatched deletes
	let unmatchedDeleted = [...deletedByHash.values()].flat();

	// ── Phase 2: Basename matching (git's find_basename_matches) ──
	// When a basename is unique among both remaining sources and
	// remaining destinations, check similarity and pair if above
	// threshold. This catches the common case of files moved to a
	// different directory without changing their name much.
	if (unmatchedDeleted.length > 0 && unmatchedAdded.length > 0) {
		const basenameRenames = await findBasenameMatches(
			ctx,
			unmatchedDeleted,
			unmatchedAdded,
			threshold,
		);
		if (basenameRenames.length > 0) {
			const matchedDelPaths = new Set(basenameRenames.map((r) => r.oldPath));
			const matchedAddPaths = new Set(basenameRenames.map((r) => r.newPath));
			unmatchedDeleted = unmatchedDeleted.filter((d) => !matchedDelPaths.has(d.path));
			unmatchedAdded = unmatchedAdded.filter((a) => !matchedAddPaths.has(a.path));
			renames.push(...basenameRenames);
		}
	}

	// ── Phase 3: Similarity-based matching ───────────────────────
	if (unmatchedDeleted.length > 0 && unmatchedAdded.length > 0) {
		const similarityRenames = await findSimilarityRenames(
			ctx,
			unmatchedDeleted,
			unmatchedAdded,
			threshold,
		);
		if (similarityRenames.length > 0) {
			const matchedDelPaths = new Set(similarityRenames.map((r) => r.oldPath));
			const matchedAddPaths = new Set(similarityRenames.map((r) => r.newPath));
			unmatchedDeleted = unmatchedDeleted.filter((d) => !matchedDelPaths.has(d.path));
			unmatchedAdded = unmatchedAdded.filter((a) => !matchedAddPaths.has(a.path));
			renames.push(...similarityRenames);
		}
	}

	return {
		remaining: [...other, ...unmatchedDeleted, ...unmatchedAdded],
		renames,
	};
}

// ── Basename matching (git's find_basename_matches) ──────────────────

/**
 * Pair files that share a unique basename between remaining sources
 * and destinations. Only considers basenames that appear exactly once
 * in each set. Checks content similarity and pairs if above threshold.
 *
 * This catches the very common case of a file being moved to a
 * different directory while keeping its name (with or without edits).
 */
async function findBasenameMatches(
	ctx: GitRepo,
	deleted: TreeDiffEntry[],
	added: TreeDiffEntry[],
	threshold: number,
): Promise<RenamePair[]> {
	// Build basename -> index maps; -1 means non-unique
	const srcByBase = new Map<string, number>();
	for (let i = 0; i < deleted.length; i++) {
		const d = deleted[i];
		if (!d) continue;
		const base = pathBasename(d.path);
		if (srcByBase.has(base)) {
			srcByBase.set(base, -1);
		} else {
			srcByBase.set(base, i);
		}
	}
	const dstByBase = new Map<string, number>();
	for (let i = 0; i < added.length; i++) {
		const a = added[i];
		if (!a) continue;
		const base = pathBasename(a.path);
		if (dstByBase.has(base)) {
			dstByBase.set(base, -1);
		} else {
			dstByBase.set(base, i);
		}
	}

	const results: RenamePair[] = [];

	for (const [base, srcIdx] of srcByBase) {
		if (srcIdx === -1) continue;
		const dstIdx = dstByBase.get(base);
		if (dstIdx === undefined || dstIdx === -1) continue;

		const del = deleted[srcIdx];
		const add = added[dstIdx];
		if (!del?.oldHash || !add?.newHash) continue;

		// Same hash → already handled in Phase 1 (shouldn't happen, but guard)
		if (del.oldHash === add.newHash) continue;

		const srcBuf = await readBlobBytes(ctx, del.oldHash);
		const dstBuf = await readBlobBytes(ctx, add.newHash);
		const sim = computeSimilarity(srcBuf, dstBuf);
		if (sim < threshold) continue;

		results.push({
			oldPath: del.path,
			newPath: add.path,
			oldHash: del.oldHash,
			newHash: add.newHash,
			similarity: sim,
			oldMode: del.oldMode,
			newMode: add.newMode,
		});
	}

	return results;
}

// ── Similarity matching (ported from git's diffcore-delta.c) ─────────

/**
 * HASHBASE — a prime between 2^16 and 2^17, matching git's diffcore-delta.c.
 * Used as modulus for the chunk hash.
 */
const HASHBASE = 107927;

/**
 * Hash a buffer into chunk counts, matching git's hash_chars().
 *
 * Splits content into chunks delimited by LF or 64-byte boundary
 * (whichever comes first). Each chunk is hashed with a rolling hash
 * and the byte count for that hash is accumulated.
 *
 * Returns a sorted array of {hash, count} entries (sorted by hash).
 */
function hashChunks(buf: Uint8Array): { hash: number; count: number }[] {
	const map = new Map<number, number>();

	let n = 0;
	let accum1 = 0;
	let accum2 = 0;

	for (let i = 0; i < buf.length; i++) {
		const c = buf[i] as number;
		const old1 = accum1;

		// Rolling hash: two 32-bit accumulators mixed together
		accum1 = ((accum1 << 7) ^ (accum2 >>> 25)) >>> 0;
		accum2 = ((accum2 << 7) ^ (old1 >>> 25)) >>> 0;
		accum1 = (accum1 + c) >>> 0;

		n++;
		// Chunk boundary: 64 bytes or LF (0x0A)
		if (n < 64 && c !== 0x0a) continue;

		const hashval = (accum1 + Math.imul(accum2, 0x61)) % HASHBASE;
		map.set(hashval, (map.get(hashval) ?? 0) + n);
		n = 0;
		accum1 = 0;
		accum2 = 0;
	}

	// Flush remaining bytes
	if (n > 0) {
		const hashval = (accum1 + Math.imul(accum2, 0x61)) % HASHBASE;
		map.set(hashval, (map.get(hashval) ?? 0) + n);
	}

	// Sort by hash value (matches git's QSORT on spanhash)
	const entries: { hash: number; count: number }[] = [];
	for (const [hash, count] of map) {
		entries.push({ hash, count });
	}
	entries.sort((a, b) => a.hash - b.hash);
	return entries;
}

/**
 * Count how many bytes from src appear in dst (src_copied)
 * and how many bytes in dst are new (literal_added).
 *
 * Ported from git's diffcore_count_changes().
 * Both arrays must be sorted by hash value.
 */
function countChanges(
	src: { hash: number; count: number }[],
	dst: { hash: number; count: number }[],
): { srcCopied: number; literalAdded: number } {
	let srcCopied = 0;
	let literalAdded = 0;
	let si = 0;
	let di = 0;

	while (si < src.length) {
		const s = src[si];
		if (!s) break;
		// Skip dst entries with hash < current src hash
		while (di < dst.length) {
			const d = dst[di];
			if (!d || d.hash >= s.hash) break;
			literalAdded += d.count;
			di++;
		}
		const srcCnt = s.count;
		let dstCnt = 0;
		if (di < dst.length) {
			const d = dst[di];
			if (d && d.hash === s.hash) {
				dstCnt = d.count;
				di++;
			}
		}
		if (srcCnt < dstCnt) {
			literalAdded += dstCnt - srcCnt;
			srcCopied += srcCnt;
		} else {
			srcCopied += dstCnt;
		}
		si++;
	}
	// Remaining dst entries
	while (di < dst.length) {
		const d = dst[di];
		if (d) literalAdded += d.count;
		di++;
	}

	return { srcCopied, literalAdded };
}

/**
 * Compute similarity between two blobs as a percentage (0–100).
 * Uses git's diffcore-delta chunk-hashing algorithm for exact score match.
 *
 * score = src_copied * 100 / max(src_size, dst_size)
 */
function computeSimilarity(srcBuf: Uint8Array, dstBuf: Uint8Array): number {
	if (srcBuf.length === 0 && dstBuf.length === 0) return 100;
	if (srcBuf.length === 0 || dstBuf.length === 0) return 0;

	return computeSimilarityFromChunks(
		srcBuf.length,
		hashChunks(srcBuf),
		dstBuf.length,
		hashChunks(dstBuf),
	);
}

/**
 * Similarity scoring from pre-computed chunk hashes. Allows callers to
 * hash each blob once and reuse across many pair comparisons.
 */
function computeSimilarityFromChunks(
	srcSize: number,
	srcChunks: { hash: number; count: number }[],
	dstSize: number,
	dstChunks: { hash: number; count: number }[],
): number {
	const maxSize = Math.max(srcSize, dstSize);

	// Early rejection: if size difference alone makes it impossible
	// to reach 50%, skip the comparison.
	// (mirrors git's delta_size check in estimate_similarity)
	const minSize = Math.min(srcSize, dstSize);
	if (minSize < maxSize - minSize) return 0;

	const { srcCopied } = countChanges(srcChunks, dstChunks);
	return Math.floor((srcCopied * 100) / maxSize);
}

/**
 * Find the best similarity-based rename matches between unmatched
 * deleted and added entries. Uses greedy best-match approach.
 */
async function findSimilarityRenames(
	ctx: GitRepo,
	deleted: TreeDiffEntry[],
	added: TreeDiffEntry[],
	threshold: number,
): Promise<RenamePair[]> {
	// Pre-compute chunk hashes once per blob — avoids re-hashing in
	// the O(D×A) pair comparison loop below.
	interface BlobInfo {
		size: number;
		chunks: { hash: number; count: number }[];
	}
	const deletedInfo: (BlobInfo | null)[] = [];
	for (const d of deleted) {
		if (d.oldHash) {
			const buf = await readBlobBytes(ctx, d.oldHash);
			deletedInfo.push({ size: buf.length, chunks: hashChunks(buf) });
		} else {
			deletedInfo.push(null);
		}
	}
	const addedInfo: (BlobInfo | null)[] = [];
	for (const a of added) {
		if (a.newHash) {
			const buf = await readBlobBytes(ctx, a.newHash);
			addedInfo.push({ size: buf.length, chunks: hashChunks(buf) });
		} else {
			addedInfo.push(null);
		}
	}

	// Build similarity matrix with basename tie-breaking score.
	// Matches git's score_compare(): primary sort by similarity descending,
	// secondary sort by nameScore descending (basename match wins ties).
	const candidates: {
		similarity: number;
		nameScore: number;
		delIdx: number;
		addIdx: number;
	}[] = [];

	for (let di = 0; di < deleted.length; di++) {
		const delEntry = deleted[di];
		const delBlob = deletedInfo[di];
		if (!delEntry || !delBlob) continue;

		for (let ai = 0; ai < added.length; ai++) {
			const addEntry = added[ai];
			const addBlob = addedInfo[ai];
			if (!addEntry || !addBlob) continue;

			const sim = computeSimilarityFromChunks(
				delBlob.size,
				delBlob.chunks,
				addBlob.size,
				addBlob.chunks,
			);
			if (sim >= threshold) {
				const nameScore = pathBasename(delEntry.path) === pathBasename(addEntry.path) ? 1 : 0;
				candidates.push({
					similarity: sim,
					nameScore,
					delIdx: di,
					addIdx: ai,
				});
			}
		}
	}

	// Greedy: sort by similarity descending, then basename match descending
	candidates.sort((a, b) => b.similarity - a.similarity || b.nameScore - a.nameScore);

	const usedDel = new Set<number>();
	const usedAdd = new Set<number>();
	const result: RenamePair[] = [];

	for (const { similarity, delIdx, addIdx } of candidates) {
		if (usedDel.has(delIdx) || usedAdd.has(addIdx)) continue;
		usedDel.add(delIdx);
		usedAdd.add(addIdx);

		const del = deleted[delIdx];
		const add = added[addIdx];
		if (!del || !add) continue;
		result.push({
			oldPath: del.path,
			newPath: add.path,
			oldHash: del.oldHash ?? "",
			newHash: add.newHash ?? "",
			similarity,
			oldMode: del.oldMode,
			newMode: add.newMode,
		});
	}

	return result;
}

// ── Formatting helpers ───────────────────────────────────────────────

/**
 * Format a rename path using git's `pprint_rename()` algorithm from diff.c.
 * Finds the longest common prefix and suffix at `/` boundaries,
 * then formats as `prefix{old_middle => new_middle}suffix`.
 * Falls back to `old => new` when no common directory parts exist.
 */
export function formatRenamePath(oldPath: string, newPath: string): string {
	const lenA = oldPath.length;
	const lenB = newPath.length;

	// Find common prefix length — only advance at '/' boundaries
	let pfxLen = 0;
	let i = 0;
	while (i < lenA && i < lenB && oldPath[i] === newPath[i]) {
		if (oldPath[i] === "/") pfxLen = i + 1;
		i++;
	}

	// Find common suffix length — only advance at '/' boundaries.
	// If there is a common prefix, it ends in a slash. In that case we
	// let this loop run 1 into the prefix to see the same slash.
	const pfxAdjust = pfxLen > 0 ? 1 : 0;
	let sfxLen = 0;
	let oi = lenA;
	let ni = lenB;
	while (pfxLen - pfxAdjust <= oi && pfxLen - pfxAdjust <= ni && oi >= 0 && ni >= 0) {
		if (oi === lenA && ni === lenB) {
			oi--;
			ni--;
			continue;
		}
		if (oldPath[oi] !== newPath[ni]) break;
		if (oldPath[oi] === "/") sfxLen = lenA - oi;
		oi--;
		ni--;
	}

	// Clamp to 0 (matching git's behavior — prefix/suffix may overlap
	// when one path is a substring of the other)
	const aMidLen = Math.max(0, lenA - pfxLen - sfxLen);
	const bMidLen = Math.max(0, lenB - pfxLen - sfxLen);

	const prefix = oldPath.slice(0, pfxLen);
	const suffix = oldPath.slice(lenA - sfxLen);
	const oldMiddle = oldPath.slice(pfxLen, pfxLen + aMidLen);
	const newMiddle = newPath.slice(pfxLen, pfxLen + bMidLen);

	if (pfxLen + sfxLen > 0) {
		return `${prefix}{${oldMiddle} => ${newMiddle}}${suffix}`;
	}
	return `${oldPath} => ${newPath}`;
}
