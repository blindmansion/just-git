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

/**
 * A value that may be synchronous or asynchronous.
 *
 * Storage methods use this return type so that sync backends (e.g. SQLite)
 * can avoid unnecessary `async`/`await` overhead while async backends
 * (e.g. PostgreSQL) return promises naturally.
 */
export type MaybeAsync<T> = T | Promise<T>;

/** Options for creating a new repo via `GitServer.createRepo`. */
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
 * Use `createStorageAdapter(driver)` to build a `StorageAdapter` from a {@link Storage}.
 */
export interface StorageAdapter {
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

	/**
	 * Fork an existing repo. Copies refs from source to target.
	 * The forked repo's object reads fall through to the root's
	 * object partition when not found locally.
	 *
	 * Only available when the storage backend implements fork methods.
	 */
	forkRepo(sourceId: string, targetId: string, options?: CreateRepoOptions): Promise<GitRepo>;
}

// ── Storage interface ─────────────────────────────────────────

/**
 * A ref entry as stored by the storage backend, without symref resolution.
 *
 * Symbolic refs (like HEAD → refs/heads/main) are returned as-is — the
 * adapter layer handles resolution. Storage backends should store and
 * return the exact {@link Ref} value that was written via `putRef`.
 */
export interface RawRefEntry {
	/** Full ref name, e.g. `"HEAD"` or `"refs/heads/main"`. */
	name: string;
	/** The ref value — either a direct hash or a symbolic pointer. */
	ref: Ref;
}

/**
 * Ref operations available inside a {@link Storage.atomicRefUpdate} callback.
 *
 * The storage backend wraps the callback in a transaction (or lock), and the
 * adapter layer uses these operations to implement compare-and-swap with
 * symref resolution. Implementations should route these to the same
 * underlying store as the top-level ref methods, but within the
 * transaction/lock scope.
 */
export interface RefOps {
	/** Read a single ref within the transaction. */
	getRef(name: string): MaybeAsync<Ref | null>;
	/** Write a ref within the transaction. */
	putRef(name: string, ref: Ref): MaybeAsync<void>;
	/** Delete a ref within the transaction. */
	removeRef(name: string): MaybeAsync<void>;
}

/**
 * Storage backend interface for multi-repo git object and ref persistence.
 *
 * Implementations provide raw key-value CRUD for objects and refs, plus an
 * atomic ref operation primitive. All git-aware logic — object hashing,
 * pack ingestion, symref resolution, compare-and-swap semantics — lives
 * in the internal adapter and does not need to be implemented by backends.
 *
 * All methods use {@link MaybeAsync} return types: sync backends (SQLite)
 * can return values directly, async backends (PostgreSQL) return promises.
 *
 * See `MemoryStorage` for a minimal reference implementation.
 */
export interface Storage {
	// ── Repo lifecycle ──────────────────────────────────────────────

	/** Check whether a repo with this ID has been created. */
	hasRepo(repoId: string): MaybeAsync<boolean>;

	/** Register a new repo ID. Does not need to create any initial data. */
	insertRepo(repoId: string): MaybeAsync<void>;

	/** Delete the repo record and all associated objects and refs. */
	deleteRepo(repoId: string): MaybeAsync<void>;

	// ── Objects ─────────────────────────────────────────────────────

	/**
	 * Read a raw git object by hash.
	 * Returns `null` when the object does not exist.
	 */
	getObject(repoId: string, hash: string): MaybeAsync<RawObject | null>;

	/** Store a single git object. `content` is the uncompressed object body (no git header). */
	putObject(repoId: string, hash: string, type: string, content: Uint8Array): MaybeAsync<void>;

	/**
	 * Bulk-insert objects. Called during pack ingestion (push, fetch).
	 * Implementations should use their optimal batch strategy (e.g. a
	 * single transaction for SQL backends).
	 */
	putObjects(
		repoId: string,
		objects: ReadonlyArray<{ hash: string; type: string; content: Uint8Array }>,
	): MaybeAsync<void>;

	/** Check whether an object exists without reading its content. */
	hasObject(repoId: string, hash: string): MaybeAsync<boolean>;

	/**
	 * Find all object hashes starting with `prefix` (for short-hash resolution).
	 * `prefix` is at least 4 hex characters.
	 */
	findObjectsByPrefix(repoId: string, prefix: string): MaybeAsync<string[]>;

	/** Return all object hashes stored for a repo. */
	listObjectHashes(repoId: string): MaybeAsync<string[]>;

	/**
	 * Delete specific objects by hash.
	 * Returns the number of objects actually deleted.
	 */
	deleteObjects(repoId: string, hashes: ReadonlyArray<string>): MaybeAsync<number>;

