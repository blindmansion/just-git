import type { GitRepo } from "../lib/types.ts";
import type { NetworkPolicy, Rejection } from "../hooks.ts";
import type { CommitOptions, CommitResult } from "../repo/writing.ts";
import type { Storage, CreateRepoOptions } from "./storage.ts";
import type { GcOptions, GcResult } from "./gc.ts";

// ── Auth ─────────────────────────────────────────────────────────────

/**
 * Default auth context type, produced by the built-in auth provider when
 * no custom `auth` config is provided to `createServer`.
 *
 * HTTP requests produce `{ transport: "http", request }`.
 * SSH sessions produce `{ transport: "ssh", username }`.
 */
export interface Auth {
	transport: "http" | "ssh";
	/** Authenticated username, when available. */
	username?: string;
	/** The HTTP request, present only when `transport` is `"http"`. */
	request?: Request;
}

/**
 * Auth provider that transforms raw transport input into a typed
 * auth context threaded through all hooks.
 *
 * Both properties are optional — provide only the transports you use.
 * TypeScript infers `A` from whichever callbacks are present.
 *
 * If a transport is used at runtime but its callback is missing, the
 * server returns an error (HTTP 501 / SSH exit 128).
 *
 * ```ts
 * // HTTP-only — no need to provide ssh
 * const server = createServer({
 *   storage: new BunSqliteStorage(db),
 *   auth: {
 *     http: (req) => ({
 *       userId: parseJwt(req).sub,
 *       roles: parseJwt(req).roles,
 *     }),
 *   },
 *   hooks: {
 *     preReceive: ({ auth }) => {
 *       // auth is { userId: string, roles: string[] } — inferred!
 *       if (!auth.roles.includes("push"))
 *         return { reject: true, message: "forbidden" };
 *     },
 *   },
 * });
 * ```
 */
export interface AuthProvider<A> {
	/**
	 * Authenticate an HTTP request.
	 *
	 * Return `A` to proceed, or return a `Response` to short-circuit
	 * the request (e.g. 401 with `WWW-Authenticate` header). This is
	 * the primary mechanism for HTTP auth — no separate middleware needed.
	 *
	 * When omitted, HTTP requests receive a 501 response.
	 */
	http?: (request: Request) => A | Response | Promise<A | Response>;
	/**
	 * Authenticate an SSH session.
	 *
	 * When omitted, SSH sessions receive exit code 128 with a
	 * diagnostic message.
	 */
	ssh?: (info: SshSessionInfo) => A | Promise<A>;
}

// ── SSH types ───────────────────────────────────────────────────────

/** Information about the SSH session passed to `handleSession`. */
export interface SshSessionInfo {
	/** SSH username from authentication. */
	username?: string;
	/**
	 * Arbitrary metadata from the SSH auth layer.
	 * Stash key fingerprints, client IPs, roles, etc. here —
	 * the auth provider can extract and type them.
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
 * These are git-level constraints that don't depend on the caller's
 * identity. For auth-dependent logic, use hooks directly.
 */
export interface ServerPolicy {
	/** Branches that cannot be force-pushed to or deleted. */
	protectedBranches?: string[];
	/** Reject all non-fast-forward pushes globally. */
	denyNonFastForward?: boolean;
	/** Reject all ref deletions globally. */
	denyDeletes?: boolean;
	/** Tags are immutable — no deletion, no overwrite once created. */
	immutableTags?: boolean;
}

// ── Server config ───────────────────────────────────────────────────

export interface GitServerConfig<A = Auth> {
	/**
	 * Storage backend for git object and ref persistence.
	 *
	 * The server calls `createStorageAdapter(storage)` internally to build the
	 * git-aware adapter. Users provide the storage backend; they never see
	 * the `StorageAdapter` interface.
	 *
	 * Defaults to {@link MemoryStorage} when omitted.
	 */
	storage?: Storage;

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
	hooks?: ServerHooks<A>;

	/**
	 * Declarative push policy. Rules run before user-provided hooks.
	 *
	 * For auth-dependent logic (permissions, post-push actions), use `hooks`.
	 */
	policy?: ServerPolicy;

