import type { GitRepo } from "../lib/types.ts";
import type { Rejection } from "../hooks.ts";
import type { StorageDriver, CreateRepoOptions } from "./storage.ts";

// ── Session ─────────────────────────────────────────────────────────

/**
 * Default session type, produced by the built-in session builder when
 * no custom `session` config is provided to `createGitServer`.
 *
 * HTTP requests produce `{ transport: "http", request }`.
 * SSH sessions produce `{ transport: "ssh", username }`.
 */
export interface Session {
	transport: "http" | "ssh";
	/** Authenticated username, when available. */
	username?: string;
	/** The HTTP request, present only when `transport` is `"http"`. */
	request?: Request;
}

/**
 * User-provided session builder that transforms raw transport input
 * into a typed session object threaded through all hooks.
 *
 * TypeScript infers `S` from the return types of the builder functions,
 * so hooks receive the custom type without explicit generic annotations.
 *
 * ```ts
 * const server = createGitServer({
 *   storage: new BunSqliteDriver(db),
 *   session: {
 *     http: (req) => ({
 *       userId: parseJwt(req).sub,
 *       roles: parseJwt(req).roles,
 *     }),
 *     ssh: (info) => ({
 *       userId: info.username ?? "anonymous",
 *       roles: (info.metadata?.roles as string[]) ?? [],
 *     }),
 *   },
 *   hooks: {
 *     preReceive: ({ session }) => {
 *       // session is { userId: string, roles: string[] } — inferred!
 *       if (!session?.roles.includes("push"))
 *         return { reject: true, message: "forbidden" };
 *     },
 *   },
 * });
 * ```
 */
export interface SessionBuilder<S> {
	/**
	 * Build a session from an HTTP request.
	 *
	 * Return `S` to proceed, or return a `Response` to short-circuit
	 * the request (e.g. 401 with `WWW-Authenticate` header). This is
	 * the primary mechanism for HTTP auth — no separate middleware needed.
	 */
	http: (request: Request) => S | Response | Promise<S | Response>;
	/** Build a session from SSH session info. */
	ssh: (info: SshSessionInfo) => S | Promise<S>;
}

// ── SSH types ───────────────────────────────────────────────────────

/** Information about the SSH session passed to `handleSession`. */
export interface SshSessionInfo {
	/** SSH username from authentication. */
	username?: string;
	/**
	 * Arbitrary metadata from the SSH auth layer.
	 * Stash key fingerprints, client IPs, roles, etc. here —
	 * the session builder can extract and type them.
	 */
	metadata?: Record<string, unknown>;
}

/**
 * Bidirectional channel for SSH session I/O.
 *
 * Adapters create this from their SSH library's channel/stream.
 * The handler reads the client request from `readable` and writes
 * the server response to `writable`.
 *
 * For receive-pack (push), `readable` must close when the client
 * finishes sending. For upload-pack (fetch/clone), the handler
 * reads protocol-aware pkt-lines and does not require EOF.
 */
export interface SshChannel {
	/** Client data (from client stdout via SSH channel). */
	readonly readable: ReadableStream<Uint8Array>;
	/** Server response (to client stdin via SSH channel). */
	readonly writable: WritableStream<Uint8Array>;
	/** Write a diagnostic/error message to the client's stderr. */
	writeStderr?(data: Uint8Array): void;
}

// ── Node.js adapter types ───────────────────────────────────────────

/** Node.js `http.IncomingMessage`-compatible request interface. */
export interface NodeHttpRequest {
	method?: string;
	url?: string;
	headers: Record<string, string | string[] | undefined>;
	on(event: string, listener: (...args: any[]) => void): any;
}

/** Node.js `http.ServerResponse`-compatible response interface. */
export interface NodeHttpResponse {
	writeHead(statusCode: number, headers?: Record<string, string | string[]>): any;
	write(chunk: any): any;
	end(data?: string): any;
}

// ── Policy ──────────────────────────────────────────────────────────

/**
 * Declarative push rules applied before user-provided hooks.
 *
 * These are git-level constraints that don't depend on the session.
 * For session-dependent logic (auth, logging), use hooks directly.
 */
