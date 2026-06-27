import { join } from "./path.ts";
import type { GitContext } from "./types.ts";
import { WM_MATCH, WM_PATHNAME, wildmatch } from "./wildmatch.ts";

// ── Attribute values ────────────────────────────────────────────────

/**
 * The resolved value of a git attribute for a path:
 * - `string` — set to a value (`attr=value`, e.g. `filter=lfs`)
 * - `true` — set (`attr`)
 * - `false` — unset (`-attr`) or explicitly unspecified (`!attr`)
 * - `undefined` — no rule decided the attribute (the default "unspecified")
 *
 * For the filters use case only the `string` form is meaningful (a driver
 * name); every other value means "no driver".
 */
export type AttrValue = string | boolean | undefined;

// ── Parsing ─────────────────────────────────────────────────────────

interface AttrPattern {
	/** Pattern body used for matching (leading `/` stripped). */
	pattern: string;
	/** Pattern has no internal slash ⇒ match against the basename at any depth. */
	nodir: boolean;
	/** Attribute assignments declared on this line. */
	attrs: Map<string, string | boolean>;
}

interface AttrFile {
	/** Directory the file lives in, relative to the work tree root (`""` = root). */
	base: string;
	patterns: AttrPattern[];
}

/**
 * Parse one `.gitattributes` line into a pattern + its attribute assignments.
 * Returns `null` for blanks, comments, and macro definitions (`[attr]…`),
 * which this focused parser does not expand.
 */
function parseAttrLine(line: string): AttrPattern | null {
	const trimmed = line.trim();
	if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("[")) {
		return null;
	}

	const tokens = trimmed.split(/\s+/);
	let pat = tokens[0]!;

	const attrs = new Map<string, string | boolean>();
	for (const tok of tokens.slice(1)) {
		if (tok.startsWith("-")) {
			attrs.set(tok.slice(1), false);
		} else if (tok.startsWith("!")) {
			// "unspecified" — for our purposes this means "no value"
			attrs.set(tok.slice(1), false);
		} else {
			const eq = tok.indexOf("=");
			if (eq >= 0) {
				attrs.set(tok.slice(0, eq), tok.slice(eq + 1));
			} else {
				attrs.set(tok, true);
			}
		}
	}

	// A leading slash anchors to the file's directory; we match relative to that
	// base, so the slash is implicit and can be dropped.
	if (pat.startsWith("/")) pat = pat.slice(1);
	const nodir = !pat.includes("/");

	return { pattern: pat, nodir, attrs };
}

function parseAttrFile(content: string, base: string): AttrFile {
	const patterns: AttrPattern[] = [];
	for (const line of content.split("\n")) {
		const p = parseAttrLine(line);
		if (p) patterns.push(p);
	}
	return { base, patterns };
}

// ── Matching ────────────────────────────────────────────────────────

function basename(path: string): string {
	const i = path.lastIndexOf("/");
	return i >= 0 ? path.slice(i + 1) : path;
}

/** Does `path` (relative to the work tree root) match this pattern? */
function matches(path: string, pat: AttrPattern, base: string): boolean {
	if (pat.nodir) {
		// A slash-less pattern matches the basename, but only for paths that
		// live at or below the directory containing the .gitattributes file.
		if (base !== "" && !path.startsWith(`${base}/`)) return false;
		return wildmatch(pat.pattern, basename(path), WM_PATHNAME) === WM_MATCH;
	}

	let rel = path;
	if (base !== "") {
		if (!path.startsWith(`${base}/`)) return false;
		rel = path.slice(base.length + 1);
	}
	return wildmatch(pat.pattern, rel, WM_PATHNAME) === WM_MATCH;
}

/** Last matching line in a file that decides `attr` wins. */
function lookupInFile(file: AttrFile, path: string, attr: string): AttrValue {
	for (let i = file.patterns.length - 1; i >= 0; i--) {
		const pat = file.patterns[i]!;
		if (!pat.attrs.has(attr)) continue;
		if (matches(path, pat, file.base)) {
			return pat.attrs.get(attr);
		}
	}
	return undefined;
}

/** A path+attr lookup over a single in-memory `.gitattributes`-format string. */
export type AttrLookup = (path: string, attr: string) => AttrValue;

/**
 * Parse a standalone `.gitattributes`-format string into a path+attr lookup,
 * rooted at the work-tree root (`base = ""`). Used for the host-policy
 * `locked` / `defaults` layers in `gitAttributes(...)`, which wrap around the
 * on-disk in-tree provider rather than living on disk themselves.
 */
export function parseAttributesText(content: string): AttrLookup {
	const file = parseAttrFile(content, "");
	return (path, attr) => lookupInFile(file, path, attr);
}

// ── Provider ────────────────────────────────────────────────────────

/**
 * Resolves git attributes for paths by reading `.gitattributes` files (and
 * `$GIT_DIR/info/attributes`) from a {@link GitContext}'s work tree. Files are
 * loaded lazily and cached, so resolving an attribute across many paths in one
 * operation re-reads each `.gitattributes` only once.
 */
export interface AttributesProvider {
	/** Resolve a single attribute for a work-tree-relative path. */
	get(path: string, attr: string): Promise<AttrValue>;
}

/** List a path's ancestor directories, deepest first, ending with the root `""`. */
function ancestorDirs(path: string): string[] {
	const dirs: string[] = [];
	let dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
	while (dir !== "") {
		dirs.push(dir);
		dir = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
	}
	dirs.push("");
	return dirs;
}

export function createAttributesProvider(ctx: GitContext): AttributesProvider {
	// dir-relative path ("" = root) → parsed file (or null if absent).
	const dirCache = new Map<string, AttrFile | null>();
	let infoCache: AttrFile | null | undefined;

	async function loadDir(dirRel: string): Promise<AttrFile | null> {
		const cached = dirCache.get(dirRel);
		if (cached !== undefined) return cached;

		let file: AttrFile | null = null;
		if (ctx.workTree) {
			const full = join(ctx.workTree, dirRel, ".gitattributes");
			try {
				file = parseAttrFile(await ctx.fs.readFile(full), dirRel);
			} catch {
				file = null;
			}
		}
		dirCache.set(dirRel, file);
		return file;
	}

	async function loadInfo(): Promise<AttrFile | null> {
		if (infoCache !== undefined) return infoCache;
		let file: AttrFile | null = null;
		try {
			file = parseAttrFile(await ctx.fs.readFile(join(ctx.gitDir, "info", "attributes")), "");
		} catch {
			file = null;
		}
		infoCache = file;
		return file;
	}

	return {
		async get(path, attr) {
			// Precedence (highest first): $GIT_DIR/info/attributes, then the
			// deepest .gitattributes up to the root. The first file to decide
			// the attribute wins.
			const info = await loadInfo();
			if (info) {
				const v = lookupInFile(info, path, attr);
				if (v !== undefined) return v;
			}
			for (const dir of ancestorDirs(path)) {
				const file = await loadDir(dir);
				if (!file) continue;
				const v = lookupInFile(file, path, attr);
				if (v !== undefined) return v;
			}
			return undefined;
		},
	};
}

/**
 * An {@link AttributesProvider} that never resolves any attribute — the in-tree
 * lookup for a bare, fs-less {@link GitRepo} (no work tree to read
 * `.gitattributes` from). The {@link CapabilityContext} always carries a
 * provider; this is the one it gets when there is no filesystem.
 */
export const emptyAttributesProvider: AttributesProvider = {
	get: () => Promise.resolve(undefined),
};
