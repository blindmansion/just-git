/**
 * Standalone helper functions for working with GitRepo.
 *
 * Thin wrappers over lib/ primitives. Useful inside server hooks
 * and equally useful outside the server for direct repo inspection.
 */

import { blame as _blame, type BlameEntry } from "../lib/blame.ts";
import { compilePattern, grepContent, type GrepMatch } from "../lib/grep.ts";
import { walkCommits, countAheadBehind as _countAheadBehind } from "../lib/commit-walk.ts";
import {
	findAllMergeBases as _findMergeBases,
	isAncestor as _isAncestor,
	type MergeConflict,
} from "../lib/merge.ts";
import { mergeOrtRecursive, mergeOrtNonRecursive } from "../lib/merge-ort.ts";
import { buildIndex, defaultStat, writeIndex } from "../lib/index.ts";
import {
	readBlobBytes,
	readBlobContent,
	readCommit as _readCommit,
	writeObject,
} from "../lib/object-db.ts";
import { serializeCommit } from "../lib/objects/commit.ts";
import { serializeTree } from "../lib/objects/tree.ts";
import { dirname, join } from "../lib/path.ts";
import { resolveRef as _resolveRef, listRefs } from "../lib/refs.ts";
import { isInsideWorkTree, verifyPath, verifySymlinkTarget } from "../lib/path-safety.ts";
import { isSymlinkMode } from "../lib/symlink.ts";
import { diffTrees as _diffTrees, flattenTree as _flattenTree } from "../lib/tree-ops.ts";
import type { FlatTreeEntry } from "../lib/tree-ops.ts";
import { normalizeRef } from "../lib/types.ts";
import type {
	Commit,
	GitContext,
	GitRepo,
	Identity,
	ObjectId,
	ObjectStore,
	ObjectType,
	RawObject,
	Ref,
	RefEntry,
	RefStore,
	TreeDiffEntry,
} from "../lib/types.ts";
import type { FileSystem } from "../fs.ts";
import { envelope } from "../lib/object-store.ts";
import { sha1 } from "../lib/sha1.ts";
import { readPack } from "../lib/pack/packfile.ts";
import { TreeBackedFs } from "../tree-backed-fs.ts";

export type { MergeConflict } from "../lib/merge.ts";

/** Commit metadata returned by {@link getNewCommits}. */
export interface CommitInfo {
	hash: string;
	message: string;
	tree: string;
	parents: string[];
	author: Identity;
	committer: Identity;
}

/**
 * Walk commits introduced by a ref update (newHash excluding oldHash).
 * If oldHash is null (new ref), walks all ancestors of newHash.
 */
export async function* getNewCommits(
	repo: GitRepo,
	oldHash: string | null,
	newHash: string,
): AsyncGenerator<CommitInfo> {
	const exclude = oldHash ? [oldHash] : [];
	for await (const entry of walkCommits(repo, newHash, { exclude })) {
		yield {
			hash: entry.hash,
			message: entry.commit.message,
			tree: entry.commit.tree,
			parents: entry.commit.parents,
			author: entry.commit.author,
			committer: entry.commit.committer,
		};
	}
}

/**
 * Get the files changed between two commits.
 * Reads the tree hash from each commit and diffs them.
 * If oldHash is null (new ref), diffs against an empty tree.
 */
export async function getChangedFiles(
	repo: GitRepo,
	oldHash: string | null,
	newHash: string,
): Promise<TreeDiffEntry[]> {
	const newCommit = await _readCommit(repo, newHash);
	let oldTree: string | null = null;
	if (oldHash) {
		const oldCommit = await _readCommit(repo, oldHash);
		oldTree = oldCommit.tree;
	}
	return _diffTrees(repo, oldTree, newCommit.tree);
}

/** Check whether `candidate` is an ancestor of `descendant` in the commit graph. */
export async function isAncestor(
	repo: GitRepo,
	candidate: string,
	descendant: string,
): Promise<boolean> {
	return _isAncestor(repo, candidate, descendant);
}

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

