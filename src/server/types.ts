import type { GitRepo } from "../lib/types.ts";
import type { Rejection } from "../hooks.ts";

// ── Server config ───────────────────────────────────────────────────

export interface GitServerConfig {
	/**
	 * Resolve an incoming request path to a repository.
	 *
	 * Return values:
	 * - `GitRepo` — use this repo for the request
	 * - `null` — respond with 404
	 * - `Response` — send this response as-is (useful for 401/403 with
	 *   custom headers like `WWW-Authenticate`)
	 */
	resolveRepo: (
		repoPath: string,
		request: Request,
	) => GitRepo | Response | null | Promise<GitRepo | Response | null>;

	/** Server-side hooks. All optional. */
	hooks?: ServerHooks;

	/** Base path prefix to strip from URLs (e.g. "/git"). */
	basePath?: string;

	/**
	 * Cache generated packfiles for identical full-clone requests.
	 *
	 * When enabled, the server caches the computed pack data for each
	 * (repo, wants) pair where no `have` lines are sent. Subsequent
	 * clones of the same ref state are served from cache, skipping
	 * object enumeration, delta computation, and compression.
	 *
	 * Set to `false` to disable. Default: enabled with 256 MB limit.
	 */
	packCache?: false | { maxBytes?: number };

	/**
	 * Control delta compression and streaming for upload-pack responses.
	 */
	packOptions?: {
		/** Skip delta compression entirely. Larger packs, much faster generation. */
		noDelta?: boolean;
		/** Delta window size (default 10). Smaller = faster, worse compression ratio. */
		deltaWindow?: number;
	};
}

export interface GitServer {
	/** Standard fetch-API handler: (Request) => Response */
	fetch: (request: Request) => Promise<Response>;
}

// ── Hooks ───────────────────────────────────────────────────────────

export interface ServerHooks {
	/**
	 * Called after objects are unpacked but before any refs update.
	 * Receives ALL ref updates as a batch. Return a Rejection to abort
	 * the entire push. Auth, branch protection, and repo-wide policy
	 * belong here.
	 */
	preReceive?: (event: PreReceiveEvent) => void | Rejection | Promise<void | Rejection>;

	/**
	 * Called per-ref, after preReceive passes.
	 * Return a Rejection to block this specific ref update while
	 * allowing others. Per-branch rules belong here.
	 */
	update?: (event: UpdateEvent) => void | Rejection | Promise<void | Rejection>;

	/**
	 * Called after all ref updates succeed. Cannot reject.
	 * CI triggers, webhooks, notifications belong here.
	 */
	postReceive?: (event: PostReceiveEvent) => void | Promise<void>;

	/**
	 * Called when a client wants to fetch or push (during ref advertisement).
	 * Return a filtered ref list to hide branches, or void to advertise all.
	 */
	advertiseRefs?: (
		event: AdvertiseRefsEvent,
	) => RefAdvertisement[] | void | Promise<RefAdvertisement[] | void>;
}

// ── Hook events ─────────────────────────────────────────────────────

export interface RefUpdate {
	ref: string;
	oldHash: string | null;
	newHash: string;
	isFF: boolean;
	isCreate: boolean;
	isDelete: boolean;
}

export interface PreReceiveEvent {
	repo: GitRepo;
	repoPath: string;
	updates: readonly RefUpdate[];
	request: Request;
}

export interface UpdateEvent {
	repo: GitRepo;
	repoPath: string;
	update: RefUpdate;
	request: Request;
}

export interface PostReceiveEvent {
	repo: GitRepo;
	repoPath: string;
	updates: readonly RefUpdate[];
	request: Request;
}

export interface AdvertiseRefsEvent {
	repo: GitRepo;
	repoPath: string;
	refs: RefAdvertisement[];
	service: "git-upload-pack" | "git-receive-pack";
	request: Request;
}

export interface RefAdvertisement {
	name: string;
	hash: string;
}

export type { Rejection };
