import {
	findObjectsByPrefix,
	objectExists,
	peelToCommit,
	readCommit,
	readObject,
} from "./object-db.ts";
import { readReflog } from "./reflog.ts";
import { resolveRef } from "./refs.ts";
import type { GitContext, ObjectId } from "./types.ts";

// ── Suffix types ─────────────────────────────────────────────────

type RevSuffix =
	| { type: "tilde"; n: number }
	| { type: "caret"; n: number }
	| { type: "peel"; target: string };

/**
 * Parse a revision string into a base ref, optional reflog index, and suffix operators.
 *
 * Examples:
 *   "HEAD~3"        → base="HEAD",  reflogIndex=undefined, suffixes=[{tilde,3}]
 *   "HEAD^2"        → base="HEAD",  reflogIndex=undefined, suffixes=[{caret,2}]
 *   "HEAD@{2}"      → base="HEAD",  reflogIndex=2,         suffixes=[]
 *   "main@{0}~3"    → base="main",  reflogIndex=0,         suffixes=[{tilde,3}]
 *   "HEAD@{1}^2"    → base="HEAD",  reflogIndex=1,         suffixes=[{caret,2}]
 */
function parseRevSuffixes(rev: string): {
	base: string;
	reflogIndex?: number;
	suffixes: RevSuffix[];
} {
	const suffixes: RevSuffix[] = [];
	let i = rev.length;

	// Walk backwards to peel off suffix operators
	while (i > 0) {
		// Try to match ~N or ~ at position before i
		const tildeMatch = rev.slice(0, i).match(/^(.+?)~(\d*)$/);
		if (tildeMatch && tildeMatch[1] !== undefined && tildeMatch[2] !== undefined) {
			const n = tildeMatch[2] === "" ? 1 : parseInt(tildeMatch[2], 10);
			suffixes.unshift({ type: "tilde", n });
			i = tildeMatch[1].length;
			continue;
		}

		// Try to match ^{type} peel syntax at position before i
		const peelMatch = rev.slice(0, i).match(/^(.+?)\^{([^}]*)}$/);
		if (peelMatch && peelMatch[1] !== undefined && peelMatch[2] !== undefined) {
			suffixes.unshift({ type: "peel", target: peelMatch[2] });
			i = peelMatch[1].length;
			continue;
		}

		// Try to match ^N or ^ at position before i
		const caretMatch = rev.slice(0, i).match(/^(.+?)\^(\d*)$/);
		if (caretMatch && caretMatch[1] !== undefined && caretMatch[2] !== undefined) {
			const n = caretMatch[2] === "" ? 1 : parseInt(caretMatch[2], 10);
			suffixes.unshift({ type: "caret", n });
			i = caretMatch[1].length;
			continue;
		}

		break;
	}

	// Check for @{N} reflog syntax on the base
	const base = rev.slice(0, i);
	const reflogMatch = base.match(/^(.+?)@\{(\d+)\}$/);
	if (reflogMatch && reflogMatch[1] !== undefined && reflogMatch[2] !== undefined) {
		return {
			base: reflogMatch[1],
			reflogIndex: parseInt(reflogMatch[2], 10),
			suffixes,
		};
	}

	return { base, suffixes };
}

// ── Special refs ────────────────────────────────────────────────

const SPECIAL_REFS = [
	"HEAD",
	"FETCH_HEAD",
	"ORIG_HEAD",
	"MERGE_HEAD",
	"CHERRY_PICK_HEAD",
	"REBASE_HEAD",
];

// ── Short hash resolution ───────────────────────────────────────

/**
 * Resolve a short hex prefix (4-39 chars) to a full ObjectId.
 * Searches both loose objects and packfiles via the object store.
 * Returns the full hash if exactly one match is found, null if none,
 * and throws on ambiguity.
 */
async function resolveShortHash(ctx: GitContext, prefix: string): Promise<ObjectId | null> {
	const matches = await findObjectsByPrefix(ctx, prefix);

	if (matches.length === 0) return null;
	if (matches.length > 1) {
		throw new ShortHashAmbiguousError(prefix);
	}
	return matches[0]!;
}

class ShortHashAmbiguousError extends Error {
	constructor(public readonly prefix: string) {
		super(`short object ID ${prefix} is ambiguous`);
	}
}

/**
 * Resolve a base ref (no suffix operators) to an ObjectId.
 *
 * Tries, in order:
 *   1. "@" or "HEAD"
 *   2. Special refs (FETCH_HEAD, ORIG_HEAD, MERGE_HEAD, etc.)
 *   3. Full 40-char hex hash (verified to exist)
 *   4. Short hex prefix (4-39 chars, unambiguous match)
 *   5. Branch name → refs/heads/<name>
 *   6. Tag name → refs/tags/<name>
 *   7. Remote tracking ref → refs/remotes/<name>
 */
async function resolveBaseRef(ctx: GitContext, ref: string): Promise<ObjectId | null> {
	// @ is an alias for HEAD
	if (ref === "HEAD" || ref === "@") {
		return resolveRef(ctx, "HEAD");
	}

	// Special state refs (FETCH_HEAD, ORIG_HEAD, etc.)
	if (SPECIAL_REFS.includes(ref)) {
		return resolveRef(ctx, ref);
	}

	// Full 40-char hex hash
	if (/^[0-9a-f]{40}$/.test(ref)) {
		if (await objectExists(ctx, ref)) {
			return ref;
		}
		return null;
	}

	// Short hex prefix (4-39 chars)
	if (/^[0-9a-f]{4,39}$/.test(ref)) {
		const resolved = await resolveShortHash(ctx, ref);
		if (resolved) return resolved;
	}

	// Full ref path (e.g. "refs/heads/main", "refs/tags/v1.0")
	if (ref.startsWith("refs/")) {
		const directHash = await resolveRef(ctx, ref);
		if (directHash) return directHash;
	}

	// Branch name
	const branchHash = await resolveRef(ctx, `refs/heads/${ref}`);
	if (branchHash) return branchHash;

	// Tag name
	const tagHash = await resolveRef(ctx, `refs/tags/${ref}`);
	if (tagHash) return tagHash;

	// Remote tracking ref (e.g. "origin/main" → refs/remotes/origin/main)
	const remoteHash = await resolveRef(ctx, `refs/remotes/${ref}`);
	if (remoteHash) return remoteHash;

	return null;
}

