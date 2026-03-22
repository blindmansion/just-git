import { envelope } from "../lib/object-store.ts";
import type { PackObject } from "../lib/pack/packfile.ts";
import { readPack } from "../lib/pack/packfile.ts";
import { sha1 } from "../lib/sha1.ts";
import { normalizeRef } from "../lib/types.ts";
import type {
	ObjectId,
	ObjectStore,
	ObjectType,
	RawObject,
	Ref,
	RefEntry,
	RefStore,
	GitRepo,
} from "../lib/types.ts";
import type { Storage, CreateRepoOptions } from "./storage.ts";

// ── MemoryStorage ───────────────────────────────────────────────────

/**
 * In-memory git storage with multi-repo support.
 *
 * Useful for tests, ephemeral servers, and benchmarking.
 * Data is lost when the process exits.
 *
 * ```ts
 * const storage = new MemoryStorage();
 * storage.createRepo("my-repo");
 * const server = createGitServer({
 *   resolveRepo: (repoPath) => storage.repo(repoPath),
 * });
 * ```
 */
export class MemoryStorage implements Storage {
	private objects = new Map<string, Map<string, RawObject>>();
	private refs = new Map<string, Map<string, Ref>>();
	private created = new Set<string>();

	createRepo(repoId: string, options?: CreateRepoOptions): GitRepo {
		if (this.created.has(repoId)) {
			throw new Error(`repo '${repoId}' already exists`);
		}
		this.created.add(repoId);
		const defaultBranch = options?.defaultBranch ?? "main";
		this.getRefs(repoId).set("HEAD", {
			type: "symbolic",
			target: `refs/heads/${defaultBranch}`,
		});
		return this.buildRepo(repoId);
	}

	repo(repoId: string): GitRepo | null {
		if (!this.created.has(repoId)) return null;
		return this.buildRepo(repoId);
	}

	deleteRepo(repoId: string): void {
		this.created.delete(repoId);
		this.objects.get(repoId)?.clear();
		this.objects.delete(repoId);
		this.refs.get(repoId)?.clear();
		this.refs.delete(repoId);
	}

	listRepos(): string[] {
		return Array.from(this.created);
	}

	private buildRepo(repoId: string): GitRepo {
		return {
			objectStore: new MemoryObjectStore(this.getObjects(repoId)),
			refStore: new MemoryRefStore(this.getRefs(repoId)),
		};
	}

	private getObjects(repoId: string): Map<string, RawObject> {
		let map = this.objects.get(repoId);
		if (!map) {
			map = new Map();
			this.objects.set(repoId, map);
		}
		return map;
	}

	private getRefs(repoId: string): Map<string, Ref> {
		let map = this.refs.get(repoId);
		if (!map) {
			map = new Map();
			this.refs.set(repoId, map);
		}
		return map;
	}
}

// ── MemoryObjectStore ───────────────────────────────────────────────

class MemoryObjectStore implements ObjectStore {
	constructor(private store: Map<string, RawObject>) {}

	async write(type: ObjectType, content: Uint8Array): Promise<ObjectId> {
		const hash = await sha1(envelope(type, content));
		if (!this.store.has(hash)) {
			this.store.set(hash, { type, content: new Uint8Array(content) });
		}
		return hash;
	}

	async read(hash: ObjectId): Promise<RawObject> {
		const obj = this.store.get(hash);
		if (!obj) throw new Error(`object ${hash} not found`);
		return { type: obj.type, content: new Uint8Array(obj.content) };
	}

	async exists(hash: ObjectId): Promise<boolean> {
		return this.store.has(hash);
	}

	async ingestPack(packData: Uint8Array): Promise<number> {
		if (packData.byteLength < 32) return 0;
		const view = new DataView(packData.buffer, packData.byteOffset, packData.byteLength);
		const numObjects = view.getUint32(8);
		if (numObjects === 0) return 0;

		const store = this.store;
		const entries = await readPack(packData, async (hash) => {
			const obj = store.get(hash);
			if (!obj) return null;
			return { type: obj.type, content: new Uint8Array(obj.content) };
		});

		for (const entry of entries) {
			if (!store.has(entry.hash)) {
				store.set(entry.hash, { type: entry.type as ObjectType, content: entry.content });
			}
		}
		return entries.length;
	}

	async ingestPackStream(entries: AsyncIterable<PackObject>): Promise<number> {
		const store = this.store;
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
		if (prefix.length < 4) return [];
		const matches: ObjectId[] = [];
		for (const hash of this.store.keys()) {
			if (hash.startsWith(prefix)) matches.push(hash);
		}
		return matches;
	}
}

// ── MemoryRefStore ──────────────────────────────────────────────────

class MemoryRefStore implements RefStore {
	constructor(private store: Map<string, Ref>) {}

	async readRef(name: string): Promise<Ref | null> {
		return this.store.get(name) ?? null;
	}

	async writeRef(name: string, refOrHash: Ref | string): Promise<void> {
		this.store.set(name, normalizeRef(refOrHash));
	}

	async deleteRef(name: string): Promise<void> {
		this.store.delete(name);
	}

	async compareAndSwapRef(
		name: string,
		expectedOldHash: string | null,
		newRef: Ref | null,
	): Promise<boolean> {
		const current = this.store.get(name) ?? null;

		let currentHash: string | null = null;
		if (current) {
			if (current.type === "direct") {
				currentHash = current.hash;
			} else if (current.type === "symbolic") {
				currentHash = this.resolveChain(current.target);
			}
		}

		if (expectedOldHash === null) {
			if (current !== null) return false;
		} else {
			if (currentHash !== expectedOldHash) return false;
		}

		if (newRef === null) {
			this.store.delete(name);
		} else {
			this.store.set(name, newRef);
		}
		return true;
	}

	async listRefs(prefix?: string): Promise<RefEntry[]> {
		const results: RefEntry[] = [];
		for (const [name, ref] of this.store) {
			if (prefix && !name.startsWith(prefix)) continue;
			if (ref.type === "direct") {
				results.push({ name, hash: ref.hash });
			} else if (ref.type === "symbolic") {
				const resolved = this.resolveChain(ref.target);
				if (resolved) results.push({ name, hash: resolved });
			}
		}
		return results;
	}

	private resolveChain(target: string, depth = 0): string | null {
		if (depth > 10) return null;
		const ref = this.store.get(target);
		if (!ref) return null;
		if (ref.type === "direct") return ref.hash;
		if (ref.type === "symbolic") return this.resolveChain(ref.target, depth + 1);
		return null;
	}
}
