import type { DurableFileSystem } from "../fs/index.ts";
import { envelope, FileObjectDatabase } from "../lib/file-object-database.ts";
import { buildPackIndexFromMeta } from "../lib/pack/pack-index.ts";
import { applyDelta, type DeltaPackInput, writePackDeltified } from "../lib/pack/packfile.ts";
import { inflate } from "../lib/pack/zlib.ts";
import { sha1 } from "../lib/sha1.ts";
import type { ObjectId, ObjectType, RawObject } from "../lib/types.ts";
import type { DeltaObjectRow, StoredObject } from "./repo-store.ts";

/**
 * Native-layout object persistence for one bare repository.
 *
 * Ref persistence is composed alongside this class by createFsRepoStorage in
 * Phase 3.4; this layer intentionally owns only RepoStorage's object methods.
 */
export class FsObjectStorage {
	private database: FileObjectDatabase;

	constructor(fs: DurableFileSystem, repoDir: string) {
		this.database = new FileObjectDatabase(fs, repoDir);
	}

	async getObject(hash: string): Promise<StoredObject | null> {
		const obj = await this.database.read(hash);
		return obj ? storedRaw(obj) : null;
	}

	async getObjects(hashes: ReadonlyArray<string>): Promise<Map<string, StoredObject>> {
		const result = new Map<string, StoredObject>();
		for (const hash of new Set(hashes)) {
			const obj = await this.database.read(hash);
			if (obj) result.set(hash, storedRaw(obj));
		}
		return result;
	}

	async putObject(hash: string, type: string, content: Uint8Array): Promise<void> {
		await this.database.putLoose(hash, requireObjectType(type), content);
	}

	async putObjects(
		objects: ReadonlyArray<{ hash: string; type: string; content: Uint8Array }>,
	): Promise<string[]> {
		const inserted: string[] = [];
		const seen = new Set<string>();
		for (const obj of objects) {
			if (seen.has(obj.hash)) continue;
			seen.add(obj.hash);
			if (await this.database.putLoose(obj.hash, requireObjectType(obj.type), obj.content)) {
				inserted.push(obj.hash);
			}
		}
		return inserted;
	}

	async putDeltaObjects(rows: ReadonlyArray<DeltaObjectRow>): Promise<void> {
		if (rows.length === 0) return;
		const packInputs = await this.materializePackInputs(rows);
		const { data: packData, entries } = await writePackDeltified(packInputs);
		const indexData = await buildPackIndexFromMeta(packData, entries);
		await this.database.installPack(packData, indexData);
		await this.database.deleteLoose(rows.map((row) => row.hash));
	}

	async hasObject(hash: string): Promise<boolean> {
		return this.database.has(hash);
	}

	async hasObjects(hashes: ReadonlyArray<string>): Promise<Set<string>> {
		const present = new Set<string>();
		for (const hash of new Set(hashes)) {
			if (await this.database.has(hash)) present.add(hash);
		}
		return present;
	}

	async findObjectsByPrefix(prefix: string): Promise<string[]> {
		return this.database.findByPrefix(prefix);
	}

	async listObjectHashes(): Promise<string[]> {
		return this.database.listHashes();
	}

	async repoByteSize(): Promise<number> {
		return this.database.repoByteSize();
	}

	async deleteObjects(hashes: ReadonlyArray<string>): Promise<number> {
		return this.database.deleteLoose(hashes);
	}

	private async materializePackInputs(
		rows: ReadonlyArray<DeltaObjectRow>,
	): Promise<DeltaPackInput[]> {
		const byHash = new Map(rows.map((row) => [row.hash, row]));
		const resolved = new Map<ObjectId, RawObject>();
		const inputs = new Map<ObjectId, DeltaPackInput>();
		const order: ObjectId[] = [];
		const visiting = new Set<ObjectId>();

		const resolve = async (hash: ObjectId): Promise<RawObject> => {
			const cached = resolved.get(hash);
			if (cached) return cached;
			if (visiting.has(hash)) throw new Error(`delta cycle detected at object ${hash}`);
			visiting.add(hash);

			const row = byHash.get(hash);
			if (!row) {
				const existing = await this.database.read(hash);
				if (!existing) throw new Error(`delta base object ${hash} not found`);
				resolved.set(hash, existing);
				inputs.set(hash, { hash, type: existing.type, content: existing.content });
				order.push(hash);
				visiting.delete(hash);
				return existing;
			}

			const type = requireObjectType(row.type);
			let rawContent: Uint8Array;
			let delta: Uint8Array | undefined;
			let deltaBaseHash: ObjectId | undefined;
			if (row.encoding === "raw") {
				rawContent = row.content;
			} else if (row.encoding === "raw-zlib") {
				rawContent = await inflate(row.content);
			} else if ("baseHash" in row) {
				const base = await resolve(row.baseHash);
				if (base.type !== type) {
					throw new Error(
						`delta object ${hash} type ${type} does not match base ${row.baseHash} type ${base.type}`,
					);
				}
				delta = row.encoding === "delta-zlib" ? await inflate(row.content) : row.content;
				rawContent = applyDelta(base.content, delta);
				deltaBaseHash = row.baseHash;
			} else {
				throw new Error(`object ${hash} has invalid encoding ${row.encoding}`);
			}

			const computed = await sha1(envelope(type, rawContent));
			if (computed !== hash) {
				throw new Error(`object hash mismatch: expected ${hash}, computed ${computed}`);
			}

			const raw = { type, content: rawContent } satisfies RawObject;
			resolved.set(hash, raw);
			inputs.set(hash, { hash, type, content: rawContent, delta, deltaBaseHash });
			order.push(hash);
			visiting.delete(hash);
			return raw;
		};

		for (const row of rows) await resolve(row.hash);
		return order.map((hash) => inputs.get(hash)!);
	}
}

function storedRaw(obj: RawObject): StoredObject {
	return { type: obj.type, encoding: "raw", content: obj.content };
}

function requireObjectType(type: string): ObjectType {
	if (type === "blob" || type === "tree" || type === "commit" || type === "tag") return type;
	throw new Error(`invalid git object type: ${type}`);
}
