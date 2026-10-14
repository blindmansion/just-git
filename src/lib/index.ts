import type { FileStat, FileSystem } from "../fs.ts";
import { bytesToHex, hexToBytes } from "./hex.ts";
import { verifyPath } from "./path-safety.ts";
import { join } from "./path.ts";
import { sha1 } from "./sha1.ts";
import { isRegularFileMode, isSubmoduleMode, isSymlinkMode, lstatSafe } from "./symlink.ts";
import type { GitContext, Index, IndexEntry, IndexStat } from "./types.ts";

// ── Constants ───────────────────────────────────────────────────────

/** Magic signature at the start of the index file: "DIRC". */
const SIGNATURE = 0x44495243;

/** We use index format version 2. */
const VERSION = 2;

/** Mtime of the on-disk index each in-memory index was read from or written to. */
const indexTimestamps = new WeakMap<Index, Date>();

// ── Public API ──────────────────────────────────────────────────────

/**
 * Return the index file mtime used for racy-clean checks, if known.
 * Entries modified at or after this time cannot be trusted by stat alone.
 */
export function getIndexTimestamp(index: Index): Date | undefined {
	return indexTimestamps.get(index);
}

/**
 * Read and parse the .git/index file.
 * Returns an empty index if the file doesn't exist.
 */
export async function readIndex(ctx: GitContext): Promise<Index> {
	const path = join(ctx.gitDir, "index");
	if (!(await ctx.fs.exists(path))) {
		return { version: VERSION, entries: [] };
	}

	const before = await ctx.fs.stat(path);
	const data = await ctx.fs.readFileBuffer(path);
	const after = await ctx.fs.stat(path);
	const index = parseIndex(data);
	const beforeMtime = timestampMilliseconds(before.mtime);
	const afterMtime = timestampMilliseconds(after.mtime);
	if (
		before.size === data.byteLength &&
		after.size === data.byteLength &&
		beforeMtime !== null &&
		beforeMtime === afterMtime
	) {
		indexTimestamps.set(index, after.mtime);
	}
	return index;
}

/**
 * Serialize and write the index to .git/index.
 * Entries are sorted by path (as Git requires).
 *
 * Entries whose mtime is not older than the written index file are racily
 * clean: a same-size edit in the same timestamp tick would be invisible to
 * stat checks once a later write advances the index mtime. Like Git, such
 * entries are smudged (their mtime zeroed, in `index` and on disk) so they
 * are always content-hashed until restaged.
 */
export async function writeIndex(ctx: GitContext, index: Index): Promise<void> {
	const path = join(ctx.gitDir, "index");
	await ctx.fs.writeFile(path, await serializeIndex(index));
	let mtime = await statMtime(ctx, path);
	if (mtime === null) {
		indexTimestamps.delete(index);
		return;
	}

	if (smudgeRacyEntries(index, mtime)) {
		await ctx.fs.writeFile(path, await serializeIndex(index));
		mtime = await statMtime(ctx, path);
		if (mtime === null) {
			indexTimestamps.delete(index);
			return;
		}
	}
	indexTimestamps.set(index, mtime);
}

/**
 * Add or replace an entry in the index (returns a new Index).
 * Entries are kept sorted by path, then by stage.
 *
 * When adding a stage-0 entry, all other stages for that path are
 * removed (this is how `git add` resolves merge conflicts).
 * When adding a higher-stage entry, only the matching (path, stage)
 * entry is replaced.
 */
export function addEntry(index: Index, entry: IndexEntry): Index {
	if (!verifyPath(entry.path)) {
		throw new Error(`refusing to add unsafe path to index: '${entry.path}'`);
	}
	let entries: IndexEntry[];
	if (entry.stage === 0) {
		// Stage 0 replaces all stages for this path (conflict resolution)
		entries = index.entries.filter((e) => e.path !== entry.path);
	} else {
		// Higher stage: only replace the same (path, stage)
		entries = index.entries.filter((e) => !(e.path === entry.path && e.stage === entry.stage));
	}
	entries.push(entry);
	entries.sort(compareEntries);
	return withEntries(index, entries);
}

