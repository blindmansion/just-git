// Client-layer host-behavior contracts. The semantic hook contract (repo/
// operation/object events) lives in `lib/hooks.ts` and is re-exported here for
// the public surface; this file adds the CLI-only command middleware
// (`beforeCommand`/`afterCommand`) that wraps the `Git` dispatcher and composes
// the two into the public {@link GitHooks} bag.
//
// The identity/config/network/credential contracts below are legacy residents
// awaiting relocation to their capability homes (see the hooks reorg plan);
// they are unrelated to hooks and stay here for now.

import type { FileSystem } from "./fs.ts";
import type { CommandResult } from "./commands/kit/command-result.ts";
import type { HttpAuth } from "./lib/transport/transport.ts";
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

// ── Progress callback ───────────────────────────────────────────────

/**
 * Called with server progress messages (sideband band-2) during
 * network operations (fetch, clone, push). Messages are raw text
 * from the remote — format varies by server.
 */
export type ProgressCallback = (message: string) => void;

// ── Credential & Identity overrides ─────────────────────────────────

/**
 * Callback that provides HTTP authentication for remote operations.
 * Called with the remote URL; return credentials or null for anonymous access.
 */
export type CredentialProvider = (url: string) => HttpAuth | null | Promise<HttpAuth | null>;

/**
 * Pluggable store for credentials *discovered at runtime* — specifically the
 * secrets that `git remote add` / `git clone` strip out of a URL before the
 * sanitized URL is written to `.git/config`. The producing command calls
 * {@link CredentialStore.remember}; a later `fetch` / `push` on the same
 * {@link GitOptions.credentialStore | instance} calls {@link CredentialStore.get}.
 *
 * Keys are URL origins (e.g. `https://github.com`). Supply a custom
 * implementation on {@link GitOptions.credentialStore} to back this with, say,
 * an OS keychain or encrypted-at-rest storage; the default is in-memory and
 * instance-scoped ({@link createMemoryCredentialStore}).
 *
 * Note: the explicit {@link CredentialProvider} capability always takes
 * precedence over the store and never touches the CLI URL path at all, so it
 * remains the safest place to supply credentials.
 */
export interface CredentialStore {
	/** Look up remembered auth for a URL origin. */
	get(origin: string): HttpAuth | undefined | Promise<HttpAuth | undefined>;
	/** Remember auth for a URL origin (stripped from a remote URL). */
	remember(origin: string, auth: HttpAuth): void | Promise<void>;
}

/** Default in-memory, instance-scoped {@link CredentialStore} backed by a `Map`. */
export function createMemoryCredentialStore(): CredentialStore {
	const map = new Map<string, HttpAuth>();
	return {
		get: (origin) => map.get(origin),
		remember: (origin, auth) => {
			map.set(origin, auth);
		},
	};
}

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
