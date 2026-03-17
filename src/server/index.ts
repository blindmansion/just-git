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
export type { AuthResult, GitServerOptions, RefUpdate, ServerRepoContext } from "./types.ts";

// FS-backed storage implementations (convenience re-exports)
export { PackedObjectStore } from "../lib/object-store.ts";
export { FileSystemRefStore } from "../lib/refs.ts";
