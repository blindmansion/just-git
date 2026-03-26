import { comparePaths } from "./command-utils.ts";
import { readObject, writeObject } from "./object-db.ts";
import { parseTree, serializeTree } from "./objects/tree.ts";
import type { GitRepo, IndexEntry, ObjectId, TreeDiffEntry, TreeEntry } from "./types.ts";
import { FileMode as FM } from "./types.ts";

// ── Types ───────────────────────────────────────────────────────────

/** A flattened file entry from walking a tree recursively. */
export interface FlatTreeEntry {
	path: string;
	mode: string;
	hash: ObjectId;
}

// ── Build tree from index ───────────────────────────────────────────

/**
 * Convert a flat list of index entries into nested tree objects,
 * write them to the object store, and return the root tree hash.
 *
 * This is the core of `git commit` — it takes the staging area
 * and produces the tree snapshot.
 */
export async function buildTreeFromIndex(ctx: GitRepo, entries: IndexEntry[]): Promise<ObjectId> {
	// Build a nested structure: group entries by their top-level directory
	return buildTreeRecursive(ctx, entries, "");
}

async function buildTreeRecursive(
	ctx: GitRepo,
	entries: IndexEntry[],
	prefix: string,
): Promise<ObjectId> {
	const treeEntries: TreeEntry[] = [];

	// Group entries by their immediate child name under `prefix`
	const groups = new Map<string, IndexEntry[]>();

	for (const entry of entries) {
		// Get the path relative to the current prefix
		const relPath = prefix ? entry.path.slice(prefix.length + 1) : entry.path;
		const slashIdx = relPath.indexOf("/");

		if (slashIdx === -1) {
			// This is a direct file in this directory
			treeEntries.push({
				mode: modeToString(entry.mode),
				name: relPath,
				hash: entry.hash,
			});
		} else {
			// This belongs to a subdirectory
			const dirName = relPath.slice(0, slashIdx);
			let group = groups.get(dirName);
			if (!group) {
				group = [];
				groups.set(dirName, group);
			}
			group.push(entry);
		}
	}

	// Recursively build subtrees
	for (const [dirName, subEntries] of groups) {
		const subPrefix = prefix ? `${prefix}/${dirName}` : dirName;
		const subTreeHash = await buildTreeRecursive(ctx, subEntries, subPrefix);
		treeEntries.push({
			mode: FM.DIRECTORY,
			name: dirName,
			hash: subTreeHash,
		});
	}

	// Sort: Git sorts tree entries by name, with directories having a trailing /
	// for comparison purposes
	treeEntries.sort((a, b) => {
		const aKey = a.mode === FM.DIRECTORY ? `${a.name}/` : a.name;
		const bKey = b.mode === FM.DIRECTORY ? `${b.name}/` : b.name;
		return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
	});

	// Serialize and write the tree object
	const content = serializeTree({ type: "tree", entries: treeEntries });
	return writeObject(ctx, "tree", content);
}

// ── Flatten tree ────────────────────────────────────────────────────

/**
 * Recursively flatten a tree into a sorted list of file entries
 * (no directory entries — only leaf blobs/symlinks/submodules).
 */
export async function flattenTree(
	ctx: GitRepo,
	treeHash: ObjectId,
	prefix: string = "",
): Promise<FlatTreeEntry[]> {
	const raw = await readObject(ctx, treeHash);
	if (raw.type !== "tree") {
		throw new Error(`Expected tree object, got ${raw.type}`);
	}

	const tree = parseTree(raw.content);
	const results: FlatTreeEntry[] = [];

	for (const entry of tree.entries) {
		const fullPath = prefix ? `${prefix}/${entry.name}` : entry.name;

		if (entry.mode === FM.DIRECTORY) {
			// Recurse into subtree
			const subResults = await flattenTree(ctx, entry.hash, fullPath);
			results.push(...subResults);
		} else {
			results.push({ path: fullPath, mode: entry.mode, hash: entry.hash });
		}
	}

	return results;
}

/**
 * Flatten a tree into a Map keyed by path.
 * Returns an empty map when treeHash is null (e.g. initial commit).
 */
export async function flattenTreeToMap(
	ctx: GitRepo,
	treeHash: ObjectId | null,
): Promise<Map<string, FlatTreeEntry>> {
	if (!treeHash) return new Map();
	const entries = await flattenTree(ctx, treeHash);
	return new Map(entries.map((e) => [e.path, e]));
}

// ── Diff trees ──────────────────────────────────────────────────────