	// ── Refs ────────────────────────────────────────────────────────

	/**
	 * Read a single ref. Returns the stored {@link Ref} value (direct hash
	 * or symbolic pointer) without following symrefs — the adapter handles
	 * resolution.
	 */
	getRef(repoId: string, name: string): MaybeAsync<Ref | null>;

	/** Write a ref (direct or symbolic). */
	putRef(repoId: string, name: string, ref: Ref): MaybeAsync<void>;

	/** Delete a ref. */
	removeRef(repoId: string, name: string): MaybeAsync<void>;

	/**
	 * List all refs, optionally filtered by a prefix (e.g. `"refs/heads/"`).
	 * Returns unresolved entries — symrefs are not followed.
	 */
	listRefs(repoId: string, prefix?: string): MaybeAsync<RawRefEntry[]>;

	/**
	 * Run ref operations atomically.
	 *
	 * The storage backend wraps the callback in whatever isolation
	 * mechanism it supports (SQL transaction, in-memory lock, etc.).
	 * The adapter uses this for compare-and-swap with symref resolution.
	 */
	atomicRefUpdate<T>(repoId: string, fn: (ops: RefOps) => MaybeAsync<T>): MaybeAsync<T>;

	// ── Forks (optional) ───────────────────────────────────────────

	/**
	 * Record a fork relationship. `targetId` becomes a fork of `sourceId`.
	 * The adapter layer handles ref copying and root resolution.
	 */
	forkRepo?(sourceId: string, targetId: string): MaybeAsync<void>;

	/**
	 * Get the parent (root) repo ID for a fork, or `null` if the repo
	 * is not a fork.
	 */
	getForkParent?(repoId: string): MaybeAsync<string | null>;

	/**
	 * List all direct fork IDs of a repo.
	 */
	listForks?(repoId: string): MaybeAsync<string[]>;
}

// ── createStorageAdapter ───────────────────────────────────────────────────

/**
 * Build a {@link StorageAdapter} from a {@link Storage} backend.
 *
 * The returned adapter handles all git-aware logic (object hashing,
 * pack ingestion, symref resolution, CAS) on top of the backend's raw I/O.
 */
export function createStorageAdapter(driver: Storage): StorageAdapter {
	async function buildRepo(repoId: string): Promise<GitRepo> {
		const parentId = driver.getForkParent ? await driver.getForkParent(repoId) : null;
		return {
			objectStore: new AdaptedObjectStore(driver, repoId, parentId),
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
			if (driver.listForks) {
				const forks = await driver.listForks(repoId);
				if (forks.length > 0) {
					throw new Error(`cannot delete repo '${repoId}': has ${forks.length} active fork(s)`);
				}
			}
			await driver.deleteRepo(repoId);
		},

		async forkRepo(
			sourceId: string,
			targetId: string,
			options?: CreateRepoOptions,
		): Promise<GitRepo> {
			if (!driver.forkRepo || !driver.getForkParent || !driver.listForks) {
				throw new Error("storage backend does not support forks");
			}

			const sourceExists = await driver.hasRepo(sourceId);
			if (!sourceExists) throw new Error(`source repo '${sourceId}' not found`);
			const targetExists = await driver.hasRepo(targetId);
			if (targetExists) throw new Error(`repo '${targetId}' already exists`);

			// Resolve to root: if source is itself a fork, fork from its root
			const sourceParent = await driver.getForkParent(sourceId);
			const rootId = sourceParent ?? sourceId;

			await driver.insertRepo(targetId);
			await driver.forkRepo(rootId, targetId);

			// Copy all refs from source to target
			const refs = await driver.listRefs(sourceId);
			for (const entry of refs) {
				await driver.putRef(targetId, entry.name, entry.ref);
			}

			// Copy HEAD
			const head = await driver.getRef(sourceId, "HEAD");
			if (head) {
				await driver.putRef(targetId, "HEAD", head);
			} else {
				const defaultBranch = options?.defaultBranch ?? "main";
				await driver.putRef(targetId, "HEAD", {
					type: "symbolic",
					target: `refs/heads/${defaultBranch}`,
				});
			}

			return buildRepo(targetId);
		},
	};
}

// ── Deferred ingestion interface ────────────────────────────────────

/** Batch of parsed objects awaiting storage commit. */
export type PendingObjectBatch = Array<{ hash: string; type: string; content: Uint8Array }>;

/**
 * Extended object store that supports two-phase pack ingestion
 * (prepare → commit) and rollback via `deleteObjects`.
 *
 * The server push path uses this to ingest objects before hook
 * evaluation, then roll back if a hook rejects the push.
 */