/** Recursively walk a tree object and return all file entries with their full paths. */
export async function flattenTree(repo: GitRepo, treeHash: string): Promise<FlatTreeEntry[]> {
	return _flattenTree(repo, treeHash);
}

/** Diff two tree objects and return the list of added/deleted/modified entries. Pass null for an empty tree. */
export async function diffTrees(
	repo: GitRepo,
	treeA: string | null,
	treeB: string | null,
): Promise<TreeDiffEntry[]> {
	return _diffTrees(repo, treeA, treeB);
}

/** Find the merge base(s) of two commits. Returns one hash for most cases, multiple for criss-cross merges. */
export async function findMergeBases(
	repo: GitRepo,
	commitA: string,
	commitB: string,
): Promise<string[]> {
	return _findMergeBases(repo, commitA, commitB);
}

// ── Tree-level merge ────────────────────────────────────────────────

/** Result of a tree-level merge via {@link mergeTrees} or {@link mergeTreesFromTreeHashes}. */
export interface MergeTreesResult {
	/** Hash of the result tree (may contain conflict-marker blobs). */
	treeHash: string;
	/** True if the merge completed without conflicts. */
	clean: boolean;
	/** Details of each conflict, if any. */
	conflicts: MergeConflict[];
	/** Informational messages from the merge engine. */
	messages: string[];
}

/**
 * Three-way tree merge using merge-ort. Operates purely on the object
 * store — no filesystem or worktree needed.
 *
 * Takes two commit hashes, finds their merge base(s) automatically
 * (handling criss-cross merges via recursive base merging), and produces
 * a result tree with conflict-marker blobs embedded for any conflicts.
 *
 * Use `mergeTreesFromTreeHashes` if you already have tree hashes and a
 * known base tree.
 */
export async function mergeTrees(
	repo: GitRepo,
	oursCommit: string,
	theirsCommit: string,
	labels?: { ours?: string; theirs?: string },
): Promise<MergeTreesResult> {
	const mergeLabels = labels
		? { a: labels.ours ?? "ours", b: labels.theirs ?? "theirs" }
		: undefined;

	const result = await mergeOrtRecursive(repo, oursCommit, theirsCommit, mergeLabels);

	return {
		treeHash: result.resultTree,
		clean: result.conflicts.length === 0,
		conflicts: result.conflicts,
		messages: result.messages,
	};
}

/**
 * Three-way tree merge from raw tree hashes. Useful when you already
 * have the base/ours/theirs trees and don't want automatic merge-base
 * computation.
 */
export async function mergeTreesFromTreeHashes(
	repo: GitRepo,
	baseTree: string | null,
	oursTree: string,
	theirsTree: string,
	labels?: { ours?: string; theirs?: string },
): Promise<MergeTreesResult> {
	const mergeLabels = labels
		? { a: labels.ours ?? "ours", b: labels.theirs ?? "theirs" }
		: undefined;

	const result = await mergeOrtNonRecursive(repo, baseTree, oursTree, theirsTree, mergeLabels);

	return {
		treeHash: result.resultTree,
		clean: result.conflicts.length === 0,
		conflicts: result.conflicts,
		messages: result.messages,
	};
}

// ── Commit creation ─────────────────────────────────────────────────

/** Options for {@link createCommit}. */
export interface CreateCommitOptions {
	/** Hash of the tree object for this commit. */
	tree: string;
	/** Parent commit hashes (empty for root commits). */
	parents: string[];
	author: Identity;
	committer: Identity;
	message: string;
	/**
	 * When set, advances `refs/heads/<branch>` to the new commit.
	 * If HEAD does not exist yet, it is created as a symbolic ref
	 * pointing to the branch — matching `git init` + `git commit`.
	 */
	branch?: string;
}

/**
 * Create a commit object directly in the object store.
 * Returns the new commit's hash.
 *
 * When `branch` is provided, also advances the branch ref and
 * (if HEAD is absent) initializes HEAD as a symbolic ref to it.
 * Without `branch`, no refs are updated.
 */
