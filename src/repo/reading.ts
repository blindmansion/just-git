import { readBlobBytes, readBlobContent, readCommit as _readCommit } from "../lib/object-db.ts";
import { resolveRef as _resolveRef, listRefs } from "../lib/refs.ts";
import { flattenTree as _flattenTree } from "../lib/tree-ops.ts";
import { compilePattern, grepContent, type GrepMatch } from "../lib/grep.ts";
import type { Commit, GitRepo, RefEntry } from "../lib/types.ts";

// ── Ref resolution ──────────────────────────────────────────────────

/** Resolve a ref name (e.g. "HEAD", "refs/heads/main") to a commit hash. Returns null if not found. */
export async function resolveRef(repo: GitRepo, name: string): Promise<string | null> {
	return _resolveRef(repo, name);
}

/** List all local branches (`refs/heads/*`). */
export async function listBranches(repo: GitRepo): Promise<RefEntry[]> {
	return listRefs(repo, "refs/heads");
}

/** List all tags (`refs/tags/*`). */
export async function listTags(repo: GitRepo): Promise<RefEntry[]> {
	return listRefs(repo, "refs/tags");
}

// ── Object reading ──────────────────────────────────────────────────

/** Read and parse a commit object by its hash. */
export async function readCommit(repo: GitRepo, hash: string): Promise<Commit> {
	return _readCommit(repo, hash);
}

/** Read a blob's raw bytes by its hash. */
export async function readBlob(repo: GitRepo, hash: string): Promise<Uint8Array> {
	return readBlobBytes(repo, hash);
}

/** Read a blob as a UTF-8 string by its hash. */
export async function readBlobText(repo: GitRepo, hash: string): Promise<string> {
	return readBlobContent(repo, hash);
}

/**
 * Read a file's content at a specific commit.
 * Returns null if the file doesn't exist at that commit.
 */
export async function readFileAtCommit(
	repo: GitRepo,
	commitHash: string,
	filePath: string,
): Promise<string | null> {
	const commit = await _readCommit(repo, commitHash);
	const entries = await _flattenTree(repo, commit.tree);
	const entry = entries.find((e) => e.path === filePath);
	if (!entry) return null;
	return readBlobContent(repo, entry.hash);
}

// ── Grep ────────────────────────────────────────────────────────────

/** Options for {@link grep}. */
export interface GrepOptions {
	/** Treat patterns as fixed strings, not regexps. */
	fixed?: boolean;
	/** Case-insensitive matching. */
	ignoreCase?: boolean;
	/** Match whole words only. */
	wordRegexp?: boolean;
	/** Require ALL patterns to hit at least one line in a file (AND). Default is OR. */
	allMatch?: boolean;
	/** Invert the match — return non-matching lines. */
	invert?: boolean;
	/** Limit matches per file. */
	maxCount?: number;
	/** Max directory depth (0 = only root-level files). */
	maxDepth?: number;
	/** Only search files whose paths match these globs. Matched against the full repo-relative path. */
	paths?: string[];
}

/** A single file's grep results from {@link grep}. */
export interface GrepFileMatch {
	/** Repo-relative file path. */
	path: string;
	/** Matching lines (empty for binary matches). */
	matches: GrepMatch[];
	/** True when the file is binary and a pattern matched its raw content. */
	binary: boolean;
}

export type { GrepMatch };

function pathDepth(p: string): number {
	let count = 0;
	for (let i = 0; i < p.length; i++) {
		if (p[i] === "/") count++;
	}
	return count;
}

function matchGlob(pattern: string, path: string): boolean {
	const re = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*\*/g, "\0")
		.replace(/\*/g, "[^/]*")
		.replace(/\?/g, "[^/]")
		.replace(/\0/g, ".*");
	return new RegExp(`^${re}$`).test(path);
}

/**
 * Search files at a commit for lines matching one or more patterns.
 *
 * Operates purely on the object store — no filesystem, index, or
 * worktree needed. Takes a commit hash (not a ref name) and returns
 * structured match results.
 *
 * ```ts
 * const results = await grep(repo, commitHash, ["TODO", "FIXME"]);
 * for (const file of results) {
 *   for (const m of file.matches) {
 *     console.log(`${file.path}:${m.lineNo}: ${m.line}`);
 *   }
 * }
 * ```
 */
export async function grep(
	repo: GitRepo,
	commitHash: string,
	patterns: (string | RegExp)[],
	options?: GrepOptions,
): Promise<GrepFileMatch[]> {
	const compiled: RegExp[] = [];
	for (const p of patterns) {
		if (p instanceof RegExp) {
			compiled.push(p);
		} else {
			const re = compilePattern(p, {
				fixed: options?.fixed,
				ignoreCase: options?.ignoreCase,
				wordRegexp: options?.wordRegexp,
			});
			if (!re) throw new Error(`Invalid pattern: ${p}`);
			compiled.push(re);
		}
	}

	const commit = await _readCommit(repo, commitHash);
	const entries = await _flattenTree(repo, commit.tree);
	const filtered = entries
		.filter((e) => !e.mode.startsWith("120"))
		.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

	const allMatch = options?.allMatch ?? false;
	const invert = options?.invert ?? false;
	const maxCount = options?.maxCount;
	const maxDepth = options?.maxDepth;
	const pathGlobs = options?.paths;

	const results: GrepFileMatch[] = [];

	for (const entry of filtered) {
		if (maxDepth !== undefined && pathDepth(entry.path) > maxDepth) continue;
		if (pathGlobs && !pathGlobs.some((g) => matchGlob(g, entry.path))) continue;

		const content = await readBlobContent(repo, entry.hash);
		const result = grepContent(content, compiled, allMatch, invert);

		if (result.binary) {
			results.push({ path: entry.path, matches: [], binary: true });
			continue;
		}

		if (result.matches.length === 0) continue;

		const matches = maxCount !== undefined ? result.matches.slice(0, maxCount) : result.matches;
		results.push({ path: entry.path, matches, binary: false });
	}

	return results;
}
