/**
 * Unified Git server: Smart HTTP + SSH session handling.
 *
 * Uses web-standard Request/Response for HTTP, and web-standard
 * ReadableStream/WritableStream for SSH. Works with Bun.serve, Hono,
 * Cloudflare Workers, or any framework that speaks fetch API. SSH
 * works with any SSH library (ssh2, etc.) through a thin adapter.
 *
 * ```ts
 * const server = createServer({
 *   storage: new MemoryStorage(),
 *   autoCreate: true,
 * });
 * await server.createRepo("my-repo");
 *
 * // HTTP
 * Bun.serve({ fetch: server.fetch });
 * ```
 */

import { isRejection } from "../hooks.ts";
import type { GitRepo } from "../lib/types.ts";
import {
	PackCache,
	advertiseRefsWithHooks,
	applyReceivePack,
	buildRefAdvertisementBytes,
	handleUploadPack,
	ingestReceivePack,
	resolveRefUpdates,
} from "./operations.ts";
import { buildReportStatus } from "./protocol.ts";
import { handleSshSession } from "./ssh-session.ts";
import { gcRepo } from "./gc.ts";
import { createStorageAdapter, type CreateRepoOptions } from "./storage.ts";
import type {
	GitServerConfig,
	GitServer,
	NodeHttpRequest,
	NodeHttpResponse,
	RefAdvertisement,
	Rejection,
	ServerHooks,
	ServerPolicy,
	Session,
	SessionBuilder,
	SshChannel,
	SshSessionInfo,
	UpdateEvent,
} from "./types.ts";

const defaultSessionBuilder: SessionBuilder<Session> = {
	http: (request) => ({ transport: "http", request }),
	ssh: (info) => ({ transport: "ssh", username: info.username }),
};

/**
 * Validate a repo ID for use with `createServer`.
 *
 * Rejects empty strings, null bytes, control characters, backslashes,
 * empty path components (double slashes, leading/trailing slash), and
 * components starting with `.` (blocks `..` traversal, `.git`, etc.).
 */
export function isValidRepoId(id: string): boolean {
	if (id.length === 0) return false;
	for (let i = 0; i < id.length; i++) {
		const c = id.charCodeAt(i);
		if (c === 0 || c < 0x20 || c === 0x7f || c === 0x5c) return false;
	}
	const parts = id.split("/");
	for (const part of parts) {
		if (part.length === 0 || part.charCodeAt(0) === 0x2e) return false;
	}
	return true;
}

