import type { HttpAuth } from "./lib/transport/transport.ts";

/** Result of executing a git command. */
export interface ExecResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

import type { GitRepo, Identity, Index, ObjectId, ObjectType } from "./lib/types.ts";

// ── Credential & Identity overrides ─────────────────────────────────

/**
 * Callback that provides HTTP authentication for remote operations.
 * Called with the remote URL; return credentials or null for anonymous access.
 */
export type CredentialProvider = (url: string) => HttpAuth | null | Promise<HttpAuth | null>;

/**
 * Override the author/committer identity for commits.
 *
 * When `locked` is true, this identity always wins — even if the agent
 * sets `GIT_AUTHOR_NAME` or runs `git config user.name`. When unlocked
 * (default), acts as a fallback when env vars and git config are absent.
 */
export interface IdentityOverride {
	name: string;
	email: string;
	/** When true, this identity cannot be overridden by env vars or git config. */
	locked?: boolean;
}

/**
 * Operator-level config overrides. Applied on every `getConfigValue()` read:
 *
 * - `locked` values take absolute precedence — the agent cannot override
 *   them via `git config`. Writes still succeed on the VFS (so the agent
 *   doesn't see errors), but the locked value always wins on read.
 * - `defaults` supply fallback values when a key is absent from
 *   `.git/config`. The agent *can* override these with `git config`.
 *
 * Keys are dotted config names, e.g. `"push.default"`, `"merge.ff"`.
 */
export interface ConfigOverrides {
	locked?: Record<string, string>;
	defaults?: Record<string, string>;
}

// ── Network policy ──────────────────────────────────────────────────

/** Custom fetch function signature for HTTP transport. */
export type FetchFunction = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

/**
 * Controls which remote URLs the git instance may access over HTTP.
 * Set to `false` on {@link GitOptions.network} to block all HTTP access.
 */
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

/**
 * Returned from pre-hooks to block an operation.
 * The optional `message` is surfaced as stderr.
 */
export interface Rejection {
	reject: true;
	message?: string;
}

/** Type guard for {@link Rejection}. */
export function isRejection(value: unknown): value is Rejection {
	return (
		value != null &&
		typeof value === "object" &&
		"reject" in value &&
		(value as Rejection).reject === true
	);
}

// ── Hook event payloads ─────────────────────────────────────────────

/** Fired before a commit is created. Return a {@link Rejection} to block. */
export interface PreCommitEvent {
	readonly repo: GitRepo;
	readonly index: Index;
	readonly treeHash: ObjectId;
}

/** Fired after `preCommit` passes. Mutate `message` to rewrite the commit message. */
export interface CommitMsgEvent {
	readonly repo: GitRepo;
	message: string;
}

/** Fired before a merge commit. Mutate `message` to rewrite the merge message. */
export interface MergeMsgEvent {
	readonly repo: GitRepo;
	message: string;
	readonly treeHash: ObjectId;
	readonly headHash: ObjectId;
	readonly theirsHash: ObjectId;
}

/** Fired after a commit is successfully created. */
export interface PostCommitEvent {
	readonly repo: GitRepo;
	readonly hash: ObjectId;
	readonly message: string;
	readonly branch: string | null;
	readonly parents: readonly ObjectId[];
	readonly author: Identity;
}

/** Fired before a three-way merge commit is written. Return a {@link Rejection} to block. */
export interface PreMergeCommitEvent {
	readonly repo: GitRepo;
	readonly mergeMessage: string;
	readonly treeHash: ObjectId;
	readonly headHash: ObjectId;
	readonly theirsHash: ObjectId;
}

/** Fired after a merge completes (fast-forward or three-way). */
export interface PostMergeEvent {
	readonly repo: GitRepo;
	readonly headHash: ObjectId;
	readonly theirsHash: ObjectId;
	readonly strategy: "fast-forward" | "three-way";
	readonly commitHash: ObjectId | null;
}

/** Fired after a branch checkout or detached HEAD checkout completes. */
export interface PostCheckoutEvent {
	readonly repo: GitRepo;
	readonly prevHead: ObjectId | null;
	readonly newHead: ObjectId;
	readonly isBranchCheckout: boolean;
}

/** Fired before objects are transferred during `git push`. Return a {@link Rejection} to block. */
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

/** Fired after a push completes. Same payload as {@link PrePushEvent}. */
export type PostPushEvent = PrePushEvent;

/** Fired before a rebase begins. Return a {@link Rejection} to block. */
export interface PreRebaseEvent {
	readonly repo: GitRepo;
	readonly upstream: string;
	readonly branch: string | null;
}

/** Fired before a checkout or switch. Return a {@link Rejection} to block. */
export interface PreCheckoutEvent {
	readonly repo: GitRepo;
	readonly target: string;
	readonly mode: "switch" | "detach" | "create-branch" | "paths";
}

/** Fired before a fetch begins. Return a {@link Rejection} to block. */
export interface PreFetchEvent {
	readonly repo: GitRepo;
	readonly remote: string;
	readonly url: string;
	readonly refspecs: readonly string[];
	readonly prune: boolean;
	readonly tags: boolean;
}

/** Fired after a fetch completes. */
export interface PostFetchEvent {
	readonly repo: GitRepo;
	readonly remote: string;
	readonly url: string;
	readonly refsUpdated: number;
}

/** Fired before a clone begins. Return a {@link Rejection} to block. */
export interface PreCloneEvent {
	readonly repo?: GitRepo;
	readonly repository: string;
	readonly targetPath: string;
	readonly bare: boolean;
	readonly branch: string | null;
}

