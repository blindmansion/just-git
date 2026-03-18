import type { FileSystem } from "../fs.ts";
import { bytesToHex } from "./hex.ts";
import { ObjectCache } from "./object-cache.ts";
import { buildPackIndex, PackIndex } from "./pack/pack-index.ts";
import { PackReader } from "./pack/pack-reader.ts";
import { deflate, inflate } from "./pack/zlib.ts";
import { join } from "./path.ts";
import { sha1 } from "./sha1.ts";
import type { ObjectId, ObjectStore, ObjectType, RawObject } from "./types.ts";

// ── Shared helpers ──────────────────────────────────────────────────

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Build the raw stored representation of a Git object:
 *   `<type> <size>\0<content>`
 */
export function envelope(type: ObjectType, content: Uint8Array): Uint8Array {
	const header = encoder.encode(`${type} ${content.byteLength}\0`);
	const result = new Uint8Array(header.byteLength + content.byteLength);
	result.set(header);
	result.set(content, header.byteLength);
	return result;
}

/**
 * Parse the `<type> <size>\0<content>` envelope, returning type + content.
 */
function parseEnvelope(hash: string, data: Uint8Array): RawObject {
	const nullIdx = data.indexOf(0);
	if (nullIdx === -1) {
		throw new Error(`Corrupt object ${hash}: no null byte in header`);
	}

	const header = decoder.decode(data.subarray(0, nullIdx));
	const spaceIdx = header.indexOf(" ");
	if (spaceIdx === -1) {
		throw new Error(`Corrupt object ${hash}: malformed header "${header}"`);
	}

	const type = header.slice(0, spaceIdx) as ObjectType;
	const size = parseInt(header.slice(spaceIdx + 1), 10);
	const content = data.subarray(nullIdx + 1);

	if (content.byteLength !== size) {
		throw new Error(`Corrupt object ${hash}: expected ${size} bytes, got ${content.byteLength}`);
	}

	return { type, content };
}

/** Return the loose-object path: `<gitDir>/objects/<ab>/<cdef…>` */
function objectPath(gitDir: string, hash: ObjectId): string {
	return join(gitDir, "objects", hash.slice(0, 2), hash.slice(2));
}

// ── PackedObjectStore ────────────────────────────────────────────────

/**
 * A discovered pack — index loaded eagerly, pack data loaded on demand.
 */
interface PackSlot {
	name: string;
	index: PackIndex;
	reader: PackReader | null;
}

/**
 * Git object storage: compressed loose objects for new writes, with
 * retained packfiles from fetch/clone. Pack indices are loaded eagerly
 * during discovery for fast hash lookups; pack data is loaded lazily
 * on first read from each pack.
 */
export class PackedObjectStore implements ObjectStore {
	private packs: PackSlot[] = [];
	private loadedPackNames = new Set<string>();
	private discoverPromise: Promise<void> | null = null;
	private cache: ObjectCache;
	private packDir: string;

	constructor(
		private fs: FileSystem,
		private gitDir: string,
		cacheMaxBytes?: number,
	) {
		this.cache = new ObjectCache(cacheMaxBytes);
		this.packDir = join(gitDir, "objects", "pack");
	}

	async write(type: ObjectType, content: Uint8Array): Promise<ObjectId> {
		const data = envelope(type, content);
		const hash = await sha1(data);
		const path = objectPath(this.gitDir, hash);

		if (await this.fs.exists(path)) {
			return hash;
		}

		const dir = join(this.gitDir, "objects", hash.slice(0, 2));
		await this.fs.mkdir(dir, { recursive: true });

		await this.fs.writeFile(path, await deflate(data));
		return hash;
	}

