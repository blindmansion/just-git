import { hexAt, hexToBytes } from "../hex.ts";
import { createHasher } from "../sha1.ts";
import type { ObjectId, ObjectType, RawObject } from "../types.ts";
import { deflate, inflateObject } from "./zlib.ts";

// ── Constants ────────────────────────────────────────────────────────

const PACK_SIGNATURE = 0x5041434b; // "PACK"
const PACK_VERSION = 2;

const OBJ_COMMIT = 1;
const OBJ_TREE = 2;
const OBJ_BLOB = 3;
const OBJ_TAG = 4;
const OBJ_OFS_DELTA = 6;
const OBJ_REF_DELTA = 7;

const TYPE_BY_NUM: Record<number, ObjectType> = {
	[OBJ_COMMIT]: "commit",
	[OBJ_TREE]: "tree",
	[OBJ_BLOB]: "blob",
	[OBJ_TAG]: "tag",
};

const NUM_BY_TYPE: Record<ObjectType, number> = {
	commit: OBJ_COMMIT,
	tree: OBJ_TREE,
	blob: OBJ_BLOB,
	tag: OBJ_TAG,
};

// ── Types ────────────────────────────────────────────────────────────

/** A fully resolved (non-delta) object from a packfile. */
export interface PackObject {
	type: ObjectType;
	content: Uint8Array;
	hash: ObjectId;
}

/** PackObject with byte-offset metadata for pack index construction. */
interface PackObjectMeta extends PackObject {
	/** Byte offset of this entry's header in the pack. */
	offset: number;
	/** Byte offset of the next entry (or the pack trailer). */
	nextOffset: number;
}

/** Input for writing a pack: type + raw content. */
export interface PackInput {
	type: ObjectType;
	content: Uint8Array;
}

/** Input for writing a deltified pack entry. */
export interface DeltaPackInput {
	hash: ObjectId;
	type: ObjectType;
	content: Uint8Array;
	/** Delta instruction stream (from createDelta). */
	delta?: Uint8Array;
	/** Hash of the base object in this pack (for OFS_DELTA). */
	deltaBaseHash?: ObjectId;
}

export interface PackEntryMeta {
	hash: ObjectId;
	offset: number;
	nextOffset: number;
}

interface PackWriteResult {
	data: Uint8Array;
	entries: PackEntryMeta[];
}

// ── Pack reader ──────────────────────────────────────────────────────

/**
 * Callback for resolving delta bases not present in the pack (thin packs).
 * Called when a REF_DELTA references an object that isn't in the pack itself.
 * Return the object if available, or null to signal it's missing.
 */
type ExternalBaseResolver = (hash: ObjectId) => Promise<RawObject | null>;

/**
 * Parse a packfile and return all objects with byte-offset metadata.
 * Fully resolves deltas. Useful for building pack indices (CRC32
 * is computed over `data[offset..nextOffset]` for each entry).
 *
 * For thin packs (where REF_DELTA bases reference objects not in the pack),
 * provide an `externalBase` resolver that fetches the base from an
 * existing object store.
 */
export async function readPack(
	data: Uint8Array,
	externalBase?: ExternalBaseResolver,
): Promise<PackObjectMeta[]> {
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

	const sig = view.getUint32(0);
	if (sig !== PACK_SIGNATURE) {
		throw new Error(
			`Invalid pack signature: 0x${sig.toString(16)} (expected 0x${PACK_SIGNATURE.toString(16)})`,
		);
	}
	const version = view.getUint32(4);
	if (version !== PACK_VERSION) {
		throw new Error(`Unsupported pack version: ${version}`);
	}

	if (data.byteLength >= 32) {
		const trailingHash = hexAt(data, data.byteLength - 20);
		const hasher = createHasher();
		hasher.update(data.subarray(0, data.byteLength - 20));
		const computedHash = await hasher.hex();
		if (computedHash !== trailingHash) {
			throw new Error(`pack checksum mismatch: expected ${trailingHash}, computed ${computedHash}`);
		}
	}

	const numObjects = view.getUint32(8);

	const entries: RawPackEntry[] = [];
	let offset = 12;
	for (let i = 0; i < numObjects; i++) {
		const entry = await readEntry(data, offset);
		entries.push(entry);
		offset = entry.nextOffset;
	}

	const resolved = await resolveEntries(entries, externalBase);
	return resolved.map(
		(obj, i): PackObjectMeta => ({
			...obj,
			offset: entries[i]!.headerOffset,
			nextOffset: entries[i]!.nextOffset,
		}),
	);
}

