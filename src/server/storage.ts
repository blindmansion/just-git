import { ObjectCache } from "../lib/object-cache.ts";
import { envelope } from "../lib/object-store.ts";
import type { PackObject } from "../lib/pack/packfile.ts";
import { readPack } from "../lib/pack/packfile.ts";
import { sha1 } from "../lib/sha1.ts";
import { normalizeRef } from "../lib/types.ts";
import type {
	GitRepo,
	ObjectId,
	ObjectStore,
	ObjectType,
	RawObject,
	Ref,
	RefEntry,
	RefStore,
} from "../lib/types.ts";

// ── Public types ────────────────────────────────────────────────────

export type MaybeAsync<T> = T | Promise<T>;

/** Options for {@link Storage.createRepo}. */
export interface CreateRepoOptions {
	/** Name of the default branch (default: `"main"`). Used for HEAD initialization. */
	defaultBranch?: string;
}

/**
 * Abstract storage backend for multi-repo git object and ref storage.
 *
 * Repos must be explicitly created via `createRepo` before they can be
 * accessed with `repo`. This prevents accidental repo creation when
 * `storage.repo(path)` is passed directly as a server's `resolveRepo`.
 *
 * Use `createStorage(driver)` to build a `Storage` from a {@link StorageDriver}.
 */
export interface Storage {
	/**
	 * Create a new repo and initialize HEAD.
	 *
	 * Writes `HEAD → refs/heads/{defaultBranch}` so the repo is ready
	 * to accept its first push. Throws if the repo already exists.
	 */
	createRepo(repoId: string, options?: CreateRepoOptions): GitRepo | Promise<GitRepo>;

	/**
	 * Get a `GitRepo` scoped to a specific repo, or `null` if the repo
	 * has not been created via {@link createRepo}.
	 */
	repo(repoId: string): GitRepo | null | Promise<GitRepo | null>;

	/** Delete all objects, refs, and the repo record. */
	deleteRepo(repoId: string): void | Promise<void>;
}

// ── StorageDriver interface ─────────────────────────────────────────

/** Unresolved ref entry as stored by the driver. */
export interface RawRefEntry {
	name: string;
	ref: Ref;
}

/**
 * Ref operations available inside an {@link StorageDriver.atomicRefUpdate} callback.
 * The driver provides isolation; the shared adapter runs git-aware CAS logic inside.
 */
export interface RefOps {
	getRef(name: string): MaybeAsync<Ref | null>;
	putRef(name: string, ref: Ref): MaybeAsync<void>;
	removeRef(name: string): MaybeAsync<void>;
}

/**
 * Thin storage driver interface. Implementations provide raw key-value
 * CRUD for objects and refs, plus an atomic ref operation primitive.
 *
 * All git-aware logic (object hashing, pack ingestion, symref resolution,
 * CAS semantics) lives in the shared adapter built by {@link createStorage}.
 *
 * All methods may return synchronously or asynchronously.
 */
export interface StorageDriver {
	// ── Repo lifecycle ──────────────────────────────────────────────

	hasRepo(repoId: string): MaybeAsync<boolean>;
	insertRepo(repoId: string): MaybeAsync<void>;
	/** Delete the repo record and all associated objects and refs. */
	deleteRepo(repoId: string): MaybeAsync<void>;

	// ── Objects ─────────────────────────────────────────────────────

	getObject(repoId: string, hash: string): MaybeAsync<RawObject | null>;
	putObject(repoId: string, hash: string, type: string, content: Uint8Array): MaybeAsync<void>;
	/** Bulk insert. Drivers should use their optimal batch strategy. */
	putObjects(
		repoId: string,
		objects: ReadonlyArray<{ hash: string; type: string; content: Uint8Array }>,
	): MaybeAsync<void>;
	hasObject(repoId: string, hash: string): MaybeAsync<boolean>;
	findObjectsByPrefix(repoId: string, prefix: string): MaybeAsync<string[]>;

	// ── Refs ────────────────────────────────────────────────────────

	getRef(repoId: string, name: string): MaybeAsync<Ref | null>;
	putRef(repoId: string, name: string, ref: Ref): MaybeAsync<void>;
	removeRef(repoId: string, name: string): MaybeAsync<void>;
	/** Return all refs under a prefix, unresolved (symrefs not followed). */
	listRefs(repoId: string, prefix?: string): MaybeAsync<RawRefEntry[]>;

	/**
	 * Run ref operations atomically. The driver wraps the callback in
	 * whatever isolation mechanism it supports (transaction, lock, etc.).
	 * The shared adapter uses this for compare-and-swap with symref resolution.
	 */
	atomicRefUpdate<T>(repoId: string, fn: (ops: RefOps) => MaybeAsync<T>): MaybeAsync<T>;
}

// ── createStorage ───────────────────────────────────────────────────

/**
 * Build a {@link Storage} from a {@link StorageDriver}.
 *
 * The returned `Storage` handles all git-aware logic (object hashing,
 * pack ingestion, symref resolution, CAS) on top of the driver's raw I/O.
 */
export function createStorage(driver: StorageDriver): Storage {
	function buildRepo(repoId: string): GitRepo {
		return {
			objectStore: new AdaptedObjectStore(driver, repoId),
			refStore: new AdaptedRefStore(driver, repoId),
		};
	}

	return {
		async createRepo(repoId: string, options?: CreateRepoOptions): Promise<GitRepo> {
			const exists = await driver.hasRepo(repoId);
			if (exists) throw new Error(`repo '${repoId}' already exists`);
			const defaultBranch = options?.defaultBranch ?? "main";
			await driver.insertRepo(repoId);
			await driver.putRef(repoId, "HEAD", {
				type: "symbolic",
				target: `refs/heads/${defaultBranch}`,
			});
			return buildRepo(repoId);
		},

		async repo(repoId: string): Promise<GitRepo | null> {
			const exists = await driver.hasRepo(repoId);
			if (!exists) return null;
			return buildRepo(repoId);
		},

		async deleteRepo(repoId: string): Promise<void> {
			await driver.deleteRepo(repoId);
		},
	};
}

