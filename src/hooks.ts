import type { HttpAuth } from "./lib/transport/transport.ts";

export interface ExecResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

import type { Identity, Index, ObjectId, ObjectType } from "./lib/types.ts";

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

// ── Hook event payloads ─────────────────────────────────────────────

export interface PreCommitEvent {
	readonly index: Index;
	readonly treeHash: ObjectId;
}

export interface CommitMsgEvent {
	message: string;
}

export interface MergeMsgEvent {
	message: string;
	readonly treeHash: ObjectId;
	readonly headHash: ObjectId;
	readonly theirsHash: ObjectId;
}

export interface PostCommitEvent {
	readonly hash: ObjectId;
	readonly message: string;
	readonly branch: string | null;
	readonly parents: readonly ObjectId[];
	readonly author: Identity;
}

export interface PreMergeCommitEvent {
	readonly mergeMessage: string;
	readonly treeHash: ObjectId;
	readonly headHash: ObjectId;
	readonly theirsHash: ObjectId;
}

export interface PostMergeEvent {
	readonly headHash: ObjectId;
	readonly theirsHash: ObjectId;
	readonly strategy: "fast-forward" | "three-way";
	readonly commitHash: ObjectId | null;
}

export interface PostCheckoutEvent {
	readonly prevHead: ObjectId | null;
	readonly newHead: ObjectId;
	readonly isBranchCheckout: boolean;
}

export interface PrePushEvent {
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
	readonly upstream: string;
	readonly branch: string | null;
}

export interface PreCheckoutEvent {
	readonly target: string;
	readonly mode: "switch" | "detach" | "create-branch" | "paths";
}

export interface PreFetchEvent {
	readonly remote: string;
	readonly url: string;
	readonly refspecs: readonly string[];
	readonly prune: boolean;
	readonly tags: boolean;
}

export interface PostFetchEvent {
	readonly remote: string;
	readonly url: string;
	readonly refsUpdated: number;
}

export interface PreCloneEvent {
	readonly repository: string;
	readonly targetPath: string;
	readonly bare: boolean;
	readonly branch: string | null;
}

export interface PostCloneEvent {
	readonly repository: string;
	readonly targetPath: string;
	readonly bare: boolean;
	readonly branch: string | null;
}

export interface PrePullEvent {
	readonly remote: string;
	readonly branch: string | null;
}

export interface PostPullEvent {
	readonly remote: string;
	readonly branch: string | null;
	readonly strategy: "up-to-date" | "fast-forward" | "three-way";
	readonly commitHash: ObjectId | null;
}

export interface PreResetEvent {
	readonly mode: "soft" | "mixed" | "hard" | "paths";
	readonly target: string | null;
}

export interface PostResetEvent {
	readonly mode: "soft" | "mixed" | "hard" | "paths";
	readonly targetHash: ObjectId | null;
}

export interface PreCleanEvent {
	readonly dryRun: boolean;
	readonly force: boolean;
	readonly removeDirs: boolean;
	readonly removeIgnored: boolean;
	readonly onlyIgnored: boolean;
}

export interface PostCleanEvent {
	readonly removed: readonly string[];
	readonly dryRun: boolean;
}

export interface PreRmEvent {
	readonly paths: readonly string[];
	readonly cached: boolean;
	readonly recursive: boolean;
	readonly force: boolean;
}

export interface PostRmEvent {
	readonly removedPaths: readonly string[];
	readonly cached: boolean;
}

export interface PreCherryPickEvent {
	readonly mode: "pick" | "continue" | "abort";
	readonly commit: string | null;
}

export interface PostCherryPickEvent {
	readonly mode: "pick" | "continue" | "abort";
	readonly commitHash: ObjectId | null;
	readonly hadConflicts: boolean;
}

export interface PreRevertEvent {
	readonly mode: "revert" | "continue" | "abort";
	readonly commit: string | null;
}

export interface PostRevertEvent {
	readonly mode: "revert" | "continue" | "abort";
	readonly commitHash: ObjectId | null;
	readonly hadConflicts: boolean;
}

export interface PreStashEvent {
	readonly action: "push" | "pop" | "apply" | "list" | "drop" | "show" | "clear";
	readonly ref: string | null;
}

export interface PostStashEvent {
	readonly action: "push" | "pop" | "apply" | "list" | "drop" | "show" | "clear";
	readonly ok: boolean;
}

export interface RefUpdateEvent {
	readonly ref: string;
	readonly oldHash: ObjectId | null;
	readonly newHash: ObjectId;
}

export interface RefDeleteEvent {
	readonly ref: string;
	readonly oldHash: ObjectId | null;
}

export interface ObjectWriteEvent {
	readonly type: ObjectType;
	readonly hash: ObjectId;
}

// ── Event map ───────────────────────────────────────────────────────

