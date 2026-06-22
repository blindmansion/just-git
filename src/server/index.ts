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
	RefUpdateCreate,
	RefUpdateDelete,
	RefUpdateModify,
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

// Storage / repo manager — re-exported from just-git/storage for back-compat.
// The server is a consumer of this layer, not its owner.
export {
	createRepoStore,
	gcRepo,
	repackRepo,
	MemoryStorage,
	BunSqliteStorage,
	BetterSqlite3Storage,
	PgStorage,
	DurableObjectSqliteStorage,
} from "../storage/index.ts";
export type {
	RepoStore,
	CreateRepoOptions,
	Storage,
	StoredObject,
	ObjectEncoding,
	DeltaObjectRow,
	RefOps,
	RawRefEntry,
	MaybeAsync,
	GcOptions,
	GcResult,
	RepackOptions,
	RepackResult,
	BunSqliteDatabase,
	BetterSqlite3Database,
	PgPool,
	DurableObjectStorageSql,
} from "../storage/index.ts";