export async function createCommit(repo: GitRepo, options: CreateCommitOptions): Promise<string> {
	const content = serializeCommit({
		type: "commit",
		tree: options.tree,
		parents: options.parents,
		author: options.author,
		committer: options.committer,
		message: options.message,
	});
	const hash = await writeObject(repo, "commit", content);

	if (options.branch) {
		const branchRef = `refs/heads/${options.branch}`;
		await repo.refStore.writeRef(branchRef, { type: "direct", hash });
		const head = await repo.refStore.readRef("HEAD");
		if (!head) {
			await repo.refStore.writeRef("HEAD", { type: "symbolic", target: branchRef });
		}
	}

	return hash;
}

// ── Tree construction ───────────────────────────────────────────────

/** An entry to include in a tree built by {@link writeTree}. */
export interface TreeEntryInput {
	/** Filename (not a path — nesting is achieved by including tree entries). */
	name: string;
	/** Hash of the blob or tree object. */
	hash: string;
	/** File mode (e.g. "100644"). Auto-detected from the object store when omitted. */
	mode?: string;
}

/**
 * Build a tree object from a flat list of entries and write it to the
 * object store. When `mode` is omitted, the object store is consulted:
 * tree objects get "040000", everything else gets "100644".
 *
 * For creating blobs to reference in the tree, write content directly
 * via `repo.objectStore.write("blob", content)`.
 */
export async function writeTree(repo: GitRepo, entries: TreeEntryInput[]): Promise<string> {
	const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
	const resolved = await Promise.all(
		sorted.map(async (e) => {
			let mode = e.mode;
			if (!mode) {
				const obj = await repo.objectStore.read(e.hash);
				mode = obj.type === "tree" ? "040000" : "100644";
			}
			return { mode, name: e.name, hash: e.hash };
		}),
	);
	const content = serializeTree({ type: "tree", entries: resolved });
	return writeObject(repo, "tree", content);
}

/**
 * Write a UTF-8 string as a blob to the object store.
 * Returns the blob's hash.
 */
export async function writeBlob(repo: GitRepo, content: string): Promise<string> {
	return writeObject(repo, "blob", new TextEncoder().encode(content));
}

// ── File read at commit ─────────────────────────────────────────────

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

// ── Internal helpers ────────────────────────────────────────────────

const HEX40 = /^[0-9a-f]{40}$/;

async function resolveToCommitHash(repo: GitRepo, refOrHash: string): Promise<string> {
	const resolved = await _resolveRef(repo, refOrHash);
	if (resolved) return resolved;
	if (HEX40.test(refOrHash) && (await repo.objectStore.exists(refOrHash))) {
		return refOrHash;
	}
	throw new Error(`ref or commit '${refOrHash}' not found`);
}

async function materializeEntries(
	repo: GitRepo,
	entries: FlatTreeEntry[],
	fs: FileSystem,
	rootDir: string,
): Promise<number> {
	const createdDirs = new Set<string>();
	let filesWritten = 0;

	for (const entry of entries) {
		if (!verifyPath(entry.path)) {
			throw new Error(`refusing to check out unsafe path '${entry.path}'`);
		}
		const fullPath = join(rootDir, entry.path);
		if (!isInsideWorkTree(rootDir, fullPath)) {
			throw new Error(`refusing to check out path outside target directory: '${entry.path}'`);
		}
		const dir = dirname(fullPath);

		if (dir !== rootDir && !createdDirs.has(dir)) {
			await fs.mkdir(dir, { recursive: true });
			createdDirs.add(dir);
		}

		if (isSymlinkMode(entry.mode)) {
			const target = await readBlobContent(repo, entry.hash);
			if (!verifySymlinkTarget(target)) {
				throw new Error(`refusing to create symlink with unsafe target '${target}'`);
			}
			if (fs.symlink) {
				await fs.symlink(target, fullPath);
			} else {
				await fs.writeFile(fullPath, target);
			}
		} else {
			const content = await readBlobBytes(repo, entry.hash);
			await fs.writeFile(fullPath, content);
		}
		filesWritten++;
	}

	return filesWritten;
}

