/**
 * Decide whether a ref is stored in the per-worktree private directory
 * (`$GIT_DIR`) rather than the shared `$GIT_COMMON_DIR`.
 *
 * A faithful port of git's `ref_type()`: uppercase pseudo-refs that sit
 * directly under the git dir (HEAD, ORIG_HEAD, MERGE_HEAD, …) and the
 * `refs/bisect`, `refs/worktree`, and `refs/rewritten` namespaces are
 * per-worktree; everything else (`refs/heads`, `refs/tags`, `refs/remotes`,
 * `refs/stash`, `refs/notes`, …) is shared across all worktrees.
 *
 * This is the single classification rule; the ref store, the reflog, and the
 * garbage collector all defer to it.
 */
export function isPerWorktreeRef(name: string): boolean {
	if (!name.includes("/")) return name === name.toUpperCase();

	return (
		name.startsWith("refs/bisect/") ||
		name.startsWith("refs/worktree/") ||
		name.startsWith("refs/rewritten/")
	);
}
