import { mergeCapabilities, withCapabilities } from "../lib/capabilities.ts";
import { ObjectCache } from "../lib/object-cache.ts";
import { envelope } from "../lib/object-store.ts";
import type { PackObject } from "../lib/pack/packfile.ts";
import { applyDelta, readPack } from "../lib/pack/packfile.ts";
import { inflate } from "../lib/pack/zlib.ts";
import { sha1 } from "../lib/sha1.ts";
import { normalizeRef } from "../lib/types.ts";
import { gcRepo } from "./gc.ts";
import type { GcOptions, GcResult } from "./gc.ts";
import { createMemoryRepoStorage, MemoryStorage } from "./memory-storage.ts";
import type { RepoPool } from "./repo-pool.ts";
import type { RepoStorage } from "./repo-storage.ts";
import type {
	GitRepo,
	ObjectId,
	ObjectStore,
	ObjectType,
	RawObject,
	Ref,
	RefEntry,
	RefStore,
	RepoCapabilities,
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
 * {@link RepoStorage.getObject} / {@link RepoStorage.getObjects}.
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
 * A row written by {@link RepoStorage.putDeltaObjects} during compaction.
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

/**
 * A `git_objects` row as read back from a SQL backend, in the table's
 * `snake_case` column shape. Every SQL backend shares the same schema, so they
 * share this row type and map it to {@link StoredObject} on read.
 */
export type ObjectRow = {
	hash?: string;
	type: string;
	content: Uint8Array;
	encoding: string;
	base_hash: string | null;
};

/**
 * A `git_refs` row as read back from a SQL backend, in the table's
 * `snake_case`/column shape. Mapped to a {@link RawRefEntry} on read.
 */
export type RefRow = { name: string; type: string; hash: string | null; target: string | null };

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
 * adds all git-aware behavior on top of a raw {@link RepoPool} backend.
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
	 *
	 * The handle carries the store's default {@link RepoCapabilities} (passed
	 * to {@link createRepoStore}). Pass a per-handle `override` to layer extra
	 * capabilities onto just this handle — e.g. a per-request identity in a
	 * multi-tenant server. The override is merged over the store defaults via
	 * {@link mergeCapabilities} (hooks compose, config deep-merges, everything
	 * else replaces).
	 */
	repo(repoId: string, override?: RepoCapabilities): GitRepo | null | Promise<GitRepo | null>;

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

	/**
	 * Garbage-collect a repo: prune unreachable objects and (optionally)
	 * delta-compress reachable history. Fork-safe — when run on a root repo,
	 * objects reachable from any of its forks are treated as live, so a fork's
	 * delta bases in the shared root partition are never pruned.
	 *
	 * Use `gc(id, { compact: true, prune: false })` for compress-only
	 * maintenance (compact live history without dropping orphaned objects).
	 *
	 * @throws If the repo does not exist.
	 */
	gc(repoId: string, options?: GcOptions): Promise<GcResult>;
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

// ── createRepoStore ───────────────────────────────────────────────────

/** Options for {@link createRepoStore}. */
export interface RepoStoreOptions {
	/**
	 * Default host behavior attached to every handle the store hands out
	 * (via {@link withCapabilities}). Sugar for "`withCapabilities` every repo
	 * I return." Omit it and handles are inert. Per-handle layering is the
	 * `override` argument to {@link RepoStore.repo}.
	 */
	capabilities?: RepoCapabilities;
}

/**
 * Build a {@link RepoStore} from a {@link RepoPool} backend.
 *
 * The returned adapter handles all git-aware logic (object hashing,
 * pack ingestion, batch object lookup fallback, symref resolution, and CAS
 * on top of the backend's raw I/O.
 *
 * Defaults to {@link MemoryStorage} when no pool is supplied, mirroring
 * `createServer`. In-memory data is lost when the process exits — pass an
 * explicit backend for persistence.
 *
 * Pass `options.capabilities` to attach default host behavior (hooks,
 * signing, identity, config, …) to every handle the store returns.
 */
