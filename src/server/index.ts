// HTTP + SSH handler
export { createServer, composeHooks } from "./handler.ts";

// Transport-agnostic operations (advanced — for building custom transports)
export {
	advertiseRefsWithHooks,
	applyCasRefUpdates,
	applyReceivePack,
	collectRefs,
	buildRefAdvertisementBytes,
	buildRefListBytes,
	buildV2CapabilityAdvertisementBytes,
	handleLsRefs,
	handleUploadPack,
	handleV2Fetch,
	ingestReceivePack,
	ingestReceivePackFromStream,
	resolveRefUpdates,
} from "./operations.ts";
export type { AdvertiseResult, ApplyReceivePackOptions, ReceivePackResult } from "./operations.ts";

// Transport-agnostic protocol primitives (advanced)
export {
	buildRefListPktLines,
	buildV2CapabilityAdvertisement,
	buildV2FetchResponse,
	buildV2LsRefsResponse,
	parseV2CommandRequest,
	parseV2FetchArgs,
} from "./protocol.ts";
export type {
	PushCommand,
	V2CommandRequest,
	V2FetchRequest,
	V2FetchResponseOptions,
	V2LsRefsRef,
} from "./protocol.ts";

// GC
export type { GcOptions, GcResult } from "./gc.ts";

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
	Auth,
	AuthProvider,
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
export { PgStorage, type PgPool } from "./pg-storage.ts";