	async read(hash: ObjectId): Promise<RawObject> {
		const cached = this.cache.get(hash);
		if (cached) return cached;

		const path = objectPath(this.gitDir, hash);
		if (await this.fs.exists(path)) {
			const compressed = await this.fs.readFileBuffer(path);
			const data = await inflate(compressed);
			const obj = parseEnvelope(hash, data);
			this.cache.set(hash, obj);
			return obj;
		}

		await this.discover();

		for (const slot of this.packs) {
			if (!slot.index.has(hash)) continue;
			const reader = await this.ensureReader(slot);
			const obj = await reader.readObject(hash);
			if (obj) {
				this.cache.set(hash, obj);
				return obj;
			}
		}

		throw new Error(`object ${hash} not found`);
	}

	async exists(hash: ObjectId): Promise<boolean> {
		if (await this.fs.exists(objectPath(this.gitDir, hash))) return true;
		await this.discover();
		for (const slot of this.packs) {
			if (slot.index.has(hash)) return true;
		}
		return false;
	}

	async ingestPack(packData: Uint8Array): Promise<number> {
		if (packData.byteLength < 32) return 0;
		const view = new DataView(packData.buffer, packData.byteOffset, packData.byteLength);
		const numObjects = view.getUint32(8);
		if (numObjects === 0) return 0;

		const checksumBytes = packData.subarray(packData.byteLength - 20);
		const packHash = bytesToHex(checksumBytes);

		await this.fs.mkdir(this.packDir, { recursive: true });

		const packName = `pack-${packHash}`;
		const packPath = join(this.packDir, `${packName}.pack`);
		await this.fs.writeFile(packPath, packData);

		const idxData = await buildPackIndex(packData);
		const idxPath = join(this.packDir, `${packName}.idx`);
		await this.fs.writeFile(idxPath, idxData);

		this.loadedPackNames.add(packName);
		const index = new PackIndex(idxData);
		this.packs.push({
			name: packName,
			index,
			reader: new PackReader(packData, index),
		});
		return numObjects;
	}

	invalidatePacks(): void {
		this.packs = [];
		this.loadedPackNames.clear();
		this.discoverPromise = null;
		this.cache.clear();
	}

	async findByPrefix(prefix: string): Promise<ObjectId[]> {
		if (prefix.length < 4) return [];
		const fanout = prefix.slice(0, 2);
		const rest = prefix.slice(2);
		const dir = join(this.gitDir, "objects", fanout);

		const matches: ObjectId[] = [];

		if (await this.fs.exists(dir)) {
			const entries = await this.fs.readdir(dir);
			for (const e of entries) {
				if (e.startsWith(rest)) {
					matches.push(`${fanout}${e}`);
				}
			}
		}

		await this.discover();
		for (const slot of this.packs) {
			for (const hash of slot.index.findByPrefix(prefix)) {
				if (!matches.includes(hash)) {
					matches.push(hash);
				}
			}
		}

		return matches;
	}

	/** Load the pack data for a slot on demand. */
	private async ensureReader(slot: PackSlot): Promise<PackReader> {
		if (slot.reader) return slot.reader;
		const packPath = join(this.packDir, `${slot.name}.pack`);
		const packBuf = await this.fs.readFileBuffer(packPath);
		slot.reader = new PackReader(packBuf, slot.index);
		return slot.reader;
	}

	/** Scan `.git/objects/pack/` for existing pack/idx pairs. */
	private discover(): Promise<void> {
		if (!this.discoverPromise) {
			this.discoverPromise = this.doDiscover();
		}
		return this.discoverPromise;
	}

	private async doDiscover(): Promise<void> {
		if (!(await this.fs.exists(this.packDir))) return;

		const files = await this.fs.readdir(this.packDir);
		for (const f of files) {
			if (!f.endsWith(".idx")) continue;
			const base = f.slice(0, -4);
			if (this.loadedPackNames.has(base)) continue;
			const packPath = join(this.packDir, `${base}.pack`);
			if (!(await this.fs.exists(packPath))) continue;

			const idxBuf = await this.fs.readFileBuffer(join(this.packDir, f));
			this.loadedPackNames.add(base);
			this.packs.push({
				name: base,
				index: new PackIndex(idxBuf),
				reader: null,
			});
		}
	}
}
