import { WM_CASEFOLD, WM_MATCH, WM_PATHNAME, wildmatch } from "./wildmatch.ts";

// Magic flags (bitmask)
export const PATHSPEC_GLOB = 1;
export const PATHSPEC_LITERAL = 2;
export const PATHSPEC_ICASE = 4;
export const PATHSPEC_TOP = 8;
export const PATHSPEC_EXCLUDE = 16;

export interface Pathspec {
	original: string;
	pattern: string;
	magic: number;
	hasWildcard: boolean;
	nowildcardLen: number;
}

const GLOB_CHARS = new Set(["*", "?", "[", "\\"]);

const MAGIC_KEYWORDS: Record<string, number> = {
	glob: PATHSPEC_GLOB,
	literal: PATHSPEC_LITERAL,
	icase: PATHSPEC_ICASE,
	top: PATHSPEC_TOP,
	exclude: PATHSPEC_EXCLUDE,
};

/**
 * Quick check: does the string contain glob metacharacters?
 */
export function containsWildcard(s: string): boolean {
	for (let i = 0; i < s.length; i++) {
		if (GLOB_CHARS.has(s[i]!)) return true;
	}
	return false;
}

/**
 * Compute the length of the literal prefix before the first wildcard.
 */
function simpleLength(pattern: string): number {
	for (let i = 0; i < pattern.length; i++) {
		if (GLOB_CHARS.has(pattern[i]!)) return i;
	}
	return pattern.length;
}

/**
 * Normalize a path produced by joining prefix + pattern.
 * Resolves `.` and `..` segments. Does not resolve against a filesystem.
 */
function normalizePath(p: string): string {
	const parts = p.split("/");
	const out: string[] = [];
	for (const part of parts) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			if (out.length > 0 && out[out.length - 1] !== "..") {
				out.pop();
			}
			// If nothing to pop, the .. would go outside the repo — drop it
			continue;
		}
		out.push(part);
	}
	return out.join("/");
}

/**
 * Parse a raw pathspec string into a structured Pathspec.
 *
 * `cwdPrefix` is the path from worktree root to the current directory
 * (e.g. "src" if cwd is `/repo/src` and worktree is `/repo`).
 * Empty string means cwd is the worktree root.
 */
export function parsePathspec(raw: string, cwdPrefix: string): Pathspec {
	let magic = 0;
	let body = raw;

	// Parse magic prefixes
	if (body.startsWith(":(")) {
		// Long-form: :(glob,icase)pattern
		const closeIdx = body.indexOf(")");
		if (closeIdx !== -1) {
			const magicStr = body.slice(2, closeIdx);
			body = body.slice(closeIdx + 1);
			for (const keyword of magicStr.split(",")) {
				const flag = MAGIC_KEYWORDS[keyword.trim()];
				if (flag !== undefined) magic |= flag;
			}
		}
	} else if (body.startsWith(":/")) {
		// Short-form top: :/pattern
		magic |= PATHSPEC_TOP;
		body = body.slice(2);
	} else if (body.startsWith(":!") || body.startsWith(":^")) {
		// Short-form exclude
		magic |= PATHSPEC_EXCLUDE;
		body = body.slice(2);
	}

	// Validate: literal and glob are incompatible
	if (magic & PATHSPEC_LITERAL && magic & PATHSPEC_GLOB) {
		magic &= ~PATHSPEC_GLOB;
	}

	// Apply cwd prefix unless :(top)
	let pattern: string;
	if (magic & PATHSPEC_TOP || cwdPrefix === "") {
		pattern = normalizePath(body);
	} else {
		pattern = normalizePath(`${cwdPrefix}/${body}`);
	}

	// Detect wildcards
	const isLiteral = !!(magic & PATHSPEC_LITERAL);
	const hasWild = isLiteral ? false : containsWildcard(pattern);
	const nowildcardLen = isLiteral ? pattern.length : simpleLength(pattern);

	return {
		original: raw,
		pattern,
		magic,
		hasWildcard: hasWild,
		nowildcardLen,
	};
}

/**
 * Match a single candidate path against a single pathspec.
 */
export function matchPathspec(spec: Pathspec, candidate: string): boolean {
	const { pattern, hasWildcard: hasWild, magic, nowildcardLen } = spec;

	// Empty pattern matches everything (like `git add .` from root)
	if (pattern === "") return true;

	if (!hasWild) {
		// Literal matching
		const icmp = !!(magic & PATHSPEC_ICASE);
		const p = icmp ? pattern.toLowerCase() : pattern;
		const c = icmp ? candidate.toLowerCase() : candidate;

		// Exact match
		if (p === c) return true;

		// Directory match: pathspec "src" matches "src/foo.ts"
		if (c.startsWith(p) && c[p.length] === "/") return true;

		// Trailing slash: pathspec "src/" matches "src/foo.ts"
		if (p.endsWith("/") && c.startsWith(p)) return true;

		return false;
	}

	// Wildcard matching

	// Literal prefix optimization: if the literal prefix doesn't match, skip wildmatch
	if (nowildcardLen > 0) {
		const prefixPattern = pattern.slice(0, nowildcardLen);
		const prefixCandidate = candidate.slice(0, nowildcardLen);
		if (magic & PATHSPEC_ICASE) {
			if (prefixPattern.toLowerCase() !== prefixCandidate.toLowerCase()) return false;
		} else {
			if (prefixPattern !== prefixCandidate) return false;
		}
	}

	let flags = 0;
	if (magic & PATHSPEC_GLOB) flags |= WM_PATHNAME;
	if (magic & PATHSPEC_ICASE) flags |= WM_CASEFOLD;

	return wildmatch(pattern, candidate, flags) === WM_MATCH;
}

/**
 * Match a candidate path against multiple pathspecs.
 *
 * A path matches if it matches at least one positive (non-exclude) pathspec
 * AND does not match any exclude pathspec.
 *
 * If there are no positive pathspecs (only excludes), nothing matches.
 */
export function matchPathspecs(specs: Pathspec[], candidate: string): boolean {
	let matched = false;
	let excluded = false;

	for (const spec of specs) {
		if (spec.magic & PATHSPEC_EXCLUDE) {
			if (matchPathspec(spec, candidate)) excluded = true;
		} else {
			if (matchPathspec(spec, candidate)) matched = true;
		}
	}

	return matched && !excluded;
}
