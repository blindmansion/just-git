import {
	createFile,
	ensureDirectory,
	installPackPairBestEffort,
	removeFile,
} from "../fs/durable-io.ts";
import type { FileSystem } from "../fs/index.ts";
import { bytesToHex } from "./hex.ts";
import { buildPackIndex, PackIndex } from "./pack/pack-index.ts";
import { PackReader } from "./pack/pack-reader.ts";
import { deflate, inflate } from "./pack/zlib.ts";
import { join } from "./path.ts";
import { sha1 } from "./sha1.ts";
import type { ObjectId, ObjectType, RawObject } from "./types.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const FANOUT_NAME = /^[0-9a-f]{2}$/;
const LOOSE_NAME = /^[0-9a-f]{38}$/;
const OBJECT_ID = /^[0-9a-f]{40}$/;
const OBJECT_PREFIX = /^[0-9a-f]{4,40}$/;

interface PackSlot {
	name: string;
	index: PackIndex;
	reader: PackReader | null;
}

export interface PackInfo {
	name: string;
	objectCount: number;
}

/** Build the native loose-object envelope: `<type> <size>\0<content>`. */
export function envelope(type: ObjectType, content: Uint8Array): Uint8Array {
	const header = encoder.encode(`${type} ${content.byteLength}\0`);
	const result = new Uint8Array(header.byteLength + content.byteLength);
	result.set(header);
	result.set(content, header.byteLength);
	return result;
}

/**
 * Shared native Git object database used by the client object store and the
 * filesystem-backed RepoStorage object layer.
 */
export class FileObjectDatabase {
	private packs: PackSlot[] = [];
	private loadedPackNames = new Set<string>();
	private discoverPromise: Promise<void> | null = null;
	private objectsDir: string;
	private packDir: string;

	constructor(
		private fs: FileSystem,
		private gitDir: string,
	) {
		this.objectsDir = join(gitDir, "objects");
		this.packDir = join(this.objectsDir, "pack");
	}

	async writeLoose(
		type: ObjectType,
		content: Uint8Array,
	): Promise<{ hash: ObjectId; inserted: boolean }> {
		const data = envelope(type, content);
		const hash = await sha1(data);
		return { hash, inserted: await this.installLoose(hash, data) };
	}

	async putLoose(hash: ObjectId, type: ObjectType, content: Uint8Array): Promise<boolean> {
		const data = envelope(type, content);
		const computed = await sha1(data);
		if (computed !== hash) {
			throw new Error(`object hash mismatch: expected ${hash}, computed ${computed}`);
		}
		return this.installLoose(hash, data);
	}

	async read(hash: ObjectId): Promise<RawObject | null> {
		requireObjectId(hash);
		const loose = await this.readLoose(hash);
		if (loose) return loose;

		await this.discover();
		for (const slot of this.packs) {
			if (!slot.index.has(hash)) continue;
			const reader = await this.ensureReader(slot);
			const obj = await reader.readObject(hash);
			if (obj) return obj;
		}
		return null;
	}

	async has(hash: ObjectId): Promise<boolean> {
		requireObjectId(hash);
		if (await this.fs.exists(this.loosePath(hash))) return true;
		await this.discover();
		return this.packs.some((slot) => slot.index.has(hash));
	}

	async findByPrefix(prefix: string): Promise<ObjectId[]> {
		if (!OBJECT_PREFIX.test(prefix)) return [];
		const matches = new Set<ObjectId>();
		const fanout = prefix.slice(0, 2);
		const rest = prefix.slice(2);
		const dir = join(this.objectsDir, fanout);

		if (FANOUT_NAME.test(fanout) && (await this.fs.exists(dir))) {
			for (const entry of await this.fs.readdir(dir)) {
				if (LOOSE_NAME.test(entry) && entry.startsWith(rest)) {
					matches.add(`${fanout}${entry}`);
				}
			}
		}

		await this.discover();
		for (const slot of this.packs) {
			for (const hash of slot.index.findByPrefix(prefix)) matches.add(hash);
		}
		return Array.from(matches);
	}