export function createRepoStore(
	pool: RepoPool = new MemoryStorage(),
	options?: RepoStoreOptions,
): RepoStore {
	const defaultCapabilities = options?.capabilities;

	async function buildRepo(repoId: string, override?: RepoCapabilities): Promise<GitRepo> {
		const parentId = pool.parentOf ? await pool.parentOf(repoId) : null;
		const own = await pool.open(repoId);
		const parent = parentId ? await pool.open(parentId) : undefined;
		return buildGitRepo(own, parent, mergeCapabilities(defaultCapabilities, override));
	}

	async function requireRepo(repoId: string): Promise<GitRepo> {
		if (!(await pool.hasRepo(repoId))) throw new Error(`repo '${repoId}' not found`);
		return buildRepo(repoId);
	}

	/**
	 * Collect handles for all forks of a root repo, so maintenance can treat
	 * fork-reachable objects (whose delta bases live in the shared root
	 * partition) as live. Handles are returned (rather than ref tips) because a
	 * fork's reachability walk must run through its own handle — the root handle
	 * cannot read a fork's partition. Returns undefined for non-root repos or
	 * backends without fork support — forks are gc'd as themselves.
	 */
	async function collectForkRepos(repoId: string): Promise<GitRepo[] | undefined> {
		if (!pool.forksOf || !pool.parentOf) return undefined;
		const parentId = await pool.parentOf(repoId);
		if (parentId) return undefined;
		const forkIds = await pool.forksOf(repoId);
		if (forkIds.length === 0) return undefined;
		const forks: GitRepo[] = [];
		for (const forkId of forkIds) {
			if (!(await pool.hasRepo(forkId))) continue;
			forks.push(await buildRepo(forkId));
		}
		return forks.length > 0 ? forks : undefined;
	}

	return {
		async createRepo(repoId: string, options?: CreateRepoOptions): Promise<GitRepo> {
			const exists = await pool.hasRepo(repoId);
			if (exists) throw new Error(`repo '${repoId}' already exists`);
			const defaultBranch = options?.defaultBranch ?? "main";
			await pool.createRepo(repoId);
			const storage = await pool.open(repoId);
			await storage.putRef("HEAD", {
				type: "symbolic",
				target: `refs/heads/${defaultBranch}`,
			});
			return buildRepo(repoId);
		},

		async repo(repoId: string, override?: RepoCapabilities): Promise<GitRepo | null> {
			const exists = await pool.hasRepo(repoId);
			if (!exists) return null;
			return buildRepo(repoId, override);
		},

		async deleteRepo(repoId: string): Promise<void> {
			if (pool.forksOf) {
				const forks = await pool.forksOf(repoId);
				if (forks.length > 0) {
					throw new Error(`cannot delete repo '${repoId}': has ${forks.length} active fork(s)`);
				}
			}
			await pool.deleteRepo(repoId);
		},

		async forkRepo(
			sourceId: string,
			targetId: string,
			options?: CreateRepoOptions,
		): Promise<GitRepo> {
			if (!pool.fork || !pool.parentOf || !pool.forksOf) {
				throw new Error("storage backend does not support forks");
			}

			const sourceExists = await pool.hasRepo(sourceId);
			if (!sourceExists) throw new Error(`source repo '${sourceId}' not found`);
			const targetExists = await pool.hasRepo(targetId);

			// Resolve to root: if source is itself a fork, fork from its root
			const sourceParent = await pool.parentOf(sourceId);
			const rootId = sourceParent ?? sourceId;

			if (targetExists) {
				const targetParent = await pool.parentOf(targetId);
				if (targetParent !== rootId) throw new Error(`repo '${targetId}' already exists`);
			} else {
				await pool.createRepo(targetId);
			}
			// Idempotently verify/repair the pool-level relationship before
			// resuming a possibly interrupted ref copy.
			await pool.fork(rootId, targetId);

			// Copy all refs from source to target
			const source = await pool.open(sourceId);
			const target = await pool.open(targetId);
			const refs = await source.listRefs();
			for (const entry of refs) {
				await target.putRef(entry.name, entry.ref);
			}

			// Copy HEAD
			const head = await source.getRef("HEAD");
			if (head) {
				await target.putRef("HEAD", head);
			} else {
				const defaultBranch = options?.defaultBranch ?? "main";
				await target.putRef("HEAD", {
					type: "symbolic",
					target: `refs/heads/${defaultBranch}`,
				});
			}

			return buildRepo(targetId);
		},

		async gc(repoId: string, options?: GcOptions): Promise<GcResult> {
			const repo = await requireRepo(repoId);
			const forkRepos = await collectForkRepos(repoId);
			return gcRepo(repo, await pool.open(repoId), options, forkRepos);
		},
	};
}

/**
 * Create a git-aware handle backed by one repository's raw storage.
 *
 * A fresh in-memory store is used by default. Existing HEAD values are
 * preserved; otherwise HEAD is initialized to `refs/heads/main`.
 */
