import { hexToBytes } from "../hex.ts";
import { createHasher } from "../sha1.ts";
import type { ObjectId } from "../types.ts";
import { crc32 } from "./crc32.ts";
import { type PackEntryMeta, readPack } from "./packfile.ts";

const IDX_MAGIC = 0xff744f63;
const IDX_VERSION = 2;

// ── PackIndex reader ────────────────────────────────────────────────

/**
 * In-memory representation of a Git pack index v2 file.
 * Provides O(log N) hash lookups via binary search on the sorted hash list.
 */
export class PackIndex {
	private fanout: Uint32Array;
	private hashes: Uint8Array;
	private offsets: Uint32Array;
	private largeOffsets: DataView | null;
	private count: number;

	constructor(data: Uint8Array) {
		const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

		if (view.getUint32(0) !== IDX_MAGIC) {
			throw new Error("Invalid pack index: bad magic");
		}
		if (view.getUint32(4) !== IDX_VERSION) {
			throw new Error(`Unsupported pack index version: ${view.getUint32(4)}`);
		}

		this.fanout = new Uint32Array(256);
		let pos = 8;
		for (let i = 0; i < 256; i++) {
			this.fanout[i] = view.getUint32(pos);
			pos += 4;
		}

		this.count = this.fanout[255]!;

		this.hashes = new Uint8Array(data.buffer, data.byteOffset + pos, this.count * 20);
		pos += this.count * 20;

		// Skip CRC32 array (not needed for reading)
		pos += this.count * 4;

		this.offsets = new Uint32Array(this.count);
		for (let i = 0; i < this.count; i++) {
			this.offsets[i] = view.getUint32(pos);
			pos += 4;
		}

		let hasLarge = false;
		for (let i = 0; i < this.count; i++) {
			if (this.offsets[i]! & 0x80000000) {
				hasLarge = true;
				break;
			}
		}
		this.largeOffsets = hasLarge ? new DataView(data.buffer, data.byteOffset + pos) : null;
	}

	/** Look up a hash and return its byte offset in the pack, or null. */
	lookup(hash: ObjectId): number | null {
		const target = hexToBytes(hash);
		const firstByte = target[0]!;
		const lo = firstByte === 0 ? 0 : this.fanout[firstByte - 1]!;
		const hi = this.fanout[firstByte]!;

		let left = lo;
		let right = hi;
		while (left < right) {
			const mid = (left + right) >>> 1;
			const cmp = this.compareAt(mid, target);
			if (cmp < 0) left = mid + 1;
			else if (cmp > 0) right = mid;
			else return this.getOffset(mid);
		}
		return null;
	}

	has(hash: ObjectId): boolean {
		return this.lookup(hash) !== null;
	}

	get objectCount(): number {
		return this.count;
	}

	/** Return all object hashes in this index. */
	allHashes(): ObjectId[] {
		const result: ObjectId[] = [];
		for (let i = 0; i < this.count; i++) {
			result.push(this.hashAtSlot(i));
		}
		return result;
	}

	/** Return all hashes matching a hex prefix (4-39 chars). */
	findByPrefix(prefix: string): ObjectId[] {
		if (prefix.length < 2) return [];
		const firstByte = parseInt(prefix.slice(0, 2), 16);
		const lo = firstByte === 0 ? 0 : this.fanout[firstByte - 1]!;
		const hi = this.fanout[firstByte]!;

		const prefixBytes = hexToBytes(prefix.padEnd(40, "0"));
		const prefixLen = prefix.length;
		const results: ObjectId[] = [];

		for (let i = lo; i < hi; i++) {
			const offset = i * 20;
			let match = true;
			for (let j = 0; j < prefixLen; j++) {
				const hashNibble =
					j % 2 === 0
						? (this.hashes[offset + (j >> 1)]! >> 4) & 0xf
						: this.hashes[offset + (j >> 1)]! & 0xf;
				const prefixNibble =
					j % 2 === 0 ? (prefixBytes[j >> 1]! >> 4) & 0xf : prefixBytes[j >> 1]! & 0xf;
				if (hashNibble !== prefixNibble) {
					match = false;
					break;
				}
			}
			if (match) {
				results.push(this.hashAtSlot(i));
			}
		}
		return results;
	}

	private hashAtSlot(idx: number): ObjectId {
		let hex = "";
		const offset = idx * 20;
		for (let j = 0; j < 20; j++) {
			const b = this.hashes[offset + j] as number;
			hex += (b >> 4).toString(16) + (b & 0xf).toString(16);
		}
		return hex;
	}

