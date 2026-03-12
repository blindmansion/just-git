import { getConfigValue } from "./config.ts";
import { join } from "./path.ts";
import type { GitContext } from "./types.ts";
import { WM_MATCH, WM_PATHNAME, wildmatch } from "./wildmatch.ts";

// ── Types ───────────────────────────────────────────────────────────

const PATTERN_FLAG_NODIR = 1;
const PATTERN_FLAG_ENDSWITH = 4;
const PATTERN_FLAG_MUSTBEDIR = 8;
const PATTERN_FLAG_NEGATIVE = 16;

interface PathPattern {
	/** The pattern string (after stripping ! prefix and trailing /). */
	pattern: string;
	patternLen: number;
	/** Length of the leading non-wildcard prefix (for fast rejection). */
	nowildcardLen: number;
	flags: number;
	/**
	 * Base directory this pattern is relative to (relative to worktree root).
	 * Empty string for root-level patterns.
	 */
	base: string;
}

/**
 * A list of patterns from a single source file.
 * Patterns are stored in file order; matching iterates in reverse
 * (last match wins).
 */
export interface PatternList {
	patterns: PathPattern[];
	/** Origin description (e.g. file path). */
	src: string;
}

/**
 * Tracks ignore state during a directory walk. Holds the stacked
 * pattern lists from all sources, ordered by precedence.
 */
export interface IgnoreStack {
	/** Per-directory .gitignore pattern lists, deepest last. */
	dirPatterns: PatternList[];
	/** $GIT_DIR/info/exclude patterns. */
	excludeFile: PatternList | null;
	/** core.excludesFile patterns. */
	globalExclude: PatternList | null;
}

// ── Pattern parsing ─────────────────────────────────────────────────

/**
 * Count how many leading characters contain no wildcard specials.
 * Used for fast prefix rejection before calling wildmatch.
 */
function simpleLength(pattern: string): number {
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern[i];
		if (ch === "\\") {
			i++; // skip escaped char
			continue;
		}
		if (ch === "*" || ch === "?" || ch === "[") return i;
	}
	return pattern.length;
}

function noWildcard(s: string): boolean {
	return simpleLength(s) === s.length;
}

/**
 * Parse a single line from a .gitignore file into a PathPattern.
 * Returns null for blank lines and comments.
 */
export function parsePatternLine(line: string, base: string): PathPattern | null {
	// Strip trailing whitespace (unless backslash-escaped)
	let stripped = line;
	while (stripped.length > 0) {
		const last = stripped[stripped.length - 1];
		if (last === " " || last === "\t") {
			if (stripped.length >= 2 && stripped[stripped.length - 2] === "\\") {
				// Escaped trailing space — keep it, remove the backslash
				stripped = stripped.slice(0, stripped.length - 2) + stripped[stripped.length - 1];
				break;
			}
			stripped = stripped.slice(0, -1);
		} else {
			break;
		}
	}

	if (stripped.length === 0) return null;
	if (stripped[0] === "#") return null;

	let flags = 0;
	let p = stripped;

	// Negation prefix
	if (p[0] === "!") {
		flags |= PATTERN_FLAG_NEGATIVE;
		p = p.slice(1);
	}

	if (p.length === 0) return null;

	let len = p.length;

	// Trailing slash means "directories only"
	if (p[len - 1] === "/") {
		len--;
		p = p.slice(0, len);
		flags |= PATTERN_FLAG_MUSTBEDIR;
	}

	// Check if there's a slash anywhere in the pattern (ignoring trailing)
	let hasSlash = false;
	for (let i = 0; i < len; i++) {
		if (p[i] === "/") {
			hasSlash = true;
			break;
		}
	}
	if (!hasSlash) {
		flags |= PATTERN_FLAG_NODIR;
	}

	const nowildcardLen = Math.min(simpleLength(p), len);

	// Optimization: pattern is "*<literal>" — use suffix matching
	if (p[0] === "*" && noWildcard(p.slice(1))) {
		flags |= PATTERN_FLAG_ENDSWITH;
	}

	return {
		pattern: p,
		patternLen: len,
		nowildcardLen,
		flags,
		base,
	};
}

/**
 * Parse an entire ignore file (or string) into a PatternList.
 */
export function parseIgnoreFile(content: string, base: string, src: string): PatternList {
	const patterns: PathPattern[] = [];
	for (const line of content.split("\n")) {
		const pat = parsePatternLine(line, base);
		if (pat) patterns.push(pat);
	}
	return { patterns, src };
}

// ── Pattern matching ────────────────────────────────────────────────

/**
 * Match a pattern against just the basename of a path.
 * Used when PATTERN_FLAG_NODIR is set (pattern contains no /).
 */
function matchBasename(basename: string, pattern: PathPattern): boolean {
	const { pattern: pat, patternLen, nowildcardLen, flags } = pattern;

	if (nowildcardLen === patternLen) {
		return basename === pat;
	}

	if (flags & PATTERN_FLAG_ENDSWITH) {
		const suffix = pat.slice(1);
		return basename.length >= suffix.length && basename.endsWith(suffix);
	}

	return wildmatch(pat, basename, WM_PATHNAME) === WM_MATCH;
}

/**
 * Match a pattern against the full path (relative to the pattern's base).
 * Used when the pattern contains a /.
 */
