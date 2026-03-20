import { bytesToHex, hexToBytes } from "./hex.ts";
import { verifyPath } from "./path-safety.ts";
import { join } from "./path.ts";
import { sha1 } from "./sha1.ts";
import type { GitContext, Index, IndexEntry, IndexStat } from "./types.ts";

// ── Constants ───────────────────────────────────────────────────────

/** Magic signature at the start of the index file: "DIRC". */
const SIGNATURE = 0x44495243;

/** We use index format version 2. */
const VERSION = 2;

// ── Public API ──────────────────────────────────────────────────────

/**
 * Read and parse the .git/index file.
 * Returns an empty index if the file doesn't exist.
 */
export async function readIndex(ctx: GitContext): Promise<Index> {
	const path = join(ctx.gitDir, "index");
	if (!(await ctx.fs.exists(path))) {
		return { version: VERSION, entries: [] };
	}

	const data = await ctx.fs.readFileBuffer(path);
	return parseIndex(data);
}

/**
 * Serialize and write the index to .git/index.
 * Entries are sorted by path (as Git requires).
 */
export async function writeIndex(ctx: GitContext, index: Index): Promise<void> {
	const path = join(ctx.gitDir, "index");
	const data = await serializeIndex(index);
	await ctx.fs.writeFile(path, data);
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
	return { ...index, entries };
}

/** Remove all entries for a given path (returns a new Index). */
export function removeEntry(index: Index, path: string): Index {
	return {
		...index,
		entries: index.entries.filter((e) => e.path !== path),
	};
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
