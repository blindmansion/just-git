import { envelope } from "../lib/object-store.ts";
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
import type { PackObject } from "../lib/pack/packfile.ts";
import { readPack } from "../lib/pack/packfile.ts";

// ── Read-only repo wrapper ──────────────────────────────────────────

class ReadonlyObjectStore implements ObjectStore {
	constructor(private inner: ObjectStore) {}

	read(hash: ObjectId): Promise<RawObject> {
		return this.inner.read(hash);
	}
	write(_type: ObjectType, _content: Uint8Array): Promise<ObjectId> {
		throw new Error("cannot write: object store is read-only");
	}
	exists(hash: ObjectId): Promise<boolean> {
		return this.inner.exists(hash);
	}
	ingestPack(_packData: Uint8Array): Promise<number> {
		throw new Error("cannot ingest pack: object store is read-only");
	}
	ingestPackStream(_entries: AsyncIterable<PackObject>): Promise<number> {
		throw new Error("cannot ingest pack: object store is read-only");
	}
	findByPrefix(prefix: string): Promise<ObjectId[]> {
		return this.inner.findByPrefix(prefix);
	}
}

class ReadonlyRefStore implements RefStore {
	constructor(private inner: RefStore) {}

	readRef(name: string): Promise<Ref | null> {
		return this.inner.readRef(name);
	}
	writeRef(_name: string, _ref: Ref | string): Promise<void> {
		throw new Error("cannot write ref: ref store is read-only");
	}
	deleteRef(_name: string): Promise<void> {
		throw new Error("cannot delete ref: ref store is read-only");
	}
	listRefs(prefix?: string): Promise<RefEntry[]> {
		return this.inner.listRefs(prefix);
	}
	compareAndSwapRef(
		_name: string,
		_expectedOldHash: string | null,
		_newRef: Ref | null,
	): Promise<boolean> {
		throw new Error("cannot update ref: ref store is read-only");
	}
}

/**
 * Wrap a `GitRepo` so all write operations throw.
 *
 * Read operations (readRef, read, exists, listRefs, findByPrefix)
 * pass through to the underlying stores. Write operations (write,
 * writeRef, deleteRef, ingestPack, compareAndSwapRef) throw with
 * a descriptive error.
 *
 * ```ts
 * const ro = readonlyRepo(storage.repo("my-repo"));
 * const { ctx } = await createWorktree(ro, fs, { workTree: "/repo" });
 * const git = createGit({
 *   objectStore: ro.objectStore,
 *   refStore: ro.refStore,
 * });
 * ```
 */
export function readonlyRepo(repo: GitRepo): GitRepo {
	return {
		objectStore: new ReadonlyObjectStore(repo.objectStore),
		refStore: new ReadonlyRefStore(repo.refStore),
		hooks: repo.hooks,
	};
}

// ── Overlay repo wrapper ───────────────────────────────────────────

class OverlayObjectStore implements ObjectStore {
	private overlay = new Map<ObjectId, RawObject>();

	constructor(private inner: ObjectStore) {}

	async read(hash: ObjectId): Promise<RawObject> {
		const local = this.overlay.get(hash);
		if (local) return { type: local.type, content: new Uint8Array(local.content) };
		return this.inner.read(hash);
	}

	async write(type: ObjectType, content: Uint8Array): Promise<ObjectId> {
		const hash = await sha1(envelope(type, content));
		if (!this.overlay.has(hash)) {
			const existsInner = await this.inner.exists(hash).catch(() => false);
			if (!existsInner) {
				this.overlay.set(hash, { type, content: new Uint8Array(content) });
			}
		}
		return hash;
	}

	async exists(hash: ObjectId): Promise<boolean> {
		if (this.overlay.has(hash)) return true;
		return this.inner.exists(hash);
	}

	async ingestPack(packData: Uint8Array): Promise<number> {
		if (packData.byteLength < 32) return 0;
		const view = new DataView(packData.buffer, packData.byteOffset, packData.byteLength);
		const numObjects = view.getUint32(8);
		if (numObjects === 0) return 0;

		const store = this.overlay;
		const inner = this.inner;
		const entries = await readPack(packData, async (hash) => {
			const local = store.get(hash);
			if (local) return { type: local.type, content: new Uint8Array(local.content) };
			try {
				return await inner.read(hash);
			} catch {
				return null;
			}
		});

		for (const entry of entries) {
			if (!store.has(entry.hash)) {
				store.set(entry.hash, { type: entry.type as ObjectType, content: entry.content });
			}
		}
		return entries.length;
	}