/** Internal representation of a single entry before delta resolution. */
interface RawPackEntry {
	/** Byte offset of this entry's type/size header in the pack. */
	headerOffset: number;
	/** Object type number (1-4 for base types, 6-7 for deltas). */
	typeNum: number;
	/** Decompressed content (raw object data, or delta instructions). */
	inflated: Uint8Array;
	/** For OFS_DELTA: absolute offset of the base entry. */
	baseOffset?: number;
	/** For REF_DELTA: SHA-1 of the base object. */
	baseHash?: ObjectId;
	/** Byte offset of the next entry. */
	nextOffset: number;
}

/**
 * Read one pack entry starting at `offset`.
 * Returns the parsed entry plus the offset of the next entry.
 */
async function readEntry(data: Uint8Array, offset: number): Promise<RawPackEntry> {
	const headerOffset = offset;

	// Type/size header: first byte has 3-bit type in bits 6-4,
	// 4-bit size in bits 3-0, continuation in bit 7.
	let byte = data[offset++]!;
	const typeNum = (byte >> 4) & 0x07;
	let size = byte & 0x0f;
	let shift = 4;
	while (byte & 0x80) {
		byte = data[offset++]!;
		size |= (byte & 0x7f) << shift;
		shift += 7;
	}

	// Delta base reference
	let baseOffset: number | undefined;
	let baseHash: ObjectId | undefined;

	if (typeNum === OBJ_OFS_DELTA) {
		// Variable-length negative offset
		let c = data[offset++]!;
		baseOffset = c & 0x7f;
		while (c & 0x80) {
			baseOffset += 1;
			c = data[offset++]!;
			baseOffset = (baseOffset << 7) + (c & 0x7f);
		}
		baseOffset = headerOffset - baseOffset;
	} else if (typeNum === OBJ_REF_DELTA) {
		baseHash = hexAt(data, offset);
		offset += 20;
	}

	// Compressed data — inflate it.
	// We don't know exactly how many compressed bytes there are,
	// so we inflate and use the consumed count from zlib.
	const { result, bytesConsumed } = await inflateObject(data.subarray(offset), size);

	return {
		headerOffset,
		typeNum,
		inflated: result,
		baseOffset,
		baseHash,
		nextOffset: offset + bytesConsumed,
	};
}

const MAX_DELTA_DEPTH = 50;

/**
 * Resolve all entries: apply deltas, compute hashes, return
 * fully materialized objects.
 */
async function resolveEntries(
	entries: RawPackEntry[],
	externalBase?: ExternalBaseResolver,
): Promise<PackObject[]> {
	// Index base entries by header offset for OFS_DELTA lookup.
	const byOffset = new Map<number, number>();
	for (let i = 0; i < entries.length; i++) {
		byOffset.set(entries[i]!.headerOffset, i);
	}

	const resolved: (PackObject | null)[] = new Array(entries.length).fill(null);

	async function resolve(idx: number, depth: number = 0): Promise<PackObject> {
		if (depth > MAX_DELTA_DEPTH) {
			throw new Error(`delta chain depth ${depth} exceeds limit of ${MAX_DELTA_DEPTH}`);
		}

		const cached = resolved[idx];
		if (cached) return cached;

		const entry = entries[idx]!;

		if (entry.typeNum !== OBJ_OFS_DELTA && entry.typeNum !== OBJ_REF_DELTA) {
			// Base object
			const type = TYPE_BY_NUM[entry.typeNum];
			if (!type) throw new Error(`Unknown object type: ${entry.typeNum}`);
			const obj: PackObject = {
				type,
				content: entry.inflated,
				hash: await hashGitObject(type, entry.inflated),
			};
			resolved[idx] = obj;
			return obj;
		}

		// Delta — find and resolve the base first
		if (entry.typeNum === OBJ_OFS_DELTA) {
			const baseIdx = byOffset.get(entry.baseOffset!);
			if (baseIdx === undefined) {
				throw new Error(`OFS_DELTA base not found at offset ${entry.baseOffset}`);
			}
			const base = await resolve(baseIdx, depth + 1);
			const content = applyDelta(base.content, entry.inflated);
			const obj: PackObject = {
				type: base.type,
				content,
				hash: await hashGitObject(base.type, content),
			};
			resolved[idx] = obj;
			return obj;
		}

		// REF_DELTA — search in pack first, then external store
		const baseIdx = await findByHash(entries, resolved, entry.baseHash!, resolve);
		let base: RawObject | undefined;
		if (baseIdx !== undefined) {
			base = await resolve(baseIdx, depth + 1);
		} else if (externalBase) {
			const ext = await externalBase(entry.baseHash!);
			if (ext) base = ext;
		}
		if (!base) {
			throw new Error(`REF_DELTA base not found for hash ${entry.baseHash}`);
		}

		const content = applyDelta(base.content, entry.inflated);
		const obj: PackObject = {
			type: base.type,
			content,
			hash: await hashGitObject(base.type, content),
		};
		resolved[idx] = obj;
		return obj;
	}

	for (let i = 0; i < entries.length; i++) {
		await resolve(i);
	}

	return resolved as PackObject[];
}