	async listHashes(): Promise<ObjectId[]> {
		const hashes = new Set<ObjectId>();
		if (await this.fs.exists(this.objectsDir)) {
			for (const fanout of await this.fs.readdir(this.objectsDir)) {
				if (!FANOUT_NAME.test(fanout)) continue;
				const dir = join(this.objectsDir, fanout);
				for (const entry of await this.fs.readdir(dir)) {
					if (LOOSE_NAME.test(entry)) hashes.add(`${fanout}${entry}`);
				}
			}
		}

		await this.discover();
		for (const slot of this.packs) {
			for (const hash of slot.index.allHashes()) hashes.add(hash);
		}
		return Array.from(hashes).sort();
	}

	async repoByteSize(): Promise<number> {
		let size = 0;
		if (await this.fs.exists(this.objectsDir)) {
			for (const fanout of await this.fs.readdir(this.objectsDir)) {
				if (!FANOUT_NAME.test(fanout)) continue;
				const dir = join(this.objectsDir, fanout);
				for (const entry of await this.fs.readdir(dir)) {
					if (!LOOSE_NAME.test(entry)) continue;
					size += (await this.fs.stat(join(dir, entry))).size;
				}
			}
		}

		if (await this.fs.exists(this.packDir)) {
			for (const entry of await this.fs.readdir(this.packDir)) {
				if (entry.endsWith(".pack")) size += (await this.fs.stat(join(this.packDir, entry))).size;
			}
		}
		return size;
	}

	async deleteLoose(hashes: ReadonlyArray<ObjectId>): Promise<number> {
		let deleted = 0;
		for (const hash of new Set(hashes)) {
			requireObjectId(hash);
			if (await removeFile(this.fs, this.loosePath(hash))) deleted++;
		}
		return deleted;
	}

	async ingestPack(packData: Uint8Array): Promise<number> {
		const { objectCount } = await inspectPack(packData);
		if (objectCount === 0) return 0;
		const indexData = await buildPackIndex(packData);
		await this.installPack(packData, indexData);
		return objectCount;
	}

	async installPack(packData: Uint8Array, indexData: Uint8Array): Promise<PackInfo> {
		const { hash, objectCount } = await inspectPack(packData);
		const index = new PackIndex(indexData);
		if (index.objectCount !== objectCount) {
			throw new Error(
				`pack index object count ${index.objectCount} does not match pack count ${objectCount}`,
			);
		}
		const packName = `pack-${hash}`;
		await ensureDirectory(this.fs, this.packDir);
		await installPackPairBestEffort(
			this.fs,
			join(this.packDir, `${packName}.pack`),
			packData,
			join(this.packDir, `${packName}.idx`),
			indexData,
		);
		this.registerPack(packName, indexData, packData);
		return { name: packName, objectCount };
	}

	invalidatePacks(): void {
		this.packs = [];
		this.loadedPackNames.clear();
		this.discoverPromise = null;
	}

	private async installLoose(hash: ObjectId, data: Uint8Array): Promise<boolean> {
		const path = this.loosePath(hash);
		if (await this.fs.exists(path)) return false;
		await ensureDirectory(this.fs, join(this.objectsDir, hash.slice(0, 2)));
		return createFile(this.fs, path, await deflate(data));
	}

	private async readLoose(hash: ObjectId): Promise<RawObject | null> {
		const path = this.loosePath(hash);
		if (!(await this.fs.exists(path))) return null;
		const data = await inflate(await this.fs.readFileBuffer(path));
		const computed = await sha1(data);
		if (computed !== hash) {
			throw new Error(`corrupt loose object ${hash}: SHA-1 mismatch (computed ${computed})`);
		}
		return parseEnvelope(hash, data);
	}

	private loosePath(hash: ObjectId): string {
		return join(this.objectsDir, hash.slice(0, 2), hash.slice(2));
	}

