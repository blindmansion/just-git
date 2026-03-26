import { readBlobBytes, readBlobContent } from "../lib/object-db.ts";
import { dirname, join } from "../lib/path.ts";
import { isInsideWorkTree, verifyPath, verifySymlinkTarget } from "../lib/path-safety.ts";
import { isSymlinkMode } from "../lib/symlink.ts";
import type { FlatTreeEntry } from "../lib/tree-ops.ts";
import type { GitRepo } from "../lib/types.ts";

/** Minimal filesystem surface needed to write a materialized tree. */
export interface MaterializeTarget {
	writeFile(path: string, content: string | Uint8Array): Promise<void>;
	mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
	symlink?(target: string, path: string): Promise<void>;
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

		if (isSymlinkMode(entry.mode)) {
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
			const content = await readBlobBytes(repo, entry.hash);
			await target.writeFile(fullPath, content);
		}
		filesWritten++;
	}

	return filesWritten;
}