	private compareAt(idx: number, target: Uint8Array): number {
		const offset = idx * 20;
		for (let i = 0; i < 20; i++) {
			const a = this.hashes[offset + i]!;
			const b = target[i]!;
			if (a < b) return -1;
			if (a > b) return 1;
		}
		return 0;
	}

	private getOffset(idx: number): number {
		const raw = this.offsets[idx]!;
		if (raw & 0x80000000) {
			const largeIdx = raw & 0x7fffffff;
			return Number(this.largeOffsets!.getBigUint64(largeIdx * 8));
		}
		return raw;
	}
}

// ── Pack index writer ───────────────────────────────────────────────

interface PackIndexEntry {
	hash: ObjectId;
	offset: number;
	crc: number;
}

/**
 * Write a v2 `.idx` file from a list of pack entries.
 * `packChecksum` is the trailing 20-byte SHA-1 from the `.pack` file.
 */
async function writePackIndex(
	entries: PackIndexEntry[],
	packChecksum: Uint8Array,
): Promise<Uint8Array> {
	const sorted = [...entries].sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
	const n = sorted.length;

	const largeOffsets: bigint[] = [];
	for (const entry of sorted) {
		if (entry.offset >= 0x80000000) {
			largeOffsets.push(BigInt(entry.offset));
		}
	}

	const size = 8 + 256 * 4 + n * 20 + n * 4 + n * 4 + largeOffsets.length * 8 + 20 + 20;

	const buf = new Uint8Array(size);
	const view = new DataView(buf.buffer);
	let pos = 0;

	view.setUint32(pos, IDX_MAGIC);
	pos += 4;
	view.setUint32(pos, IDX_VERSION);
	pos += 4;

	// Fanout: cumulative count of objects with first hash byte ≤ i
	const fanout = new Uint32Array(256);
	for (const entry of sorted) {
		const fb = parseInt(entry.hash.slice(0, 2), 16);
		for (let i = fb; i < 256; i++) fanout[i]!++;
	}
	for (let i = 0; i < 256; i++) {
		view.setUint32(pos, fanout[i]!);
		pos += 4;
	}

	for (const entry of sorted) {
		buf.set(hexToBytes(entry.hash), pos);
		pos += 20;
	}

	for (const entry of sorted) {
		view.setUint32(pos, entry.crc);
		pos += 4;
	}

	let largeIdx = 0;
	for (const entry of sorted) {
		if (entry.offset >= 0x80000000) {
			view.setUint32(pos, 0x80000000 | largeIdx++);
		} else {
			view.setUint32(pos, entry.offset);
		}
		pos += 4;
	}

	for (const big of largeOffsets) {
		view.setBigUint64(pos, big);
		pos += 8;
	}

	buf.set(packChecksum, pos);
	pos += 20;

	const hasher = createHasher();
	hasher.update(buf.subarray(0, pos));
	const checkHex = await hasher.hex();
	buf.set(hexToBytes(checkHex), pos);

	return buf;
}

// ── Build index from pack data ──────────────────────────────────────

/**
 * Parse a packfile and produce a complete v2 `.idx` file.
 * Resolves all objects (including deltas) to obtain hashes,
 * and computes CRC32 over each entry's raw bytes.
 */
export async function buildPackIndex(packData: Uint8Array): Promise<Uint8Array> {
	const objects = await readPack(packData);
	const entries: PackIndexEntry[] = objects.map((obj) => ({
		hash: obj.hash,
		offset: obj.offset,
		crc: crc32(packData.subarray(obj.offset, obj.nextOffset)),
	}));
	const packChecksum = packData.subarray(packData.byteLength - 20);
	return writePackIndex(entries, packChecksum);
}

/**
 * Build a v2 `.idx` file from pre-computed entry metadata.
 * Avoids re-parsing the pack — only computes CRC32 per entry.
 */
export async function buildPackIndexFromMeta(
	packData: Uint8Array,
	metas: PackEntryMeta[],
): Promise<Uint8Array> {
	const entries: PackIndexEntry[] = metas.map((m) => ({
		hash: m.hash,
		offset: m.offset,
		crc: crc32(packData.subarray(m.offset, m.nextOffset)),
	}));
	const packChecksum = packData.subarray(packData.byteLength - 20);
	return writePackIndex(entries, packChecksum);
}