export interface ServerPolicy {
	/** Branches that cannot be force-pushed to or deleted. */
	protectedBranches?: string[];
	/** Reject all non-fast-forward pushes globally. */
	denyNonFastForward?: boolean;
	/** Reject all ref deletions globally. */
	denyDeletes?: boolean;
	/** Reject deletion and overwrite of tags. Tags are treated as immutable. */
	denyDeleteTags?: boolean;
}

// ── Server config ───────────────────────────────────────────────────

export interface GitServerConfig<S = Session> {
	/**
	 * Storage driver for git object and ref persistence.
	 *
	 * The server calls `createStorage(storage)` internally to build the
	 * git-aware adapter. Users provide the raw driver; they never see
	 * the `Storage` interface.
	 */
	storage: StorageDriver;

	/**
	 * Map a request path to a repo ID.
	 *
	 * Called for both HTTP and SSH requests. Return a string repo ID
	 * to serve, or `null` to respond with 404 / reject.
	 *
	 * Default: identity — the URL path segment is the repo ID.
	 */
	resolve?: (path: string) => string | null | Promise<string | null>;

	/**
	 * Automatically create repos on first access.
	 *
	 * When `true`, uses `"main"` as the default branch.
	 * When `{ defaultBranch }`, uses the specified branch name.
	 * When `false` or omitted, unknown repos return 404.
	 */
	autoCreate?: boolean | { defaultBranch?: string };

	/** Server-side hooks. All optional. */
	hooks?: ServerHooks<S>;

	/**
	 * Declarative push policy. Rules run before user-provided hooks.
	 *
	 * For session-dependent logic (auth, post-push actions), use `hooks`.
	 */
	policy?: ServerPolicy;

	/**
	 * Custom session builder. When provided, the server calls
	 * `session.http(request)` for HTTP and `session.ssh(info)` for SSH
	 * to produce the session object threaded through all hooks.
	 *
	 * When omitted, the built-in `Session` type is used.
	 */
	session?: SessionBuilder<S>;

	/** Base path prefix to strip from HTTP URLs (e.g. "/git"). */
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

	/**
	 * Called when the server catches an unhandled error.
	 *
	 * Defaults to logging `err.message` (no stack trace) to `console.error`.
	 * Override to integrate with your own logging, or set to `false` to
	 * suppress all error output.
	 */
	onError?: false | ((err: unknown, session?: S) => void);
}

export interface GitServer {
	/** Standard fetch-API handler for HTTP: (Request) => Response */
	fetch(request: Request): Promise<Response>;

	/**
	 * Handle a single git-over-SSH session.
	 *
	 * Call this when the SSH client execs a git command (typically
	 * `git-upload-pack` or `git-receive-pack`). Returns the exit code
	 * to send to the client.
	 *
	 * ```ts
	 * import { Server } from "ssh2";
	 *
	 * new Server({ hostKeys: [key] }, (client) => {
	 *   client.on("authentication", (ctx) => { ctx.accept(); });
	 *   client.on("session", (accept) => {
	 *     accept().on("exec", (accept, reject, info) => {
	 *       const stream = accept();
	 *       const channel: SshChannel = {
	 *         readable: new ReadableStream({
	 *           start(c) {
	 *             stream.on("data", (d: Buffer) => c.enqueue(new Uint8Array(d)));
	 *             stream.on("end", () => c.close());
	 *           },
	 *         }),
	 *         writable: new WritableStream({ write(chunk) { stream.write(chunk); } }),
	 *         writeStderr(data) { stream.stderr.write(data); },
	 *       };
	 *       server.handleSession(info.command, channel, { username: ctx.username })
	 *         .then((code) => { stream.exit(code); stream.close(); });
	 *     });
	 *   });
	 * });
	 * ```
	 */
	handleSession(command: string, channel: SshChannel, session?: SshSessionInfo): Promise<number>;

	/**
	 * Node.js `http.createServer` compatible handler.
	 *
	 * ```ts
	 * import http from "node:http";
	 * http.createServer(server.nodeHandler).listen(4280);
	 * ```
	 */
	nodeHandler(req: NodeHttpRequest, res: NodeHttpResponse): void;