function matchPathname(pathname: string, pattern: PathPattern): boolean {
	const { base } = pattern;
	let { pattern: pat, patternLen, nowildcardLen } = pattern;

	// Strip leading / from pattern (it's implicit via the base)
	if (pat[0] === "/") {
		pat = pat.slice(1);
		patternLen--;
		nowildcardLen = Math.max(0, nowildcardLen - 1);
	}

	// pathname must be under the pattern's base directory
	const baseLen = base.length;
	if (baseLen > 0) {
		if (pathname.length < baseLen + 1) return false;
		if (pathname[baseLen] !== "/") return false;
		if (!pathname.startsWith(base)) return false;
	}

	const name = baseLen > 0 ? pathname.slice(baseLen + 1) : pathname;
	const nameLen = name.length;

	if (nowildcardLen > 0) {
		if (nowildcardLen > nameLen) return false;
		if (name.slice(0, nowildcardLen) !== pat.slice(0, nowildcardLen)) return false;
		if (patternLen === nowildcardLen && nameLen === nowildcardLen) return true;
	}

	return wildmatch(pat, name, WM_PATHNAME) === WM_MATCH;
}

/**
 * Search a single pattern list in reverse order for the last matching pattern.
 * Returns the matching pattern, or null if undecided.
 */
function lastMatchingPattern(
	pathname: string,
	isDir: boolean,
	pl: PatternList,
): PathPattern | null {
	const basename =
		pathname.lastIndexOf("/") >= 0 ? pathname.slice(pathname.lastIndexOf("/") + 1) : pathname;

	for (let i = pl.patterns.length - 1; i >= 0; i--) {
		const pattern = pl.patterns[i];
		if (!pattern) continue;

		if (pattern.flags & PATTERN_FLAG_MUSTBEDIR) {
			if (!isDir) continue;
		}

		if (pattern.flags & PATTERN_FLAG_NODIR) {
			// NODIR patterns match by basename, but only for paths under the
			// pattern's base directory (the dir containing the .gitignore).
			if (pattern.base) {
				if (!pathname.startsWith(`${pattern.base}/`)) continue;
			}
			if (matchBasename(basename, pattern)) return pattern;
			continue;
		}

		if (matchPathname(pathname, pattern)) return pattern;
	}

	return null;
}

// ── Public API ──────────────────────────────────────────────────────

type IgnoreResult = "ignored" | "not-ignored" | "undecided";

/**
 * Check whether a path is ignored according to all loaded pattern sources.
 *
 * Sources are checked in precedence order (highest first):
 * 1. Per-directory .gitignore (deepest directory first)
 * 2. $GIT_DIR/info/exclude
 * 3. core.excludesFile
 *
 * Within each source, the last matching pattern wins.
 * A negative pattern (!) un-ignores.
 */
export function isIgnored(stack: IgnoreStack, pathname: string, isDir: boolean): IgnoreResult {
	// Per-directory .gitignore files, deepest first (they're stored deepest-last)
	for (let i = stack.dirPatterns.length - 1; i >= 0; i--) {
		const pl = stack.dirPatterns[i]!;
		const match = lastMatchingPattern(pathname, isDir, pl);
		if (match) {
			return match.flags & PATTERN_FLAG_NEGATIVE ? "not-ignored" : "ignored";
		}
	}

	// $GIT_DIR/info/exclude
	if (stack.excludeFile) {
		const match = lastMatchingPattern(pathname, isDir, stack.excludeFile);
		if (match) {
			return match.flags & PATTERN_FLAG_NEGATIVE ? "not-ignored" : "ignored";
		}
	}

	// core.excludesFile
	if (stack.globalExclude) {
		const match = lastMatchingPattern(pathname, isDir, stack.globalExclude);
		if (match) {
			return match.flags & PATTERN_FLAG_NEGATIVE ? "not-ignored" : "ignored";
		}
	}

	return "undecided";
}

// ── Ignore stack construction ───────────────────────────────────────

/**
 * Load the repository-level and global ignore sources (info/exclude,
 * core.excludesFile). Call once before starting a worktree walk.
 */
export async function loadBaseIgnore(ctx: GitContext): Promise<IgnoreStack> {
	const stack: IgnoreStack = {
		dirPatterns: [],
		excludeFile: null,
		globalExclude: null,
	};

	// $GIT_DIR/info/exclude
	const infoExclude = join(ctx.gitDir, "info", "exclude");
	try {
		const content = await ctx.fs.readFile(infoExclude);
		stack.excludeFile = parseIgnoreFile(content, "", infoExclude);
	} catch {
		// File doesn't exist — that's fine
	}

	// core.excludesFile
	try {
		const excludesFilePath = await getConfigValue(ctx, "core.excludesFile");
		if (excludesFilePath) {
			try {
				const content = await ctx.fs.readFile(excludesFilePath);
				stack.globalExclude = parseIgnoreFile(content, "", excludesFilePath);
			} catch {
				// File doesn't exist — that's fine
			}
		}
	} catch {
		// No config — that's fine
	}

	return stack;
}

/**
 * Push a per-directory .gitignore onto the stack.
 * Returns a new stack with the additional patterns.
 */
export function pushDirIgnore(
	stack: IgnoreStack,
	content: string,
	dirRelative: string,
	src: string,
): IgnoreStack {
	const base = dirRelative === "" ? "" : dirRelative;
	const pl = parseIgnoreFile(content, base, src);
	return {
		...stack,
		dirPatterns: [...stack.dirPatterns, pl],
	};
}