export async function createRepo(
	storage: RepoStorage = createMemoryRepoStorage(),
): Promise<GitRepo> {
	if (!(await storage.getRef("HEAD"))) {
		await storage.putRef("HEAD", { type: "symbolic", target: "refs/heads/main" });
	}
	return buildGitRepo(storage);
}

function buildGitRepo(
	own: RepoStorage,
	parent?: RepoStorage,
	capabilities?: RepoCapabilities,
): GitRepo {
	const repo: GitRepo = {
		objectStore: new AdaptedObjectStore(own, parent),
		refStore: new AdaptedRefStore(own),
	};
	return withCapabilities(repo, capabilities);
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
		private own: RepoStorage,
		private parent?: RepoStorage,
	) {}

	async write(type: ObjectType, content: Uint8Array): Promise<ObjectId> {
		const data = envelope(type, content);
		const hash = await sha1(data);
		await this.own.putObject(hash, type, content);
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
		let obj = await this.own.getObject(hash);
		if (!obj && this.parent) {
			obj = await this.parent.getObject(hash);
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
			const ownStored = await this.loadStored(this.own, missingOwn);
			await this.decodeInto(ownStored, result);
		}

		if (this.parent) {
			const missingParent = missingOwn.filter((hash) => !result.has(hash));
			if (missingParent.length > 0) {
				const parentStored = await this.loadStored(this.parent, missingParent);
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
		if (await this.own.hasObject(hash)) return true;
		if (this.parent) return !!(await this.parent.hasObject(hash));
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
			const ownSet = await this.checkObjects(this.own, missingOwn);
			for (const hash of ownSet) present.add(hash);
		}

		if (this.parent) {
			const missingParent = missingOwn.filter((hash) => !present.has(hash));
			if (missingParent.length > 0) {
				const parentSet = await this.checkObjects(this.parent, missingParent);
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
		return await this.own.putObjects(batch);
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
		return this.own.deleteObjects(hashes);
	}

	async findByPrefix(prefix: string): Promise<ObjectId[]> {
		if (prefix.length < 4) return [];
		const own = await this.own.findObjectsByPrefix(prefix);
		if (!this.parent) return Array.from(own);
		const parent = await this.parent.findObjectsByPrefix(prefix);
		const set = new Set(own);
		for (const h of parent) set.add(h);
		return Array.from(set);
	}

	private async loadStored(
		storage: RepoStorage,
		hashes: ReadonlyArray<ObjectId>,
	): Promise<Map<ObjectId, StoredObject>> {
		if (hashes.length === 0) return new Map();
		if (storage.getObjects) {
			return await storage.getObjects(hashes);
		}

		const result = new Map<ObjectId, StoredObject>();
		for (const hash of hashes) {
			const obj = await storage.getObject(hash);
			if (obj) result.set(hash, obj);
		}
		return result;
	}

	private async checkObjects(
		storage: RepoStorage,
		hashes: ReadonlyArray<ObjectId>,
	): Promise<Set<ObjectId>> {
		if (hashes.length === 0) return new Set();
		if (storage.hasObjects) {
			const rows = await storage.hasObjects(hashes);
			return new Set(rows as Set<ObjectId>);
		}

		const result = new Set<ObjectId>();
		for (const hash of hashes) {
			if (await storage.hasObject(hash)) result.add(hash);
		}
		return result;
	}
}

// ── AdaptedRefStore (private) ───────────────────────────────────────

class AdaptedRefStore implements RefStore {
	constructor(private storage: RepoStorage) {}

	async readRef(name: string): Promise<Ref | null> {
		return (await this.storage.getRef(name)) ?? null;
	}

	async writeRef(name: string, refOrHash: Ref | string): Promise<void> {
		await this.storage.putRef(name, normalizeRef(refOrHash));
	}

	async deleteRef(name: string): Promise<void> {
		await this.storage.removeRef(name);
	}

	async listRefs(prefix?: string): Promise<RefEntry[]> {
		const raw = await this.storage.listRefs(prefix);
		const results: RefEntry[] = [];
		for (const entry of raw) {
			if (entry.ref.type === "direct") {
				results.push({ name: entry.name, hash: entry.ref.hash });
			} else if (entry.ref.type === "symbolic") {
				const resolved = await resolveRefChain((n) => this.storage.getRef(n), entry.ref.target);
				if (resolved) results.push({ name: entry.name, hash: resolved });
			}
		}
		return results;
	}

	async compareAndSwapRef(
		name: string,
		expectedOld: Ref | null,
		newRef: Ref | null,
	): Promise<boolean> {
		return !!(await this.storage.compareAndSwapRef(name, expectedOld, newRef));
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