/** Fired after a clone completes. */
export interface PostCloneEvent {
	readonly repo: GitRepo;
	readonly repository: string;
	readonly targetPath: string;
	readonly bare: boolean;
	readonly branch: string | null;
}

/** Fired before a pull begins. Return a {@link Rejection} to block. */
export interface PrePullEvent {
	readonly repo: GitRepo;
	readonly remote: string;
	readonly branch: string | null;
}

/** Fired after a pull completes. */
export interface PostPullEvent {
	readonly repo: GitRepo;
	readonly remote: string;
	readonly branch: string | null;
	readonly strategy: "up-to-date" | "fast-forward" | "three-way" | "rebase";
	readonly commitHash: ObjectId | null;
}

/** Fired before a reset. Return a {@link Rejection} to block. */
export interface PreResetEvent {
	readonly repo: GitRepo;
	readonly mode: "soft" | "mixed" | "hard" | "paths";
	readonly target: string | null;
}

/** Fired after a reset completes. */
export interface PostResetEvent {
	readonly repo: GitRepo;
	readonly mode: "soft" | "mixed" | "hard" | "paths";
	readonly targetHash: ObjectId | null;
}

/** Fired before `git clean`. Return a {@link Rejection} to block. */
export interface PreCleanEvent {
	readonly repo: GitRepo;
	readonly dryRun: boolean;
	readonly force: boolean;
	readonly removeDirs: boolean;
	readonly removeIgnored: boolean;
	readonly onlyIgnored: boolean;
}

/** Fired after `git clean` completes. */
export interface PostCleanEvent {
	readonly repo: GitRepo;
	readonly removed: readonly string[];
	readonly dryRun: boolean;
}

/** Fired before `git rm`. Return a {@link Rejection} to block. */
export interface PreRmEvent {
	readonly repo: GitRepo;
	readonly paths: readonly string[];
	readonly cached: boolean;
	readonly recursive: boolean;
	readonly force: boolean;
}

/** Fired after `git rm` completes. */
export interface PostRmEvent {
	readonly repo: GitRepo;
	readonly removedPaths: readonly string[];
	readonly cached: boolean;
}

/** Fired before a cherry-pick. Return a {@link Rejection} to block. */
export interface PreCherryPickEvent {
	readonly repo: GitRepo;
	readonly mode: "pick" | "continue" | "abort";
	readonly commit: string | null;
}

/** Fired after a cherry-pick completes. */
export interface PostCherryPickEvent {
	readonly repo: GitRepo;
	readonly mode: "pick" | "continue" | "abort";
	readonly commitHash: ObjectId | null;
	readonly hadConflicts: boolean;
}

/** Fired before a revert. Return a {@link Rejection} to block. */
export interface PreRevertEvent {
	readonly repo: GitRepo;
	readonly mode: "revert" | "continue" | "abort";
	readonly commit: string | null;
}

/** Fired after a revert completes. */
export interface PostRevertEvent {
	readonly repo: GitRepo;
	readonly mode: "revert" | "continue" | "abort";
	readonly commitHash: ObjectId | null;
	readonly hadConflicts: boolean;
}

/** Fired before a stash operation. Return a {@link Rejection} to block. */
export interface PreStashEvent {
	readonly repo: GitRepo;
	readonly action: "push" | "pop" | "apply" | "list" | "drop" | "show" | "clear";
	readonly ref: string | null;
}

/** Fired after a stash operation completes. */
export interface PostStashEvent {
	readonly repo: GitRepo;
	readonly action: "push" | "pop" | "apply" | "list" | "drop" | "show" | "clear";
	readonly ok: boolean;
}

/** Fired whenever a ref is created or updated. */
export interface RefUpdateEvent {
	readonly repo: GitRepo;
	readonly ref: string;
	readonly oldHash: ObjectId | null;
	readonly newHash: ObjectId;
}

/** Fired whenever a ref is deleted. */
export interface RefDeleteEvent {
	readonly repo: GitRepo;
	readonly ref: string;
	readonly oldHash: ObjectId | null;
}

/** Fired whenever a git object (blob, tree, commit, tag) is written to the store. */
export interface ObjectWriteEvent {
	readonly repo: GitRepo;
	readonly type: ObjectType;
	readonly hash: ObjectId;
}

// ── Command-level events ────────────────────────────────────────────

import type { FileSystem } from "./fs.ts";

/** Fired before any git subcommand executes. Return a {@link Rejection} to block. */
export interface BeforeCommandEvent {
	readonly command: string;
	readonly args: string[];
	readonly fs: FileSystem;
	readonly cwd: string;
	readonly env: Map<string, string>;
}

/** Fired after any git subcommand completes. */
export interface AfterCommandEvent {
	readonly command: string;
	readonly args: string[];
	readonly result: ExecResult;
}

// ── GitHooks interface ──────────────────────────────────────────────

type PreHookReturn = void | Rejection | Promise<void | Rejection>;
type PostHookReturn = void | Promise<void>;

/**
 * Hook callbacks for intercepting git operations.
 *
 * Pre-hooks can return a {@link Rejection} to block the operation.
 * Post-hooks are fire-and-forget. Low-level events (`onRefUpdate`,
 * `onRefDelete`, `onObjectWrite`) fire synchronously on every
 * ref/object write.
 *
 * Use {@link composeGitHooks} to combine multiple hook sets.
 */
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

/**
 * Combine multiple {@link GitHooks} objects into one.
 *
 * Pre-hooks chain in order, short-circuiting on the first {@link Rejection}.
 * Post-hooks and low-level events chain in order, individually try/caught.
 * Mutable-message hooks (`commitMsg`, `mergeMsg`) pass the mutated message through.
 */
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
