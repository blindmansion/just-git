import type { Ref } from "../lib/types.ts";
import type { DeltaObjectRow, Storage, StoredObject, RawRefEntry, RefOps } from "./repo-store.ts";

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
export class MemoryStorage implements Storage {
	private repos = new Set<string>();
	private objects = new Map<string, Map<string, StoredObject>>();
	private refs = new Map<string, Map<string, Ref>>();
	private forks = new Map<string, string>(); // targetId → rootId

	hasRepo(repoId: string): boolean {
		return this.repos.has(repoId);
	}

	insertRepo(repoId: string): void {
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

	getObject(repoId: string, hash: string): StoredObject | null {
		const obj = this.getObjMap(repoId).get(hash);
		if (!obj) return null;
		return cloneStored(obj);
	}

	getObjects(repoId: string, hashes: ReadonlyArray<string>): Map<string, StoredObject> {
		const map = this.getObjMap(repoId);
		const result = new Map<string, StoredObject>();
		for (const hash of new Set(hashes)) {
			const obj = map.get(hash);
			if (!obj) continue;
			result.set(hash, cloneStored(obj));
		}
		return result;
	}

	putObject(repoId: string, hash: string, type: string, content: Uint8Array): void {
		const map = this.getObjMap(repoId);
		if (!map.has(hash)) {
			map.set(hash, {
				type: type as StoredObject["type"],
				encoding: "raw",
				content: new Uint8Array(content),
			});
		}
	}

	putObjects(
		repoId: string,
		objects: ReadonlyArray<{ hash: string; type: string; content: Uint8Array }>,
	): string[] {
		const map = this.getObjMap(repoId);
		const inserted: string[] = [];
		for (const obj of objects) {
			if (!map.has(obj.hash)) {
				map.set(obj.hash, {
					type: obj.type as StoredObject["type"],
					encoding: "raw",
					content: new Uint8Array(obj.content),
				});
				inserted.push(obj.hash);
			}
		}
		return inserted;
	}

	putDeltaObjects(repoId: string, rows: ReadonlyArray<DeltaObjectRow>): void {
		const map = this.getObjMap(repoId);
		for (const row of rows) {
			map.set(row.hash, {
				type: row.type as StoredObject["type"],
				encoding: row.encoding,
				baseHash: "baseHash" in row ? row.baseHash : null,
				content: new Uint8Array(row.content),
			});
		}
	}

	hasObject(repoId: string, hash: string): boolean {
		return this.getObjMap(repoId).has(hash);
	}

	hasObjects(repoId: string, hashes: ReadonlyArray<string>): Set<string> {
		const map = this.getObjMap(repoId);
		const result = new Set<string>();
		for (const hash of new Set(hashes)) {
			if (map.has(hash)) result.add(hash);
		}
		return result;
	}

	findObjectsByPrefix(repoId: string, prefix: string): string[] {
		const matches: string[] = [];
		for (const hash of this.getObjMap(repoId).keys()) {
			if (hash.startsWith(prefix)) matches.push(hash);
		}
		return matches;
	}

	listObjectHashes(repoId: string): string[] {
		return Array.from(this.getObjMap(repoId).keys());
	}

	repoByteSize(repoId: string): number {
		let total = 0;
		for (const obj of this.getObjMap(repoId).values()) {
			total += obj.content.byteLength;
		}
		return total;
	}

	deleteObjects(repoId: string, hashes: ReadonlyArray<string>): number {
		const map = this.getObjMap(repoId);
		let deleted = 0;
		for (const hash of hashes) {
			if (map.delete(hash)) deleted++;
		}
		return deleted;
	}

	getRef(repoId: string, name: string): Ref | null {
		return this.getRefMap(repoId).get(name) ?? null;
	}

	putRef(repoId: string, name: string, ref: Ref): void {
		this.getRefMap(repoId).set(name, ref);
	}

	removeRef(repoId: string, name: string): void {
		this.getRefMap(repoId).delete(name);
	}

	listRefs(repoId: string, prefix?: string): RawRefEntry[] {
		const entries: RawRefEntry[] = [];
		for (const [name, ref] of this.getRefMap(repoId)) {
			if (prefix && !name.startsWith(prefix)) continue;
			entries.push({ name, ref });
		}
		return entries;
	}

	atomicRefUpdate<T>(repoId: string, fn: (ops: RefOps) => T): T {
		// Single-threaded JS — no lock needed; just delegate to the same maps.
		const refMap = this.getRefMap(repoId);
		return fn({
			getRef: (name) => refMap.get(name) ?? null,
			putRef: (name, ref) => {
				refMap.set(name, ref);
			},
			removeRef: (name) => {
				refMap.delete(name);
			},
		});
	}

	// ── Forks ──────────────────────────────────────────────────

	forkRepo(sourceId: string, targetId: string): void {
		this.forks.set(targetId, sourceId);
	}

	getForkParent(repoId: string): string | null {
		return this.forks.get(repoId) ?? null;
	}

	listForks(repoId: string): string[] {
		const result: string[] = [];
		for (const [child, parent] of this.forks) {
			if (parent === repoId) result.push(child);
		}
		return result;
	}

	// ── Extras (not part of Storage interface) ──────────────────

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

// ── Helpers ─────────────────────────────────────────────────────────

function cloneStored(obj: StoredObject): StoredObject {
	return {
		type: obj.type,
		encoding: obj.encoding,
		baseHash: obj.baseHash ?? null,
		content: new Uint8Array(obj.content),
	};
}
