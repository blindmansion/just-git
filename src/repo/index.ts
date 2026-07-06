// Repo operations SDK — high-level functions for working with GitRepo

// Reading
export {
	branchNameFromRef,
	grep,
	listBranches,
	listTags,
	readBlob,
	readBlobText,
	readCommit,
	readFileAtCommit,
	readHead,
	readTree,
	resolveRef,
	revParse,
	tagNameFromRef,
	verifyCommit,
	verifyTag,
	type GrepFileMatch,
	type GrepMatch,
	type GrepOptions,
	type HeadInfo,
	type VerificationResult,
} from "./reading.ts";

// Config (bounded value-state core: materialize on the shell, transform
// purely, persist on the shell — keeps config operations GitRepo-shaped)
export { configDataFromText, type ConfigData } from "../lib/config/parse.ts";
export {
	addConfig,
	getConfigAllFrom,
	getConfigFrom,
	setConfig,
	unsetConfig,
} from "../lib/config/store.ts";
export { configViewFrom } from "../lib/config/view.ts";

// Identity (GitRepo-shaped core: resolve commit/reflog identity from a
// materialized ConfigView, no fs — the shell materializes and threads it)
export { reflogIdentityFrom, resolveIdentityFrom, type IdentityRole } from "../lib/identity.ts";

// Operation state (bounded value-state core: the primary in-progress
// operation unified into one discriminated value)
export { operationInProgress, readOperationState, type OperationState } from "../lib/operation.ts";
export type { BisectState } from "../lib/bisect.ts";
export type { RebaseState, RebaseTodoEntry } from "../lib/rebase.ts";

// Reflog (bounded value-state core: pure code builds ReflogEffects, the
// shell applies them — keeps reflog writes GitRepo-shaped)
export {
	logRefEffects,
	reflogAppend,
	reflogDelete,
	reflogRewrite,
	type ReflogEffect,
	type ReflogEntry,
	type ReflogIdentity,
} from "../lib/refs/reflog.ts";

// Ref mutation that emits reflog effects (GitRepo-shaped: ref write rides on
// refStore, reflog comes back as effects for the shell to apply)
export { deleteRefEffects } from "../lib/refs/refs.ts";

// Signing & verification (the byte-for-byte sign/verify contract)
export {
	commitSigningPayload,
	SigningError,
	tagSigningPayload,
	VerificationError,
	type SignatureFormat,
	type Signer,
	type SigningCapability,
	type Verifier,
} from "../lib/signing.ts";

// Diffing and history
export {
	blame,
	countAheadBehind,
	diffCommits,
	formatDiff,
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
	type DiffOptions,
	type FileDiff,
} from "./diffing.ts";

// Writing
export {
	buildCommit,
	commit,
	createAnnotatedTag,
	createCommit,
	updateTree,
	writeBlob,
	writeTree,
	type BuildCommitOptions,
	type CommitAuthor,
	type CommitIdentity,
	type CommitOptions,
	type CommitResult,
	type CreateAnnotatedTagOptions,
	type CreateCommitOptions,
	type TreeEntryInput,
	type TreeUpdate,
} from "./writing.ts";

// Merging
export { buildMergeMessageFrom } from "../lib/merge.ts";
export {
	mergeTrees,
	mergeTreesDetailed,
	mergeTreesDetailedFromTreeHashes,
	mergeTreesFromTreeHashes,
	type BlobSide,
	type ConflictedPath,
	type MergeConflict,
	type MergeDriver,
	type MergeDriverResult,
	type MergeTreesDetailedResult,
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

// Operations
export {
	bisect,
	cherryPick,
	merge,
	pull,
	rebase,
	revert,
	type BisectOptions,
	type BisectSearchResult,
	type BisectStepInfo,
	type CherryPickOptions,
	type CherryPickResult,
	type CleanPickCommitted,
	type CleanPickNoCommit,
	type MergeOptions,
	type MergeResult,
	type NoCommitPickResult,
	type NoCommitRevertResult,
	type PickConflict,
	type PullOptions,
	type PullResult,
	type RebaseContinuation,
	type RebaseOptions,
	type RebaseResult,
	type Resolution,
	type RevertOptions,
	type RevertResult,
} from "./operations.ts";

// Network operations (clone / fetch / push over a GitRepo; network behavior
// rides on repo.capabilities)
export {
	cloneInto,
	fetch,
	listRemoteRefs,
	push,
	type CloneResult,
	type FetchResult,
	type PushRefResult,
	type PushRefStatus,
	type PushRemote,
	type PushResult,
	type RemoteRef,
} from "./network.ts";

// Patching — tree-level apply with rejects-as-data, plus promoted pure
// patch primitives (parse / reverse / format-patch)
export {
	applyPatch,
	ApplyParseError,
	FormatPatchError,
	formatPatchSeries,
	parsePatch,
	reversePatch,
	type ApplyHunkLine,
	type ApplyPatchOptions,
	type ApplyPatchResult,
	type BlobEffect,
	type FileReject,
	type FormatPatchOptions,
	type FormatPatchResult,
	type HunkReject,
	type ParsedPatch,
	type PatchChangeKind,
	type PatchFragment,
	type PatchRecord,
	type WhitespaceAction,
} from "./patching.ts";

export { createTreeAccessor, type TreeAccessor } from "./tree-accessor.ts";

export type { MaterializeTarget } from "./materialize.ts";

// Safety
export { overlayRepo, readonlyRepo } from "./safety.ts";

// Re-exported lib types used in helper signatures
export type { ConfigOverrides } from "../lib/config/store.ts";
export type {
	Commit,
	ConfigView,
	GitRepo,
	Identity,
	RefEntry,
	TreeDiffEntry,
	TreeEntry,
} from "../lib/types.ts";
export type { FlatTreeEntry } from "../lib/tree-ops.ts";
