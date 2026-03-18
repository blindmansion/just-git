import type { HttpAuth } from "./lib/transport/transport.ts";

export interface ExecResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

import type { GitRepo, Identity, Index, ObjectId, ObjectType } from "./lib/types.ts";

// ── Credential & Identity overrides ─────────────────────────────────

export type CredentialProvider = (url: string) => HttpAuth | null | Promise<HttpAuth | null>;

export interface IdentityOverride {
	name: string;
	email: string;
	locked?: boolean;
}

// ── Network policy ──────────────────────────────────────────────────

export type FetchFunction = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

export interface NetworkPolicy {
	/**
	 * Allowed URL patterns. Can be:
	 * - A hostname: "github.com" (matches any URL whose host equals this)
	 * - A URL prefix: "https://github.com/myorg/" (matches URLs starting with this)
	 */
	allowed?: string[];
	/** Custom fetch function for HTTP transport. Falls back to globalThis.fetch. */
	fetch?: FetchFunction;
}

// ── Rejection protocol ──────────────────────────────────────────────

export interface Rejection {
	reject: true;
	message?: string;
}

export function isRejection(value: unknown): value is Rejection {
	return (
		value != null &&
		typeof value === "object" &&
		"reject" in value &&
		(value as Rejection).reject === true
	);
}

// ── Hook event payloads ─────────────────────────────────────────────

export interface PreCommitEvent {
	readonly repo: GitRepo;
	readonly index: Index;
	readonly treeHash: ObjectId;
}

export interface CommitMsgEvent {
	readonly repo: GitRepo;
	message: string;
}

export interface MergeMsgEvent {
	readonly repo: GitRepo;
	message: string;
	readonly treeHash: ObjectId;
	readonly headHash: ObjectId;
	readonly theirsHash: ObjectId;
}

export interface PostCommitEvent {
	readonly repo: GitRepo;
	readonly hash: ObjectId;
	readonly message: string;
	readonly branch: string | null;
	readonly parents: readonly ObjectId[];
	readonly author: Identity;
}

export interface PreMergeCommitEvent {
	readonly repo: GitRepo;
	readonly mergeMessage: string;
	readonly treeHash: ObjectId;
	readonly headHash: ObjectId;
	readonly theirsHash: ObjectId;
}

export interface PostMergeEvent {
	readonly repo: GitRepo;
	readonly headHash: ObjectId;
	readonly theirsHash: ObjectId;
	readonly strategy: "fast-forward" | "three-way";
	readonly commitHash: ObjectId | null;
}

export interface PostCheckoutEvent {
	readonly repo: GitRepo;
	readonly prevHead: ObjectId | null;
	readonly newHead: ObjectId;
	readonly isBranchCheckout: boolean;
}

export interface PrePushEvent {
	readonly repo: GitRepo;
	readonly remote: string;
	readonly url: string;
	readonly refs: ReadonlyArray<{
		srcRef: string | null;
		srcHash: ObjectId | null;
		dstRef: string;
		dstHash: ObjectId | null;
		force: boolean;
		delete: boolean;
	}>;
}

export type PostPushEvent = PrePushEvent;

export interface PreRebaseEvent {
	readonly repo: GitRepo;
	readonly upstream: string;
	readonly branch: string | null;
}

export interface PreCheckoutEvent {
	readonly repo: GitRepo;
	readonly target: string;
	readonly mode: "switch" | "detach" | "create-branch" | "paths";
}

export interface PreFetchEvent {
	readonly repo: GitRepo;
	readonly remote: string;
	readonly url: string;
	readonly refspecs: readonly string[];
	readonly prune: boolean;
	readonly tags: boolean;
}

export interface PostFetchEvent {
	readonly repo: GitRepo;
	readonly remote: string;
	readonly url: string;
	readonly refsUpdated: number;
}

export interface PreCloneEvent {
	readonly repo?: GitRepo;
	readonly repository: string;
	readonly targetPath: string;
	readonly bare: boolean;
	readonly branch: string | null;
}

export interface PostCloneEvent {
	readonly repo: GitRepo;
	readonly repository: string;
	readonly targetPath: string;
	readonly bare: boolean;
	readonly branch: string | null;
}

export interface PrePullEvent {
	readonly repo: GitRepo;
	readonly remote: string;
	readonly branch: string | null;
}

export interface PostPullEvent {
	readonly repo: GitRepo;
	readonly remote: string;
	readonly branch: string | null;
	readonly strategy: "up-to-date" | "fast-forward" | "three-way";
	readonly commitHash: ObjectId | null;
}

