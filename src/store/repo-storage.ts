import type { Ref } from "../lib/types.ts";
import { rawRefsEqual } from "../lib/refs/equality.ts";
import type {
	DeltaObjectRow,
	MaybeAsync,
	RawRefEntry,
	StoredObject,
} from "./repo-store.ts";

/**
 * Apply raw single-ref CAS using operations that are already isolated by the
 * caller. This helper provides comparison and mutation semantics, not locking.
 */
export function compareAndSwapRawRef(
	read: () => Ref | null,
	write: (ref: Ref) => void,
	remove: () => void,
	expectedOld: Ref | null,
	newRef: Ref | null,
): boolean;
export function compareAndSwapRawRef(
	read: () => MaybeAsync<Ref | null>,
	write: (ref: Ref) => MaybeAsync<void>,
	remove: () => MaybeAsync<void>,
	expectedOld: Ref | null,
	newRef: Ref | null,
): MaybeAsync<boolean>;
export function compareAndSwapRawRef(
	read: () => MaybeAsync<Ref | null>,
	write: (ref: Ref) => MaybeAsync<void>,
	remove: () => MaybeAsync<void>,
	expectedOld: Ref | null,
	newRef: Ref | null,
): MaybeAsync<boolean> {
	return chain(read(), (current) => {
		if (!rawRefsEqual(current, expectedOld)) return false;
		if (newRef === null) {
			return chain(remove(), () => true);
		}
		return chain(write(newRef), () => true);
	});
}

function chain<A, B>(value: MaybeAsync<A>, next: (result: A) => MaybeAsync<B>): MaybeAsync<B> {
	return value instanceof Promise ? value.then(next) : next(value);
}

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
	/**
	 * Atomically replace the raw value of `name` when it exactly matches
	 * `expectedOld`. Symbolic refs are compared by target, without resolution.
	 */
	compareAndSwapRef(
		name: string,
		expectedOld: Ref | null,
		newRef: Ref | null,
	): MaybeAsync<boolean>;
}