/**
 * Resolve a ref name to the reflog name git uses for lookups.
 * "HEAD" and "@" use the "HEAD" reflog directly.
 * Branch names resolve to "refs/heads/<name>", etc.
 */
function reflogRefName(base: string): string {
	if (base === "HEAD" || base === "@") return "HEAD";
	for (const special of SPECIAL_REFS) {
		if (base === special) return special;
	}
	if (base.startsWith("refs/")) return base;
	return `refs/heads/${base}`;
}

/**
 * Look up the Nth reflog entry for a ref, returning the hash it pointed to.
 * Index 0 = current value, 1 = previous value, etc. (newest-first, like real git).
 */
async function resolveReflogEntry(
	ctx: GitContext,
	base: string,
	n: number,
): Promise<ObjectId | null> {
	const refName = reflogRefName(base);
	const entries = await readReflog(ctx, refName);
	if (entries.length === 0) return null;
	const idx = entries.length - 1 - n;
	if (idx < 0 || idx >= entries.length) return null;
	const entry = entries[idx];
	return entry ? entry.newHash : null;
}

/**
 * Peel an object to a specific type, as in `^{commit}`, `^{tree}`, `^{blob}`, `^{tag}`, `^{}`.
 * - `^{commit}` — peel through tags to a commit
 * - `^{tree}` — peel to a commit, return its tree
 * - `^{blob}` — verify the object is a blob
 * - `^{tag}` — verify the object is a tag
 * - `^{}` — peel through tags to the first non-tag object
 */
async function peelToType(
	ctx: GitContext,
	hash: ObjectId,
	target: string,
): Promise<ObjectId | null> {
	if (target === "" || target === "commit") {
		try {
			return await peelToCommit(ctx, hash);
		} catch {
			return null;
		}
	}

	if (target === "tree") {
		let commitHash: ObjectId;
		try {
			commitHash = await peelToCommit(ctx, hash);
		} catch {
			return null;
		}
		const commit = await readCommit(ctx, commitHash);
		return commit.tree;
	}

	// ^{tag} and ^{blob}: read the object and verify its type
	const raw = await readObject(ctx, hash);
	if (raw.type !== target) return null;
	return hash;
}

/**
 * Resolve a revision string to an ObjectId.
 *
 * Supports:
 *   - "HEAD" / "@", full 40-char hex hash, branch name, tag name
 *   - Short hex prefix (4+ chars, unambiguous)
 *   - Special refs: FETCH_HEAD, ORIG_HEAD, MERGE_HEAD, CHERRY_PICK_HEAD, REBASE_HEAD
 *   - Remote tracking refs: origin/main → refs/remotes/origin/main
 *   - Reflog syntax: HEAD@{N}, main@{0}, @{2}
 *   - ~N suffix (follow first parent N times): HEAD~3
 *   - ^N suffix (Nth parent): HEAD^2, HEAD^ (= HEAD^1)
 *   - Chained suffixes: HEAD~2^2, main~1^1~3, HEAD@{1}~2
 *
 * Returns null if the revision cannot be resolved.
 */
export async function resolveRevision(ctx: GitContext, rev: string): Promise<ObjectId | null> {
	const { base, reflogIndex, suffixes } = parseRevSuffixes(rev);

	let hash: ObjectId | null;
	if (reflogIndex !== undefined) {
		hash = await resolveReflogEntry(ctx, base, reflogIndex);
	} else {
		hash = await resolveBaseRef(ctx, base);
	}
	if (!hash) return null;

	// Peel through tag objects to reach a commit before applying parent/ancestor suffixes
	const hasTildeOrCaret = suffixes.some((s) => s.type === "tilde" || s.type === "caret");
	if (hasTildeOrCaret) {
		hash = await peelToCommit(ctx, hash);
	}

	for (const suffix of suffixes) {
		if (suffix.type === "peel") {
			if (!hash) return null;
			hash = await peelToType(ctx, hash, suffix.target);
		} else if (suffix.type === "tilde") {
			for (let i = 0; i < suffix.n; i++) {
				if (!hash) return null;
				const commit = await readCommit(ctx, hash);
				if (commit.parents.length === 0) return null;
				hash = commit.parents[0] ?? null;
				if (!hash) return null;
			}
		} else {
			// caret: ^0 means the commit itself, ^N means Nth parent (1-indexed)
			if (suffix.n === 0) continue;
			if (!hash) return null;
			const commit = await readCommit(ctx, hash);
			if (suffix.n > commit.parents.length) return null;
			hash = commit.parents[suffix.n - 1] ?? null;
			if (!hash) return null;
		}
	}

	return hash;
}

/**
 * Parse a `<rev>:<path>` expression. Returns null if the input
 * doesn't contain the colon separator.
 */
export function parseRevPath(spec: string): { rev: string; path: string } | null {
	const colonIdx = spec.indexOf(":");
	if (colonIdx < 0) return null;
	return {
		rev: spec.slice(0, colonIdx) || "HEAD",
		path: spec.slice(colonIdx + 1),
	};
}