export interface PreResetEvent {
	readonly repo: GitRepo;
	readonly mode: "soft" | "mixed" | "hard" | "paths";
	readonly target: string | null;
}

export interface PostResetEvent {
	readonly repo: GitRepo;
	readonly mode: "soft" | "mixed" | "hard" | "paths";
	readonly targetHash: ObjectId | null;
}

export interface PreCleanEvent {
	readonly repo: GitRepo;
	readonly dryRun: boolean;
	readonly force: boolean;
	readonly removeDirs: boolean;
	readonly removeIgnored: boolean;
	readonly onlyIgnored: boolean;
}

export interface PostCleanEvent {
	readonly repo: GitRepo;
	readonly removed: readonly string[];
	readonly dryRun: boolean;
}

export interface PreRmEvent {
	readonly repo: GitRepo;
	readonly paths: readonly string[];
	readonly cached: boolean;
	readonly recursive: boolean;
	readonly force: boolean;
}

export interface PostRmEvent {
	readonly repo: GitRepo;
	readonly removedPaths: readonly string[];
	readonly cached: boolean;
}

export interface PreCherryPickEvent {
	readonly repo: GitRepo;
	readonly mode: "pick" | "continue" | "abort";
	readonly commit: string | null;
}

export interface PostCherryPickEvent {
	readonly repo: GitRepo;
	readonly mode: "pick" | "continue" | "abort";
	readonly commitHash: ObjectId | null;
	readonly hadConflicts: boolean;
}

export interface PreRevertEvent {
	readonly repo: GitRepo;
	readonly mode: "revert" | "continue" | "abort";
	readonly commit: string | null;
}

export interface PostRevertEvent {
	readonly repo: GitRepo;
	readonly mode: "revert" | "continue" | "abort";
	readonly commitHash: ObjectId | null;
	readonly hadConflicts: boolean;
}

export interface PreStashEvent {
	readonly repo: GitRepo;
	readonly action: "push" | "pop" | "apply" | "list" | "drop" | "show" | "clear";
	readonly ref: string | null;
}

export interface PostStashEvent {
	readonly repo: GitRepo;
	readonly action: "push" | "pop" | "apply" | "list" | "drop" | "show" | "clear";
	readonly ok: boolean;
}

export interface RefUpdateEvent {
	readonly repo: GitRepo;
	readonly ref: string;
	readonly oldHash: ObjectId | null;
	readonly newHash: ObjectId;
}

export interface RefDeleteEvent {
	readonly repo: GitRepo;
	readonly ref: string;
	readonly oldHash: ObjectId | null;
}

export interface ObjectWriteEvent {
	readonly repo: GitRepo;
	readonly type: ObjectType;
	readonly hash: ObjectId;
}

// ── Command-level events ────────────────────────────────────────────

import type { FileSystem } from "./fs.ts";

export interface BeforeCommandEvent {
	readonly command: string;
	readonly args: string[];
	readonly fs: FileSystem;
	readonly cwd: string;
	readonly env: Map<string, string>;
}

export interface AfterCommandEvent {
	readonly command: string;
	readonly args: string[];
	readonly result: ExecResult;
}

// ── GitHooks interface ──────────────────────────────────────────────

type PreHookReturn = void | Rejection | Promise<void | Rejection>;
type PostHookReturn = void | Promise<void>;

export interface GitHooks {
	preCommit?: (event: PreCommitEvent) => PreHookReturn;
	commitMsg?: (event: CommitMsgEvent) => PreHookReturn;
	mergeMsg?: (event: MergeMsgEvent) => PreHookReturn;
	preMergeCommit?: (event: PreMergeCommitEvent) => PreHookReturn;
	preCheckout?: (event: PreCheckoutEvent) => PreHookReturn;
	prePush?: (event: PrePushEvent) => PreHookReturn;
	preFetch?: (event: PreFetchEvent) => PreHookReturn;
	preClone?: (event: PreCloneEvent) => PreHookReturn;
	prePull?: (event: PrePullEvent) => PreHookReturn;
	preRebase?: (event: PreRebaseEvent) => PreHookReturn;
	preReset?: (event: PreResetEvent) => PreHookReturn;
	preClean?: (event: PreCleanEvent) => PreHookReturn;
	preRm?: (event: PreRmEvent) => PreHookReturn;
	preCherryPick?: (event: PreCherryPickEvent) => PreHookReturn;
	preRevert?: (event: PreRevertEvent) => PreHookReturn;
	preStash?: (event: PreStashEvent) => PreHookReturn;

