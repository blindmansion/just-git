import { ObjectCache } from "../lib/object-cache.ts";
import { envelope } from "../lib/object-store.ts";
import type { PackObject } from "../lib/pack/packfile.ts";
import { applyDelta, readPack } from "../lib/pack/packfile.ts";
import { inflate } from "../lib/pack/zlib.ts";
import { sha1 } from "../lib/sha1.ts";
import { normalizeRef } from "../lib/types.ts";
import { MemoryStorage } from "./memory-storage.ts";
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

/**
 * How an object row's `content` bytes are encoded at rest.
 *
 * - `raw` — the raw git object body (no header/envelope, no compression).
 *   This is the default for the ingest hot path (`putObject`/`putObjects`).
 * - `raw-zlib` — the raw body, zlib-compressed (RFC 1950). Produced by
 *   compaction when a delta base wasn't worthwhile but compression was.
 * - `delta` — a binary delta (git delta format, as produced by `createDelta`
 *   and consumed by `applyDelta`) against {@link StoredObject.baseHash}.
 * - `delta-zlib` — a delta, zlib-compressed. The common compaction output.
 *
 * The object's content hash is **always** of the reconstructed raw body
 * (`sha1(envelope(type, rawBody))`), never of the stored bytes — so
 * addressing and integrity are independent of the encoding.
 */
export type ObjectEncoding = "raw" | "raw-zlib" | "delta" | "delta-zlib";

/**
 * The stored representation of a git object as returned by a backend's
 * {@link Storage.getObject} / {@link Storage.getObjects}.
 *
 * Backends persist objects verbatim and report how the `content` bytes are
 * encoded; the adapter (`createRepoStore`) reconstructs the raw object body
 * (inflating zlib, applying deltas against `baseHash`). Backends never need
 * to understand the encoding beyond storing and returning these fields.
 */
export interface StoredObject {
	/** The object's real git type (of the reconstructed raw body). */
	type: ObjectType;
	/** How `content` is encoded. */
	encoding: ObjectEncoding;
	/**
	 * For `delta`/`delta-zlib`, the hash of the base object this deltas
	 * against. Omitted (or null) for `raw`/`raw-zlib`.
	 */
	baseHash?: string | null;
	/** The stored bytes (raw body, zlib body, delta, or zlib'd delta). */
	content: Uint8Array;
}

/**
 * A row written by {@link Storage.putDeltaObjects} during compaction.
 *
 * A row is either a self-contained object (`raw`/`raw-zlib`) or a delta
 * (`delta`/`delta-zlib`) that names its `baseHash`. The hash is always of
 * the reconstructed raw body.
 */
export type DeltaObjectRow =
	| { hash: string; type: string; encoding: "raw" | "raw-zlib"; content: Uint8Array }
	| {
			hash: string;
			type: string;
			encoding: "delta" | "delta-zlib";
			baseHash: string;
			content: Uint8Array;
	  };

/** Options for creating a new repo via `GitServer.createRepo`. */
export interface CreateRepoOptions {
	/** Default branch name for the initial `HEAD -> refs/heads/<branch>` symref. */
	defaultBranch?: string;
}

/**
 * Abstract storage backend for multi-repo git object and ref storage.
 *
 * Repos must be explicitly created via {@link RepoStore.createRepo}
 * before they can be accessed with {@link RepoStore.repo}. This keeps
 * repo creation explicit and avoids accidental creation when a resolved path
 * is passed through server code.
 *
 * Construct a `RepoStore` with {@link createRepoStore}. The adapter
 * adds all git-aware behavior on top of a raw {@link Storage} backend.
 */
export interface RepoStore {
	/**
	 * Create a new repo and initialize HEAD.
	 *
	 * Writes `HEAD -> refs/heads/<defaultBranch>` so the repo is ready to
	 * accept its first push. Throws if the repo already exists.
	 */
	createRepo(repoId: string, options?: CreateRepoOptions): GitRepo | Promise<GitRepo>;

	/**
	 * Get a `GitRepo` scoped to a specific repo, or `null` if the repo
	 * has not been created via {@link createRepo}.
	 */
	repo(repoId: string): GitRepo | null | Promise<GitRepo | null>;

	/** Delete the repo record plus all repo-local objects and refs. */
	deleteRepo(repoId: string): void | Promise<void>;

