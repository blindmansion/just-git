/**
 * Standalone helper functions for working with GitRepo.
 *
 * Thin wrappers over lib/ primitives. Useful inside server hooks
 * and equally useful outside the server for direct repo inspection.
 */

import type { CommitEntry } from "../lib/commit-walk.ts";
import { walkCommits } from "../lib/commit-walk.ts";
import { isAncestor as _isAncestor } from "../lib/merge.ts";
import { readBlobBytes, readBlobContent, readCommit as _readCommit } from "../lib/object-db.ts";
import { resolveRef as _resolveRef, listRefs } from "../lib/refs.ts";
import { diffTrees as _diffTrees, flattenTree as _flattenTree } from "../lib/tree-ops.ts";
import type { FlatTreeEntry } from "../lib/tree-ops.ts";
import type { Commit, GitRepo, RefEntry, TreeDiffEntry } from "../lib/types.ts";

export type { CommitEntry } from "../lib/commit-walk.ts";

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
