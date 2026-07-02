/**
 * Path safety validation — prevents `.git` injection, `..` traversal,
 * and other malicious path components. Ports the essential checks from
 * git's `verify_path` / `verify_dotfile` in `read-cache.c`.
 */

/**
 * Case-insensitive check for `.git` (and case variants like `.GIT`, `.Git`).
 * No NTFS/HFS obfuscation checks needed — virtual FS, not a real filesystem.
 */
function isDotGit(component: string): boolean {
	return component.length === 4 && component.toLowerCase() === ".git";
}

/**
 * Validate a path from a tree entry or index entry.
 *
 * Rejects:
 * - Empty paths
 * - Paths containing null bytes
 * - Components that are `.`, `..`, or `.git` (case-insensitive)
 * - Leading or trailing `/`
 * - Empty components (double `//`)
 */
export function verifyPath(path: string): boolean {
	if (path.length === 0) return false;
	if (path.includes("\0")) return false;
	if (path.charCodeAt(0) === 0x2f) return false; // leading /
	if (path.charCodeAt(path.length - 1) === 0x2f) return false; // trailing /

	const components = path.split("/");
	for (const c of components) {
		if (c.length === 0) return false; // empty component (double slash)
		if (c === ".") return false;
		if (c === "..") return false;
		if (isDotGit(c)) return false;
	}
	return true;
}

/**
 * After `join(workTree, entryPath)` resolves `..` segments, verify the
 * resulting absolute path is still inside the worktree. Catches traversal
 * that `verifyPath` might miss after path normalization.
 */
export function isInsideWorkTree(workTree: string, fullPath: string): boolean {
	if (fullPath === workTree) return false; // must be strictly inside
	if (workTree === "/") return fullPath.startsWith("/") && fullPath.length > 1;
	return fullPath.startsWith(workTree + "/");
}

/**
 * Validate a symlink target. Rejects:
 * - Absolute targets (start with `/`)
 * - Targets containing `..` components that could escape the worktree
 * - Targets containing `.git` components (case-insensitive)
 */
export function verifySymlinkTarget(target: string): boolean {
	if (target.length === 0) return false;
	if (target.charCodeAt(0) === 0x2f) return false; // absolute path

	const components = target.split("/");
	for (const c of components) {
		if (c === "..") return false;
		if (isDotGit(c)) return false;
	}
	return true;
}
