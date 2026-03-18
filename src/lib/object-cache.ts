import type { ObjectId, ObjectType, RawObject } from "./types.ts";

const CACHEABLE_TYPES: ReadonlySet<ObjectType> = new Set(["tree", "commit", "tag"]);

/**
 * Bounded cache for git objects, sized by total content bytes.
 *
 * Only tree, commit, and tag objects are cached — these are small
 * and frequently re-read during walks, merge-ort, diff, etc.
 * Blobs are skipped entirely: they are large, rarely re-read within
 * a single operation, and would thrash smaller objects out of cache.
 *
 * Uses insertion-order eviction (FIFO) rather than LRU. At high
 * utilization the hit-rate difference between FIFO and LRU is
 * negligible, but FIFO avoids the delete+re-insert bookkeeping
 * on every cache hit that made LRU a net-negative on VFS backends.
 */
export class ObjectCache {
	private map = new Map<ObjectId, RawObject>();
	private currentBytes = 0;
	private maxBytes: number;

	constructor(maxBytes: number = 16 * 1024 * 1024) {
		this.maxBytes = maxBytes;
	}

	get(hash: ObjectId): RawObject | undefined {
		return this.map.get(hash);
	}

	set(hash: ObjectId, obj: RawObject): void {
		if (!CACHEABLE_TYPES.has(obj.type)) return;

		const size = obj.content.byteLength;
		if (size > this.maxBytes / 2) return;

		if (this.map.has(hash)) return;

		while (this.currentBytes + size > this.maxBytes && this.map.size > 0) {
			const oldest = this.map.keys().next().value!;
			this.currentBytes -= this.map.get(oldest)!.content.byteLength;
			this.map.delete(oldest);
		}

		this.map.set(hash, obj);
		this.currentBytes += size;
	}

	get size(): number {
		return this.map.size;
	}

	get bytes(): number {
		return this.currentBytes;
	}

	clear(): void {
		this.map.clear();
		this.currentBytes = 0;
	}
}
