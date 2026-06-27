import { createTreeAttributesProvider } from "../lib/attributes.ts";
import { type BoundAttributes, bindAttributes } from "../lib/bound-attributes.ts";
import { readBlobBytes, readBlobContent } from "../lib/object-db.ts";
import { dirname, join } from "../lib/path.ts";
import { isInsideWorkTree, verifyPath, verifySymlinkTarget } from "../lib/path-safety.ts";
import { isSubmoduleMode, isSymlinkMode } from "../lib/symlink.ts";
import type { FlatTreeEntry } from "../lib/tree-ops.ts";
import type { GitRepo, ObjectId } from "../lib/types.ts";

/** Minimal filesystem surface needed to write a materialized tree. */
export interface MaterializeTarget {
	writeFile(path: string, content: string | Uint8Array): Promise<void>;
	mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
	symlink?(target: string, path: string): Promise<void>;
}

/**
 * Smudge a single materialized blob (object → worktree form) for `relPath`.
 * Returns the content unchanged when no `filter=` driver applies.
 */
export type TreeSmudge = (
	relPath: string,
	content: Uint8Array,
	blobOid: ObjectId,
) => Promise<Uint8Array>;

/**
 * Build a {@link TreeSmudge} for a tree about to be written out, or `undefined`
 * when the repo has no `attributes` capability (keeping the no-capability path a
 * raw, byte-identical blob copy). The binding is lazy and memoized: the
 * capability context + tree-backed `.gitattributes` provider are built once, on
 * the first file that needs smudging. Filter selection reads `.gitattributes`
 * from the committed `treeHash` (via {@link createTreeAttributesProvider}), since
 * the materialization seams run on a bare `GitRepo` with no worktree fs.
 */
export function createTreeSmudge(repo: GitRepo, treeHash: ObjectId): TreeSmudge | undefined {
	if (!repo.capabilities?.attributes) return undefined;
	let bound: Promise<BoundAttributes | undefined> | undefined;
	return async (relPath, content, blobOid) => {
		bound ??= bindAttributes(repo, "checkout", {
			attributes: createTreeAttributesProvider(repo.objectStore, treeHash),
		});
		const b = await bound;
		return b ? b.smudge(relPath, content, blobOid) : content;
	};
}

/**
 * Write flattened tree entries onto a filesystem target.
 *
 * Handles directory creation, symlink mode detection with fallback,
 * and path safety checks. Returns the number of files written.
 */
export async function materializeEntries(
	repo: GitRepo,
	entries: FlatTreeEntry[],
	target: MaterializeTarget,
	rootDir: string,
	smudge?: TreeSmudge,
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
			await target.mkdir(dir, { recursive: true });
			createdDirs.add(dir);
		}

		if (isSubmoduleMode(entry.mode)) {
			await target.mkdir(fullPath, { recursive: true });
		} else if (isSymlinkMode(entry.mode)) {
			const linkTarget = await readBlobContent(repo, entry.hash);
			if (!verifySymlinkTarget(linkTarget)) {
				throw new Error(`refusing to create symlink with unsafe target '${linkTarget}'`);
			}
			if (target.symlink) {
				await target.symlink(linkTarget, fullPath);
			} else {
				await target.writeFile(fullPath, linkTarget);
			}
		} else {
			let content = await readBlobBytes(repo, entry.hash);
			if (smudge) content = await smudge(entry.path, content, entry.hash);
			await target.writeFile(fullPath, content);
		}
		filesWritten++;
	}

	return filesWritten;
}
