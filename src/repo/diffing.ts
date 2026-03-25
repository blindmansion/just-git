import { blame as _blame, type BlameEntry } from "../lib/blame.ts";
import {
	CommitHeap,
	walkCommits,
	countAheadBehind as _countAheadBehind,
} from "../lib/commit-walk.ts";
import {
	buildHunks,
	myersDiff,
	splitLines,
	type Hunk,
	type HunkLine,
} from "../lib/diff-algorithm.ts";
import { findAllMergeBases as _findMergeBases, isAncestor as _isAncestor } from "../lib/merge.ts";
import { readBlobContent, readCommit as _readCommit } from "../lib/object-db.ts";
import { detectRenames } from "../lib/rename-detection.ts";
import { resolveRevisionRepo } from "../lib/rev-parse.ts";
import { diffTrees as _diffTrees, flattenTree as _flattenTree } from "../lib/tree-ops.ts";
import type { FlatTreeEntry } from "../lib/tree-ops.ts";
import type { GitRepo, Identity, ObjectId, TreeDiffEntry } from "../lib/types.ts";

export type { BlameEntry };

/** Commit metadata returned by {@link getNewCommits} and {@link walkCommitHistory}. */
export interface CommitInfo {
	hash: string;
	message: string;
	tree: string;
	parents: string[];
	author: Identity;
	committer: Identity;
}

// ── Tree diffing ────────────────────────────────────────────────────

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

/**
 * Get the files changed between two commits.
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

// ── Commit graph ────────────────────────────────────────────────────

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

/** Check whether `candidate` is an ancestor of `descendant` in the commit graph. */
export async function isAncestor(
	repo: GitRepo,
	candidate: string,
	descendant: string,
): Promise<boolean> {
	return _isAncestor(repo, candidate, descendant);
}

/** Find the merge base(s) of two commits. Returns one hash for most cases, multiple for criss-cross merges. */
export async function findMergeBases(
	repo: GitRepo,
	commitA: string,
	commitB: string,
): Promise<string[]> {
	return _findMergeBases(repo, commitA, commitB);
}

/**
 * Count how many commits `localHash` is ahead of and behind `upstreamHash`.
 */
export async function countAheadBehind(
	repo: GitRepo,
	localHash: string,
	upstreamHash: string,
): Promise<{ ahead: number; behind: number }> {
	return _countAheadBehind(repo, localHash, upstreamHash);
}

// ── Blame ───────────────────────────────────────────────────────────

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

// ── Commit-level diff ───────────────────────────────────────────────

/** A single hunk in a file diff. */
export interface DiffHunk {
	oldStart: number;
	oldCount: number;
	newStart: number;
	newCount: number;
	/** Lines prefixed with ' ' (context), '+' (insert), or '-' (delete). */
	lines: string[];
}

/** One file's diff between two commits. */
export interface FileDiff {
	path: string;
	status: "added" | "modified" | "deleted" | "renamed";
	/** Original path when status is "renamed". */
	oldPath?: string;
	/** Similarity percentage (0–100) for renames. */
	similarity?: number;
	hunks: DiffHunk[];
}

function hunkLinePrefix(type: HunkLine["type"]): string {
	if (type === "insert") return "+";
	if (type === "delete") return "-";
	return " ";
}

function toFileDiffHunk(h: Hunk): DiffHunk {
	return {
		oldStart: h.oldStart,
		oldCount: h.oldCount,
		newStart: h.newStart,
		newCount: h.newCount,
		lines: h.lines.map((l) => hunkLinePrefix(l.type) + l.content),
	};
}

function computeHunks(oldContent: string, newContent: string, contextLines?: number): DiffHunk[] {
	const oldLines = splitLines(oldContent);
	const newLines = splitLines(newContent);
	const edits = myersDiff(oldLines, newLines);
	const hunks = buildHunks(edits, contextLines);
	return hunks.map(toFileDiffHunk);
}

async function resolveToCommitHash(repo: GitRepo, refOrHash: string): Promise<string> {
	const resolved = await resolveRevisionRepo(repo, refOrHash);
	if (resolved) return resolved;
	throw new Error(`ref or commit '${refOrHash}' not found`);
}

/**
 * Produce structured, line-level diffs between two commits.
 *
 * Accepts commit hashes or ref names. Returns one `FileDiff` per
 * changed file, each containing hunks with prefixed diff lines.
 * Rename detection is enabled by default.
 *
 * ```ts
 * const diffs = await diffCommits(repo, "main", "feature");
 * for (const file of diffs) {
 *   console.log(`${file.status} ${file.path}`);
 *   for (const hunk of file.hunks) {
 *     for (const line of hunk.lines) console.log(line);
 *   }
 * }
 * ```
 */