/**
 * Create a unified Git server that handles both HTTP and SSH.
 *
 * ```ts
 * const server = createServer({
 *   storage: new MemoryStorage(),
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
export function createServer<S = Session>(config: GitServerConfig<S>): GitServer<S> {
	if (!config || !config.storage) {
		throw new TypeError(
			"createServer: config.storage is required. " +
				"Example: createServer({ storage: new MemoryStorage() })",
		);
	}

	const storage = createStorageAdapter(config.storage);
	const resolve = config.resolve ?? ((path: string) => path);
	const autoCreate = config.autoCreate;
	const { basePath } = config;

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
	// Safe: when config.session is omitted, S defaults to Session, matching defaultSessionBuilder.
	const buildSession = (config.session ?? defaultSessionBuilder) as SessionBuilder<S>;

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

	const server: GitServer<S> = {
		async fetch(req: Request): Promise<Response> {
			if (!enter()) return new Response("Service Unavailable", { status: 503 });
			let session: S | undefined;
			try {
				if (!buildSession.http) {
					return new Response("HTTP session builder not configured", { status: 501 });
				}
				const sessionOrResponse = await buildSession.http(req);
				if (sessionOrResponse instanceof Response) return sessionOrResponse;
				session = sessionOrResponse;

				const url = new URL(req.url);
				let pathname = decodeURIComponent(url.pathname);

				if (basePath) {
					const normalized = basePath.replace(/\/+$/, "");
					if (!pathname.startsWith(normalized)) {
						return new Response("Not Found", { status: 404 });
					}
					pathname = pathname.slice(normalized.length);
				}

				if (!pathname.startsWith("/")) {
					pathname = `/${pathname}`;
				}

				// ── info/refs ───────────────────────────────────────
				if (pathname.endsWith("/info/refs") && req.method === "GET") {
					const service = url.searchParams.get("service");
					if (service !== "git-upload-pack" && service !== "git-receive-pack") {
						return new Response("Unsupported service", { status: 403 });
					}

					const requestPath = extractRepoPath(pathname, "/info/refs");
					const resolved = await resolveRepo(requestPath);
					if (!resolved) return new Response("Not Found", { status: 404 });

					const adv = await advertiseRefsWithHooks(
						resolved.repo,
						resolved.repoId,
						service,
						hooks,
						session,
					);
					if (isRejection(adv)) {
						return new Response(adv.message ?? "Forbidden", { status: 403 });
					}

					const body = buildRefAdvertisementBytes(adv.refs, service, adv.headTarget);
					return new Response(body, {
						headers: {
							"Content-Type": `application/x-${service}-advertisement`,
							"Cache-Control": "no-cache",
						},
					});
				}

				// ── git-upload-pack ─────────────────────────────────
				if (pathname.endsWith("/git-upload-pack") && req.method === "POST") {
					const requestPath = extractRepoPath(pathname, "/git-upload-pack");
					const resolved = await resolveRepo(requestPath);
					if (!resolved) return new Response("Not Found", { status: 404 });

					const body = await readRequestBody(req);
					const responseBody = await handleUploadPack(resolved.repo, body, {
						cache: packCache,
						cacheKey: resolved.repoId,
						noDelta: config.packOptions?.noDelta,
						deltaWindow: config.packOptions?.deltaWindow,
					});
					return new Response(responseBody, {
						headers: { "Content-Type": "application/x-git-upload-pack-result" },
					});
				}

				// ── git-receive-pack ────────────────────────────────
				if (pathname.endsWith("/git-receive-pack") && req.method === "POST") {
					const requestPath = extractRepoPath(pathname, "/git-receive-pack");
					const resolved = await resolveRepo(requestPath);
					if (!resolved) return new Response("Not Found", { status: 404 });

					const body = await readRequestBody(req);
					const ingestResult = await ingestReceivePack(resolved.repo, body);

					if (!ingestResult.sawFlush && ingestResult.updates.length === 0) {
						return new Response("Bad Request", { status: 400 });
					}

					const useSideband = ingestResult.capabilities.includes("side-band-64k");
					const useReportStatus = ingestResult.capabilities.includes("report-status");

					if (!ingestResult.unpackOk) {
						if (useReportStatus) {
							const refResults = ingestResult.updates.map((u) => ({
								name: u.ref,
								ok: false,
								error: "unpack failed",
							}));
							return new Response(buildReportStatus(false, refResults, useSideband), {
								headers: { "Content-Type": "application/x-git-receive-pack-result" },
							});
						}
						return new Response(new Uint8Array(0), {
							headers: { "Content-Type": "application/x-git-receive-pack-result" },
						});
					}

					const { refResults } = await applyReceivePack({
						repo: resolved.repo,
						repoId: resolved.repoId,
						ingestResult,
						hooks,
						session,
					});

					if (useReportStatus) {
						const reportResults = refResults.map((r) => ({
							name: r.ref,
							ok: r.ok,
							error: r.error,
						}));
						return new Response(buildReportStatus(true, reportResults, useSideband), {
							headers: { "Content-Type": "application/x-git-receive-pack-result" },
						});
					}

					return new Response(new Uint8Array(0), {
						headers: { "Content-Type": "application/x-git-receive-pack-result" },
					});
				}

				return new Response("Not Found", { status: 404 });
			} catch (err) {
				onError?.(err, session);
				return new Response("Internal Server Error", { status: 500 });
			} finally {
				leave();
			}
		},

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
				if (!buildSession.ssh) {
					channel.writeStderr?.(
						new TextEncoder().encode("fatal: SSH session builder not configured\n"),
					);
					return 128;
				}
				const session = await buildSession.ssh(sshSession ?? {});
				return await handleSshSession(command, channel, {
					resolveRepo,
					hooks,
					packCache,
					packOptions: config.packOptions,
					session,
					onError: onError ? (err) => onError(err, session) : undefined,
				});
			} finally {
				leave();
			}
		},

		async updateRefs(repoId, refs, session?) {
			if (!enter()) throw new Error("Server is shutting down");
			try {
				const repo = await server.requireRepo(repoId);

				const updates = await resolveRefUpdates(repo, refs);
				return applyReceivePack({
					repo,
					repoId,
					ingestResult: { updates, unpackOk: true, capabilities: [], sawFlush: true },
					hooks,
					session,
				});
			} finally {
				leave();
			}
		},

		nodeHandler(req: NodeHttpRequest, res: NodeHttpResponse): void {
			const chunks: Uint8Array[] = [];
			req.on("data", (chunk: Uint8Array) => chunks.push(new Uint8Array(chunk)));
			req.on("error", () => {
				res.writeHead(500);
				res.end("Internal Server Error");
			});
			req.on("end", () => {
				nodeRequestToFetch(server, req, chunks, res).catch(() => {
					try {
						res.writeHead(500);
						res.end("Internal Server Error");
					} catch {
						// headers already sent
					}
				});
			});
		},

		createRepo: (id, options) => storage.createRepo(id, options) as Promise<GitRepo>,
		repo: (id) => storage.repo(id) as Promise<GitRepo | null>,
		async requireRepo(id) {
			const repo = await storage.repo(id);
			if (!repo) throw new Error(`Repository "${id}" not found`);
			return repo as GitRepo;
		},
		deleteRepo: (id) => storage.deleteRepo(id) as Promise<void>,

		async gc(repoId, options?) {
			if (!enter()) throw new Error("Server is shutting down");
			try {
				const repo = await server.requireRepo(repoId);
				return gcRepo(repo, config.storage, repoId, options);
			} finally {
				leave();
			}
		},

		get closed() {
			return closed;
		},

		asNetwork(baseUrl = "http://git") {
			const normalized = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
			return {
				allowed: [normalized],
				fetch: (input: string | URL | Request, init?: RequestInit) =>
					server.fetch(new Request(input as string, init)),
			};
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

// ── Internal helpers ────────────────────────────────────────────────

function extractRepoPath(pathname: string, suffix: string): string {
	let repoPath = pathname.slice(0, -suffix.length);
	if (repoPath.startsWith("/")) {
		repoPath = repoPath.slice(1);
	}
	return repoPath;
}

async function readRequestBody(req: Request): Promise<Uint8Array> {
	const raw = new Uint8Array(await req.arrayBuffer());
	const encoding = req.headers.get("content-encoding");
	if (encoding === "gzip" || encoding === "x-gzip") {
		const ds = new DecompressionStream("gzip");
		const writer = ds.writable.getWriter();
		writer.write(raw);
		writer.close();
		return new Uint8Array(await new Response(ds.readable).arrayBuffer());
	}
	return raw;
}

// ── Node.js adapter internals ───────────────────────────────────────

async function nodeRequestToFetch(
	server: Pick<GitServer, "fetch">,
	req: NodeHttpRequest,
	chunks: Uint8Array[],
	res: NodeHttpResponse,
): Promise<void> {
	const host = typeof req.headers.host === "string" ? req.headers.host : "localhost";
	const url = new URL(req.url ?? "/", `http://${host}`);

	const headers = new Headers();
	for (const [key, value] of Object.entries(req.headers)) {
		if (value === undefined) continue;
		if (Array.isArray(value)) {
			for (const v of value) headers.append(key, v);
		} else {
			headers.set(key, value);
		}
	}

	const method = req.method ?? "GET";

	let body: Uint8Array | undefined;
	if (method !== "GET" && method !== "HEAD") {
		let len = 0;
		for (const c of chunks) len += c.byteLength;
		const buf = new Uint8Array(len);
		let off = 0;
		for (const c of chunks) {
			buf.set(c, off);
			off += c.byteLength;
		}
		body = buf;
	}

	const request = new Request(url.href, { method, headers, body });
	const response = await server.fetch(request);

	const responseHeaders: Record<string, string> = {};
	response.headers.forEach((value, key) => {
		responseHeaders[key] = value;
	});
	res.writeHead(response.status, responseHeaders);

	const responseBody = new Uint8Array(await response.arrayBuffer());
	if (responseBody.byteLength > 0) {
		res.write(responseBody);
	}
	res.end();
}

// ── Policy → hooks ─────────────────────────────────────────────────

function buildPolicyHooks(policy: ServerPolicy): ServerHooks<any> {
	const {
		protectedBranches = [],
		denyNonFastForward = false,
		denyDeletes = false,
		immutableTags = false,
	} = policy;

	const protectedSet = new Set(
		protectedBranches.map((b) => (b.startsWith("refs/") ? b : `refs/heads/${b}`)),
	);

	const hooks: ServerHooks<any> = {};

	if (protectedSet.size > 0) {
		hooks.preReceive = async (event) => {
			for (const update of event.updates) {
				if (!protectedSet.has(update.ref)) continue;
				if (update.isDelete) {
					return { reject: true, message: `cannot delete protected branch ${update.ref}` };
				}
				if (!update.isCreate && !update.isFF) {
					return {
						reject: true,
						message: `non-fast-forward push to protected branch ${update.ref}`,
					};
				}
			}
		};
	}

	if (denyNonFastForward || denyDeletes || immutableTags) {
		hooks.update = async (event: UpdateEvent): Promise<void | Rejection> => {
			if (denyDeletes && event.update.isDelete) {
				return { reject: true, message: "ref deletion denied" };
			}
			if (immutableTags && event.update.ref.startsWith("refs/tags/")) {
				if (event.update.isDelete) {
					return { reject: true, message: "tag deletion denied" };
				}
				if (!event.update.isCreate) {
					return { reject: true, message: "tag overwrite denied" };
				}
			}
			if (
				denyNonFastForward &&
				!event.update.isCreate &&
				!event.update.isDelete &&
				!event.update.isFF
			) {
				return { reject: true, message: "non-fast-forward" };
			}
		};
	}

	return hooks;
}

function mergePolicyAndHooks<S>(
	policy: ServerPolicy | undefined,
	hooks: ServerHooks<S> | undefined,
): ServerHooks<S> | undefined {
	const policyHooks = policy ? buildPolicyHooks(policy) : undefined;
	if (policyHooks && hooks) return composeHooks(policyHooks, hooks);
	return policyHooks ?? hooks;
}

/**
 * Compose multiple hook sets into a single `ServerHooks` object.
 *
 * - **Pre-hooks** (`preReceive`, `update`): run in order, short-circuit
 *   on the first `Rejection`.
 * - **Post-hooks** (`postReceive`): run all in order. Each is individually
 *   try/caught so one failure doesn't prevent the rest from running.
 * - **Filter hooks** (`advertiseRefs`): chain — each hook receives the
 *   refs returned by the previous one. Short-circuits on `Rejection`.
 *   Returning void passes through unchanged.
 */