function indexFromEntries(entries: FlatTreeEntry[]) {
	return buildIndex(
		entries.map((e) => ({
			path: e.path,
			mode: parseInt(e.mode, 8),
			hash: e.hash,
			stage: 0,
			stat: defaultStat(),
		})),
	);
}

// ── Checkout to filesystem ──────────────────────────────────────────

/** Result of {@link extractTree}. */
export interface ExtractTreeResult {
	commitHash: string;
	treeHash: string;
	filesWritten: number;
}

/**
 * Materialize the worktree of a commit onto an arbitrary filesystem.
 *
 * Accepts a ref name ("HEAD", "refs/heads/main") or a raw commit hash.
 * Writes all tracked files under `targetDir` (default "/"). No `.git`
 * directory is created — just the working tree.
 *
 * Useful inside server hooks and platform callbacks to inspect, build,
 * or lint the code at a given commit without affecting the repo itself.
 */
export async function extractTree(
	repo: GitRepo,
	refOrHash: string,
	fs: FileSystem,
	targetDir = "/",
): Promise<ExtractTreeResult> {
	const commitHash = await resolveToCommitHash(repo, refOrHash);
	const commit = await _readCommit(repo, commitHash);
	const entries = await _flattenTree(repo, commit.tree);
	const filesWritten = await materializeEntries(repo, entries, fs, targetDir);

	return { commitHash, treeHash: commit.tree, filesWritten };
}

// ── Create worktree context ─────────────────────────────────────────

export interface CreateWorktreeOptions {
	/** Ref name or commit hash to check out (default: "HEAD"). */
	ref?: string;
	/** Root of the working tree on the VFS (default: "/"). */
	workTree?: string;
	/** Path to the `.git` directory on the VFS (default: `<workTree>/.git`). */
	gitDir?: string;
}

/** Result of {@link createWorktree}. */
export interface WorktreeResult {
	/** The fully-wired GitContext, ready for use with lib/ functions. */
	ctx: GitContext;
	commitHash: string;
	treeHash: string;
	filesWritten: number;
}

/**
 * Create a full `GitContext` backed by a repo's abstract stores.
 *
 * Populates the worktree and index on the provided filesystem from
 * a commit, then returns a `GitContext` whose `objectStore` and
 * `refStore` point at the repo's backing stores (e.g. SQLite) while
 * worktree, index, config, and reflog live on the VFS.
 *
 * The returned context can be used directly with lib/ functions.
 * To use it with `createGit()` + `Bash`, pass the repo's stores
 * through `GitOptions.objectStore` / `GitOptions.refStore` so that
 * command handlers use the shared stores instead of the VFS:
 *
 * ```ts
 * const repo = storage.repo("my-repo");
 * const fs = new InMemoryFs();
 * const { ctx } = await createWorktree(repo, fs);
 * const git = createGit({
 *   objectStore: repo.objectStore,
 *   refStore: repo.refStore,
 * });
 * const bash = new Bash({ fs, cwd: ctx.workTree!, customCommands: [git] });
 * ```
 */
export async function createWorktree(
	repo: GitRepo,
	fs: FileSystem,
	options?: CreateWorktreeOptions,
): Promise<WorktreeResult> {
	const workTree = options?.workTree ?? "/";
	const gitDir = options?.gitDir ?? join(workTree, ".git");
	const ref = options?.ref ?? "HEAD";

	await fs.mkdir(gitDir, { recursive: true });

	const commitHash = await resolveToCommitHash(repo, ref);
	const commit = await _readCommit(repo, commitHash);
	const entries = await _flattenTree(repo, commit.tree);

	const ctx: GitContext = {
		...repo,
		fs,
		gitDir,
		workTree,
	};

	const filesWritten = await materializeEntries(repo, entries, fs, workTree);
	await writeIndex(ctx, indexFromEntries(entries));

	return { ctx, commitHash, treeHash: commit.tree, filesWritten };
}

// ── Ahead/behind ────────────────────────────────────────────────────

