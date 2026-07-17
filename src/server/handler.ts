/**
 * Unified Git server: Smart HTTP + SSH session handling.
 *
 * Uses web-standard Request/Response for HTTP, and web-standard
 * ReadableStream/WritableStream for SSH. Works with Bun.serve, Hono,
 * Cloudflare Workers, or any framework that speaks fetch API. SSH
 * works with any SSH library (ssh2, etc.) through a thin adapter.
 *
 * ```ts
 * const server = createServer({ autoCreate: true });
 * await server.createRepo("my-repo");
 *
 * // HTTP
 * Bun.serve({ fetch: server.fetch });
 * ```
 */

import { nodeRequestToWebRequest, pipeWebResponseToNode } from "../node-http.ts";
import { buildCommit } from "../repo/writing.ts";
import { httpTransport } from "../transport.ts";
import type { GitRepo, TransportResolver } from "../lib/types.ts";

const inProcessAuth = new WeakMap<Request, unknown>();
import { PackCache, applyCasRefUpdates, resolveRefUpdates } from "./operations.ts";
import { createHttpHandler } from "./http-handler.ts";
import { handleSshSession } from "./ssh-session.ts";
import { createRepoStore, type CreateRepoOptions } from "../store/repo-store.ts";
import { MemoryStorage } from "../store/memory-storage.ts";
import { isValidRepoId } from "../store/repo-id.ts";
import { mergePolicyAndHooks } from "./policy.ts";
import type {
	GitServerConfig,
	GitServer,
	NodeHttpRequest,
	NodeHttpResponse,
	Auth,
	AuthProvider,
	RefUpdate,
	SshChannel,
	SshSessionInfo,
} from "./types.ts";

const defaultAuthProvider: AuthProvider<Auth> = {
	http: (request) => ({ transport: "http", request }),
	ssh: (info) => ({ transport: "ssh", username: info.username }),
};

export { isValidRepoId } from "../store/repo-id.ts";

/**
 * Create a unified Git server that handles both HTTP and SSH.
 *
 * ```ts
 * const server = createServer({
 *   autoCreate: true,
 * });
 * await server.createRepo("my-repo");
 *
 * // HTTP — pass to Bun.serve, Hono, Cloudflare Workers, etc.
 * Bun.serve({ fetch: server.fetch });
 *
 * // SSH — wire up with ssh2 or any SSH library
 * server.handleSession(command, channel, { username });
 * ```
 */
