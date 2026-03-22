// HTTP + SSH handler
export { createGitServer, composeHooks } from "./handler.ts";

// SSH helpers
export { parseGitSshCommand } from "./ssh-session.ts";

// Transport-agnostic operations
export {
	advertiseRefsWithHooks,
	applyReceivePack,
	collectRefs,
	buildRefAdvertisementBytes,
	buildRefListBytes,
	handleUploadPack,
	ingestReceivePack,
	ingestReceivePackFromStream,
} from "./operations.ts";
export type {
	AdvertiseResult,
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
	NodeHttpRequest,
	NodeHttpResponse,
	PostReceiveEvent,
	PreReceiveEvent,
	RefAdvertisement,
	RefUpdate,
	Rejection,
	ServerHooks,
	Session,
	SessionBuilder,
	SshChannel,
	SshSessionInfo,
	UpdateEvent,
} from "./types.ts";

// Policy
export type { ServerPolicy } from "./types.ts";

// Storage
export type { Storage, CreateRepoOptions } from "./storage.ts";
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