export interface DeferrableObjectStore {
	preparePack(packData: Uint8Array): Promise<PendingObjectBatch>;
	preparePackStream(entries: AsyncIterable<PackObject>): Promise<PendingObjectBatch>;
	commitPack(
		batch: ReadonlyArray<{ hash: string; type: string; content: Uint8Array }>,
	): Promise<number>;
	deleteObjects(hashes: ReadonlyArray<string>): Promise<number>;
}

/** Type guard for object stores that support two-phase ingestion + rollback. */
export function isDeferrableObjectStore(store: unknown): store is DeferrableObjectStore {
	return (
		typeof store === "object" &&
		store !== null &&
		typeof (store as any).preparePack === "function" &&
		typeof (store as any).commitPack === "function" &&
		typeof (store as any).deleteObjects === "function"
	);
}

// ── AdaptedObjectStore (private) ────────────────────────────────────

class AdaptedObjectStore implements ObjectStore, DeferrableObjectStore {
	private cache = new ObjectCache();

	constructor(
		private driver: Storage,
		private repoId: string,
		private parentId: string | null = null,
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

		let obj = await this.driver.getObject(this.repoId, hash);
		if (!obj && this.parentId) {
			obj = await this.driver.getObject(this.parentId, hash);
		}
		if (!obj) throw new Error(`object ${hash} not found`);
		this.cache.set(hash, obj);
		return obj;
	}

	async exists(hash: ObjectId): Promise<boolean> {
		if (await this.driver.hasObject(this.repoId, hash)) return true;
		if (this.parentId) return !!(await this.driver.hasObject(this.parentId, hash));
		return false;
	}

	async preparePack(
		packData: Uint8Array,
	): Promise<Array<{ hash: string; type: string; content: Uint8Array }>> {
		if (packData.byteLength < 32) return [];
		const view = new DataView(packData.buffer, packData.byteOffset, packData.byteLength);

		const sig = view.getUint32(0);
		if (sig !== 0x5041434b) {
			throw new Error(`invalid pack signature: 0x${sig.toString(16)} (expected 0x5041434b)`);
		}
		const version = view.getUint32(4);
		if (version !== 2) {
			throw new Error(`unsupported pack version: ${version}`);
		}

		const numObjects = view.getUint32(8);
		if (numObjects === 0) return [];

		const driver = this.driver;
		const repoId = this.repoId;
		const parentId = this.parentId;

		const entries = await readPack(packData, async (hash) => {
			let obj = await driver.getObject(repoId, hash);
			if (!obj && parentId) obj = await driver.getObject(parentId, hash);
			if (!obj) return null;
			return { type: obj.type, content: new Uint8Array(obj.content) };
		});

		return entries.map((e) => ({ hash: e.hash, type: e.type, content: e.content }));
	}

	async preparePackStream(
		entries: AsyncIterable<PackObject>,
	): Promise<Array<{ hash: string; type: string; content: Uint8Array }>> {
		const batch: Array<{ hash: string; type: string; content: Uint8Array }> = [];
		for await (const entry of entries) {
			batch.push({ hash: entry.hash, type: entry.type, content: entry.content });
		}
		return batch;
	}

	async commitPack(
		batch: ReadonlyArray<{ hash: string; type: string; content: Uint8Array }>,
	): Promise<number> {
		if (batch.length === 0) return 0;
		await this.driver.putObjects(this.repoId, batch);
		return batch.length;
	}

	async ingestPack(packData: Uint8Array): Promise<number> {
		const batch = await this.preparePack(packData);
		return this.commitPack(batch);
	}

	async ingestPackStream(entries: AsyncIterable<PackObject>): Promise<number> {
		const batch = await this.preparePackStream(entries);
		return this.commitPack(batch);
	}

	async deleteObjects(hashes: ReadonlyArray<string>): Promise<number> {
		if (hashes.length === 0) return 0;
		return this.driver.deleteObjects(this.repoId, hashes);
	}

	async findByPrefix(prefix: string): Promise<ObjectId[]> {
		if (prefix.length < 4) return [];
		const own = await this.driver.findObjectsByPrefix(this.repoId, prefix);
		if (!this.parentId) return Array.from(own);
		const parent = await this.driver.findObjectsByPrefix(this.parentId, prefix);
		const set = new Set(own);
		for (const h of parent) set.add(h);
		return Array.from(set);
	}
}

// ── AdaptedRefStore (private) ───────────────────────────────────────

class AdaptedRefStore implements RefStore {
	constructor(
		private driver: Storage,
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