/** Remove all entries for a given path (returns a new Index). */
export function removeEntry(index: Index, path: string): Index {
	return withEntries(
		index,
		index.entries.filter((e) => e.path !== path),
	);
}

/** Find an entry by path (stage 0 by default). */
export function findEntry(index: Index, path: string, stage: number = 0): IndexEntry | undefined {
	return index.entries.find((e) => e.path === path && e.stage === stage);
}

/** Check whether the index contains any unmerged (conflicted) entries. */
export function hasConflicts(index: Index): boolean {
	return index.entries.some((e) => e.stage > 0);
}

/** Return the deduplicated list of paths with unmerged entries. */
export function getConflictedPaths(index: Index): string[] {
	return [...new Set(index.entries.filter((e) => e.stage > 0).map((e) => e.path))];
}

/** Return only the stage-0 (resolved) entries. */
export function getStage0Entries(index: Index): IndexEntry[] {
	return index.entries.filter((e) => e.stage === 0);
}

/** Return a fresh empty index. */
export function clearIndex(): Index {
	return { version: VERSION, entries: [] };
}

/**
 * Build an index from a pre-constructed array of entries with a single sort.
 * Use this instead of calling `addEntry` in a loop when constructing an index
 * from scratch (e.g. from a flattened tree), since `addEntry` scans for
 * duplicates on each call making the loop O(n²).
 */
export function buildIndex(entries: IndexEntry[]): Index {
	const sorted = [...entries].sort(compareEntries);
	return { version: VERSION, entries: sorted };
}

/** Create a default IndexStat with zeroed fields. */
export function defaultStat(): IndexStat {
	return {
		ctimeSeconds: 0,
		ctimeNanoseconds: 0,
		mtimeSeconds: 0,
		mtimeNanoseconds: 0,
		dev: 0,
		ino: 0,
		uid: 0,
		gid: 0,
		size: 0,
	};
}

/** Convert available filesystem metadata to the fields stored in an index entry. */
export function indexStatFromFileStat(stat: FileStat, size: number = stat.size): IndexStat {
	const mtime = splitTimestamp(stat.mtime);
	const ctime = stat.ctime ? splitTimestamp(stat.ctime) : { seconds: 0, nanoseconds: 0 };
	return {
		ctimeSeconds: ctime.seconds,
		ctimeNanoseconds: ctime.nanoseconds,
		mtimeSeconds: mtime.seconds,
		mtimeNanoseconds: mtime.nanoseconds,
		dev: toUint32(stat.dev),
		ino: toUint32(stat.ino),
		uid: toUint32(stat.uid),
		gid: toUint32(stat.gid),
		size: toUint32(size),
	};
}

/**
 * Return whether an index entry's metadata safely identifies the current
 * worktree file. Files at or newer than the index timestamp are racily clean
 * and must still be hashed.
 */
export function indexStatMatchesFile(
	fs: FileSystem,
	entry: IndexEntry,
	stat: FileStat,
	indexTimestamp: Date | undefined,
): boolean {
	if (!indexTimestamp || !stat.isFile || stat.isSymbolicLink) return false;
	if (entry.stat.mtimeSeconds === 0 || stat.size < 0 || stat.size > 0xffffffff) return false;
	if (worktreeMode(fs, entry, stat) !== entry.mode || stat.size !== entry.stat.size) return false;

	const fileMtimeMs = timestampMilliseconds(stat.mtime);
	const indexMtimeMs = timestampMilliseconds(indexTimestamp);
	if (
		fileMtimeMs === null ||
		indexMtimeMs === null ||
		fileMtimeMs !== indexTimestampMs(entry.stat)
	) {
		return false;
	}

	if (stat.ctime) {
		if (entry.stat.ctimeSeconds === 0) return false;
		const ctimeMs =
			entry.stat.ctimeSeconds * 1000 + Math.floor(entry.stat.ctimeNanoseconds / 1_000_000);
		if (Math.trunc(stat.ctime.getTime()) !== ctimeMs) return false;
	}
	if (!optionalStatFieldMatches(stat.dev, entry.stat.dev)) return false;
	if (!optionalStatFieldMatches(stat.ino, entry.stat.ino)) return false;
	if (!optionalStatFieldMatches(stat.uid, entry.stat.uid)) return false;
	if (!optionalStatFieldMatches(stat.gid, entry.stat.gid)) return false;

	return fileMtimeMs < indexMtimeMs;
}