	/**
	 * Fork an existing repo. Copies refs from source to target.
	 * The forked repo's object reads fall through to the root repo's
	 * object partition when not found locally.
	 *
	 * Throws when the underlying storage backend does not implement the
	 * optional fork methods.
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
 * Optional batch helpers (`getObjects`, `hasObjects`) let the adapter reduce
 * round trips during object walks and pack generation, but are not required.
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
	 * Read a git object by hash.
	 * Returns `null` when the object does not exist.
	 *
	 * Returns the **stored representation** ({@link StoredObject}): `type`,
	 * the on-disk `content` bytes, and how they are `encoding`-ed (plus
	 * `baseHash` for deltas). The adapter reconstructs the raw object body.
	 * For the ingest hot path (objects written via `putObject`/`putObjects`)
	 * this is always `{ encoding: "raw" }`, i.e. `content` is the raw body.
	 */
	getObject(repoId: string, hash: string): MaybeAsync<StoredObject | null>;

	/**
	 * Batch-read git objects by hash.
	 * Returns only objects that exist for `repoId`, keyed by full hash, in
	 * their {@link StoredObject} stored representation (see {@link getObject}).
	 * Missing hashes must simply be omitted from the returned map.
	 * Backends should keep the singleton case cheap as well — callers may
	 * sometimes probe one hash at a time, so avoid batch-only overhead such as
	 * per-call query preparation or heavy intermediate allocation.
	 */
	getObjects?(repoId: string, hashes: ReadonlyArray<string>): MaybeAsync<Map<string, StoredObject>>;

	/**
	 * Store a single git object.
	 *
	 * `content` is the raw object body (no git header / envelope). The row is
	 * persisted with `encoding = "raw"`. Because git objects are immutable,
	 * duplicate writes may be ignored.
	 */
	putObject(repoId: string, hash: string, type: string, content: Uint8Array): MaybeAsync<void>;

	/**
	 * Bulk-insert objects. Called during pack ingestion (push, fetch).
	 * Implementations should use their optimal batch strategy (e.g. a
	 * single transaction for SQL backends).
	 *
	 * Returns the hashes newly inserted for `repoId`. Existing rows must not
	 * be reported, even if the same object appears in the incoming batch.
	 * The adapter uses this return value for rejected-push rollback, so it
	 * must reflect only rows created by this call in this repo partition.
	 */
	putObjects(
		repoId: string,
		objects: ReadonlyArray<{ hash: string; type: string; content: Uint8Array }>,
	): MaybeAsync<string[]>;

	/**
	 * Rewrite objects in their compacted ({@link DeltaObjectRow}) form.
	 *
	 * Called by the compaction pass (`repackRepo` / `gcRepo({ compact })`) to
	 * replace existing raw rows with delta/zlib-encoded ones. Unlike
	 * `putObjects` (insert-or-ignore on the ingest path), this **replaces** any
	 * existing row for the same hash — the reconstructed body is identical, so
	 * the hash is unchanged; only the stored encoding differs.
	 *
	 * Implementations must apply the whole batch atomically (a single
	 * transaction), so a `delta` row is never observable before its `baseHash`
	 * row is present. The compaction pass guarantees every `baseHash` lives in
	 * the same repo partition as the delta that references it.
	 */
	putDeltaObjects(repoId: string, rows: ReadonlyArray<DeltaObjectRow>): MaybeAsync<void>;

	/** Check whether an object exists without reading its content. */
	hasObject(repoId: string, hash: string): MaybeAsync<boolean>;

	/**
	 * Batch existence check for objects.
	 * Returns the subset of `hashes` that exist for `repoId`.
	 * Missing hashes must simply be omitted from the returned set.
	 * As with `getObjects`, implementations should preserve a fast path for
	 * single-hash probes and prefer reusable query plans / statement caches when
	 * the backend benefits from them.
	 */
	hasObjects?(repoId: string, hashes: ReadonlyArray<string>): MaybeAsync<Set<string>>;

	/**
	 * Find all object hashes starting with `prefix` (for short-hash resolution).
	 * `prefix` is at least 4 hex characters.
	 */
	findObjectsByPrefix(repoId: string, prefix: string): MaybeAsync<string[]>;

	/** Return all object hashes stored for a repo. */
	listObjectHashes(repoId: string): MaybeAsync<string[]>;

	/**
	 * Approximate on-disk size, in bytes, of a repo's object partition.
	 *
	 * Used by consumers to drive disk-pressure-based maintenance (e.g. run
	 * `repackRepo` once a repo crosses a threshold). The value is a cheap
	 * estimate — the sum of stored `content` lengths is a reasonable choice;
	 * backends need not account for index/page overhead. Optional: consumers
	 * fall back to `listObjectHashes(repoId).length` as a coarser signal.
	 */
	repoByteSize?(repoId: string): MaybeAsync<number>;