// ── AdaptedObjectStore (private) ────────────────────────────────────

class AdaptedObjectStore implements ObjectStore {
	private cache = new ObjectCache();

	constructor(
		private driver: StorageDriver,
		private repoId: string,
	) {}

	async write(type: ObjectType, content: Uint8Array): Promise<ObjectId> {
		const data = envelope(type, content);
		const hash = await sha1(data);
		await this.driver.putObject(this.repoId, hash, type, content);
		return hash;
	}

	async read(hash: ObjectId): Promise<RawObject> {
		const cached = this.cache.get(hash);
		if (cached) return cached;

		const obj = await this.driver.getObject(this.repoId, hash);
		if (!obj) throw new Error(`object ${hash} not found`);
		this.cache.set(hash, obj);
		return obj;
	}

	async exists(hash: ObjectId): Promise<boolean> {
		return !!(await this.driver.hasObject(this.repoId, hash));
	}

	async ingestPack(packData: Uint8Array): Promise<number> {
		if (packData.byteLength < 32) return 0;
		const view = new DataView(packData.buffer, packData.byteOffset, packData.byteLength);
		const numObjects = view.getUint32(8);
		if (numObjects === 0) return 0;

		const driver = this.driver;
		const repoId = this.repoId;

		const entries = await readPack(packData, async (hash) => {
			const obj = await driver.getObject(repoId, hash);
			if (!obj) return null;
			return { type: obj.type, content: new Uint8Array(obj.content) };
		});

		await driver.putObjects(
			repoId,
			entries.map((e) => ({ hash: e.hash, type: e.type, content: e.content })),
		);
		return entries.length;
	}

	async ingestPackStream(entries: AsyncIterable<PackObject>): Promise<number> {
		const batch: Array<{ hash: string; type: string; content: Uint8Array }> = [];
		for await (const entry of entries) {
			batch.push({ hash: entry.hash, type: entry.type, content: entry.content });
		}
		if (batch.length === 0) return 0;
		await this.driver.putObjects(this.repoId, batch);
		return batch.length;
	}

	async findByPrefix(prefix: string): Promise<ObjectId[]> {
		if (prefix.length < 4) return [];
		return Array.from(await this.driver.findObjectsByPrefix(this.repoId, prefix));
	}
}

// ── AdaptedRefStore (private) ───────────────────────────────────────

class AdaptedRefStore implements RefStore {
	constructor(
		private driver: StorageDriver,
		private repoId: string,
	) {}

	async readRef(name: string): Promise<Ref | null> {
		return (await this.driver.getRef(this.repoId, name)) ?? null;
	}

	async writeRef(name: string, refOrHash: Ref | string): Promise<void> {
		await this.driver.putRef(this.repoId, name, normalizeRef(refOrHash));
	}

	async deleteRef(name: string): Promise<void> {
		await this.driver.removeRef(this.repoId, name);
	}

	async listRefs(prefix?: string): Promise<RefEntry[]> {
		const raw = await this.driver.listRefs(this.repoId, prefix);
		const results: RefEntry[] = [];
		for (const entry of raw) {
			if (entry.ref.type === "direct") {
				results.push({ name: entry.name, hash: entry.ref.hash });
			} else if (entry.ref.type === "symbolic") {
				const resolved = await resolveRefChain(
					(n) => this.driver.getRef(this.repoId, n),
					entry.ref.target,
				);
				if (resolved) results.push({ name: entry.name, hash: resolved });
			}
		}
		return results;
	}

	async compareAndSwapRef(
		name: string,
		expectedOldHash: string | null,
		newRef: Ref | null,
	): Promise<boolean> {
		return !!(await this.driver.atomicRefUpdate(this.repoId, (ops) => {
			return chain(ops.getRef(name), (current) => {
				const hashResult: MaybeAsync<string | null> = !current
					? null
					: current.type === "direct"
						? current.hash
						: resolveRefChain((n) => ops.getRef(n), current.target);

				return chain(hashResult, (currentHash) => {
					if (expectedOldHash === null) {
						if (current !== null) return false;
					} else {
						if (currentHash !== expectedOldHash) return false;
					}

					if (newRef === null) {
						return chain(ops.removeRef(name), () => true as boolean);
					}
					return chain(ops.putRef(name, newRef), () => true as boolean);
				});
			});
		}));
	}
}

// ── Shared helpers ──────────────────────────────────────────────────

function chain<A, B>(value: MaybeAsync<A>, fn: (a: A) => MaybeAsync<B>): MaybeAsync<B> {
	if (value instanceof Promise) return value.then(fn);
	return fn(value);
}

function resolveRefChain(
	readRef: (name: string) => MaybeAsync<Ref | null>,
	target: string,
	depth = 0,
): MaybeAsync<string | null> {
	if (depth > 10) return null;
	return chain(readRef(target), (ref) => {
		if (!ref) return null;
		if (ref.type === "direct") return ref.hash;
		if (ref.type === "symbolic") {
			return resolveRefChain(readRef, ref.target, depth + 1);
		}
		return null;
	});
}
