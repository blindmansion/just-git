import {
	findObjectsByPrefix,
	objectExists,
	peelToCommit,
	readCommit,
	readObject,
} from "./object-db.ts";
import { readIndex } from "./index.ts";
import { parseCommit } from "./objects/commit.ts";
import { parseTag } from "./objects/tag.ts";
import { parseTree } from "./objects/tree.ts";
import { join } from "./path.ts";
import { readReflog } from "./reflog.ts";
import { resolveRef } from "./refs.ts";
import { FileMode, type GitContext, type GitRepo, type ObjectId } from "./types.ts";

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
async function resolveShortHash(ctx: GitRepo, prefix: string): Promise<ObjectId | null> {
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
async function resolveBaseRef(ctx: GitRepo, ref: string): Promise<ObjectId | null> {
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
async function peelToType(ctx: GitRepo, hash: ObjectId, target: string): Promise<ObjectId | null> {
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

async function applySuffixes(
	ctx: GitRepo,
	startHash: ObjectId,
	suffixes: RevSuffix[],
): Promise<ObjectId | null> {
	let hash: ObjectId | null = startHash;

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

	return applySuffixes(ctx, hash, suffixes);
}

/**
 * Resolve a revision string against a `GitRepo` (no filesystem needed).
 *
 * Same capabilities as {@link resolveRevision} except reflog syntax
 * (`@{N}`) is not supported — reflog entries live on-disk and require
 * a full `GitContext`.
 */
export async function resolveRevisionRepo(ctx: GitRepo, rev: string): Promise<ObjectId | null> {
	const { base, reflogIndex, suffixes } = parseRevSuffixes(rev);

	if (reflogIndex !== undefined) return null;

	const hash = await resolveBaseRef(ctx, base);
	if (!hash) return null;

	return applySuffixes(ctx, hash, suffixes);
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

/**
 * What a `<rev>:<path>` or `:[<stage>:]<path>` object name points at: the
 * object, and its mode in the tree or index (`undefined` for a revision's
 * root tree, `<rev>:`).
 */
export type RevPathTarget = { hash: ObjectId; mode?: string } | { error: string };

/**
 * Resolve git's `<rev>:<path>` and `:[<stage>:]<path>` object names, as
 * `get_oid_with_context` does. Returns null when `spec` has no colon.
 *
 * - `<rev>:<path>` looks the path up in the revision's tree. The path is
 *   relative to the repository root unless it starts with `./` or `../`,
 *   which are relative to `cwdPrefix`. Empty, `.` and `..` components are
 *   not allowed elsewhere, and a trailing slash only after a directory.
 *   An empty path is the root tree.
 * - `:<path>` and `:<n>:<path>` (n = 0..3) look the path up in the index
 *   at that stage (0 when omitted), with the same `./` and `../` rule.
 *
 * `:/<text>` (commit message search) is not supported and is reported as
 * an invalid name.
 */
export async function resolveRevPath(
	ctx: GitContext,
	spec: string,
	cwdPrefix: string,
): Promise<RevPathTarget | null> {
	const colon = spec.indexOf(":");
	if (colon < 0) return null;
	const invalid = { error: `Not a valid object name ${spec}` };

	if (colon === 0) {
		let rest = spec.slice(1);
		let stage = 0;
		if (/^[0-3]:/.test(rest)) {
			stage = Number(rest[0]);
			rest = rest.slice(2);
		}
		if (rest.startsWith("/")) return invalid;
		const path = resolveCwdRelative(ctx, rest, cwdPrefix);
		if (typeof path !== "string") return path;
		const entry = (await readIndex(ctx)).entries.find((e) => e.path === path && e.stage === stage);
		if (!entry) return invalid;
		return { hash: entry.hash, mode: entry.mode.toString(8).padStart(6, "0") };
	}

	const revHash = await resolveRevision(ctx, spec.slice(0, colon));
	if (!revHash) return invalid;
	const rootTree = await peelToTree(ctx, revHash);
	if (!rootTree) return invalid;

	let path = resolveCwdRelative(ctx, spec.slice(colon + 1), cwdPrefix);
	if (typeof path !== "string") return path;
	if (path === "") return { hash: rootTree };
	const trailingSlash = path.endsWith("/");
	if (trailingSlash) path = path.slice(0, -1);

	let hash = rootTree;
	let mode: string = FileMode.DIRECTORY;
	for (const name of path.split("/")) {
		if (name === "" || name === "." || name === "..") return invalid;
		if (mode !== FileMode.DIRECTORY) return invalid;
		const raw = await readObject(ctx, hash);
		if (raw.type !== "tree") return invalid;
		const entry = parseTree(raw.content).entries.find((e) => e.name === name);
		if (!entry) return invalid;
		hash = entry.hash;
		mode = entry.mode;
	}
	if (trailingSlash && mode !== FileMode.DIRECTORY) return invalid;
	return { hash, mode };
}

/**
 * Apply git's rule for the path part of `<rev>:<path>`: `./` and `../`
 * paths are joined to the cwd prefix (and normalized), others are kept.
 */
function resolveCwdRelative(
	ctx: GitContext,
	rawPath: string,
	cwdPrefix: string,
): string | { error: string } {
	if (!rawPath.startsWith("./") && !rawPath.startsWith("../")) return rawPath;
	let path = join(cwdPrefix, rawPath).replace(/\/$/, "");
	if (path === ".") path = "";
	if (path === ".." || path.startsWith("../")) {
		return { error: `'${rawPath}' is outside repository at '${ctx.workTree ?? ctx.gitDir}'` };
	}
	// git keeps one trailing slash, e.g. `HEAD:./` from a subdirectory.
	return rawPath.endsWith("/") && path !== "" ? `${path}/` : path;
}

/** Peel a commit or tag to its tree. Returns null for blobs (or tags of blobs). */
export async function peelToTree(ctx: GitRepo, hash: ObjectId): Promise<ObjectId | null> {
	let current = hash;
	for (;;) {
		const raw = await readObject(ctx, current);
		if (raw.type === "tree") return current;
		if (raw.type === "commit") return parseCommit(raw.content).tree;
		if (raw.type !== "tag") return null;
		current = parseTag(raw.content).object;
	}
}
