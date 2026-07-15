import type { Ref } from "../lib/types.ts";
import type {
	DeltaObjectRow,
	MaybeAsync,
	RawRefEntry,
	RefOps,
	StoredObject,
} from "./repo-store.ts";

/**
 * Raw object and ref persistence for a single repository.
 *
 * Lifecycle, fork metadata, and repo IDs belong to the pool that owns the
 * handle.
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
