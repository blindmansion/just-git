import type { Ref, RawObject } from "../lib/types.ts";
import type { Storage, RawRefEntry, RefOps } from "./storage.ts";

// ── MemoryStorage ───────────────────────────────────────────────────

/**
 * In-memory storage backend with multi-repo support.
 *
 * Useful for tests, ephemeral servers, and benchmarking.
 * Data is lost when the process exits.
 *
 * ```ts
 * const server = createServer({
 *   storage: new MemoryStorage(),
 * });
 * await server.createRepo("my-repo");
 * ```
 */
export class MemoryStorage implements Storage {
	private repos = new Set<string>();
	private objects = new Map<string, Map<string, RawObject>>();
	private refs = new Map<string, Map<string, Ref>>();

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
	}

	getObject(repoId: string, hash: string): RawObject | null {
		const obj = this.getObjMap(repoId).get(hash);
		if (!obj) return null;
		return { type: obj.type, content: new Uint8Array(obj.content) };
	}

	putObject(repoId: string, hash: string, type: string, content: Uint8Array): void {
		const map = this.getObjMap(repoId);
		if (!map.has(hash)) {
			map.set(hash, { type: type as RawObject["type"], content: new Uint8Array(content) });
		}
	}

	putObjects(
		repoId: string,
		objects: ReadonlyArray<{ hash: string; type: string; content: Uint8Array }>,
	): void {
		const map = this.getObjMap(repoId);
		for (const obj of objects) {
			if (!map.has(obj.hash)) {
				map.set(obj.hash, {
					type: obj.type as RawObject["type"],
					content: new Uint8Array(obj.content),
				});
			}
		}
	}

	hasObject(repoId: string, hash: string): boolean {
		return this.getObjMap(repoId).has(hash);
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

	repoIds(): string[] {
		return Array.from(this.repos);
	}

	private getObjMap(repoId: string): Map<string, RawObject> {
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
