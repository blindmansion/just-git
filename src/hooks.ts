// Client-layer hook contract. The semantic hook contract (repo/operation/object
// events) lives in `lib/hooks.ts` and is re-exported here for the public
// surface; this file adds the CLI-only command middleware
// (`beforeCommand`/`afterCommand`) that wraps the `Git` dispatcher and composes
// the two into the public {@link GitHooks} bag.
//
// Host-behavior *capabilities* that used to live here now sit in their capability
// homes: identity (`lib/identity.ts`), config (`lib/config/store.ts`), and the
// network/credential contracts (`lib/transport/transport.ts`).

import type { FileSystem } from "./fs.ts";
import type { CommandResult } from "./commands/kit/command-result.ts";
import type { Rejection, RepoHooks } from "./lib/hooks.ts";

// ── Semantic hook contract (re-exported from lib) ───────────────────

export { composeGitHooks, isRejection } from "./lib/hooks.ts";
export type {
	CommitMsgEvent,
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
} from "./lib/hooks.ts";

// ── Command-level middleware (CLI client only) ──────────────────────

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
	readonly result: CommandResult;
}

/**
 * The public hook bag accepted by the `Git` client: the semantic
 * {@link RepoHooks} attached to a repo, plus CLI-only command middleware
 * (`beforeCommand`/`afterCommand`) that wraps the command dispatcher. The
 * client strips the command middleware off before attaching the semantic
 * subset to `RepoCapabilities.hooks`, so the two concerns stay separate below
 * the client boundary.
 */
export interface GitHooks extends RepoHooks {
	beforeCommand?: (event: BeforeCommandEvent) => void | Rejection | Promise<void | Rejection>;
	afterCommand?: (event: AfterCommandEvent) => void | Promise<void>;
}
