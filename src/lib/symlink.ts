import type { FileSystem, FileStat } from "../fs.ts";

const encoder = new TextEncoder();

/** Stat without following symlinks. Falls back to stat() when lstat is unavailable. */
export function lstatSafe(fs: FileSystem, path: string): Promise<FileStat> {
	return fs.lstat ? fs.lstat(path) : fs.stat(path);
}

/** Check whether a git mode (numeric or string) represents a symlink. */
export function isSymlinkMode(mode: number | string): boolean {
	if (typeof mode === "string") return mode === "120000";
	return mode === 0o120000;
}

/** Check whether a git mode (numeric or string) represents a submodule (gitlink). */
export function isSubmoduleMode(mode: number | string): boolean {
	if (typeof mode === "string") return mode === "160000";
	return mode === 0o160000;
}

/**
 * Read the "content" of a worktree entry for hashing/diffing purposes.
 * For symlinks, returns the link target encoded as bytes.
 * For regular files, returns the file content bytes.
 */
export async function readWorktreeContent(fs: FileSystem, fullPath: string): Promise<Uint8Array> {
	const st = await lstatSafe(fs, fullPath);
	if (st.isSymbolicLink && fs.readlink) {
		const target = await fs.readlink(fullPath);
		return encoder.encode(target);
	}
	return fs.readFileBuffer(fullPath);
}