/**
 * Diff two trees and return a list of changes.
 * Either tree hash can be null to represent an empty tree
 * (useful for the initial commit or comparing against nothing).
 *
 * Walks both trees recursively in parallel, pruning entire subtrees
 * whose hashes match — O(changed files + tree depth) instead of
 * O(total files).
 */
export async function diffTrees(
	ctx: GitRepo,
	treeA: ObjectId | null,
	treeB: ObjectId | null,
): Promise<TreeDiffEntry[]> {
	if (treeA === treeB) return [];
	const results: TreeDiffEntry[] = [];
	await diffTreesRecursive(ctx, treeA, treeB, "", results);
	return results.sort((a, b) => comparePaths(a.path, b.path));
}

async function readTreeEntries(ctx: GitRepo, treeHash: ObjectId): Promise<TreeEntry[]> {
	const raw = await readObject(ctx, treeHash);
	if (raw.type !== "tree") throw new Error(`Expected tree object, got ${raw.type}`);
	return parseTree(raw.content).entries;
}

async function diffTreesRecursive(
	ctx: GitRepo,
	hashA: ObjectId | null,
	hashB: ObjectId | null,
	prefix: string,
	results: TreeDiffEntry[],
): Promise<void> {
	if (hashA === hashB) return;

	const entriesA = hashA ? await readTreeEntries(ctx, hashA) : [];
	const entriesB = hashB ? await readTreeEntries(ctx, hashB) : [];

	const mapA = new Map<string, TreeEntry>();
	for (const e of entriesA) mapA.set(e.name, e);
	const mapB = new Map<string, TreeEntry>();
	for (const e of entriesB) mapB.set(e.name, e);

	const allNames = new Set<string>();
	for (const e of entriesA) allNames.add(e.name);
	for (const e of entriesB) allNames.add(e.name);

	for (const name of allNames) {
		const a = mapA.get(name);
		const b = mapB.get(name);
		const fullPath = prefix ? `${prefix}/${name}` : name;

		if (a && b) {
			if (a.hash === b.hash && a.mode === b.mode) continue;

			const aIsDir = a.mode === FM.DIRECTORY;
			const bIsDir = b.mode === FM.DIRECTORY;

			if (aIsDir && bIsDir) {
				await diffTreesRecursive(ctx, a.hash, b.hash, fullPath, results);
			} else if (aIsDir) {
				await collectSubtree(ctx, a.hash, fullPath, "deleted", results);
				results.push({ path: fullPath, status: "added", newHash: b.hash, newMode: b.mode });
			} else if (bIsDir) {
				results.push({ path: fullPath, status: "deleted", oldHash: a.hash, oldMode: a.mode });
				await collectSubtree(ctx, b.hash, fullPath, "added", results);
			} else {
				results.push({
					path: fullPath,
					status: "modified",
					oldHash: a.hash,
					newHash: b.hash,
					oldMode: a.mode,
					newMode: b.mode,
				});
			}
		} else if (a) {
			if (a.mode === FM.DIRECTORY) {
				await collectSubtree(ctx, a.hash, fullPath, "deleted", results);
			} else {
				results.push({ path: fullPath, status: "deleted", oldHash: a.hash, oldMode: a.mode });
			}
		} else {
			const bEntry = b!;
			if (bEntry.mode === FM.DIRECTORY) {
				await collectSubtree(ctx, bEntry.hash, fullPath, "added", results);
			} else {
				results.push({
					path: fullPath,
					status: "added",
					newHash: bEntry.hash,
					newMode: bEntry.mode,
				});
			}
		}
	}
}

/** Flatten a subtree and emit all leaf entries as added or deleted. */
async function collectSubtree(
	ctx: GitRepo,
	treeHash: ObjectId,
	prefix: string,
	status: "added" | "deleted",
	results: TreeDiffEntry[],
): Promise<void> {
	const flat = await flattenTree(ctx, treeHash, prefix);
	for (const entry of flat) {
		if (status === "added") {
			results.push({ path: entry.path, status: "added", newHash: entry.hash, newMode: entry.mode });
		} else {
			results.push({
				path: entry.path,
				status: "deleted",
				oldHash: entry.hash,
				oldMode: entry.mode,
			});
		}
	}
}

// ── Helpers ─────────────────────────────────────────────────────────

/** Convert numeric file mode (e.g. 0o100644) to the string form ("100644"). */
function modeToString(mode: number): string {
	return mode.toString(8).padStart(6, "0");
}
