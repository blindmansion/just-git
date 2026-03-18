/**
 * Standalone helper functions for working with GitRepo.
 *
 * Thin wrappers over lib/ primitives. Useful inside server hooks
 * and equally useful outside the server for direct repo inspection.
 */

import { walkCommits } from "../lib/commit-walk.ts";
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
import { isSymlinkMode } from "../lib/symlink.ts";
import { diffTrees as _diffTrees, flattenTree as _flattenTree } from "../lib/tree-ops.ts";
import type { FlatTreeEntry } from "../lib/tree-ops.ts";
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

export type { MergeConflict } from "../lib/merge.ts";

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

export async function isAncestor(
	repo: GitRepo,
	candidate: string,
	descendant: string,
): Promise<boolean> {
	return _isAncestor(repo, candidate, descendant);
}

export async function resolveRef(repo: GitRepo, name: string): Promise<string | null> {
	return _resolveRef(repo, name);
}

export async function listBranches(repo: GitRepo): Promise<RefEntry[]> {
	return listRefs(repo, "refs/heads");
}

export async function listTags(repo: GitRepo): Promise<RefEntry[]> {
	return listRefs(repo, "refs/tags");
}

export async function readCommit(repo: GitRepo, hash: string): Promise<Commit> {
	return _readCommit(repo, hash);
}

export async function readBlob(repo: GitRepo, hash: string): Promise<Uint8Array> {
	return readBlobBytes(repo, hash);
}

export async function readBlobText(repo: GitRepo, hash: string): Promise<string> {
	return readBlobContent(repo, hash);
}

export async function flattenTree(repo: GitRepo, treeHash: string): Promise<FlatTreeEntry[]> {
	return _flattenTree(repo, treeHash);
}

export async function diffTrees(
	repo: GitRepo,
	treeA: string | null,
	treeB: string | null,
): Promise<TreeDiffEntry[]> {
	return _diffTrees(repo, treeA, treeB);
}

export async function findMergeBases(
	repo: GitRepo,
	commitA: string,
	commitB: string,
): Promise<string[]> {
	return _findMergeBases(repo, commitA, commitB);
}

// ── Tree-level merge ────────────────────────────────────────────────

export interface MergeTreesResult {
	treeHash: string;
	clean: boolean;
	conflicts: MergeConflict[];
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

export interface CreateCommitOptions {
	tree: string;
	parents: string[];
	author: Identity;
	committer: Identity;
	message: string;
}

/**
 * Create a commit object directly in the object store.
 * Returns the new commit's hash.
 *
 * This does not update any refs — call `repo.refStore.writeRef()`
 * separately to advance a branch.
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
	return writeObject(repo, "commit", content);
}

// ── Tree construction ───────────────────────────────────────────────

export interface TreeEntryInput {
	name: string;
	hash: string;
	mode?: string;
}

/**
 * Build a tree object from a flat list of entries and write it to the
 * object store. Entries default to mode "100644" (regular file).
 *
 * For creating blobs to reference in the tree, write content directly
 * via `repo.objectStore.write("blob", content)`.
 */
export async function writeTree(repo: GitRepo, entries: TreeEntryInput[]): Promise<string> {
	const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
	const content = serializeTree({
		type: "tree",
		entries: sorted.map((e) => ({
			mode: e.mode ?? "100644",
			name: e.name,
			hash: e.hash,
		})),
	});
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

// ── Checkout to filesystem ──────────────────────────────────────────

const HEX40 = /^[0-9a-f]{40}$/;

export interface CheckoutToResult {
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
export async function checkoutTo(
	repo: GitRepo,
	refOrHash: string,
	fs: FileSystem,
	targetDir = "/",
): Promise<CheckoutToResult> {
	let commitHash = await _resolveRef(repo, refOrHash);
	if (!commitHash) {
		if (HEX40.test(refOrHash) && (await repo.objectStore.exists(refOrHash))) {
			commitHash = refOrHash;
		} else {
			throw new Error(`ref or commit '${refOrHash}' not found`);
		}
	}

	const commit = await _readCommit(repo, commitHash);
	const entries = await _flattenTree(repo, commit.tree);

	const createdDirs = new Set<string>();
	let filesWritten = 0;

	for (const entry of entries) {
		const fullPath = join(targetDir, entry.path);
		const dir = dirname(fullPath);

		if (dir !== targetDir && !createdDirs.has(dir)) {
			await fs.mkdir(dir, { recursive: true });
			createdDirs.add(dir);
		}

		if (isSymlinkMode(entry.mode)) {
			const target = await readBlobContent(repo, entry.hash);
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

export interface WorktreeResult {
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

	let commitHash = await _resolveRef(repo, ref);
	if (!commitHash) {
		if (HEX40.test(ref) && (await repo.objectStore.exists(ref))) {
			commitHash = ref;
		} else {
			throw new Error(`ref or commit '${ref}' not found`);
		}
	}

	const commit = await _readCommit(repo, commitHash);
	const entries = await _flattenTree(repo, commit.tree);

	const ctx: GitContext = {
		...repo,
		fs,
		gitDir,
		workTree,
	};

	const createdDirs = new Set<string>();
	let filesWritten = 0;

	for (const entry of entries) {
		const fullPath = join(workTree, entry.path);
		const dir = dirname(fullPath);

		if (dir !== workTree && !createdDirs.has(dir)) {
			await fs.mkdir(dir, { recursive: true });
			createdDirs.add(dir);
		}

		if (isSymlinkMode(entry.mode)) {
			const target = await readBlobContent(repo, entry.hash);
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

	const index = buildIndex(
		entries.map((e) => ({
			path: e.path,
			mode: parseInt(e.mode, 8),
			hash: e.hash,
			stage: 0,
			stat: defaultStat(),
		})),
	);
	await writeIndex(ctx, index);

	return { ctx, commitHash, treeHash: commit.tree, filesWritten };
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
	writeRef(_name: string, _ref: Ref): Promise<void> {
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
