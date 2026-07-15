import type { FileSystem } from "../fs/index.ts";
import { FileObjectDatabase } from "./file-object-database.ts";
import { ObjectCache } from "./object-cache.ts";
import type { PackObject } from "./pack/packfile.ts";
import { writePack } from "./pack/packfile.ts";
import type { ObjectId, ObjectStore, ObjectType, RawObject } from "./types.ts";

export { envelope } from "./file-object-database.ts";

/**
 * Git object storage: compressed loose objects for new writes, with
 * retained packfiles from fetch/clone. Pack indices are loaded eagerly
 * during discovery for fast hash lookups; pack data is loaded lazily
 * on first read from each pack.
 */
export class PackedObjectStore implements ObjectStore {
	private database: FileObjectDatabase;
	private cache: ObjectCache;

	constructor(fs: FileSystem, gitDir: string, cacheMaxBytes?: number) {
		this.database = new FileObjectDatabase(fs, gitDir);
		this.cache = new ObjectCache(cacheMaxBytes);
	}

	async write(type: ObjectType, content: Uint8Array): Promise<ObjectId> {
		return (await this.database.writeLoose(type, content)).hash;
	}

	async read(hash: ObjectId): Promise<RawObject> {
		const cached = this.cache.get(hash);
		if (cached) return cached;
		const obj = await this.database.read(hash);
		if (obj) {
			this.cache.set(hash, obj);
			return obj;
		}
		throw new Error(`object ${hash} not found`);
	}

	async exists(hash: ObjectId): Promise<boolean> {
		return this.database.has(hash);
	}

	async ingestPack(packData: Uint8Array): Promise<number> {
		return this.database.ingestPack(packData);
	}

	async ingestPackStream(entries: AsyncIterable<PackObject>): Promise<number> {
		const objects: PackObject[] = [];
		for await (const obj of entries) objects.push(obj);
		if (objects.length === 0) return 0;

		const packData = await writePack(objects);
		return this.ingestPack(packData);
	}

	invalidatePacks(): void {
		this.database.invalidatePacks();
		this.cache.clear();
	}

	async findByPrefix(prefix: string): Promise<ObjectId[]> {
		return this.database.findByPrefix(prefix);
	}
}
