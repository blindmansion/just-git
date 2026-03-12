/**
 * lib/patch-id.ts
 *
 * Computes a "patch-id" for a commit — a hash of the normalized diff
 * that ignores line numbers, whitespace, and commit metadata.
 *
 * Used by rebase to detect already-applied commits (cherry-pick skip).
 * Mirrors git's patch-id computation from patch-ids.c.
 *
 * Normalization:
 *   - Strip diff headers (diff --git, ---, +++, @@)
 *   - Strip leading/trailing whitespace from each line
 *   - Only hash +/- lines (actual changes)
 *   - Sort files by path for deterministic ordering
 *   - Hash with SHA-1
 */

import { comparePaths } from "./command-utils.ts";
import { formatUnifiedDiff } from "./diff-algorithm.ts";
import { readObject } from "./object-db.ts";
import { parseCommit } from "./objects/commit.ts";
import { createHasher } from "./sha1.ts";
import { diffTrees } from "./tree-ops.ts";
import type { GitContext, ObjectId } from "./types.ts";

/**
 * Compute the patch-id for a commit.
 *
 * Diffs the commit against its first parent (or empty tree for root commits),
 * normalizes the diff, and returns a SHA-1 hash of the normalized content.
 *
 * Returns null if the commit produces no diff (empty commit).
 */
export async function computePatchId(
	ctx: GitContext,
	commitHash: ObjectId,
): Promise<string | null> {
	const raw = await readObject(ctx, commitHash);
	if (raw.type !== "commit") return null;

	const commit = parseCommit(raw.content);

	// Get parent tree (empty tree for root commits)
	let parentTree: ObjectId | null = null;
	if (commit.parents.length > 0 && commit.parents[0]) {
		const parentRaw = await readObject(ctx, commit.parents[0]);
		if (parentRaw.type === "commit") {
			const parentCommit = parseCommit(parentRaw.content);
			parentTree = parentCommit.tree;
		}
	}

	// Get the tree diff
	const diffs = await diffTrees(ctx, parentTree, commit.tree);
	if (diffs.length === 0) return null;

	// Build normalized patch content.
	// We normalize unified diffs (with context) instead of only +/- lines to
	// avoid false positives where unrelated commits happen to share the same
	// inserted/deleted line content.
	const hash = createHasher();
	let hasContent = false;

	// Sort diffs by path for deterministic ordering.
	const sortedDiffs = [...diffs].sort((a, b) => comparePaths(a.path, b.path));

	for (const diff of sortedDiffs) {
		let oldContent = "";
		let newContent = "";

		if (diff.oldHash) {
			try {
				const obj = await readObject(ctx, diff.oldHash);
				oldContent = new TextDecoder().decode(obj.content);
			} catch {
				// ignore
			}
		}

		if (diff.newHash) {
			try {
				const obj = await readObject(ctx, diff.newHash);
				newContent = new TextDecoder().decode(obj.content);
			} catch {
				// ignore
			}
		}

		const patch = formatUnifiedDiff({
			path: diff.path,
			oldContent,
			newContent,
			oldMode: diff.oldMode,
			newMode: diff.newMode,
		});
		if (!patch) continue;

		for (const line of patch.split("\n")) {
			if (!line) continue;
			// Git ignores index lines for patch-id.
			if (line.startsWith("index ")) continue;

			// Ignore hunk range coordinates but keep marker structure.
			const normalizedHeader = line.startsWith("@@") ? line.replace(/^@@ [^@]* @@/, "@@ @@") : line;

			// Git patch-id normalization is whitespace-insensitive.
			const normalized = normalizedHeader.replace(/[ \t\r]/g, "");
			if (!normalized) continue;
			hash.update(normalized);
			hash.update("\n");
			hasContent = true;
		}
	}

	if (!hasContent) return null;
	return hash.hex();
}