	/**
	 * Auth provider. Provide `http`, `ssh`, or both —
	 * the server calls whichever is present for that transport.
	 * If a transport is used but its callback is missing, the server
	 * returns an error (HTTP 501 / SSH exit 128).
	 *
	 * When omitted entirely, the built-in `Auth` type is used.
	 */
	auth?: AuthProvider<A>;

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
	onError?: false | ((err: unknown, auth?: A) => void);
}

/**
 * A ref update request for {@link GitServer.updateRefs}.
 *
 * In-process ref update with CAS protection. Objects must already
 * exist in the repo's object store.
 */
export interface RefUpdateRequest {
	/** Full ref name (e.g. `"refs/heads/main"`, `"refs/tags/v1.0"`). */
	ref: string;
	/** New commit hash, or `null` to delete the ref. */
	newHash: string | null;
	/**
	 * Expected current hash for compare-and-swap.
	 *
	 * - `undefined` (default) — the server reads the current ref state
	 *   automatically. Still CAS-protected against concurrent updates.
	 * - `null` — assert the ref does not exist (create-only).
	 * - `string` — explicit CAS: the update fails if the ref's current
	 *   hash doesn't match.
	 */
	oldHash?: string | null;
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
	 * Update refs in-process with CAS protection.
	 *
	 * Applies compare-and-swap ref updates without transport overhead.
	 * Does NOT fire hooks (`preReceive`, `update`, `postReceive`) —
	 * hooks are a transport boundary concern. For hook enforcement,
	 * push through {@link asNetwork} instead.
	 *
	 * Objects must already exist in the repo's object store (e.g. via
	 * `createCommit` or `buildCommit` from `just-git/repo`).
	 *
	 * ```ts
	 * import { createCommit, writeBlob, writeTree } from "just-git/repo";
	 *
	 * const repo = await server.repo("my-repo");
	 * const blob = await writeBlob(repo, "content");
	 * const tree = await writeTree(repo, [{ name: "file.txt", hash: blob }]);
	 * const commit = await createCommit(repo, { tree, parents: [head], ... });
	 *
	 * await server.updateRefs("my-repo", [
	 *   { ref: "refs/heads/auto-fix", newHash: commit },
	 * ]);
	 * ```
	 *
	 * @throws If the repo does not exist or the server is shutting down.
	 */
	updateRefs(repoId: string, refs: RefUpdateRequest[]): Promise<RefUpdateResult>;

	/**
	 * Commit files to a branch with CAS protection.
	 *
	 * High-level convenience that combines object creation ({@link buildCommit}
	 * from `just-git/repo`) with CAS-protected ref advancement
	 * ({@link updateRefs}). This is the recommended API for trusted
	 * server-side writes (bots, scripts, platform features).
	 *
	 * Does NOT fire hooks — hooks are a transport boundary concern.
	 * For hook enforcement (auth, policy), push through
	 * {@link asNetwork} instead.
	 *
	 * ```ts
	 * const { hash } = await server.commit("my-repo", {
	 *   files: { "README.md": "# Hello\n" },
	 *   message: "auto-fix",
	 *   author: { name: "Bot", email: "bot@example.com" },
	 *   branch: "main",
	 * });
	 * ```
	 *
	 * For lower-level control (e.g. constructing trees manually, multi-ref
	 * updates), use `buildCommit()` + {@link updateRefs} directly.
	 *
	 * @returns The new commit's hash and parent hash.
	 * @throws If the repo does not exist, the server is shutting down,
	 *   or a concurrent write moved the branch.
	 */
	commit(repoId: string, options: CommitOptions): Promise<CommitResult>;

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

	/** Get a repo by ID, or throw if it doesn't exist. */
	requireRepo(id: string): Promise<GitRepo>;

	/** Delete a repo and all its data. */
	deleteRepo(id: string): Promise<void>;

	/**
	 * Remove unreachable objects from a repo's storage.
	 *
	 * Walks all objects reachable from the repo's refs, compares against
	 * the full set of stored objects, and deletes the difference.
	 *
	 * If refs change during the walk (e.g. a concurrent push completes),
	 * GC aborts and returns `{ aborted: true }` to prevent deleting
	 * newly-reachable objects. Callers can retry.
	 *
	 * @throws If the repo does not exist or the server is shutting down.
	 */
	gc(repoId: string, options?: GcOptions): Promise<GcResult>;

	/**
	 * Graceful shutdown. After calling, new HTTP requests receive 503
	 * and new SSH sessions get exit 128. Resolves when all in-flight
	 * operations complete and the pack cache is released.
	 *
	 * Pass an `AbortSignal` to set a timeout — when aborted, the
	 * promise resolves immediately even if operations are still running.
	 * Idempotent: subsequent calls return the same drain promise.
	 */
	close(options?: { signal?: AbortSignal }): Promise<void>;