export async function diffCommits(
	repo: GitRepo,
	base: string,
	head: string,
	options?: {
		/** Only include files matching these paths (exact prefix match). */
		paths?: string[];
		/** Number of context lines around each change (default 3). */
		contextLines?: number;
		/** Enable rename detection (default true). */
		renames?: boolean;
	},
): Promise<FileDiff[]> {
	const baseHash = await resolveToCommitHash(repo, base);
	const headHash = await resolveToCommitHash(repo, head);

	const baseCommit = await _readCommit(repo, baseHash);
	const headCommit = await _readCommit(repo, headHash);

	let diffs = await _diffTrees(repo, baseCommit.tree, headCommit.tree);

	const enableRenames = options?.renames !== false;
	const ctx = options?.contextLines;
	const pathFilter = options?.paths;

	let renames: import("../lib/rename-detection.ts").RenamePair[] = [];

	if (enableRenames) {
		const result = await detectRenames(repo, diffs);
		diffs = result.remaining;
		renames = result.renames;
	}

	const fileDiffs: FileDiff[] = [];

	for (const entry of diffs) {
		if (pathFilter && !pathFilter.some((p) => entry.path.startsWith(p))) continue;

		const oldContent = entry.oldHash ? await readBlobContent(repo, entry.oldHash) : "";
		const newContent = entry.newHash ? await readBlobContent(repo, entry.newHash) : "";
		const hunks = computeHunks(oldContent, newContent, ctx);

		fileDiffs.push({
			path: entry.path,
			status: entry.status as "added" | "modified" | "deleted",
			hunks,
		});
	}

	for (const rename of renames) {
		if (
			pathFilter &&
			!pathFilter.some((p) => rename.newPath.startsWith(p) || rename.oldPath.startsWith(p))
		)
			continue;

		const oldContent = await readBlobContent(repo, rename.oldHash);
		const newContent = await readBlobContent(repo, rename.newHash);
		const hunks = computeHunks(oldContent, newContent, ctx);

		fileDiffs.push({
			path: rename.newPath,
			status: "renamed",
			oldPath: rename.oldPath,
			similarity: rename.similarity,
			hunks,
		});
	}

	fileDiffs.sort((a, b) => a.path.localeCompare(b.path));
	return fileDiffs;
}

// ── Commit history walk ─────────────────────────────────────────────

/**
 * Walk the commit graph starting from one or more hashes, yielding
 * commits in reverse chronological order. Supports excluding commits
 * reachable from specified hashes, following only first parents,
 * limiting the number of commits yielded, and filtering to commits
 * that touch specific paths.
 *
 * When `paths` is provided, history simplification is applied: at
 * merge points, only TREESAME parents are followed (matching git's
 * default simplification for `git log -- <path>`).
 */
export async function* walkCommitHistory(
	repo: GitRepo,
	startHash: string | string[],
	opts?: { exclude?: string[]; firstParent?: boolean; paths?: string[]; limit?: number },
): AsyncGenerator<CommitInfo> {
	if (opts?.paths && opts.paths.length > 0) {
		const limit = opts?.limit;
		let count = 0;
		for await (const info of walkCommitHistoryFiltered(repo, startHash, opts.paths, opts)) {
			yield info;
			if (limit !== undefined && ++count >= limit) return;
		}
		return;
	}
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

function pathMatchesFilter(path: string, filters: string[]): boolean {
	return filters.some((f) => path === f || path.startsWith(f.endsWith("/") ? f : f + "/"));
}

async function* walkCommitHistoryFiltered(
	repo: GitRepo,
	startHash: string | string[],
	paths: string[],
	opts?: { exclude?: string[]; firstParent?: boolean },
): AsyncGenerator<CommitInfo> {
	const excludeSet = new Set<ObjectId>();
	if (opts?.exclude) {
		for await (const entry of walkCommits(repo, opts.exclude)) {
			excludeSet.add(entry.hash);
		}
	}

	const visited = new Set<ObjectId>(excludeSet);
	const queue = new CommitHeap();

	const enqueue = async (hash: ObjectId) => {
		if (!visited.has(hash)) {
			try {
				const commit = await _readCommit(repo, hash);
				queue.push({ hash, commit });
			} catch {
				// Missing parent (shallow repo)
			}
		}
	};

	const starts = Array.isArray(startHash) ? startHash : [startHash];
	for (const h of starts) await enqueue(h);

	while (queue.size > 0) {
		const entry = queue.pop()!;
		if (visited.has(entry.hash)) continue;
		visited.add(entry.hash);

		const { commit } = entry;
		const parents = opts?.firstParent ? commit.parents.slice(0, 1) : commit.parents;

		const toInfo = (): CommitInfo => ({
			hash: entry.hash,
			message: commit.message,
			tree: commit.tree,
			parents: commit.parents,
			author: commit.author,
			committer: commit.committer,
		});

		if (parents.length === 0) {
			const diff = await _diffTrees(repo, null, commit.tree);
			if (diff.some((e) => pathMatchesFilter(e.path, paths))) yield toInfo();
			continue;
		}

		if (parents.length === 1) {
			const p0 = parents[0]!;
			try {
				const parentCommit = await _readCommit(repo, p0);
				const diff = await _diffTrees(repo, parentCommit.tree, commit.tree);
				if (diff.some((e) => pathMatchesFilter(e.path, paths))) yield toInfo();
			} catch {
				yield toInfo();
			}
			await enqueue(p0);
			continue;
		}

		// Merge: TREESAME simplification
		const treesameParents: ObjectId[] = [];
		for (const parentHash of parents) {
			try {
				const parentCommit = await _readCommit(repo, parentHash);
				const diff = await _diffTrees(repo, parentCommit.tree, commit.tree);
				if (!diff.some((e) => pathMatchesFilter(e.path, paths))) {
					treesameParents.push(parentHash);
				}
			} catch {
				// Missing parent — not treesame
			}
		}

		if (treesameParents.length > 0) {
			await enqueue(treesameParents[0]!);
		} else {
			yield toInfo();
			for (const p of parents) await enqueue(p);
		}
	}
}