/**
 * Count how many commits `localHash` is ahead of and behind `upstreamHash`.
 * Useful for tracking info display and branch comparison.
 */
export async function countAheadBehind(
	repo: GitRepo,
	localHash: string,
	upstreamHash: string,
): Promise<{ ahead: number; behind: number }> {
	return _countAheadBehind(repo, localHash, upstreamHash);
}

// ── Blame ───────────────────────────────────────────────────────────

export type { BlameEntry };

/**
 * Compute line-by-line blame for a file at a given commit.
 * Returns one entry per line with the originating commit, author, and content.
 * Optionally restrict to a line range with `startLine` / `endLine` (1-based).
 */
export async function blame(
	repo: GitRepo,
	commitHash: string,
	path: string,
	opts?: { startLine?: number; endLine?: number },
): Promise<BlameEntry[]> {
	return _blame(repo, commitHash, path, opts);
}

// ── Commit history walk ─────────────────────────────────────────────

/**
 * Walk the commit graph starting from one or more hashes, yielding
 * commits in reverse chronological order. Supports excluding commits
 * reachable from specified hashes and following only first parents.
 */
export async function* walkCommitHistory(
	repo: GitRepo,
	startHash: string | string[],
	opts?: { exclude?: string[]; firstParent?: boolean },
): AsyncGenerator<CommitInfo> {
	for await (const entry of walkCommits(repo, startHash, opts)) {
		yield {
			hash: entry.hash,
			message: entry.commit.message,
			tree: entry.commit.tree,
			parents: entry.commit.parents,
			author: entry.commit.author,
			committer: entry.commit.committer,
		};
	}
}

// ── Read-only repo wrapper ──────────────────────────────────────────

class ReadonlyObjectStore implements ObjectStore {
	constructor(private inner: ObjectStore) {}

	read(hash: ObjectId): Promise<RawObject> {
		return this.inner.read(hash);
	}
	write(_type: ObjectType, _content: Uint8Array): Promise<ObjectId> {
		throw new Error("cannot write: object store is read-only");
	}
	exists(hash: ObjectId): Promise<boolean> {
		return this.inner.exists(hash);
	}
	ingestPack(_packData: Uint8Array): Promise<number> {
		throw new Error("cannot ingest pack: object store is read-only");
	}
	findByPrefix(prefix: string): Promise<ObjectId[]> {
		return this.inner.findByPrefix(prefix);
	}
}

class ReadonlyRefStore implements RefStore {
	constructor(private inner: RefStore) {}

	readRef(name: string): Promise<Ref | null> {
		return this.inner.readRef(name);
	}
	writeRef(_name: string, _ref: Ref | string): Promise<void> {
		throw new Error("cannot write ref: ref store is read-only");
	}
	deleteRef(_name: string): Promise<void> {
		throw new Error("cannot delete ref: ref store is read-only");
	}
	listRefs(prefix?: string): Promise<RefEntry[]> {
		return this.inner.listRefs(prefix);
	}
	compareAndSwapRef(
		_name: string,
		_expectedOldHash: string | null,
		_newRef: Ref | null,
	): Promise<boolean> {
		throw new Error("cannot update ref: ref store is read-only");
	}
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

/**
 * Wrap a `GitRepo` so all write operations throw.
 *
 * Read operations (readRef, read, exists, listRefs, findByPrefix)
 * pass through to the underlying stores. Write operations (write,
 * writeRef, deleteRef, ingestPack, compareAndSwapRef) throw with
 * a descriptive error.
 *
 * Use with `createWorktree` and/or `GitOptions.objectStore` /
 * `GitOptions.refStore` to enforce read-only access:
 *
 * ```ts
 * const ro = readonlyRepo(storage.repo("my-repo"));
 * const { ctx } = await createWorktree(ro, fs, { workTree: "/repo" });
 * const git = createGit({
 *   objectStore: ro.objectStore,
 *   refStore: ro.refStore,
 * });
 * ```
 */
export function readonlyRepo(repo: GitRepo): GitRepo {
	return {
		objectStore: new ReadonlyObjectStore(repo.objectStore),
		refStore: new ReadonlyRefStore(repo.refStore),
		hooks: repo.hooks,
	};
}

// ── Overlay repo wrapper ───────────────────────────────────────────

class OverlayObjectStore implements ObjectStore {
	private overlay = new Map<ObjectId, RawObject>();

