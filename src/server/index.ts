// Layer 2: HTTP handler
export { createGitServer } from "./handler.ts";

// Layer 1: Operations (building blocks)
export {
	buildRefAdvertisementBytes,
	collectRefs,
	handleUploadPack,
	ingestReceivePack,
	type ReceivePackResult,
	type RefsData,
} from "./operations.ts";

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

// Helpers
export {
	createCommit,
	diffTrees,
	findMergeBases,
	flattenTree,
	getChangedFiles,
	getNewCommits,
	isAncestor,
	listBranches,
	listTags,
	mergeTrees,
	mergeTreesFromTreeHashes,
	readBlob,
	readBlobText,
	readCommit,
	readFileAtCommit,
	resolveRef,
	type CommitEntry,
	type CreateCommitOptions,
	type MergeConflict,
	type MergeTreesResult,
} from "./helpers.ts";

// Presets
export { createStandardHooks, type StandardHooksConfig } from "./presets.ts";

// Storage implementations
export { PackedObjectStore } from "../lib/object-store.ts";
export { FileSystemRefStore } from "../lib/refs.ts";
export { SqliteStorage } from "./sqlite-storage.ts";

// Re-exported lib types needed by helpers
export type { Identity, GitRepo } from "../lib/types.ts";
