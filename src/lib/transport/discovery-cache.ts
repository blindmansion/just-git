// Default in-memory implementation of the `DiscoveryCache` capability.
//
// A host sets one of these once on a handle (`capabilities.discoveryCache`) so a
// tight sync loop reuses stable per-remote protocol discovery (version + caps)
// across operations instead of re-running the capability `GET` every cycle. It
// is a plain `Map` with a TTL: entries older than `maxAgeMs` are treated as a
// miss (and dropped), so a server upgrade is picked up automatically. Caps are
// advisory, so a stale entry only ever costs one wasted request — the transport
// evicts and re-discovers on any protocol error.

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
 * Create the shipped default {@link DiscoveryCache}: a `Map` keyed by remote
 * origin with TTL eviction. `set` re-stamps the entry's `fetchedAt` with this
 * cache's own clock so freshness is judged consistently regardless of what the
 * transport recorded. A multi-tenant server wanting cross-process sharing can
 * implement the interface over its own storage instead.
 */
export function createMemoryDiscoveryCache(options?: MemoryDiscoveryCacheOptions): DiscoveryCache {
	const maxAgeMs = options?.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
	const now = options?.now ?? Date.now;
	const store = new Map<string, DiscoveryEntry>();

	return {
		get(origin: string): DiscoveryEntry | undefined {
			const entry = store.get(origin);
			if (!entry) return undefined;
			if (now() - entry.fetchedAt > maxAgeMs) {
				store.delete(origin);
				return undefined;
			}
			return entry;
		},
		set(origin: string, entry: DiscoveryEntry): void {
			store.set(origin, { ...entry, fetchedAt: now() });
		},
		evict(origin: string): void {
			store.delete(origin);
		},
	};
}
