// Repo operations SDK — high-level functions for working with GitRepo
export {
	checkoutTo,
	createCommit,
	createWorktree,
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
	readonlyRepo,
	resolveRef,
	writeBlob,
	writeTree,
	type CheckoutToResult,
	type CommitInfo,
	type CreateCommitOptions,
	type CreateWorktreeOptions,
	type MergeConflict,
	type MergeTreesResult,
	type TreeEntryInput,
	type WorktreeResult,
} from "./helpers.ts";

// Storage implementations
export { PackedObjectStore } from "../lib/object-store.ts";
export { FileSystemRefStore } from "../lib/refs.ts";

// Re-exported lib types needed by helpers
export type { Identity, GitRepo } from "../lib/types.ts";