	/**
	 * Delete specific objects by hash.
	 * Returns the number of objects actually deleted from this repo's own
	 * object partition. Fork-aware backends must not treat this as a request
	 * to delete from a parent/shared object partition.
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
	 * The adapter uses this for compare-and-swap with symref resolution and
	 * expects all reads/writes inside `fn` to observe the same transaction or
	 * lock scope.
	 */
	atomicRefUpdate<T>(repoId: string, fn: (ops: RefOps) => MaybeAsync<T>): MaybeAsync<T>;

	// ── Forks (optional) ───────────────────────────────────────────

	/**
	 * Record a fork relationship. `targetId` becomes a fork of `sourceId`.
	 * The adapter layer handles ref copying and root resolution; this method
	 * only needs to persist the parent relationship.
	 */
	forkRepo?(sourceId: string, targetId: string): MaybeAsync<void>;

	/**
	 * Get the root parent repo ID for a fork, or `null` if the repo is not
	 * a fork.
	 */
	getForkParent?(repoId: string): MaybeAsync<string | null>;

	/**
	 * List all direct fork IDs of a repo. Used to block deletion of a root
	 * repo while active forks still exist.
	 */
	listForks?(repoId: string): MaybeAsync<string[]>;
}

// ── createRepoStore ───────────────────────────────────────────────────

/**
 * Build a {@link RepoStore} from a {@link Storage} backend.
 *
 * The returned adapter handles all git-aware logic (object hashing,
 * pack ingestion, batch object lookup fallback, symref resolution, and CAS
 * on top of the backend's raw I/O.
 *
 * Defaults to {@link MemoryStorage} when no driver is supplied, mirroring
 * `createServer`. In-memory data is lost when the process exits — pass an
 * explicit backend for persistence.
 */