export interface HookEventMap {
	"pre-commit": PreCommitEvent;
	"commit-msg": CommitMsgEvent;
	"merge-msg": MergeMsgEvent;
	"post-commit": PostCommitEvent;
	"pre-merge-commit": PreMergeCommitEvent;
	"post-merge": PostMergeEvent;
	"pre-checkout": PreCheckoutEvent;
	"post-checkout": PostCheckoutEvent;
	"pre-push": PrePushEvent;
	"post-push": PostPushEvent;
	"pre-fetch": PreFetchEvent;
	"post-fetch": PostFetchEvent;
	"pre-clone": PreCloneEvent;
	"post-clone": PostCloneEvent;
	"pre-pull": PrePullEvent;
	"post-pull": PostPullEvent;
	"pre-rebase": PreRebaseEvent;
	"pre-reset": PreResetEvent;
	"post-reset": PostResetEvent;
	"pre-clean": PreCleanEvent;
	"post-clean": PostCleanEvent;
	"pre-rm": PreRmEvent;
	"post-rm": PostRmEvent;
	"pre-cherry-pick": PreCherryPickEvent;
	"post-cherry-pick": PostCherryPickEvent;
	"pre-revert": PreRevertEvent;
	"post-revert": PostRevertEvent;
	"pre-stash": PreStashEvent;
	"post-stash": PostStashEvent;
	"ref:update": RefUpdateEvent;
	"ref:delete": RefDeleteEvent;
	"object:write": ObjectWriteEvent;
}

type PreHookName =
	| "pre-commit"
	| "commit-msg"
	| "merge-msg"
	| "pre-merge-commit"
	| "pre-checkout"
	| "pre-push"
	| "pre-fetch"
	| "pre-clone"
	| "pre-pull"
	| "pre-rebase"
	| "pre-reset"
	| "pre-clean"
	| "pre-rm"
	| "pre-cherry-pick"
	| "pre-revert"
	| "pre-stash";

export interface AbortResult {
	abort: true;
	message?: string;
}

export type PreHookHandler<E extends PreHookName> = (
	event: HookEventMap[E],
) => void | AbortResult | Promise<void | AbortResult>;

export type PostHookHandler<E extends keyof HookEventMap> = (
	event: HookEventMap[E],
) => void | Promise<void>;

export type HookHandler<E extends keyof HookEventMap> = E extends PreHookName
	? PreHookHandler<E>
	: PostHookHandler<E>;

// ── Command middleware ──────────────────────────────────────────────

import type { CommandExecOptions } from "./git.ts";
import type { FileSystem } from "./fs.ts";

export interface CommandEvent {
	/** The git subcommand being invoked (e.g. "commit", "push"). */
	command: string | undefined;
	/** Arguments after the subcommand. */
	rawArgs: string[];
	/** Virtual filesystem — same instance custom commands receive from just-bash. */
	fs: FileSystem;
	/** Current working directory. */
	cwd: string;
	/** Environment variables. */
	env: Map<string, string>;
	/** Standard input content. */
	stdin: string;
	/** Execute a subcommand in the shell. Available when running via just-bash. */
	exec?: (command: string, options: CommandExecOptions) => Promise<ExecResult>;
	/** Abort signal for cooperative cancellation. */
	signal?: AbortSignal;
}

export type Middleware = (
	event: CommandEvent,
	next: () => Promise<ExecResult>,
) => ExecResult | Promise<ExecResult>;

// ── HookEmitter ─────────────────────────────────────────────────────

type AnyHandler = (event: unknown) => unknown;

export class HookEmitter {
	private listeners = new Map<string, AnyHandler[]>();
	onError: (error: unknown) => void = () => {};

	on<E extends keyof HookEventMap>(event: E, handler: HookHandler<E>): () => void {
		const key = event as string;
		let list = this.listeners.get(key);
		if (!list) {
			list = [];
			this.listeners.set(key, list);
		}
		const h = handler as AnyHandler;
		list.push(h);
		return () => {
			const arr = this.listeners.get(key);
			if (arr) {
				const idx = arr.indexOf(h);
				if (idx !== -1) arr.splice(idx, 1);
			}
		};
	}

	/**
	 * Emit a pre-hook event. Returns an AbortResult if any handler aborts,
	 * or null if all handlers allow the operation to proceed.
	 */
	async emitPre<E extends PreHookName>(
		event: E,
		data: HookEventMap[E],
	): Promise<AbortResult | null> {
		const list = this.listeners.get(event as string);
		if (!list || list.length === 0) return null;
		for (const handler of list) {
			const result = await handler(data);
			if (result && typeof result === "object" && "abort" in result) {
				return result as AbortResult;
			}
		}
		return null;
	}

	/** Emit a post-hook event and await all handlers in order. */
	async emitPost<E extends keyof HookEventMap>(event: E, data: HookEventMap[E]): Promise<void> {
		const list = this.listeners.get(event as string);
		if (!list || list.length === 0) return;
		for (const handler of list) {
			await handler(data);
		}
	}

	/** Emit low-level events (synchronous, fire-and-forget). */
	emit<E extends keyof HookEventMap>(event: E, data: HookEventMap[E]): void {
		const list = this.listeners.get(event as string);
		if (!list || list.length === 0) return;
		for (const handler of list) {
			try {
				const result = handler(data);
				if (result && typeof result === "object" && "then" in result) {
					(result as Promise<unknown>).catch(this.onError);
				}
			} catch (e) {
				this.onError(e);
			}
		}
	}
}