export function createServer<A = Auth>(
	config: GitServerConfig<A> = {} as GitServerConfig<A>,
): GitServer<A> {
	const rawStorage = config.storage ?? new MemoryStorage();
	const storage = createRepoStore(rawStorage, { capabilities: config.capabilities });
	const resolve = config.resolve ?? ((path: string) => path);
	const autoCreate = config.autoCreate;
	const { basePath } = config;
	const receiveLimits = {
		maxRequestBytes: 128 * 1024 * 1024,
		maxInflatedBytes: 256 * 1024 * 1024,
		maxPackBytes: 128 * 1024 * 1024,
		maxPackObjects: 250_000,
		...config.receiveLimits,
	};
	const fetchLimits = {
		maxRequestBytes: 10 * 1024 * 1024,
		maxInflatedBytes: 20 * 1024 * 1024,
		...config.fetchLimits,
	};

	async function resolveRepo(path: string): Promise<{ repo: GitRepo; repoId: string } | null> {
		if (!isValidRepoId(path)) return null;
		const id = await resolve(path);
		if (id == null) return null;
		if (id !== path && !isValidRepoId(id)) return null;
		const repo = await storage.repo(id);
		if (repo) return { repo, repoId: id };
		if (!autoCreate) return null;
		const opts: CreateRepoOptions | undefined =
			typeof autoCreate === "object" ? { defaultBranch: autoCreate.defaultBranch } : undefined;
		return { repo: await storage.createRepo(id, opts), repoId: id };
	}
	const hooks = mergePolicyAndHooks(config.policy, config.hooks);
	// Safe: when config.auth is omitted, A defaults to Auth, matching defaultAuthProvider.
	const buildAuth = (config.auth ?? defaultAuthProvider) as AuthProvider<A>;

	const packCache =
		config.packCache === false ? undefined : new PackCache(config.packCache?.maxBytes);

	const onError =
		config.onError === false
			? undefined
			: (config.onError ??
				((err: unknown) => {
					const msg = err instanceof Error ? err.message : String(err);
					console.error(`[server] Internal error: ${msg}`);
				}));

	let closed = false;
	let inflight = 0;
	let drainResolve: (() => void) | null = null;
	let drainPromise: Promise<void> | null = null;

	function enter(): boolean {
		if (closed) return false;
		inflight++;
		return true;
	}

	function leave(): void {
		inflight--;
		if (closed && inflight === 0) drainResolve?.();
	}

	/**
	 * Fire the low-level ref-change notification. Fire-and-forget: a throwing
	 * listener never affects the operation that produced the change.
	 */
	function emitRefChange(
		repoId: string,
		repo: GitRepo,
		applied: readonly RefUpdate[],
		source: "push" | "commit" | "update-refs",
		auth?: A,
	): void {
		if (!config.onRefUpdate || applied.length === 0) return;
		try {
			config.onRefUpdate({ repoId, repo, updates: applied, source, auth });
		} catch {
			// Observation channel — swallow listener errors.
		}
	}

	const httpHandler = createHttpHandler({
		basePath,
		resolveRepo,
		hooks,
		packCache,
		packOptions: config.packOptions,
		receiveLimits,
		fetchLimits,
		auth: buildAuth,
		getEmbeddedAuth: (request) => inProcessAuth.get(request) as A | undefined,
		enter,
		leave,
		onRefApplied: (repoId, repo, applied, auth) =>
			emitRefChange(repoId, repo, applied, "push", auth),
		onError,
	});

	const server: GitServer<A> = {
		fetch: httpHandler,

		async handleSession(
			command: string,
			channel: SshChannel,
			sshSession?: SshSessionInfo,
		): Promise<number> {
			if (!enter()) {
				channel.writeStderr?.(new TextEncoder().encode("fatal: server shutting down\n"));
				return 128;
			}
			try {
				if (!buildAuth.ssh) {
					channel.writeStderr?.(
						new TextEncoder().encode("fatal: SSH auth provider not configured\n"),
					);
					return 128;
				}
				const auth = await buildAuth.ssh(sshSession ?? {});
				return await handleSshSession(command, channel, {
					resolveRepo,
					hooks,
					packCache,
					packOptions: config.packOptions,
					receiveLimits,
					fetchLimits,
					auth,
					onRefApplied: (repoId, repo, applied) =>
						emitRefChange(repoId, repo, applied, "push", auth),
					onError: onError ? (err) => onError(err, auth) : undefined,
				});
			} finally {
				leave();
			}
		},

		async updateRefs(repoId, refs) {
			if (!enter()) throw new Error("Server is shutting down");
			try {
				const repo = await server.requireRepo(repoId);
				const updates = await resolveRefUpdates(repo, refs);
				const result = await applyCasRefUpdates(repo, updates);
				emitRefChange(repoId, repo, result.applied, "update-refs");
				return result;
			} finally {
				leave();
			}
		},

		async commit(repoId, options) {
			if (!enter()) throw new Error("Server is shutting down");
			try {
				const repo = await server.requireRepo(repoId);
				const commitResult = await buildCommit(repo, options);

				const branchRef = `refs/heads/${options.branch}`;
				const updates = await resolveRefUpdates(repo, [
					{ ref: branchRef, newHash: commitResult.hash, oldHash: commitResult.parentHash },
				]);
				const result = await applyCasRefUpdates(repo, updates);

				const refResult = result.refResults[0];
				if (!refResult?.ok) {
					throw new Error(refResult?.error ?? "ref update failed");
				}
				emitRefChange(repoId, repo, result.applied, "commit");
				return commitResult;
			} finally {
				leave();
			}
		},

		nodeHandler(req: NodeHttpRequest, res: NodeHttpResponse): void {
			void handleNodeRequest(server, req, res);
		},

		createRepo: (id, options) => storage.createRepo(id, options) as Promise<GitRepo>,
		repo: (id, override) => storage.repo(id, override) as Promise<GitRepo | null>,
		async requireRepo(id) {
			const repo = await storage.repo(id);
			if (!repo) throw new Error(`Repository "${id}" not found`);
			return repo as GitRepo;
		},
		deleteRepo: (id) => storage.deleteRepo(id) as Promise<void>,

		async forkRepo(sourceId, targetId, options?) {
			if (!enter()) throw new Error("Server is shutting down");
			try {
				return (await storage.forkRepo(sourceId, targetId, options)) as GitRepo;
			} finally {
				leave();
			}
		},

		async gc(repoId, options?) {
			if (!enter()) throw new Error("Server is shutting down");
			try {
				// requireRepo validates existence; storage.gc handles fork-tip safety.
				await server.requireRepo(repoId);
				return storage.gc(repoId, options);
			} finally {
				leave();
			}
		},

		get closed() {
			return closed;
		},

		asNetwork(baseUrl = "http://git", auth?: A) {
			const normalized = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
			return {
				allowed: [normalized],
				fetch: (input: string | URL | Request, init?: RequestInit) => {
					const req = new Request(input as string, init);
					if (auth !== undefined) inProcessAuth.set(req, auth);
					return server.fetch(req);
				},
			};
		},

		asTransport(baseUrl = "http://git", auth?: A): TransportResolver {
			const policy = this.asNetwork(baseUrl, auth);
			return httpTransport({ allowed: policy.allowed, fetch: policy.fetch });
		},

		async close(options?): Promise<void> {
			if (closed) return drainPromise ?? Promise.resolve();
			closed = true;
			packCache?.clear();
			if (inflight === 0) return;
			drainPromise = new Promise<void>((resolve) => {
				drainResolve = resolve;
			});
			if (options?.signal) {
				if (options.signal.aborted) {
					drainResolve!();
					return;
				}
				const onAbort = () => drainResolve?.();
				options.signal.addEventListener("abort", onAbort, { once: true });
				drainPromise.then(() => options.signal!.removeEventListener("abort", onAbort));
			}
			return drainPromise;
		},
	};
	return server;
}

