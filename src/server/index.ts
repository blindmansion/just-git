// Layer 2: HTTP handler
export { createGitServer, type GitServer } from "./handler.ts";

// Layer 1: Operations (building blocks)
export { advertiseRefs, handleReceivePack, handleUploadPack } from "./operations.ts";

// Layer 1: Protocol primitives
export {
	buildRefAdvertisement,
	buildReportStatus,
	buildUploadPackResponse,
	encodeSidebandPacket,
	parseReceivePackRequest,
	parseUploadPackRequest,
	type AdvertisedRef,
	type PushCommand,
	type ReceivePackRequest,
	type RefResult,
	type UploadPackRequest,
} from "./protocol.ts";

// Types
export type { AuthResult, GitServerOptions, RefUpdate } from "./types.ts";

// Storage implementations
export { PackedObjectStore } from "../lib/object-store.ts";
export { FileSystemRefStore } from "../lib/refs.ts";
export { SqliteStorage } from "./sqlite-storage.ts";