/** Convert filesystem type and executable bits to a canonical Git mode. */
export function gitModeFromFileStat(stat: FileStat): number {
	if (stat.isSymbolicLink) return 0o120000;
	if (stat.isDirectory) return 0o040000;
	return stat.mode & 0o111 ? 0o100755 : 0o100644;
}

function fileStandsInForSymlink(
	fs: FileSystem,
	entry: Pick<IndexEntry, "mode">,
	stat: FileStat,
): boolean {
	return stat.isFile && isSymlinkMode(entry.mode) && !fs.symlink;
}

function fsTracksExecutableBit(fs: FileSystem): boolean {
	return fs.chmod !== undefined;
}

export function worktreeMode(
	fs: FileSystem,
	entry: Pick<IndexEntry, "mode"> | undefined,
	stat: FileStat,
): number {
	if (entry && fileStandsInForSymlink(fs, entry, stat)) return entry.mode;
	if (stat.isFile && !fsTracksExecutableBit(fs)) {
		return entry && isRegularFileMode(entry.mode) ? entry.mode : 0o100644;
	}
	return gitModeFromFileStat(stat);
}

/**
 * Refresh stat metadata for index entries whose content a caller has just
 * materialized in the worktree. Paths that cannot be verified by type/mode
 * retain their existing (usually zero) metadata and will be hashed later.
 */
export async function refreshIndexStatsAfterCheckout(
	ctx: GitContext,
	index: Index,
	paths?: Iterable<string>,
): Promise<Index> {
	if (!ctx.workTree) return index;
	const selected = paths ? new Set(paths) : null;
	const entries: IndexEntry[] = [];

	for (const entry of index.entries) {
		if (
			entry.stage !== 0 ||
			isSubmoduleMode(entry.mode) ||
			(selected && !selected.has(entry.path))
		) {
			entries.push(entry);
			continue;
		}

		const stat = await lstatSafe(ctx.fs, join(ctx.workTree, entry.path)).catch(() => null);
		if (!stat || worktreeMode(ctx.fs, entry, stat) !== entry.mode) {
			entries.push(entry);
			continue;
		}
		entries.push({ ...entry, stat: indexStatFromFileStat(stat) });
	}

	return withEntries(index, entries);
}

// ── Binary parsing (Git index v2 format) ────────────────────────────

/**
 * Index v2 binary layout:
 *
 * Header:
 *   4 bytes  "DIRC" signature
 *   4 bytes  version number (2)
 *   4 bytes  number of entries
 *
 * Per entry:
 *   32 bits  ctime seconds
 *   32 bits  ctime nanoseconds
 *   32 bits  mtime seconds
 *   32 bits  mtime nanoseconds
 *   32 bits  dev
 *   32 bits  ino
 *   32 bits  mode
 *   32 bits  uid
 *   32 bits  gid
 *   32 bits  file size
 *   160 bits (20 bytes) SHA-1
 *   16 bits  flags: 1-bit assume-valid, 1-bit extended, 2-bit stage, 12-bit name length
 *   variable name (null-terminated, then padded to 8-byte alignment of the entry)
 *
 * Footer:
 *   160 bits (20 bytes) SHA-1 checksum of all preceding content
 */