	async ingestPackStream(entries: AsyncIterable<PackObject>): Promise<number> {
		const store = this.overlay;
		let count = 0;
		for await (const entry of entries) {
			if (!store.has(entry.hash)) {
				store.set(entry.hash, { type: entry.type as ObjectType, content: entry.content });
			}
			count++;
		}
		return count;
	}

	async findByPrefix(prefix: string): Promise<ObjectId[]> {
		const innerMatches = await this.inner.findByPrefix(prefix);
		const localMatches: ObjectId[] = [];
		for (const hash of this.overlay.keys()) {
			if (hash.startsWith(prefix)) localMatches.push(hash);
		}
		const combined = new Set([...innerMatches, ...localMatches]);
		return [...combined];
	}
}

class OverlayRefStore implements RefStore {
	private overlay = new Map<string, Ref>();
	private deleted = new Set<string>();

	constructor(private inner: RefStore) {}

	async readRef(name: string): Promise<Ref | null> {
		if (this.deleted.has(name)) return null;
		const local = this.overlay.get(name);
		if (local) return local;
		return this.inner.readRef(name);
	}

	async writeRef(name: string, refOrHash: Ref | string): Promise<void> {
		this.deleted.delete(name);
		this.overlay.set(name, normalizeRef(refOrHash));
	}

	async deleteRef(name: string): Promise<void> {
		this.overlay.delete(name);
		this.deleted.add(name);
	}

	async listRefs(prefix?: string): Promise<RefEntry[]> {
		const inner = await this.inner.listRefs(prefix);
		const results = new Map<string, RefEntry>();

		for (const entry of inner) {
			if (!this.deleted.has(entry.name)) {
				results.set(entry.name, entry);
			}
		}

		for (const [name, ref] of this.overlay) {
			if (prefix && !name.startsWith(prefix)) continue;
			if (ref.type === "direct") {
				results.set(name, { name, hash: ref.hash });
			} else if (ref.type === "symbolic") {
				const resolved = await this.resolveSymbolic(ref.target);
				if (resolved) results.set(name, { name, hash: resolved });
			}
		}

		return [...results.values()];
	}

	async compareAndSwapRef(
		name: string,
		expectedOldHash: string | null,
		newRef: Ref | null,
	): Promise<boolean> {
		const current = await this.readRef(name);
		let currentHash: string | null = null;
		if (current) {
			if (current.type === "direct") {
				currentHash = current.hash;
			} else if (current.type === "symbolic") {
				currentHash = await this.resolveSymbolic(current.target);
			}
		}

		if (expectedOldHash === null) {
			if (current !== null) return false;
		} else {
			if (currentHash !== expectedOldHash) return false;
		}

		if (newRef === null) {
			this.overlay.delete(name);
			this.deleted.add(name);
		} else {
			this.deleted.delete(name);
			this.overlay.set(name, newRef);
		}
		return true;
	}

	private async resolveSymbolic(target: string, depth = 0): Promise<string | null> {
		if (depth > 10) return null;
		const ref = await this.readRef(target);
		if (!ref) return null;
		if (ref.type === "direct") return ref.hash;
		if (ref.type === "symbolic") return this.resolveSymbolic(ref.target, depth + 1);
		return null;
	}
}

/**
 * Wrap a `GitRepo` with copy-on-write overlay stores.
 *
 * Read operations pass through to the underlying stores.
 * Write operations (write, writeRef, deleteRef, ingestPack,
 * compareAndSwapRef) are captured in an in-memory overlay
 * and never reach the inner repo.
 *
 * ```ts
 * const ephemeral = overlayRepo(storage.repo("my-repo"));
 * await ephemeral.objectStore.write("blob", content);
 * // original repo is untouched
 * ```
 */
export function overlayRepo(repo: GitRepo): GitRepo {
	return {
		objectStore: new OverlayObjectStore(repo.objectStore),
		refStore: new OverlayRefStore(repo.refStore),
		hooks: repo.hooks,
	};
}
