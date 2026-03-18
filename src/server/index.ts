// HTTP handler
export { createGitServer, composeHooks } from "./handler.ts";

// Server operations (used internally by handler, exposed for custom transports)
export {
	buildRefAdvertisementBytes,
	collectRefs,
	handleUploadPack,
	ingestReceivePack,
	type ReceivePackResult,
	type RefsData,
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
export { createStandardHooks, type StandardHooksConfig } from "./presets.ts";

// Storage
export { SqliteStorage, type SqliteDatabase, type SqliteStatement } from "./sqlite-storage.ts";
