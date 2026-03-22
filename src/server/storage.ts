import type { GitRepo } from "../lib/types.ts";

/** Options for {@link Storage.createRepo}. */
export interface CreateRepoOptions {
	/** Name of the default branch (default: `"main"`). Used for HEAD initialization. */
	defaultBranch?: string;
}

/**
 * Abstract storage backend for multi-repo git object and ref storage.
 *
 * Repos must be explicitly created via `createRepo` before they can be
 * accessed with `repo`. This prevents accidental repo creation when
 * `storage.repo(path)` is passed directly as a server's `resolveRepo`.
 *
 * Implemented by `MemoryStorage`, `BunSqliteStorage`, `BetterSqlite3Storage`, and `PgStorage`.
 */
export interface Storage {
	/**
	 * Create a new repo and initialize HEAD.
	 *
	 * Writes `HEAD → refs/heads/{defaultBranch}` so the repo is ready
	 * to accept its first push. Throws if the repo already exists.
	 */
	createRepo(repoId: string, options?: CreateRepoOptions): GitRepo | Promise<GitRepo>;

	/**
	 * Get a `GitRepo` scoped to a specific repo, or `null` if the repo
	 * has not been created via {@link createRepo}.
	 */
	repo(repoId: string): GitRepo | null | Promise<GitRepo | null>;

	/** Delete all objects, refs, and the repo record. */
	deleteRepo(repoId: string): void | Promise<void>;
}