	constructor(private inner: ObjectStore) {}

	async read(hash: ObjectId): Promise<RawObject> {
		const local = this.overlay.get(hash);
		if (local) return { type: local.type, content: new Uint8Array(local.content) };
		return this.inner.read(hash);
	}

	async write(type: ObjectType, content: Uint8Array): Promise<ObjectId> {
		const hash = await sha1(envelope(type, content));
		if (!this.overlay.has(hash)) {
			const existsInner = await this.inner.exists(hash).catch(() => false);
			if (!existsInner) {
				this.overlay.set(hash, { type, content: new Uint8Array(content) });
			}
		}
		return hash;
	}

	async exists(hash: ObjectId): Promise<boolean> {
		if (this.overlay.has(hash)) return true;
		return this.inner.exists(hash);
	}

	async ingestPack(packData: Uint8Array): Promise<number> {
		if (packData.byteLength < 32) return 0;
		const view = new DataView(packData.buffer, packData.byteOffset, packData.byteLength);
		const numObjects = view.getUint32(8);
		if (numObjects === 0) return 0;

		const store = this.overlay;
		const inner = this.inner;
		const entries = await readPack(packData, async (hash) => {
			const local = store.get(hash);
			if (local) return { type: local.type, content: new Uint8Array(local.content) };
			try {
				return await inner.read(hash);
			} catch {
				return null;
			}
		});

		for (const entry of entries) {
			if (!store.has(entry.hash)) {
				store.set(entry.hash, { type: entry.type as ObjectType, content: entry.content });
			}
		}
		return entries.length;
	}

	async findByPrefix(prefix: string): Promise<ObjectId[]> {
		const innerMatches = await this.inner.findByPrefix(prefix);
		const localMatches: ObjectId[] = [];
		for (const hash of this.overlay.keys()) {
			if (hash.startsWith(prefix)) localMatches.push(hash);
		}
		const combined = new Set([...innerMatches, ...localMatches]);
		return [...combined];
	}
}

class OverlayRefStore implements RefStore {
	private overlay = new Map<string, Ref>();
	private deleted = new Set<string>();

	constructor(private inner: RefStore) {}

	async readRef(name: string): Promise<Ref | null> {
		if (this.deleted.has(name)) return null;
		const local = this.overlay.get(name);
		if (local) return local;
		return this.inner.readRef(name);
	}

	async writeRef(name: string, refOrHash: Ref | string): Promise<void> {
		this.deleted.delete(name);
		this.overlay.set(name, normalizeRef(refOrHash));
	}

	async deleteRef(name: string): Promise<void> {
		this.overlay.delete(name);
		this.deleted.add(name);
	}

	async listRefs(prefix?: string): Promise<RefEntry[]> {
		const inner = await this.inner.listRefs(prefix);
		const results = new Map<string, RefEntry>();

		for (const entry of inner) {
			if (!this.deleted.has(entry.name)) {
				results.set(entry.name, entry);
			}
		}

		for (const [name, ref] of this.overlay) {
			if (prefix && !name.startsWith(prefix)) continue;
			if (ref.type === "direct") {
				results.set(name, { name, hash: ref.hash });
			} else if (ref.type === "symbolic") {
				// Resolve through overlay-aware readRef
				const resolved = await this.resolveSymbolic(ref.target);
				if (resolved) results.set(name, { name, hash: resolved });
			}
		}

		return [...results.values()];
	}

