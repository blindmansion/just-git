// just-git/storage — multi-repo manager, gc, and storage backends.
//
// Neutral layer with no dependency on the HTTP/SSH server. The server is a
// consumer of this module, not its owner. Import from here to run a
// storage-backed repo manager standalone (headless, browser, edge).

// Manager construction
export { createRepoStore } from "./repo-store.ts";

// Manager + backend contract types
export type {
	RepoStore,
	Storage,
	StoredObject,
	ObjectEncoding,
	DeltaObjectRow,
	CreateRepoOptions,
	RefOps,
	RawRefEntry,
	MaybeAsync,
} from "./repo-store.ts";

// Maintenance — free functions over (GitRepo, Storage)
export { gcRepo, repackRepo } from "./gc.ts";
export type { GcOptions, GcResult, RepackOptions, RepackResult } from "./gc.ts";

// Backends
export { MemoryStorage } from "./memory-storage.ts";
export { BunSqliteStorage, type BunSqliteDatabase } from "./bun-sqlite-storage.ts";
export { BetterSqlite3Storage, type BetterSqlite3Database } from "./better-sqlite3-storage.ts";
export { PgStorage, type PgPool } from "./pg-storage.ts";
export { DurableObjectSqliteStorage, type DurableObjectStorageSql } from "./do-sqlite-storage.ts";

// Re-exported lib types used in the Storage / RepoStore signatures
export type { GitRepo, RawObject, Ref } from "../lib/types.ts";
