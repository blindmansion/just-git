// Object-hash abbreviation: fixed-length and unique-prefix short hashes,
// matching git's `find_unique_abbrev`.

import { findObjectsByPrefix } from "./object-db.ts";
import type { GitRepo, ObjectId } from "./types.ts";

/** git's minimum auto abbreviation length (FALLBACK_DEFAULT_ABBREV). */
export const DEFAULT_ABBREV = 7;

/**
 * Abbreviate a hash to a fixed length without disambiguation.
 *
 * Prefer {@link uniqueAbbrev} for user-facing output — this fixed-length
 * form can print an ambiguous prefix when another object shares it. Kept for
 * contexts where the object DB isn't available and for building fallbacks.
 */
export function abbreviateHash(hash: ObjectId): string {
	return hash.slice(0, DEFAULT_ABBREV);
}

/**
 * Abbreviate a hash to the shortest prefix (>= {@link DEFAULT_ABBREV}) that
 * uniquely identifies an object in the store, matching git's
 * `find_unique_abbrev`. Extends the prefix while more than one object shares
 * it, so callers never emit an ambiguous short hash.
 */
export async function uniqueAbbrev(
	ctx: GitRepo,
	hash: ObjectId,
	minLen: number = DEFAULT_ABBREV,
): Promise<string> {
	const start = Math.max(minLen, 4);
	for (let len = start; len < hash.length; len++) {
		const matches = await findObjectsByPrefix(ctx, hash.slice(0, len));
		if (matches.length <= 1) return hash.slice(0, len);
	}
	return hash;
}

/**
 * Pre-resolve unique abbreviations for a set of hashes and return a synchronous
 * lookup. Lets sync formatters (log/status output) emit disambiguated short
 * hashes without threading async object-DB access through every call site.
 * Unknown hashes fall back to the fixed-length abbreviation.
 */
export async function buildAbbrevResolver(
	ctx: GitRepo,
	hashes: Iterable<ObjectId>,
): Promise<(hash: ObjectId) => string> {
	const map = new Map<ObjectId, string>();
	await Promise.all(
		[...new Set(hashes)].map(async (h) => {
			map.set(h, await uniqueAbbrev(ctx, h));
		}),
	);
	return (h) => map.get(h) ?? abbreviateHash(h);
}