export function createRepoStore(driver: Storage = new MemoryStorage()): RepoStore {
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
 * evaluation, then roll back newly inserted objects if a hook rejects the
 * push before any refs apply.
 */
export interface DeferrableObjectStore {
	/** Parse a buffered packfile into a batch ready for storage. */
	preparePack(packData: Uint8Array): Promise<PendingObjectBatch>;
	/** Parse a streamed packfile into a batch ready for storage. */
	preparePackStream(entries: AsyncIterable<PackObject>): Promise<PendingObjectBatch>;
	/** Commit a prepared batch and return only the hashes newly inserted. */
	commitPack(
		batch: ReadonlyArray<{ hash: string; type: string; content: Uint8Array }>,
	): Promise<string[]>;
	/** Delete repo-local objects by hash and return the number removed. */
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

/**
 * Hard cap on delta-base recursion depth when reading. Compaction bounds
 * real chains by its `depth` option (default 50); this much larger limit
 * only exists to fail fast on cyclic/corrupt stored data.
 */
const MAX_DELTA_CHAIN = 1000;

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
		return this.readDecoded(hash, 0);
	}

	/**
	 * Read and reconstruct a single object, resolving zlib/delta encodings.
	 * `depth` bounds delta-base recursion to guard against cyclic/corrupt data.
	 */
	private async readDecoded(hash: ObjectId, depth: number): Promise<RawObject> {
		const cached = this.cache.get(hash);
		if (cached) return cached;

		const stored = await this.fetchStored(hash);
		if (!stored) throw new Error(`object ${hash} not found`);
		const raw = await this.decode(stored, depth);
		this.cache.set(hash, raw);
		return raw;
	}

	/** Fetch a stored row from the own partition, falling through to parent. */
	private async fetchStored(hash: ObjectId): Promise<StoredObject | null> {
		let obj = await this.driver.getObject(this.repoId, hash);
		if (!obj && this.parentId) {
			obj = await this.driver.getObject(this.parentId, hash);
		}
		return obj;
	}

	/** Reconstruct the raw object body from its stored representation. */
	private async decode(stored: StoredObject, depth: number): Promise<RawObject> {
		switch (stored.encoding) {
			case "raw":
				return { type: stored.type, content: stored.content };
			case "raw-zlib":
				return { type: stored.type, content: await inflate(stored.content) };
			case "delta":
			case "delta-zlib": {
				if (depth > MAX_DELTA_CHAIN) {
					throw new Error("delta chain too deep (possible cycle in stored objects)");
				}
				if (!stored.baseHash) {
					throw new Error("delta object missing base hash");
				}
				const deltaBytes =
					stored.encoding === "delta-zlib" ? await inflate(stored.content) : stored.content;
				const base = await this.readDecoded(stored.baseHash, depth + 1);
				return { type: stored.type, content: applyDelta(base.content, deltaBytes) };
			}
		}
	}

	async readMany(hashes: ReadonlyArray<ObjectId>): Promise<Map<ObjectId, RawObject>> {
		const uniqueHashes = dedupeHashes(hashes);
		const result = new Map<ObjectId, RawObject>();
		const missingOwn: ObjectId[] = [];

		for (const hash of uniqueHashes) {
			const cached = this.cache.get(hash);
			if (cached) {
				result.set(hash, cached);
			} else {
				missingOwn.push(hash);
			}
		}

		if (missingOwn.length > 0) {
			const ownStored = await this.loadStored(this.repoId, missingOwn);
			await this.decodeInto(ownStored, result);
		}

		if (this.parentId) {
			const missingParent = missingOwn.filter((hash) => !result.has(hash));
			if (missingParent.length > 0) {
				const parentStored = await this.loadStored(this.parentId, missingParent);
				await this.decodeInto(parentStored, result);
			}
		}

		return result;
	}

	/** Decode a batch of stored rows into raw objects, populating the cache. */
	private async decodeInto(
		stored: Map<ObjectId, StoredObject>,
		out: Map<ObjectId, RawObject>,
	): Promise<void> {
		for (const [hash, row] of stored) {
			if (out.has(hash)) continue;
			const raw = await this.decode(row, 0);
			this.cache.set(hash, raw);
			out.set(hash, raw);
		}
	}

	async exists(hash: ObjectId): Promise<boolean> {
		if (await this.driver.hasObject(this.repoId, hash)) return true;
		if (this.parentId) return !!(await this.driver.hasObject(this.parentId, hash));
		return false;
	}

	async existsMany(hashes: ReadonlyArray<ObjectId>): Promise<Set<ObjectId>> {
		const uniqueHashes = dedupeHashes(hashes);
		const present = new Set<ObjectId>();
		const missingOwn: ObjectId[] = [];

		for (const hash of uniqueHashes) {
			if (this.cache.get(hash)) {
				present.add(hash);
			} else {
				missingOwn.push(hash);
			}
		}

		if (missingOwn.length > 0) {
			const ownSet = await this.checkObjects(this.repoId, missingOwn);
			for (const hash of ownSet) present.add(hash);
		}

		if (this.parentId) {
			const missingParent = missingOwn.filter((hash) => !present.has(hash));
			if (missingParent.length > 0) {
				const parentSet = await this.checkObjects(this.parentId, missingParent);
				for (const hash of parentSet) present.add(hash);
			}
		}

		return present;
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

		const entries = await readPack(packData, async (hash) => {
			try {
				const raw = await this.readDecoded(hash, 0);
				return { type: raw.type, content: new Uint8Array(raw.content) };
			} catch {
				return null;
			}
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
	): Promise<string[]> {
		if (batch.length === 0) return [];
		return await this.driver.putObjects(this.repoId, batch);
	}

	async ingestPack(packData: Uint8Array): Promise<number> {
		const batch = await this.preparePack(packData);
		const inserted = await this.commitPack(batch);
		return inserted.length;
	}

	async ingestPackStream(entries: AsyncIterable<PackObject>): Promise<number> {
		const batch = await this.preparePackStream(entries);
		const inserted = await this.commitPack(batch);
		return inserted.length;
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

	private async loadStored(
		repoId: string,
		hashes: ReadonlyArray<ObjectId>,
	): Promise<Map<ObjectId, StoredObject>> {
		if (hashes.length === 0) return new Map();
		if (this.driver.getObjects) {
			return await this.driver.getObjects(repoId, hashes);
		}

		const result = new Map<ObjectId, StoredObject>();
		for (const hash of hashes) {
			const obj = await this.driver.getObject(repoId, hash);
			if (obj) result.set(hash, obj);
		}
		return result;
	}

	private async checkObjects(
		repoId: string,
		hashes: ReadonlyArray<ObjectId>,
	): Promise<Set<ObjectId>> {
		if (hashes.length === 0) return new Set();
		if (this.driver.hasObjects) {
			const rows = await this.driver.hasObjects(repoId, hashes);
			return new Set(rows as Set<ObjectId>);
		}

		const result = new Set<ObjectId>();
		for (const hash of hashes) {
			if (await this.driver.hasObject(repoId, hash)) result.add(hash);
		}
		return result;
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

function dedupeHashes<T extends string>(hashes: ReadonlyArray<T>): T[] {
	return Array.from(new Set(hashes));
}