/**
 * Find a base entry by its resolved hash. May need to resolve
 * entries along the way.
 */
async function findByHash(
	entries: RawPackEntry[],
	resolved: (PackObject | null)[],
	hash: ObjectId,
	resolve: (idx: number) => Promise<PackObject>,
): Promise<number | undefined> {
	// Check already-resolved first
	for (let i = 0; i < resolved.length; i++) {
		if (resolved[i]?.hash === hash) return i;
	}
	// Try resolving non-delta entries to find the match
	for (let i = 0; i < entries.length; i++) {
		const e = entries[i]!;
		if (e.typeNum !== OBJ_OFS_DELTA && e.typeNum !== OBJ_REF_DELTA) {
			const obj = await resolve(i);
			if (obj.hash === hash) return i;
		}
	}
	return undefined;
}

// ── Streaming pack reader ────────────────────────────────────────────

/**
 * Buffered async byte reader for sequential consumption of an
 * `AsyncIterable<Uint8Array>`. Tracks total bytes consumed and
 * optionally maintains a running SHA-1 hash of all consumed bytes
 * (for pack checksum verification).
 */
class AsyncByteReader {
	private buf = new Uint8Array(0);
	private iter: AsyncIterator<Uint8Array>;
	private eof = false;
	private _bytesRead = 0;
	private hasher: ReturnType<typeof createHasher> | null;

	constructor(source: AsyncIterable<Uint8Array>, hash = false) {
		this.iter = source[Symbol.asyncIterator]();
		this.hasher = hash ? createHasher() : null;
	}

	get bytesRead(): number {
		return this._bytesRead;
	}

	private async pullMore(): Promise<boolean> {
		if (this.eof) return false;
		const { value, done } = await this.iter.next();
		if (done || !value) {
			this.eof = true;
			return false;
		}
		if (this.buf.byteLength === 0) {
			this.buf = new Uint8Array(value);
		} else {
			const merged = new Uint8Array(this.buf.byteLength + value.byteLength);
			merged.set(this.buf);
			merged.set(value, this.buf.byteLength);
			this.buf = merged;
		}
		return true;
	}

	private async ensure(n: number): Promise<void> {
		while (this.buf.byteLength < n) {
			if (!(await this.pullMore())) {
				throw new Error(
					`Unexpected end of pack data: needed ${n} bytes, have ${this.buf.byteLength}`,
				);
			}
		}
	}

	private consume(n: number): Uint8Array {
		const result = new Uint8Array(this.buf.subarray(0, n));
		this.hasher?.update(result);
		this.buf = this.buf.subarray(n);
		this._bytesRead += n;
		return result;
	}

	async readByte(): Promise<number> {
		await this.ensure(1);
		return this.consume(1)[0]!;
	}

	async readExact(n: number): Promise<Uint8Array> {
		await this.ensure(n);
		return this.consume(n);
	}

	/** Read exactly `n` bytes without feeding them to the hasher. */
	async readRaw(n: number): Promise<Uint8Array> {
		await this.ensure(n);
		const result = new Uint8Array(this.buf.subarray(0, n));
		this.buf = this.buf.subarray(n);
		this._bytesRead += n;
		return result;
	}

	/**
	 * Inflate a single zlib-compressed entry from the stream.
	 * Buffers enough data for decompression, consumes only the
	 * compressed bytes, and returns the inflated result.
	 */
	async inflateNext(expectedSize: number): Promise<Uint8Array> {
		if (this.buf.byteLength === 0 && !this.eof) await this.pullMore();
		while (true) {
			try {
				const { result, bytesConsumed } = await inflateObject(this.buf, expectedSize);
				this.consume(bytesConsumed);
				return result;
			} catch {
				if (!this.eof && (await this.pullMore())) continue;
				throw new Error(
					`Failed to inflate pack entry at byte ${this._bytesRead} (expected ${expectedSize} bytes)`,
				);
			}
		}
	}

