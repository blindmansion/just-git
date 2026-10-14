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

export function isExecutableMode(mode: number | string): boolean {
	if (typeof mode === "string") return mode === "100755";
	return mode === 0o100755;
}

export function isRegularFileMode(mode: number | string): boolean {
	if (typeof mode === "string") return mode === "100644" || mode === "100755";
	return mode === 0o100644 || mode === 0o100755;
}

/** Check whether a git mode (numeric or string) represents a submodule (gitlink). */
export function isSubmoduleMode(mode: number | string): boolean {
	if (typeof mode === "string") return mode === "160000";
	return mode === 0o160000;
}

/**
 * Whether a change from `oldMode` to `newMode` changes the object type
 * (regular file, symlink, gitlink), which git reports as a typechange (`T`)
 * rather than a modification. Missing modes are never a typechange.
 */
export function isTypeChange(
	oldMode: number | string | undefined,
	newMode: number | string | undefined,
): boolean {
	if (!oldMode || !newMode) return false;
	const o = typeof oldMode === "string" ? Number.parseInt(oldMode, 8) : oldMode;
	const n = typeof newMode === "string" ? Number.parseInt(newMode, 8) : newMode;
	return (o & 0o170000) !== (n & 0o170000);
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