	async compareAndSwapRef(
		name: string,
		expectedOldHash: string | null,
		newRef: Ref | null,
	): Promise<boolean> {
		// Resolve current value through overlay
		const current = await this.readRef(name);
		let currentHash: string | null = null;
		if (current) {
			if (current.type === "direct") {
				currentHash = current.hash;
			} else if (current.type === "symbolic") {
				currentHash = await this.resolveSymbolic(current.target);
			}
		}

		if (expectedOldHash === null) {
			if (current !== null) return false;
		} else {
			if (currentHash !== expectedOldHash) return false;
		}

		if (newRef === null) {
			this.overlay.delete(name);
			this.deleted.add(name);
		} else {
			this.deleted.delete(name);
			this.overlay.set(name, newRef);
		}
		return true;
	}

	private async resolveSymbolic(target: string, depth = 0): Promise<string | null> {
		if (depth > 10) return null;
		const ref = await this.readRef(target);
		if (!ref) return null;
		if (ref.type === "direct") return ref.hash;
		if (ref.type === "symbolic") return this.resolveSymbolic(ref.target, depth + 1);
		return null;
	}
}

/**
 * Wrap a `GitRepo` with copy-on-write overlay stores.
 *
 * Read operations pass through to the underlying stores.
 * Write operations (write, writeRef, deleteRef, ingestPack,
 * compareAndSwapRef) are captured in an in-memory overlay
 * and never reach the inner repo.
 *
 * Use for ephemeral operations (CI, previews, dry-run merges)
 * where you need full read-write semantics but must not
 * mutate the real repository.
 *
 * ```ts
 * const ephemeral = overlayRepo(storage.repo("my-repo"));
 * // writes succeed but only exist in memory
 * await ephemeral.objectStore.write("blob", content);
 * // original repo is untouched
 * ```
 */
export function overlayRepo(repo: GitRepo): GitRepo {
	return {
		objectStore: new OverlayObjectStore(repo.objectStore),
		refStore: new OverlayRefStore(repo.refStore),
		hooks: repo.hooks,
	};
}

// ── Ephemeral worktree ─────────────────────────────────────────────

/**
 * Create an ephemeral worktree backed by overlay stores and a lazy filesystem.
 *
 * - Object/ref writes go to an in-memory overlay (real repo untouched)
 * - Worktree files are read lazily from the object store on demand
 * - All state is discarded when the returned context goes out of scope
 *
 * Designed for server hooks that need to run tools against pushed code
 * without paying the cost of materializing the entire tree and without
 * risking mutation of the real repository.
 *
 * ```ts
 * hooks: {
 *   async preReceive({ repo, updates }) {
 *     const { ctx } = await createSandboxWorktree(repo, {
 *       ref: updates[0].newHash,
 *     });
 *     const git = createGit({
 *       objectStore: ctx.objectStore,
 *       refStore: ctx.refStore,
 *     });
 *     const bash = new Bash({ fs: ctx.fs, cwd: ctx.workTree! });
 *     const result = await bash.exec("cat package.json");
 *     // reads lazily from object store — only touched files are loaded
 *   }
 * }
 * ```
 */
export async function createSandboxWorktree(
	repo: GitRepo,
	options?: { ref?: string; workTree?: string; gitDir?: string },
): Promise<WorktreeResult> {
	const overlay = overlayRepo(repo);
	const workTree = options?.workTree ?? "/";
	const gitDir = options?.gitDir ?? join(workTree, ".git");
	const ref = options?.ref ?? "HEAD";

	const commitHash = await resolveToCommitHash(overlay, ref);
	const commit = await _readCommit(overlay, commitHash);
	const fs = new TreeBackedFs(overlay.objectStore, commit.tree, workTree);

	const branchRef = "refs/heads/main";
	await overlay.refStore.writeRef("HEAD", { type: "symbolic", target: branchRef });
	await overlay.refStore.writeRef(branchRef, { type: "direct", hash: commitHash });

	const ctx: GitContext = {
		...overlay,
		fs,
		gitDir,
		workTree,
	};

	const entries = await _flattenTree(overlay, commit.tree);
	await writeIndex(ctx, indexFromEntries(entries));

	return { ctx, commitHash, treeHash: commit.tree, filesWritten: 0 };
}