// ── Node.js adapter orchestration ───────────────────────────────────

async function handleNodeRequest(
	server: Pick<GitServer<any>, "fetch">,
	req: NodeHttpRequest,
	res: NodeHttpResponse,
): Promise<void> {
	let bridge: ReturnType<typeof nodeRequestToWebRequest> | undefined;
	try {
		bridge = nodeRequestToWebRequest(req);
		const response = await server.fetch(bridge.request);
		const cleanupNow = deferRequestCleanupUntilResponseFinishes(bridge.cleanup, res);
		try {
			await pipeWebResponseToNode(response, res);
			if (!cleanupNow) bridge.cleanup();
		} catch (error) {
			cleanupNow?.();
			throw error;
		}
	} catch {
		bridge?.cleanup();
		try {
			res.writeHead(500);
			res.end("Internal Server Error");
		} catch {
			// Headers were already sent or the socket disconnected.
		}
	}
}

function deferRequestCleanupUntilResponseFinishes(
	cleanupRequest: () => void,
	res: NodeHttpResponse,
): (() => void) | undefined {
	if (!res.once) return undefined;
	let cleaned = false;
	const cleanup = (): void => {
		if (cleaned) return;
		cleaned = true;
		res.off?.("finish", cleanup);
		res.off?.("close", cleanup);
		cleanupRequest();
	};
	res.once("finish", cleanup);
	res.once("close", cleanup);
	return cleanup;
}