	async hashHex(): Promise<string> {
		if (!this.hasher) throw new Error("Hashing not enabled");
		return this.hasher.hex();
	}
}

/**
 * Streaming pack parser. Reads entries one at a time from an async
 * byte source, resolves deltas on the fly, and yields fully resolved
 * objects. Peak memory is `N * resolved_objects` — the raw compressed
 * pack bytes are discarded as each entry is consumed.
 *
 * Verifies the pack checksum incrementally: all bytes before the
 * trailing 20-byte SHA-1 are hashed as they flow through, and the
 * trailer is checked at the end.
 *
 * Delta bases must precede their dependents in the pack (the standard
 * ordering guarantee from `git pack-objects`).
 */
export async function* readPackStreaming(
	source: AsyncIterable<Uint8Array>,
	externalBase?: ExternalBaseResolver,
): AsyncGenerator<PackObject> {
	const reader = new AsyncByteReader(source, true);

	const header = await reader.readExact(12);
	const view = new DataView(header.buffer, header.byteOffset, header.byteLength);

	const sig = view.getUint32(0);
	if (sig !== PACK_SIGNATURE) {
		throw new Error(
			`Invalid pack signature: 0x${sig.toString(16)} (expected 0x${PACK_SIGNATURE.toString(16)})`,
		);
	}
	const version = view.getUint32(4);
	if (version !== PACK_VERSION) {
		throw new Error(`Unsupported pack version: ${version}`);
	}
	const numObjects = view.getUint32(8);

	const byOffset = new Map<number, PackObject>();
	const byHash = new Map<string, PackObject>();

	for (let i = 0; i < numObjects; i++) {
		const headerOffset = reader.bytesRead;

		let byte = await reader.readByte();
		const typeNum = (byte >> 4) & 0x07;
		let size = byte & 0x0f;
		let shift = 4;
		while (byte & 0x80) {
			byte = await reader.readByte();
			size |= (byte & 0x7f) << shift;
			shift += 7;
		}

		let baseOffset: number | undefined;
		let baseHash: string | undefined;

		if (typeNum === OBJ_OFS_DELTA) {
			let c = await reader.readByte();
			baseOffset = c & 0x7f;
			while (c & 0x80) {
				baseOffset += 1;
				c = await reader.readByte();
				baseOffset = (baseOffset << 7) + (c & 0x7f);
			}
			baseOffset = headerOffset - baseOffset;
		} else if (typeNum === OBJ_REF_DELTA) {
			const hashBytes = await reader.readExact(20);
			baseHash = hexAt(hashBytes, 0);
		}

		const inflated = await reader.inflateNext(size);

		let obj: PackObject;

		if (typeNum !== OBJ_OFS_DELTA && typeNum !== OBJ_REF_DELTA) {
			const type = TYPE_BY_NUM[typeNum];
			if (!type) throw new Error(`Unknown object type: ${typeNum}`);
			obj = { type, content: inflated, hash: await hashGitObject(type, inflated) };
		} else if (typeNum === OBJ_OFS_DELTA) {
			const base = byOffset.get(baseOffset!);
			if (!base) throw new Error(`OFS_DELTA base not found at offset ${baseOffset}`);
			const content = applyDelta(base.content, inflated);
			obj = { type: base.type, content, hash: await hashGitObject(base.type, content) };
		} else {
			let base: { type: ObjectType; content: Uint8Array } | undefined = byHash.get(baseHash!);
			if (!base && externalBase) {
				base = (await externalBase(baseHash!)) ?? undefined;
			}
			if (!base) throw new Error(`REF_DELTA base not found for hash ${baseHash}`);
			const content = applyDelta(base.content, inflated);
			obj = { type: base.type, content, hash: await hashGitObject(base.type, content) };
		}

		byOffset.set(headerOffset, obj);
		byHash.set(obj.hash, obj);
		yield obj;
	}

	const expectedHash = hexAt(await reader.readRaw(20), 0);
	const computedHash = await reader.hashHex();
	if (computedHash !== expectedHash) {
		throw new Error(`pack checksum mismatch: expected ${expectedHash}, computed ${computedHash}`);
	}
}

// ── Delta application ────────────────────────────────────────────────

