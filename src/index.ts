export type { DurableFileSystem, FileStat, FileSystem } from "./fs/index.ts";
export { isDurable } from "./fs/index.ts";
export { durableFileSystemFromNodeFs, type NodeFsPromises } from "./fs/node-durable-fs.ts";
export type { ExecContext, GitCommandName, GitOptions } from "./git.ts";
export { createGit, Git } from "./git.ts";
export type { CommandResult } from "./commands/kit/command-result.ts";
export type {
	AfterCommandEvent,
	BeforeCommandEvent,
	CommitMsgEvent,
	GitHooks,
	MergeMsgEvent,
	ObjectWriteEvent,
	PostApplyEvent,
	PostCheckoutEvent,
	PostCherryPickEvent,
	PostCloneEvent,
	PostCommitEvent,
	PostFetchEvent,
	PostMergeEvent,
	PostPullEvent,
	PostPushEvent,
	PostResetEvent,
	PostRevertEvent,
	PreApplyEvent,
	PreCheckoutEvent,
	PreCherryPickEvent,
	PreCloneEvent,
	PreCommitEvent,
	PreFetchEvent,
	PreMergeCommitEvent,
	PrePullEvent,
	PrePushEvent,
	PreRebaseEvent,
	PreResetEvent,
	PreRevertEvent,
	RefDeleteEvent,
	RefUpdateEvent,
	Rejection,
	RepoHooks,
} from "./hooks.ts";
export { composeGitHooks, isRejection } from "./hooks.ts";
export type { ConfigOverrides } from "./lib/config/store.ts";
export type { IdentityOverride } from "./lib/identity.ts";
export { MemoryFileSystem } from "./fs/memory-fs.ts";
export type {
	CapabilityContext,
	Commit,
	ConfigView,
	DirectRef,
	GitContext,
	GitOperation,
	GitRepo,
	Identity,
	ObjectId,
	ObjectStore,
	ObjectType,
	RawObject,
	Ref,
	RefEntry,
	RefStore,
	RemoteResolver,
	RepoCapabilities,
	SymbolicRef,
	TransportResolver,
	TransportTarget,
} from "./lib/types.ts";
export {
	allowlist,
	type FetchWrapper,
	httpTransport,
	pipe,
	withAuth,
	withRetry,
} from "./transport.ts";
export { mergeCapabilities, withCapabilities } from "./lib/capabilities.ts";
export { everyPath, gitAttributes, pipeAttributes } from "./lib/attributes/attribute-resolver.ts";
export type {
	AttributeResolver,
	GitAttributesOptions,
	ResolvedAttributes,
} from "./lib/attributes/attribute-resolver.ts";
export type { AttributesProvider, AttrValue } from "./lib/attributes/attributes.ts";
export { FilterError } from "./lib/attributes/filters.ts";
export type {
	FilterConfig,
	FilterDriver,
	FilterFn,
	FilterInput,
} from "./lib/attributes/filters.ts";
export type { MergeDriver, MergeDriverInput, MergeDriverResult } from "./lib/merge-ort.ts";
export type { PackObject } from "./lib/pack/packfile.ts";
export {
	commitSigningPayload,
	SigningError,
	tagSigningPayload,
	VerificationError,
} from "./lib/signing.ts";
export type {
	SignatureFormat,
	Signer,
	SigningCapability,
	Verifier,
	VerifierOptions,
	VerificationResult,
} from "./lib/signing.ts";
export type {
	CredentialProvider,
	CredentialStore,
	HttpAuth,
	NetworkPolicy,
	ProgressCallback,
} from "./lib/transport/transport.ts";
export { createMemoryCredentialStore } from "./lib/transport/transport.ts";
export { findRepo } from "./lib/repo.ts";
