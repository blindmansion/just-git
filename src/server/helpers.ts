/**
 * Standalone helper functions for working with GitRepo.
 *
 * Thin wrappers over lib/ primitives. Useful inside server hooks
 * and equally useful outside the server for direct repo inspection.
 */

import type { CommitEntry } from "../lib/commit-walk.ts";
import { walkCommits } from "../lib/commit-walk.ts";
import {
	findAllMergeBases as _findMergeBases,
	isAncestor as _isAncestor,
	type MergeConflict,
} from "../lib/merge.ts";
import { mergeOrtRecursive, mergeOrtNonRecursive } from "../lib/merge-ort.ts";
import {
	readBlobBytes,
	readBlobContent,
	readCommit as _readCommit,
	writeObject,
} from "../lib/object-db.ts";
import { serializeCommit } from "../lib/objects/commit.ts";
import { serializeTree } from "../lib/objects/tree.ts";
import { resolveRef as _resolveRef, listRefs } from "../lib/refs.ts";
import { diffTrees as _diffTrees, flattenTree as _flattenTree } from "../lib/tree-ops.ts";
import type { FlatTreeEntry } from "../lib/tree-ops.ts";
import type { Commit, GitRepo, Identity, RefEntry, TreeDiffEntry } from "../lib/types.ts";

export type { CommitEntry } from "../lib/commit-walk.ts";
export type { MergeConflict } from "../lib/merge.ts";

/**
 * Walk commits introduced by a ref update (newHash excluding oldHash).
 * If oldHash is null (new ref), walks all ancestors of newHash.
 */
export async function* getNewCommits(
	repo: GitRepo,
	oldHash: string | null,
	newHash: string,
): AsyncGenerator<CommitEntry> {
	const exclude = oldHash ? [oldHash] : [];
	yield* walkCommits(repo, newHash, { exclude });
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
