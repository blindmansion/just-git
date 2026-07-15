import type { Ref } from "../lib/types.ts";
import type { RepoPool } from "./repo-pool.ts";
import { compareAndSwapRawRef, type RepoStorage } from "./repo-storage.ts";
import type { DeltaObjectRow, StoredObject, RawRefEntry } from "./repo-store.ts";

// ── MemoryStorage ───────────────────────────────────────────────────

/**
 * In-memory storage backend with multi-repo support.
 *
 * Useful for tests, ephemeral servers, and benchmarking.
 * Data is lost when the process exits.
 *
 * ```ts
 * // MemoryStorage is the default — these are equivalent:
 * const server = createServer();
 * const server2 = createServer({ storage: new MemoryStorage() });
 * ```
 */
export class MemoryStorage implements RepoPool {
	private repos = new Set<string>();
	private objects = new Map<string, Map<string, StoredObject>>();
	private refs = new Map<string, Map<string, Ref>>();
	private forks = new Map<string, string>(); // targetId → rootId

	hasRepo(repoId: string): boolean {
		return this.repos.has(repoId);
	}

	createRepo(repoId: string): void {
		this.repos.add(repoId);
	}

	deleteRepo(repoId: string): void {
		this.repos.delete(repoId);
		this.objects.get(repoId)?.clear();
		this.objects.delete(repoId);
		this.refs.get(repoId)?.clear();
		this.refs.delete(repoId);
		this.forks.delete(repoId);
	}

	open(repoId: string): RepoStorage {
		return new MemoryRepoStorage(this.getObjMap(repoId), this.getRefMap(repoId));
	}

	// ── Forks ──────────────────────────────────────────────────

	fork(sourceId: string, targetId: string): void {
		this.forks.set(targetId, sourceId);
	}

	parentOf(repoId: string): string | null {
		return this.forks.get(repoId) ?? null;
	}

	forksOf(repoId: string): string[] {
		const result: string[] = [];
		for (const [child, parent] of this.forks) {
			if (parent === repoId) result.push(child);
		}
		return result;
	}

	// ── Extras (not part of RepoPool) ───────────────────────────

	/** List all created repo IDs. Convenience for tests and debugging. */
	repoIds(): string[] {
		return Array.from(this.repos);
	}

	// ── Internal helpers ────────────────────────────────────────

	private getObjMap(repoId: string): Map<string, StoredObject> {
		let map = this.objects.get(repoId);
		if (!map) {
			map = new Map();
			this.objects.set(repoId, map);
		}
		return map;
	}

	private getRefMap(repoId: string): Map<string, Ref> {
		let map = this.refs.get(repoId);
		if (!map) {
			map = new Map();
			this.refs.set(repoId, map);
		}
		return map;
	}
}

/** Create isolated in-memory storage for the standalone single-repo API. */
export function createMemoryRepoStorage(): RepoStorage {
	return new MemoryRepoStorage(new Map(), new Map());
}

class MemoryRepoStorage implements RepoStorage {
	constructor(
		private objects: Map<string, StoredObject>,
		private refs: Map<string, Ref>,
	) {}

	getObject(hash: string): StoredObject | null {
		const obj = this.objects.get(hash);
		return obj ? cloneStored(obj) : null;
	}

	getObjects(hashes: ReadonlyArray<string>): Map<string, StoredObject> {
		const result = new Map<string, StoredObject>();
		for (const hash of new Set(hashes)) {
			const obj = this.objects.get(hash);
			if (obj) result.set(hash, cloneStored(obj));
		}
		return result;
	}

	putObject(hash: string, type: string, content: Uint8Array): void {
		if (!this.objects.has(hash)) {
			this.objects.set(hash, {
				type: type as StoredObject["type"],
				encoding: "raw",
				content: new Uint8Array(content),
			});
		}
	}

	putObjects(
		objects: ReadonlyArray<{ hash: string; type: string; content: Uint8Array }>,
	): string[] {
		const inserted: string[] = [];
		for (const obj of objects) {
			if (this.objects.has(obj.hash)) continue;
			this.objects.set(obj.hash, {
				type: obj.type as StoredObject["type"],
				encoding: "raw",
				content: new Uint8Array(obj.content),
			});
			inserted.push(obj.hash);
		}
		return inserted;
	}

	putDeltaObjects(rows: ReadonlyArray<DeltaObjectRow>): void {
		for (const row of rows) {
			this.objects.set(row.hash, {
				type: row.type as StoredObject["type"],
				encoding: row.encoding,
				baseHash: "baseHash" in row ? row.baseHash : null,
				content: new Uint8Array(row.content),
			});
		}
	}

	hasObject(hash: string): boolean {
		return this.objects.has(hash);
	}

	hasObjects(hashes: ReadonlyArray<string>): Set<string> {
		const result = new Set<string>();
		for (const hash of new Set(hashes)) {
			if (this.objects.has(hash)) result.add(hash);
		}
		return result;
	}

	findObjectsByPrefix(prefix: string): string[] {
		const matches: string[] = [];
		for (const hash of this.objects.keys()) {
			if (hash.startsWith(prefix)) matches.push(hash);
		}
		return matches;
	}

	listObjectHashes(): string[] {
		return Array.from(this.objects.keys());
	}

	repoByteSize(): number {
		let total = 0;
		for (const obj of this.objects.values()) total += obj.content.byteLength;
		return total;
	}

	deleteObjects(hashes: ReadonlyArray<string>): number {
		let deleted = 0;
		for (const hash of hashes) {
			if (this.objects.delete(hash)) deleted++;
		}
		return deleted;
	}

	getRef(name: string): Ref | null {
		return this.refs.get(name) ?? null;
	}

	putRef(name: string, ref: Ref): void {
		this.refs.set(name, ref);
	}

	removeRef(name: string): void {
		this.refs.delete(name);
	}

	listRefs(prefix?: string): RawRefEntry[] {
		const entries: RawRefEntry[] = [];
		for (const [name, ref] of this.refs) {
			if (!prefix || name.startsWith(prefix)) entries.push({ name, ref });
		}
		return entries;
	}

	compareAndSwapRef(name: string, expectedOld: Ref | null, newRef: Ref | null): boolean {
		return compareAndSwapRawRef(
			() => this.refs.get(name) ?? null,
			(ref) => {
				this.refs.set(name, ref);
			},
			() => {
				this.refs.delete(name);
			},
			expectedOld,
			newRef,
		);
	}
}

// ── Helpers ─────────────────────────────────────────────────────────

function cloneStored(obj: StoredObject): StoredObject {
	return {
		type: obj.type,
		encoding: obj.encoding,
		baseHash: obj.baseHash ?? null,
		content: new Uint8Array(obj.content),
	};
}
