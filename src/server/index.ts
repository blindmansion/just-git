// HTTP handler
export { createGitServer, composeHooks } from "./handler.ts";

// Node.js adapter
export { toNodeHandler, type NodeHttpRequest, type NodeHttpResponse } from "./handler.ts";

// Server operations (used internally by handler, exposed for custom transports)
export {
	PackCache,
	buildRefAdvertisementBytes,
	collectRefs,
	handleUploadPack,
	ingestReceivePack,
	type ReceivePackResult,
	type RefsData,
	type UploadPackOptions,
} from "./operations.ts";

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
	SqliteStorage,
	wrapBetterSqlite3,
	type BetterSqlite3Database,
	type BetterSqlite3Statement,
	type SqliteDatabase,
	type SqliteStatement,
} from "./sqlite-storage.ts";
export {
	PgStorage,
	wrapPgPool,
	type PgDatabase,
	type PgPool,
	type PgPoolClient,
} from "./pg-storage.ts";
