import { readBlobBytes, readBlobContent } from "../lib/object-db.ts";
import { dirname, join } from "../lib/path.ts";
import { isInsideWorkTree, verifyPath, verifySymlinkTarget } from "../lib/path-safety.ts";
import { isExecutableMode, isSubmoduleMode, isSymlinkMode } from "../lib/symlink.ts";
import type { FlatTreeEntry } from "../lib/tree-ops.ts";
import type { GitRepo } from "../lib/types.ts";

/** Minimal filesystem surface needed to write a materialized tree. */
export interface MaterializeTarget {
	writeFile(path: string, content: string | Uint8Array): Promise<void>;
	mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
	symlink?(target: string, path: string): Promise<void>;
	/**
	 * Set permission bits. When present, `100755` entries are made
	 * executable (and an existing executable file is reset to `0o644` for
	 * a `100644` entry, which needs `lstat` or `stat` to detect). Without
	 * it, every file is written with the target's default mode.
	 */
	chmod?(path: string, mode: number): Promise<void>;
	/**
	 * Read an existing file's mode without following symlinks. Node's
	 * `fs.promises.lstat` fits: `isSymbolicLink` may be a boolean or a
	 * method.
	 */
	lstat?(path: string): Promise<{ mode?: number; isSymbolicLink?: boolean | (() => boolean) }>;
	/** Fallback for `lstat` (follows symlinks). Node's `fs.promises.stat` fits. */
	stat?(path: string): Promise<{ mode?: number }>;
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
			const content = await readBlobBytes(repo, entry.hash);
			const executable = isExecutableMode(entry.mode);
			// writeFile keeps an existing file's mode (as on a real disk), so
			// a non-executable entry over an executable file must clear it.
			const existingMode =
				target.chmod && !executable ? await existingFileMode(target, fullPath) : null;
			await target.writeFile(fullPath, content);
			if (target.chmod) {
				if (executable) {
					await target.chmod(fullPath, 0o755);
				} else if (existingMode !== null && existingMode & 0o111) {
					await target.chmod(fullPath, 0o644);
				}
			}
		}
		filesWritten++;
	}

	return filesWritten;
}

async function existingFileMode(target: MaterializeTarget, path: string): Promise<number | null> {
	try {
		if (target.lstat) {
			const st = await target.lstat(path);
			const link =
				typeof st.isSymbolicLink === "function" ? st.isSymbolicLink() : st.isSymbolicLink;
			if (link || ((st.mode ?? 0) & 0o170000) === 0o120000) return null;
			return st.mode ?? null;
		}
		if (target.stat) return (await target.stat(path))?.mode ?? null;
	} catch {}
	return null;
}