function parseIndex(data: Uint8Array): Index {
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	let offset = 0;

	// ── Header ──
	const sig = view.getUint32(offset);
	offset += 4;
	if (sig !== SIGNATURE) {
		throw new Error(`Invalid index signature: 0x${sig.toString(16)}`);
	}

	const version = view.getUint32(offset);
	offset += 4;

	const numEntries = view.getUint32(offset);
	offset += 4;

	// ── Entries ──
	const entries: IndexEntry[] = [];

	for (let i = 0; i < numEntries; i++) {
		const entryStart = offset;

		const stat: IndexStat = {
			ctimeSeconds: view.getUint32(offset),
			ctimeNanoseconds: view.getUint32(offset + 4),
			mtimeSeconds: view.getUint32(offset + 8),
			mtimeNanoseconds: view.getUint32(offset + 12),
			dev: view.getUint32(offset + 16),
			ino: view.getUint32(offset + 20),
			uid: view.getUint32(offset + 28),
			gid: view.getUint32(offset + 32),
			size: view.getUint32(offset + 36),
		};

		const mode = view.getUint32(offset + 24);
		offset += 40;

		// 20-byte SHA-1
		const hashBytes = data.subarray(offset, offset + 20);
		const hash = bytesToHex(hashBytes);
		offset += 20;

		// 16-bit flags
		const flags = view.getUint16(offset);
		offset += 2;

		const stage = (flags >> 12) & 0x3;
		const nameLen = flags & 0xfff;

		// Read the name — use nameLen if < 0xFFF, otherwise scan for null.
		// nameLen is the UTF-8 byte length (capped at 0xFFF).
		let nameBytesLen: number;
		let name: string;
		if (nameLen < 0xfff) {
			name = new TextDecoder().decode(data.subarray(offset, offset + nameLen));
			nameBytesLen = nameLen;
		} else {
			// Long name: scan for null terminator
			let end = offset;
			while (end < data.byteLength && data[end] !== 0) end++;
			name = new TextDecoder().decode(data.subarray(offset, end));
			nameBytesLen = end - offset;
		}

		// Entry is padded to 8-byte alignment (from entry start).
		// Must use byte length, not JS string length, for non-ASCII paths.
		const entryLen = 62 + nameBytesLen + 1;
		const padded = Math.ceil(entryLen / 8) * 8;
		offset = entryStart + padded;

		entries.push({ path: name, mode, hash, stage, stat });
	}

	return { version, entries };
}

async function serializeIndex(index: Index): Promise<Uint8Array> {
	const encoder = new TextEncoder();

	// Sort entries by path, then stage
	const entries = [...index.entries].sort(compareEntries);

	// Pre-encode all names so we use UTF-8 byte lengths everywhere
	const encodedNames: Uint8Array[] = [];
	let totalSize = 12; // header
	for (const entry of entries) {
		const nameBytes = encoder.encode(entry.path);
		encodedNames.push(nameBytes);
		const entryLen = 62 + nameBytes.byteLength + 1;
		totalSize += Math.ceil(entryLen / 8) * 8;
	}
	totalSize += 20; // checksum

	const buffer = new ArrayBuffer(totalSize);
	const data = new Uint8Array(buffer);
	const view = new DataView(buffer);
	let offset = 0;

	// ── Header ──
	view.setUint32(offset, SIGNATURE);
	offset += 4;
	view.setUint32(offset, index.version);
	offset += 4;
	view.setUint32(offset, entries.length);
	offset += 4;

	// ── Entries ──
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i]!;
		const nameBytes = encodedNames[i]!;
		const entryStart = offset;

		view.setUint32(offset, entry.stat.ctimeSeconds);
		view.setUint32(offset + 4, entry.stat.ctimeNanoseconds);
		view.setUint32(offset + 8, entry.stat.mtimeSeconds);
		view.setUint32(offset + 12, entry.stat.mtimeNanoseconds);
		view.setUint32(offset + 16, entry.stat.dev);
		view.setUint32(offset + 20, entry.stat.ino);
		view.setUint32(offset + 24, entry.mode);
		view.setUint32(offset + 28, entry.stat.uid);
		view.setUint32(offset + 32, entry.stat.gid);
		view.setUint32(offset + 36, entry.stat.size);
		offset += 40;

		// 20-byte SHA-1
		const hashBytes = hexToBytes(entry.hash);
		data.set(hashBytes, offset);
		offset += 20;

		// Flags: stage in bits 13-12, name length in bits 11-0
		const nameLen = Math.min(nameBytes.byteLength, 0xfff);
		const flags = ((entry.stage & 0x3) << 12) | nameLen;
		view.setUint16(offset, flags);
		offset += 2;

		// Name (null-terminated)
		data.set(nameBytes, offset);
		offset += nameBytes.byteLength;
		data[offset] = 0; // null terminator
		offset += 1;

		// Pad to 8-byte alignment
		const entryLen = 62 + nameBytes.byteLength + 1;
		const padded = Math.ceil(entryLen / 8) * 8;
		offset = entryStart + padded;
	}

	// ── Checksum ──
	const contentToHash = data.subarray(0, offset);
	const checksum = await sha1(contentToHash);
	const checksumBytes = hexToBytes(checksum);
	data.set(checksumBytes, offset);

	return data;
}

