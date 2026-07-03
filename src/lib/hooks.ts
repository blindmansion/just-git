// The semantic hook contract: repository/operation/object events a host can
// observe or veto. This is the fs-/CLI-agnostic subset that attaches to a bare
// {@link GitRepo} via `RepoCapabilities.hooks` — every event carries only a
// `GitRepo` plus semantic fields, never a filesystem or a command context. The
// CLI-only command middleware (`beforeCommand`/`afterCommand`) lives in the
// client layer (`src/hooks.ts`), not here.

import type { GitRepo, Identity, Index, ObjectId, ObjectType } from "./types.ts";

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
	readonly message: string;
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
	readonly mode: "switch" | "detach" | "create-branch";
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
	readonly updatedRefCount: number;
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
	readonly targetRef: string | null;
}

/** Fired after a reset completes. */
export interface PostResetEvent {
	readonly repo: GitRepo;
	readonly mode: "soft" | "mixed" | "hard" | "paths";
	readonly targetHash: ObjectId | null;
}

/** Base type for pre-hooks that apply a commit (cherry-pick, revert). */
export interface PreApplyEvent {
	readonly repo: GitRepo;
	readonly mode: string;
	readonly commitRef: string | null;
}

/** Base type for post-hooks that apply a commit (cherry-pick, revert). */
export interface PostApplyEvent {
	readonly repo: GitRepo;
	readonly mode: string;
	readonly commitHash: ObjectId | null;
	readonly hadConflicts: boolean;
}

/** Fired before a cherry-pick. Return a {@link Rejection} to block. */
export interface PreCherryPickEvent extends PreApplyEvent {
	readonly mode: "pick" | "continue" | "abort";
}

/** Fired after a cherry-pick completes. */
export interface PostCherryPickEvent extends PostApplyEvent {
	readonly mode: "pick" | "continue" | "abort";
}

/** Fired before a revert. Return a {@link Rejection} to block. */
export interface PreRevertEvent extends PreApplyEvent {
	readonly mode: "revert" | "continue" | "abort";
}

/** Fired after a revert completes. */
export interface PostRevertEvent extends PostApplyEvent {
	readonly mode: "revert" | "continue" | "abort";
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

// ── RepoHooks interface ─────────────────────────────────────────────

type PreHookReturn = void | Rejection | Promise<void | Rejection>;
type PostHookReturn = void | Promise<void>;

/**
 * Semantic hook callbacks for intercepting git operations on a repository.
 *
 * Pre-hooks can return a {@link Rejection} to block the operation.
 * Post-hooks are fire-and-forget. Low-level events (`onRefUpdate`,
 * `onRefDelete`, `onObjectWrite`) fire synchronously on every
 * ref/object write.
 *
 * Every event carries only a {@link GitRepo} plus semantic fields — no
 * filesystem, no CLI/command context — so these hooks apply equally to a bare
 * repo handle, the SDK, and the CLI. The CLI-only command middleware
 * (`beforeCommand`/`afterCommand`) is a separate concern layered on top by the
 * `Git` client, not part of this contract.
 *
 * Use {@link composeGitHooks} to combine multiple hook sets.
 */
export interface RepoHooks {
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
	preCherryPick?: (event: PreCherryPickEvent) => PreHookReturn;
	preRevert?: (event: PreRevertEvent) => PreHookReturn;

	postCommit?: (event: PostCommitEvent) => PostHookReturn;
	postMerge?: (event: PostMergeEvent) => PostHookReturn;
	postCheckout?: (event: PostCheckoutEvent) => PostHookReturn;
	postPush?: (event: PostPushEvent) => PostHookReturn;
	postFetch?: (event: PostFetchEvent) => PostHookReturn;
	postClone?: (event: PostCloneEvent) => PostHookReturn;
	postPull?: (event: PostPullEvent) => PostHookReturn;
	postReset?: (event: PostResetEvent) => PostHookReturn;
	postCherryPick?: (event: PostCherryPickEvent) => PostHookReturn;
	postRevert?: (event: PostRevertEvent) => PostHookReturn;

	onRefUpdate?: (event: RefUpdateEvent) => void;
	onRefDelete?: (event: RefDeleteEvent) => void;
	onObjectWrite?: (event: ObjectWriteEvent) => void;
}

// ── composeGitHooks ─────────────────────────────────────────────────

const PRE_HOOK_KEYS: (keyof RepoHooks)[] = [
	"preCommit",
	"preMergeCommit",
	"preCheckout",
	"prePush",
	"preFetch",
	"preClone",
	"prePull",
	"preRebase",
	"preReset",
	"preCherryPick",
	"preRevert",
];

const MUTABLE_MSG_KEYS: (keyof RepoHooks)[] = ["commitMsg", "mergeMsg"];

const POST_HOOK_KEYS: (keyof RepoHooks)[] = [
	"postCommit",
	"postMerge",
	"postCheckout",
	"postPush",
	"postFetch",
	"postClone",
	"postPull",
	"postReset",
	"postCherryPick",
	"postRevert",
];

const LOW_LEVEL_KEYS: (keyof RepoHooks)[] = ["onRefUpdate", "onRefDelete", "onObjectWrite"];

/**
 * Combine multiple {@link RepoHooks} objects into one.
 *
 * Pre-hooks chain in order, short-circuiting on the first {@link Rejection}.
 * Post-hooks and low-level events chain in order, individually try/caught.
 * Mutable-message hooks (`commitMsg`, `mergeMsg`) pass the mutated message through.
 */
export function composeGitHooks(...hookSets: (RepoHooks | undefined)[]): RepoHooks {
	const sets = hookSets.filter((h): h is RepoHooks => h != null);
	if (sets.length === 0) return {};
	if (sets.length === 1) return sets[0]!;

	const composed: RepoHooks = {};

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
