// Default in-memory implementation of the `DiscoveryCache` capability.
//
// A host can set one of these on a handle (`capabilities.discoveryCache`) so
// repeated operations reuse stable per-repository upload-pack discovery
// (version + caps) instead of re-running the capability `GET` every time. It is
// a plain `Map` with a TTL: entries older than `maxAgeMs` are treated as a miss
// and dropped. This is opt-in; ordinary handles allocate no cache.

import type { DiscoveryCache, DiscoveryEntry } from "../types.ts";

export interface MemoryDiscoveryCacheOptions {
	/**
	 * Max entry age in ms before `get` treats it as a miss (and evicts it).
	 * Defaults to 5 minutes — long enough to fold a burst of sync cycles, short
	 * enough that a server upgrade is re-discovered promptly.
	 */
	maxAgeMs?: number;
	/** Injected clock (epoch ms) for deterministic TTL in tests. Defaults to `Date.now`. */
	now?: () => number;
}

const DEFAULT_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * Create the provided {@link DiscoveryCache} implementation: a `Map` keyed by
 * canonical remote repository URL with TTL eviction. `set` re-stamps the
 * entry's `fetchedAt` with this cache's own clock so freshness is judged
 * consistently regardless of what the transport recorded. Scope an instance
 * to one authorization context.
 */
export function createMemoryDiscoveryCache(options?: MemoryDiscoveryCacheOptions): DiscoveryCache {
	const maxAgeMs = options?.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
	const now = options?.now ?? Date.now;
	const store = new Map<string, DiscoveryEntry>();

	return {
		get(key: string): DiscoveryEntry | undefined {
			const entry = store.get(key);
			if (!entry) return undefined;
			if (now() - entry.fetchedAt > maxAgeMs) {
				store.delete(key);
				return undefined;
			}
			return entry;
		},
		set(key: string, entry: DiscoveryEntry): void {
			store.set(key, { ...entry, fetchedAt: now() });
		},
		evict(key: string): void {
			store.delete(key);
		},
	};
}
