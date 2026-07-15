import type { Ref } from "../lib/types.ts";
import type {
	DeltaObjectRow,
	MaybeAsync,
	RawRefEntry,
	RefOps,
	Storage,
	StoredObject,
} from "./repo-store.ts";

/**
 * Raw object and ref persistence for a single repository.
 *
 * This is the single-repo counterpart to {@link Storage}: lifecycle, fork
 * metadata, and repo IDs belong to the pool that owns the handle.
 */
export interface RepoStorage {
	getObject(hash: string): MaybeAsync<StoredObject | null>;
	getObjects?(hashes: ReadonlyArray<string>): MaybeAsync<Map<string, StoredObject>>;
	putObject(hash: string, type: string, content: Uint8Array): MaybeAsync<void>;
	putObjects(
		objects: ReadonlyArray<{ hash: string; type: string; content: Uint8Array }>,
	): MaybeAsync<string[]>;
	putDeltaObjects(rows: ReadonlyArray<DeltaObjectRow>): MaybeAsync<void>;
	hasObject(hash: string): MaybeAsync<boolean>;
	hasObjects?(hashes: ReadonlyArray<string>): MaybeAsync<Set<string>>;
	findObjectsByPrefix(prefix: string): MaybeAsync<string[]>;
	listObjectHashes(): MaybeAsync<string[]>;
	repoByteSize?(): MaybeAsync<number>;
	deleteObjects(hashes: ReadonlyArray<string>): MaybeAsync<number>;

	getRef(name: string): MaybeAsync<Ref | null>;
	putRef(name: string, ref: Ref): MaybeAsync<void>;
	removeRef(name: string): MaybeAsync<void>;
	listRefs(prefix?: string): MaybeAsync<RawRefEntry[]>;
	atomicRefUpdate<T>(fn: (ops: RefOps) => MaybeAsync<T>): MaybeAsync<T>;
}

/**
 * Scope a legacy multi-repo {@link Storage} backend to one repository.
 *
 * This bridge keeps existing backends working while adapters migrate to the
 * single-repo contract. Native {@link RepoStorage} handles will replace it as
 * backends move behind RepoPool.
 */
export function partitionStorage(driver: Storage, repoId: string): RepoStorage {
	return {
		getObject: (hash) => driver.getObject(repoId, hash),
		getObjects: driver.getObjects ? (hashes) => driver.getObjects!(repoId, hashes) : undefined,
		putObject: (hash, type, content) => driver.putObject(repoId, hash, type, content),
		putObjects: (objects) => driver.putObjects(repoId, objects),
		putDeltaObjects: (rows) => driver.putDeltaObjects(repoId, rows),
		hasObject: (hash) => driver.hasObject(repoId, hash),
		hasObjects: driver.hasObjects ? (hashes) => driver.hasObjects!(repoId, hashes) : undefined,
		findObjectsByPrefix: (prefix) => driver.findObjectsByPrefix(repoId, prefix),
		listObjectHashes: () => driver.listObjectHashes(repoId),
		repoByteSize: driver.repoByteSize ? () => driver.repoByteSize!(repoId) : undefined,
		deleteObjects: (hashes) => driver.deleteObjects(repoId, hashes),
		getRef: (name) => driver.getRef(repoId, name),
		putRef: (name, ref) => driver.putRef(repoId, name, ref),
		removeRef: (name) => driver.removeRef(repoId, name),
		listRefs: (prefix) => driver.listRefs(repoId, prefix),
		atomicRefUpdate: (fn) => driver.atomicRefUpdate(repoId, fn),
	};
}