	postCommit?: (event: PostCommitEvent) => PostHookReturn;
	postMerge?: (event: PostMergeEvent) => PostHookReturn;
	postCheckout?: (event: PostCheckoutEvent) => PostHookReturn;
	postPush?: (event: PostPushEvent) => PostHookReturn;
	postFetch?: (event: PostFetchEvent) => PostHookReturn;
	postClone?: (event: PostCloneEvent) => PostHookReturn;
	postPull?: (event: PostPullEvent) => PostHookReturn;
	postReset?: (event: PostResetEvent) => PostHookReturn;
	postClean?: (event: PostCleanEvent) => PostHookReturn;
	postRm?: (event: PostRmEvent) => PostHookReturn;
	postCherryPick?: (event: PostCherryPickEvent) => PostHookReturn;
	postRevert?: (event: PostRevertEvent) => PostHookReturn;
	postStash?: (event: PostStashEvent) => PostHookReturn;

	onRefUpdate?: (event: RefUpdateEvent) => void;
	onRefDelete?: (event: RefDeleteEvent) => void;
	onObjectWrite?: (event: ObjectWriteEvent) => void;

	beforeCommand?: (event: BeforeCommandEvent) => PreHookReturn;
	afterCommand?: (event: AfterCommandEvent) => PostHookReturn;
}

// ── composeGitHooks ─────────────────────────────────────────────────

const PRE_HOOK_KEYS: (keyof GitHooks)[] = [
	"preCommit",
	"preMergeCommit",
	"preCheckout",
	"prePush",
	"preFetch",
	"preClone",
	"prePull",
	"preRebase",
	"preReset",
	"preClean",
	"preRm",
	"preCherryPick",
	"preRevert",
	"preStash",
	"beforeCommand",
];

const MUTABLE_MSG_KEYS: (keyof GitHooks)[] = ["commitMsg", "mergeMsg"];

const POST_HOOK_KEYS: (keyof GitHooks)[] = [
	"postCommit",
	"postMerge",
	"postCheckout",
	"postPush",
	"postFetch",
	"postClone",
	"postPull",
	"postReset",
	"postClean",
	"postRm",
	"postCherryPick",
	"postRevert",
	"postStash",
	"afterCommand",
];

const LOW_LEVEL_KEYS: (keyof GitHooks)[] = ["onRefUpdate", "onRefDelete", "onObjectWrite"];

export function composeGitHooks(...hookSets: (GitHooks | undefined)[]): GitHooks {
	const sets = hookSets.filter((h): h is GitHooks => h != null);
	if (sets.length === 0) return {};
	if (sets.length === 1) return sets[0]!;

	const composed: GitHooks = {};

	for (const key of PRE_HOOK_KEYS) {
		const handlers = sets.filter((s) => s[key]).map((s) => s[key]!);
		if (handlers.length > 0) {
			(composed as Record<string, unknown>)[key] = async (event: unknown) => {
				for (const handler of handlers) {
					const result = await (handler as (e: unknown) => PreHookReturn)(event);
					if (isRejection(result)) return result;
				}
			};
		}
	}

	for (const key of MUTABLE_MSG_KEYS) {
		const handlers = sets.filter((s) => s[key]).map((s) => s[key]!);
		if (handlers.length > 0) {
			(composed as Record<string, unknown>)[key] = async (event: unknown) => {
				for (const handler of handlers) {
					const result = await (handler as (e: unknown) => PreHookReturn)(event);
					if (isRejection(result)) return result;
				}
			};
		}
	}

	for (const key of POST_HOOK_KEYS) {
		const handlers = sets.filter((s) => s[key]).map((s) => s[key]!);
		if (handlers.length > 0) {
			(composed as Record<string, unknown>)[key] = async (event: unknown) => {
				for (const handler of handlers) {
					try {
						await (handler as (e: unknown) => PostHookReturn)(event);
					} catch {
						// fire-and-forget: one handler failing doesn't block the rest
					}
				}
			};
		}
	}

	for (const key of LOW_LEVEL_KEYS) {
		const handlers = sets.filter((s) => s[key]).map((s) => s[key]!);
		if (handlers.length > 0) {
			(composed as Record<string, unknown>)[key] = (event: unknown) => {
				for (const handler of handlers) {
					try {
						(handler as (e: unknown) => void)(event);
					} catch {
						// fire-and-forget
					}
				}
			};
		}
	}

	return composed;
}
