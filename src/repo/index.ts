// Repo operations SDK — high-level functions for working with GitRepo
export {
	blame,
	checkoutTo,
	countAheadBehind,
	createCommit,
	createEphemeralWorktree,
	createWorktree,
	diffTrees,
	findMergeBases,
	flattenTree,
	getChangedFiles,
	getNewCommits,
	grep,
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
	walkCommitHistory,
	writeBlob,
	writeTree,
	type BlameEntry,
	type CheckoutToResult,
	type CommitInfo,
	type CreateCommitOptions,
	type CreateWorktreeOptions,
	type GrepFileMatch,
	type GrepMatch,
	type GrepOptions,
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
