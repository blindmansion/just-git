// Repo operations SDK — high-level functions for working with GitRepo

// Reading
export {
	grep,
	listBranches,
	listTags,
	readBlob,
	readBlobText,
	readCommit,
	readFileAtCommit,
	resolveRef,
	type GrepFileMatch,
	type GrepMatch,
	type GrepOptions,
} from "./reading.ts";

// Diffing and history
export {
	blame,
	countAheadBehind,
	diffCommits,
	diffTrees,
	findMergeBases,
	flattenTree,
	getChangedFiles,
	getNewCommits,
	isAncestor,
	walkCommitHistory,
	type BlameEntry,
	type CommitInfo,
	type DiffHunk,
	type FileDiff,
} from "./diffing.ts";

// Writing
export {
	createCommit,
	writeBlob,
	writeTree,
	type CreateCommitOptions,
	type TreeEntryInput,
} from "./writing.ts";

// Merging
export {
	mergeTrees,
	mergeTreesFromTreeHashes,
	type MergeConflict,
	type MergeTreesResult,
} from "./merging.ts";

// Worktree
export {
	createSandboxWorktree,
	createWorktree,
	extractTree,
	type CreateWorktreeOptions,
	type ExtractTreeResult,
	type WorktreeResult,
} from "./worktree.ts";

// Safety
export { overlayRepo, readonlyRepo } from "./safety.ts";

// Re-exported lib types used in helper signatures
export type { Commit, GitRepo, Identity, RefEntry, TreeDiffEntry } from "../lib/types.ts";
export type { FlatTreeEntry } from "../lib/tree-ops.ts";