	/** Create a new repo. Throws if the repo already exists. */
	createRepo(id: string, options?: CreateRepoOptions): Promise<GitRepo>;

	/** Get a repo by ID, or `null` if it doesn't exist. */
	repo(id: string): Promise<GitRepo | null>;

	/** Delete a repo and all its data. */
	deleteRepo(id: string): Promise<void>;
}

// ── Hooks ───────────────────────────────────────────────────────────

export interface ServerHooks<S = Session> {
	/**
	 * Called after objects are unpacked but before any refs update.
	 * Receives ALL ref updates as a batch. Return a Rejection to abort
	 * the entire push. Auth, branch protection, and repo-wide policy
	 * belong here.
	 */
	preReceive?: (event: PreReceiveEvent<S>) => void | Rejection | Promise<void | Rejection>;

	/**
	 * Called per-ref, after preReceive passes.
	 * Return a Rejection to block this specific ref update while
	 * allowing others. Per-branch rules belong here.
	 */
	update?: (event: UpdateEvent<S>) => void | Rejection | Promise<void | Rejection>;

	/**
	 * Called after all ref updates succeed. Cannot reject.
	 * CI triggers, webhooks, notifications belong here.
	 */
	postReceive?: (event: PostReceiveEvent<S>) => void | Promise<void>;

	/**
	 * Called when a client wants to fetch or push (during ref advertisement).
	 * Return a filtered ref list to hide branches, a Rejection to deny
	 * access entirely, or void to advertise all refs.
	 */
	advertiseRefs?: (
		event: AdvertiseRefsEvent<S>,
	) => RefAdvertisement[] | void | Rejection | Promise<RefAdvertisement[] | void | Rejection>;
}

// ── Hook events ─────────────────────────────────────────────────────

/** A single ref update within a push. */
export interface RefUpdate {
	/** Full ref name, e.g. "refs/heads/main". */
	ref: string;
	/** Previous hash, or null if creating a new ref. */
	oldHash: string | null;
	/** New hash being pushed. */
	newHash: string;
	/** Whether the update is a fast-forward. */
	isFF: boolean;
	/** Whether this creates a new ref. */
	isCreate: boolean;
	/** Whether this deletes an existing ref. */
	isDelete: boolean;
}

/** Fired after objects are unpacked but before refs are updated. */
export interface PreReceiveEvent<S = Session> {
	repo: GitRepo;
	/** Resolved repo ID (the value returned by `resolve`, or the raw path when `resolve` is not set). */
	repoId: string;
	updates: readonly RefUpdate[];
	/** Session info. Present for HTTP and SSH; absent for in-process pushes. */
	session?: S;
}

/** Fired per-ref after preReceive passes. */
export interface UpdateEvent<S = Session> {
	repo: GitRepo;
	/** Resolved repo ID (the value returned by `resolve`, or the raw path when `resolve` is not set). */
	repoId: string;
	update: RefUpdate;
	/** Session info. Present for HTTP and SSH; absent for in-process pushes. */
	session?: S;
}

/** Fired after all ref updates succeed. */
export interface PostReceiveEvent<S = Session> {
	repo: GitRepo;
	/** Resolved repo ID (the value returned by `resolve`, or the raw path when `resolve` is not set). */
	repoId: string;
	updates: readonly RefUpdate[];
	/** Session info. Present for HTTP and SSH; absent for in-process pushes. */
	session?: S;
}

/** Fired during ref advertisement (info/refs). */
export interface AdvertiseRefsEvent<S = Session> {
	repo: GitRepo;
	/** Resolved repo ID (the value returned by `resolve`, or the raw path when `resolve` is not set). */
	repoId: string;
	refs: RefAdvertisement[];
	service: "git-upload-pack" | "git-receive-pack";
	/** Session info. Present for HTTP and SSH; absent for in-process requests. */
	session?: S;
}

/** A ref name and hash advertised to clients during fetch/push discovery. */
export interface RefAdvertisement {
	name: string;
	hash: string;
}

export type { Rejection };
