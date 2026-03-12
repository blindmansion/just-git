import type { FileSystem, FileStat } from "../fs.ts";
import { hashObject } from "./object-db.ts";

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

/**
 * Hash the worktree content of a file or symlink as a git blob.
 * Returns the object hash.
 */
export async function hashWorktreeEntry(fs: FileSystem, fullPath: string): Promise<string> {
	const content = await readWorktreeContent(fs, fullPath);
	return hashObject("blob", content);
}