/**
 * Apply a delta instruction stream to a base object, producing the
 * target object content.
 *
 * Delta format:
 *   - Size-encoded base object size
 *   - Size-encoded target object size
 *   - Sequence of copy/insert instructions
 */
export function applyDelta(base: Uint8Array, delta: Uint8Array): Uint8Array {
	let pos = 0;

	// Read base size (for validation)
	const { value: baseSize, newPos: p1 } = readSizeEncoding(delta, pos);
	pos = p1;
	if (baseSize !== base.byteLength) {
		throw new Error(`Delta base size mismatch: expected ${baseSize}, got ${base.byteLength}`);
	}

	// Read target size
	const { value: targetSize, newPos: p2 } = readSizeEncoding(delta, pos);
	pos = p2;

	const target = new Uint8Array(targetSize);
	let tPos = 0;

	while (pos < delta.byteLength) {
		const cmd = delta[pos++]!;

		if (cmd & 0x80) {
			// Copy instruction
			let cpOff = 0;
			let cpSize = 0;
			if (cmd & 0x01) cpOff = delta[pos++]!;
			if (cmd & 0x02) cpOff |= delta[pos++]! << 8;
			if (cmd & 0x04) cpOff |= delta[pos++]! << 16;
			if (cmd & 0x08) cpOff |= delta[pos++]! << 24;
			if (cmd & 0x10) cpSize = delta[pos++]!;
			if (cmd & 0x20) cpSize |= delta[pos++]! << 8;
			if (cmd & 0x40) cpSize |= delta[pos++]! << 16;
			if (cpSize === 0) cpSize = 0x10000;

			target.set(base.subarray(cpOff, cpOff + cpSize), tPos);
			tPos += cpSize;
		} else if (cmd > 0) {
			// Insert instruction
			target.set(delta.subarray(pos, pos + cmd), tPos);
			tPos += cmd;
			pos += cmd;
		} else {
			throw new Error("Unexpected delta opcode 0x00 (reserved)");
		}
	}

	if (tPos !== targetSize) {
		throw new Error(`Delta produced ${tPos} bytes, expected ${targetSize}`);
	}

	return target;
}

// ── Pack writer ──────────────────────────────────────────────────────

/**
 * Create a packfile from a list of objects. Writes full (undeltified)
 * objects only — no delta compression. The result is a valid `.pack`
 * file with header, entries, and SHA-1 trailer.
 */
export async function writePack(objects: PackInput[]): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];

	const header = new Uint8Array(12);
	const hView = new DataView(header.buffer);
	hView.setUint32(0, PACK_SIGNATURE);
	hView.setUint32(4, PACK_VERSION);
	hView.setUint32(8, objects.length);
	chunks.push(header);

	for (const obj of objects) {
		const typeNum = NUM_BY_TYPE[obj.type];
		const compressed = await deflate(obj.content);
		chunks.push(encodeTypeSize(typeNum, obj.content.byteLength));
		chunks.push(compressed);
	}

	return finalizePack(chunks);
}

/**
 * Create a packfile that may contain OFS_DELTA entries.
 * Objects must be ordered so that delta bases appear before
 * their dependents (guaranteed by `findBestDeltas` output order).
 */
export async function writePackDeltified(objects: DeltaPackInput[]): Promise<PackWriteResult> {
	const chunks: Uint8Array[] = [];
	const offsets = new Map<ObjectId, number>();

	const header = new Uint8Array(12);
	const hView = new DataView(header.buffer);
	hView.setUint32(0, PACK_SIGNATURE);
	hView.setUint32(4, PACK_VERSION);
	hView.setUint32(8, objects.length);
	chunks.push(header);
	let currentOffset = 12;
	const entryMetas: PackEntryMeta[] = [];

	for (const obj of objects) {
		const entryStart = currentOffset;
		offsets.set(obj.hash, currentOffset);

		const baseOffset = obj.delta && obj.deltaBaseHash ? offsets.get(obj.deltaBaseHash) : undefined;

		if (obj.delta && baseOffset !== undefined) {
			const objHeader = encodeTypeSize(OBJ_OFS_DELTA, obj.delta.byteLength);
			const ofsBytes = encodeOfsOffset(currentOffset - baseOffset);
			const compressed = await deflate(obj.delta);
			chunks.push(objHeader, ofsBytes, compressed);
			currentOffset += objHeader.byteLength + ofsBytes.byteLength + compressed.byteLength;
		} else {
			const typeNum = NUM_BY_TYPE[obj.type];
			const objHeader = encodeTypeSize(typeNum, obj.content.byteLength);
			const compressed = await deflate(obj.content);
			chunks.push(objHeader, compressed);
			currentOffset += objHeader.byteLength + compressed.byteLength;
		}

		entryMetas.push({
			hash: obj.hash,
			offset: entryStart,
			nextOffset: currentOffset,
		});
	}

	return { data: await finalizePack(chunks), entries: entryMetas };
}

