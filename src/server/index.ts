// HTTP + SSH handler
export { createServer, composeHooks } from "./handler.ts";

// Transport-agnostic operations (advanced — for building custom transports)
export {
	advertiseRefsWithHooks,
	applyReceivePack,
	collectRefs,
	buildRefAdvertisementBytes,
	buildRefListBytes,
	handleUploadPack,
	ingestReceivePack,
	ingestReceivePackFromStream,
	resolveRefUpdates,
} from "./operations.ts";
export type { AdvertiseResult, ApplyReceivePackOptions, ReceivePackResult } from "./operations.ts";

// Transport-agnostic protocol primitives (advanced)
export { buildRefListPktLines } from "./protocol.ts";
export type { PushCommand } from "./protocol.ts";

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
	RefResult,
	RefUpdate,
	RefUpdateRequest,
	RefUpdateResult,
	Rejection,
	ServerHooks,
	ServerPolicy,
	Session,
	SessionBuilder,
	SshChannel,
	SshSessionInfo,
	UpdateEvent,
} from "./types.ts";

// Re-exported lib types used in Storage and hook signatures
export type { GitRepo, RawObject, Ref } from "../lib/types.ts";

// Storage
export type { CreateRepoOptions, Storage, RefOps, RawRefEntry, MaybeAsync } from "./storage.ts";
export { MemoryStorage } from "./memory-storage.ts";
export { BunSqliteStorage, type BunSqliteDatabase } from "./bun-sqlite-storage.ts";
export { BetterSqlite3Storage, type BetterSqlite3Database } from "./better-sqlite3-storage.ts";
export {
	PgStorage,
	wrapPgPool,
	type PgDatabase,
	type PgPool,
	type PgPoolClient,
} from "./pg-storage.ts";