export function composeHooks<S = Session>(
	...hookSets: (ServerHooks<S> | undefined)[]
): ServerHooks<S> {
	const sets = hookSets.filter((h): h is ServerHooks<S> => h != null);
	if (sets.length === 0) return {};
	if (sets.length === 1) return sets[0]!;

	const composed: ServerHooks<S> = {};

	const preReceiveHandlers = sets.filter((s) => s.preReceive).map((s) => s.preReceive!);
	if (preReceiveHandlers.length > 0) {
		composed.preReceive = async (event) => {
			for (const handler of preReceiveHandlers) {
				const result = await handler(event);
				if (isRejection(result)) return result;
			}
		};
	}

	const updateHandlers = sets.filter((s) => s.update).map((s) => s.update!);
	if (updateHandlers.length > 0) {
		composed.update = async (event) => {
			for (const handler of updateHandlers) {
				const result = await handler(event);
				if (isRejection(result)) return result;
			}
		};
	}

	const postReceiveHandlers = sets.filter((s) => s.postReceive).map((s) => s.postReceive!);
	if (postReceiveHandlers.length > 0) {
		composed.postReceive = async (event) => {
			for (const handler of postReceiveHandlers) {
				try {
					await handler(event);
				} catch {
					// fire-and-forget: one handler failing doesn't block the rest
				}
			}
		};
	}

	const advertiseRefsHandlers = sets.filter((s) => s.advertiseRefs).map((s) => s.advertiseRefs!);
	if (advertiseRefsHandlers.length > 0) {
		composed.advertiseRefs = async (event) => {
			let refs: RefAdvertisement[] = event.refs;
			for (const handler of advertiseRefsHandlers) {
				const result = await handler({ ...event, refs });
				if (isRejection(result)) return result;
				if (result) refs = result;
			}
			return refs;
		};
	}

	return composed;
}
