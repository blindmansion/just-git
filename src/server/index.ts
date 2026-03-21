// HTTP handler
export { createGitServer, composeHooks } from "./handler.ts";

// Node.js adapter
export { toNodeHandler } from "./handler.ts";

// Transport-agnostic operations
export {
	applyReceivePack,
	collectRefs,
	buildRefAdvertisementBytes,
	handleUploadPack,
	ingestReceivePack,
} from "./operations.ts";
export type {
	ApplyReceivePackOptions,
	ApplyReceivePackResult,
	RefResult,
	ReceivePackResult,
} from "./operations.ts";

// Transport-agnostic protocol primitives
export { buildRefListPktLines } from "./protocol.ts";

// Types
export type {
	AdvertiseRefsEvent,
	GitServer,
	GitServerConfig,
	PostReceiveEvent,
	PreReceiveEvent,
	RefAdvertisement,
	RefUpdate,
	Rejection,
	ServerHooks,
	UpdateEvent,
} from "./types.ts";

// Presets
export { createStandardHooks, withAuth, type StandardHooksConfig } from "./presets.ts";

// Storage
export type { Storage } from "./storage.ts";
export { MemoryStorage } from "./memory-storage.ts";
export {
	BunSqliteStorage,
	type BunSqliteDatabase,
	type BunSqliteStatement,
} from "./bun-sqlite-storage.ts";
export {
	BetterSqlite3Storage,
	type BetterSqlite3Database,
	type BetterSqlite3Statement,
} from "./better-sqlite3-storage.ts";
export {
	PgStorage,
	wrapPgPool,
	type PgDatabase,
	type PgPool,
	type PgPoolClient,
} from "./pg-storage.ts";
