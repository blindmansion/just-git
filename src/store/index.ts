// just-git/store — multi-repo manager, gc, and storage backends.
//
// Neutral layer with no dependency on the HTTP/SSH server. The server is a
// consumer of this module, not its owner. Import from here to run a
// storage-backed repo manager standalone (headless, browser, edge).

// Manager construction
export { createRepo, createRepoStore } from "./repo-store.ts";

// Manager + backend contract types
export type {
	RepoStore,
	RepoStoreOptions,
	StoredObject,
	ObjectEncoding,
	DeltaObjectRow,
	CreateRepoOptions,
	RefOps,
	RawRefEntry,
	MaybeAsync,
} from "./repo-store.ts";
export type { RepoStorage } from "./repo-storage.ts";
export type { RepoPool } from "./repo-pool.ts";

// Maintenance — run via `RepoStore.gc` (fork-safe). The underlying free
// function is intentionally not exported; go through the manager.
export type { GcOptions, GcResult } from "./gc.ts";

// Backends
export { createMemoryRepoStorage, MemoryStorage } from "./memory-storage.ts";
export { BunSqliteStorage, type BunSqliteDatabase } from "./bun-sqlite-storage.ts";
export { BetterSqlite3Storage, type BetterSqlite3Database } from "./better-sqlite3-storage.ts";
export { PgStorage, type PgPool } from "./pg-storage.ts";
export { DurableObjectSqliteStorage, type DurableObjectStorageSql } from "./do-sqlite-storage.ts";

// Re-exported lib types used in the RepoStorage / RepoStore signatures
export type { GitRepo, RawObject, Ref, RepoCapabilities } from "../lib/types.ts";