// ── Helpers ─────────────────────────────────────────────────────────

/** Sort comparator for index entries: by path, then by stage. */
function compareEntries(a: IndexEntry, b: IndexEntry): number {
	if (a.path < b.path) return -1;
	if (a.path > b.path) return 1;
	return a.stage - b.stage;
}

function splitTimestamp(date: Date | undefined): { seconds: number; nanoseconds: number } {
	const milliseconds = timestampMilliseconds(date);
	if (milliseconds === null) return { seconds: 0, nanoseconds: 0 };
	const seconds = Math.floor(milliseconds / 1000);
	return {
		seconds: toUint32(seconds),
		nanoseconds: (milliseconds - seconds * 1000) * 1_000_000,
	};
}

function timestampMilliseconds(date: Date | undefined): number | null {
	if (!(date instanceof Date)) return null;
	const milliseconds = Math.trunc(date.getTime());
	return Number.isFinite(milliseconds) ? milliseconds : null;
}

function toUint32(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value) || value < 0) return 0;
	return Math.trunc(value) >>> 0;
}

function optionalStatFieldMatches(value: number | undefined, indexed: number): boolean {
	if (value === undefined) return true;
	return indexed !== 0 && toUint32(value) === indexed;
}

function indexTimestampMs(stat: IndexStat): number {
	return stat.mtimeSeconds * 1000 + Math.floor(stat.mtimeNanoseconds / 1_000_000);
}

function withEntries(index: Index, entries: IndexEntry[]): Index {
	const next = { ...index, entries };
	const timestamp = indexTimestamps.get(index);
	if (timestamp) indexTimestamps.set(next, timestamp);
	return next;
}

async function statMtime(ctx: GitContext, path: string): Promise<Date | null> {
	const { mtime } = await ctx.fs.stat(path);
	return timestampMilliseconds(mtime) === null ? null : mtime;
}

/** Zero the mtime of stage-0 entries not strictly older than `indexMtime`. */
function smudgeRacyEntries(index: Index, indexMtime: Date): boolean {
	const indexMs = Math.trunc(indexMtime.getTime());
	let smudged = false;
	for (let i = 0; i < index.entries.length; i++) {
		const entry = index.entries[i]!;
		if (entry.stage !== 0 || entry.stat.mtimeSeconds === 0) continue;
		if (indexTimestampMs(entry.stat) < indexMs) continue;
		index.entries[i] = {
			...entry,
			stat: { ...entry.stat, mtimeSeconds: 0, mtimeNanoseconds: 0 },
		};
		smudged = true;
	}
	return smudged;
}