// ── Streaming pack writer ────────────────────────────────────────────

/**
 * Streaming variant of `writePack` that yields chunks as they're
 * produced. Each entry is deflated and yielded independently, so
 * the consumer can forward bytes to the network before the full
 * pack is materialized. The SHA-1 trailer is yielded last.
 *
 * Only supports undeltified objects — use `writePackDeltified` for
 * delta-compressed packs (which must be fully buffered anyway due
 * to the sliding-window delta search).
 */
export async function* writePackStreaming(
	count: number,
	objects: AsyncIterable<PackInput>,
): AsyncGenerator<Uint8Array> {
	const hasher = createHasher();

	const header = new Uint8Array(12);
	const hView = new DataView(header.buffer);
	hView.setUint32(0, PACK_SIGNATURE);
	hView.setUint32(4, PACK_VERSION);
	hView.setUint32(8, count);
	hasher.update(header);
	yield header;

	for await (const obj of objects) {
		const typeNum = NUM_BY_TYPE[obj.type];
		const objHeader = encodeTypeSize(typeNum, obj.content.byteLength);
		const compressed = await deflate(obj.content);

		hasher.update(objHeader);
		hasher.update(compressed);
		yield concat(objHeader, compressed);
	}

	yield hexToBytes(await hasher.hex());
}

/**
 * Concatenate chunks, append the SHA-1 trailer, return the final pack.
 */
async function finalizePack(chunks: Uint8Array[]): Promise<Uint8Array> {
	let totalSize = 0;
	for (const c of chunks) totalSize += c.byteLength;
	totalSize += 20;

	const result = new Uint8Array(totalSize);
	let offset = 0;
	for (const c of chunks) {
		result.set(c, offset);
		offset += c.byteLength;
	}

	const hasher = createHasher();
	hasher.update(result.subarray(0, offset));
	const checksum = await hasher.hex();
	result.set(hexToBytes(checksum), offset);

	return result;
}

// ── Encoding helpers ─────────────────────────────────────────────────

/**
 * Encode the variable-length negative offset for OFS_DELTA.
 * The encoding uses 7-bit chunks with the MSB as a continuation
 * flag, but with an unusual encoding where each continuation byte
 * contributes `(value + 1) << 7`.
 */
function encodeOfsOffset(negOffset: number): Uint8Array {
	const buf: number[] = [];
	buf.push(negOffset & 0x7f);
	let val = negOffset >>> 7;
	while (val > 0) {
		buf.unshift(0x80 | (--val & 0x7f));
		val >>>= 7;
	}
	return new Uint8Array(buf);
}

/** Encode the type/size header for a pack entry. */
function encodeTypeSize(typeNum: number, size: number): Uint8Array {
	const buf: number[] = [];
	let byte = (typeNum << 4) | (size & 0x0f);
	size >>= 4;
	while (size > 0) {
		buf.push(byte | 0x80);
		byte = size & 0x7f;
		size >>= 7;
	}
	buf.push(byte);
	return new Uint8Array(buf);
}

/** Read a size-encoded integer from a delta stream. */
function readSizeEncoding(data: Uint8Array, pos: number): { value: number; newPos: number } {
	let value = 0;
	let shift = 0;
	let byte: number;
	do {
		byte = data[pos++]!;
		value |= (byte & 0x7f) << shift;
		shift += 7;
	} while (byte & 0x80);
	return { value, newPos: pos };
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
	const out = new Uint8Array(a.byteLength + b.byteLength);
	out.set(a, 0);
	out.set(b, a.byteLength);
	return out;
}

const encoder = new TextEncoder();

/** Compute the git object hash: SHA-1 of `<type> <size>\0<content>`. */
async function hashGitObject(type: ObjectType, content: Uint8Array): Promise<ObjectId> {
	const header = encoder.encode(`${type} ${content.byteLength}\0`);
	const hasher = createHasher();
	hasher.update(header);
	hasher.update(content);
	return hasher.hex();
}
