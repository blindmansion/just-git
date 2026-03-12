import { comparePaths } from "./command-utils.ts";
import { readObject, writeObject } from "./object-db.ts";
import { parseTree, serializeTree } from "./objects/tree.ts";
import type { GitContext, IndexEntry, ObjectId, TreeDiffEntry, TreeEntry } from "./types.ts";
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
export async function buildTreeFromIndex(
	ctx: GitContext,
	entries: IndexEntry[],
): Promise<ObjectId> {
	// Build a nested structure: group entries by their top-level directory
	return buildTreeRecursive(ctx, entries, "");
}

async function buildTreeRecursive(
	ctx: GitContext,
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
	ctx: GitContext,
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
	ctx: GitContext,
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
 */
export async function diffTrees(
	ctx: GitContext,
	treeA: ObjectId | null,
	treeB: ObjectId | null,
): Promise<TreeDiffEntry[]> {
	const mapA = await flattenTreeToMap(ctx, treeA);
	const mapB = await flattenTreeToMap(ctx, treeB);

	const results: TreeDiffEntry[] = [];

	// Files in A but not in B → deleted
	// Files in both → check for modifications
	for (const [path, entryA] of mapA) {
		const entryB = mapB.get(path);
		if (!entryB) {
			results.push({
				path,
				status: "deleted",
				oldHash: entryA.hash,
				oldMode: entryA.mode,
			});
		} else if (entryA.hash !== entryB.hash || entryA.mode !== entryB.mode) {
			results.push({
				path,
				status: "modified",
				oldHash: entryA.hash,
				newHash: entryB.hash,
				oldMode: entryA.mode,
				newMode: entryB.mode,
			});
		}
	}

	// Files in B but not in A → added
	for (const [path, entryB] of mapB) {
		if (!mapA.has(path)) {
			results.push({
				path,
				status: "added",
				newHash: entryB.hash,
				newMode: entryB.mode,
			});
		}
	}

	return results.sort((a, b) => comparePaths(a.path, b.path));
}

// ── Helpers ─────────────────────────────────────────────────────────

/** Convert numeric file mode (e.g. 0o100644) to the string form ("100644"). */
function modeToString(mode: number): string {
	return mode.toString(8).padStart(6, "0");
}
