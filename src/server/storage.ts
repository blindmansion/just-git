import type { GitRepo } from "../lib/types.ts";

/**
 * Abstract storage backend for multi-repo git object and ref storage.
 *
 * Implemented by `BunSqliteStorage`, `BetterSqlite3Storage`, and `PgStorage`.
 */
export interface Storage {
	/** Get a `GitRepo` scoped to a specific repo. */
	repo(repoId: string): GitRepo;
	/** Delete all objects and refs for a repo. */
	deleteRepo(repoId: string): Promise<void>;
}