	private async ensureReader(slot: PackSlot): Promise<PackReader> {
		if (slot.reader) return slot.reader;
		const packData = await this.fs.readFileBuffer(join(this.packDir, `${slot.name}.pack`));
		slot.reader = new PackReader(packData, slot.index);
		return slot.reader;
	}

	private discover(): Promise<void> {
		if (!this.discoverPromise) this.discoverPromise = this.doDiscover();
		return this.discoverPromise;
	}

	private async doDiscover(): Promise<void> {
		if (!(await this.fs.exists(this.packDir))) return;
		for (const entry of await this.fs.readdir(this.packDir)) {
			if (!entry.endsWith(".idx")) continue;
			const name = entry.slice(0, -4);
			if (this.loadedPackNames.has(name)) continue;
			if (!(await this.fs.exists(join(this.packDir, `${name}.pack`)))) continue;
			const indexData = await this.fs.readFileBuffer(join(this.packDir, entry));
			this.registerPack(name, indexData, null);
		}
	}

	private registerPack(name: string, indexData: Uint8Array, packData: Uint8Array | null): void {
		const index = new PackIndex(indexData);
		const existing = this.packs.find((slot) => slot.name === name);
		if (existing) {
			existing.index = index;
			existing.reader = packData ? new PackReader(packData, index) : null;
		} else {
			this.packs.push({
				name,
				index,
				reader: packData ? new PackReader(packData, index) : null,
			});
		}
		this.loadedPackNames.add(name);
	}
}

function parseEnvelope(hash: string, data: Uint8Array): RawObject {
	const nullIdx = data.indexOf(0);
	if (nullIdx === -1) throw new Error(`Corrupt object ${hash}: no null byte in header`);
	const header = decoder.decode(data.subarray(0, nullIdx));
	const spaceIdx = header.indexOf(" ");
	if (spaceIdx === -1) throw new Error(`Corrupt object ${hash}: malformed header "${header}"`);

	const type = header.slice(0, spaceIdx);
	if (!isObjectType(type)) throw new Error(`Corrupt object ${hash}: invalid type "${type}"`);
	const sizeText = header.slice(spaceIdx + 1);
	if (!/^(0|[1-9][0-9]*)$/.test(sizeText)) {
		throw new Error(`Corrupt object ${hash}: invalid size "${sizeText}"`);
	}
	const size = Number.parseInt(sizeText, 10);
	const content = data.subarray(nullIdx + 1);
	if (!Number.isSafeInteger(size) || size < 0 || content.byteLength !== size) {
		throw new Error(`Corrupt object ${hash}: expected ${size} bytes, got ${content.byteLength}`);
	}
	return { type, content };
}

async function inspectPack(packData: Uint8Array): Promise<{ hash: string; objectCount: number }> {
	if (packData.byteLength < 32) return { hash: "", objectCount: 0 };
	const view = new DataView(packData.buffer, packData.byteOffset, packData.byteLength);
	const signature = view.getUint32(0);
	if (signature !== 0x5041434b) {
		throw new Error(`invalid pack signature: 0x${signature.toString(16)} (expected 0x5041434b)`);
	}
	const version = view.getUint32(4);
	if (version !== 2) throw new Error(`unsupported pack version: ${version}`);

	const hash = bytesToHex(packData.subarray(packData.byteLength - 20));
	const computed = await sha1(packData.subarray(0, packData.byteLength - 20));
	if (computed !== hash) {
		throw new Error(`pack checksum mismatch: expected ${hash}, computed ${computed}`);
	}
	return { hash, objectCount: view.getUint32(8) };
}

function isObjectType(type: string): type is ObjectType {
	return type === "blob" || type === "tree" || type === "commit" || type === "tag";
}

function requireObjectId(hash: string): asserts hash is ObjectId {
	if (!OBJECT_ID.test(hash)) throw new Error(`invalid git object id: ${hash}`);
}
