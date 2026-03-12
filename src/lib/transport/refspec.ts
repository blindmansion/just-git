// ── Refspec parsing, matching, and mapping ───────────────────────────

/** Parsed refspec. */
export interface Refspec {
	/** Allow non-fast-forward updates. */
	force: boolean;
	/** Source pattern (e.g. "refs/heads/*" or "refs/heads/main"). */
	src: string;
	/** Destination pattern (e.g. "refs/remotes/origin/*"). */
	dst: string;
}

/**
 * Parse a refspec string like "+refs/heads/*:refs/remotes/origin/*".
 */
export function parseRefspec(spec: string): Refspec {
	let s = spec;
	let force = false;
	if (s.startsWith("+")) {
		force = true;
		s = s.slice(1);
	}

	const colonIdx = s.indexOf(":");
	if (colonIdx === -1) {
		return { force, src: s, dst: s };
	}

	return {
		force,
		src: s.slice(0, colonIdx),
		dst: s.slice(colonIdx + 1),
	};
}

/**
 * Check whether a ref name matches a refspec source pattern.
 *
 * Patterns use a single `*` glob that matches any path segment(s).
 * "refs/heads/*" matches "refs/heads/main" and "refs/heads/feature/foo".
 * "refs/heads/main" matches only "refs/heads/main".
 */
export function refspecMatches(pattern: string, refName: string): boolean {
	const starIdx = pattern.indexOf("*");
	if (starIdx === -1) {
		return pattern === refName;
	}
	const prefix = pattern.slice(0, starIdx);
	const suffix = pattern.slice(starIdx + 1);
	return (
		refName.startsWith(prefix) &&
		refName.endsWith(suffix) &&
		refName.length >= prefix.length + suffix.length
	);
}

/**
 * Map a ref name through a refspec, returning the destination ref name.
 * Returns null if the ref doesn't match the refspec's source pattern.
 *
 * Example:
 *   mapRefspec(parse("+refs/heads/*:refs/remotes/origin/*"), "refs/heads/main")
 *   → "refs/remotes/origin/main"
 */
export function mapRefspec(spec: Refspec, refName: string): string | null {
	if (!refspecMatches(spec.src, refName)) return null;

	const srcStar = spec.src.indexOf("*");
	const dstStar = spec.dst.indexOf("*");

	if (srcStar === -1) {
		return spec.dst;
	}

	// Extract the matched wildcard portion from the ref name
	const prefix = spec.src.slice(0, srcStar);
	const suffix = spec.src.slice(srcStar + 1);
	const endIdx = suffix.length > 0 ? refName.length - suffix.length : refName.length;
	const matched = refName.slice(prefix.length, endIdx);

	if (dstStar === -1) {
		return spec.dst;
	}

	return spec.dst.slice(0, dstStar) + matched + spec.dst.slice(dstStar + 1);
}