	/** Whether `close()` has been called. */
	readonly closed: boolean;

	/**
	 * Build a {@link NetworkPolicy} that routes HTTP requests to this
	 * server in-process, bypassing the network stack entirely.
	 *
	 * Pass the returned policy as `network` to {@link createGit}:
	 *
	 * ```ts
	 * const git = createGit({ network: server.asNetwork() });
	 * await git.exec("clone http://git/my-repo /work");
	 * ```
	 *
	 * @param baseUrl - Base URL used in clone/push/fetch commands.
	 *   Only the hostname matters (for the `allowed` list). The URL
	 *   never hits the network — it's resolved by the server's
	 *   `resolve` function. Defaults to `"http://git"`.
	 */
	asNetwork(baseUrl?: string): NetworkPolicy;
}

// ── Hooks ───────────────────────────────────────────────────────────

export interface ServerHooks<A = Auth> {
	/**
	 * Called after objects are unpacked but before any refs update.
	 * Receives ALL ref updates as a batch. Return a Rejection to abort
	 * the entire push. Auth, branch protection, and repo-wide policy
	 * belong here.
	 */
	preReceive?: (event: PreReceiveEvent<A>) => void | Rejection | Promise<void | Rejection>;

	/**
	 * Called per-ref, after preReceive passes.
	 * Return a Rejection to block this specific ref update while
	 * allowing others. Per-branch rules belong here.
	 */
	update?: (event: UpdateEvent<A>) => void | Rejection | Promise<void | Rejection>;

	/**
	 * Called after all ref updates succeed. Cannot reject.
	 * CI triggers, webhooks, notifications belong here.
	 */
	postReceive?: (event: PostReceiveEvent<A>) => void | Promise<void>;

	/**
	 * Called when a client wants to fetch or push (during ref advertisement).
	 * Return a filtered ref list to hide branches, a Rejection to deny
	 * access entirely, or void to advertise all refs.
	 */
	advertiseRefs?: (
		event: AdvertiseRefsEvent<A>,
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
export interface PreReceiveEvent<A = Auth> {
	repo: GitRepo;
	/** Resolved repo ID (the value returned by `resolve`, or the raw path when `resolve` is not set). */
	repoId: string;
	updates: readonly RefUpdate[];
	/** Auth context from the transport's auth provider. Always present — hooks only fire from HTTP/SSH transport. */
	auth: A;
}

/** Fired per-ref after preReceive passes. */
export interface UpdateEvent<A = Auth> {
	repo: GitRepo;
	/** Resolved repo ID (the value returned by `resolve`, or the raw path when `resolve` is not set). */
	repoId: string;
	update: RefUpdate;
	/** Auth context from the transport's auth provider. Always present — hooks only fire from HTTP/SSH transport. */
	auth: A;
}

/** Fired after all ref updates succeed. */
export interface PostReceiveEvent<A = Auth> {
	repo: GitRepo;
	/** Resolved repo ID (the value returned by `resolve`, or the raw path when `resolve` is not set). */
	repoId: string;
	updates: readonly RefUpdate[];
	/** Auth context from the transport's auth provider. Always present — hooks only fire from HTTP/SSH transport. */
	auth: A;
}

/** Fired during ref advertisement (info/refs). */
export interface AdvertiseRefsEvent<A = Auth> {
	repo: GitRepo;
	/** Resolved repo ID (the value returned by `resolve`, or the raw path when `resolve` is not set). */
	repoId: string;
	refs: RefAdvertisement[];
	service: "git-upload-pack" | "git-receive-pack";
	/** Auth context from the transport's auth provider. Always present — hooks only fire from HTTP/SSH transport. */
	auth: A;
}

/** A ref name and hash advertised to clients during fetch/push discovery. */
export interface RefAdvertisement {
	name: string;
	hash: string;
}

// ── Ref update results ──────────────────────────────────────────────

/** Per-ref result from a push, {@link GitServer.updateRefs}, or {@link GitServer.commit} call. */
export interface RefResult {
	ref: string;
	ok: boolean;
	error?: string;
}

/** Result of a push or {@link GitServer.updateRefs} call. */
export interface RefUpdateResult {
	refResults: RefResult[];
	applied: RefUpdate[];
}

export type { Rejection };
