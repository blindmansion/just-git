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

import { isRejection } from "../hooks.ts";
import { buildCommit } from "../repo/writing.ts";
import type { GitRepo } from "../lib/types.ts";

const inProcessAuth = new WeakMap<Request, unknown>();
import {
	PackCache,
	advertiseRefsWithHooks,
	applyCasRefUpdates,
	applyReceivePack,
	buildAuthorizedFetchSet,
	type AuthorizedFetchSet,
	buildRefAdvertisementBytes,
	buildV2CapabilityAdvertisementBytes,
	handleLsRefs,
	handleUploadPack,
	handleV2Fetch,
	ingestReceivePack,
	resolveRefUpdates,
} from "./operations.ts";
import { buildReportStatus, parseV2CommandRequest } from "./protocol.ts";
import { handleSshSession } from "./ssh-session.ts";
import { gcRepo } from "./gc.ts";
import { createStorageAdapter, type CreateRepoOptions } from "./storage.ts";
import { MemoryStorage } from "./memory-storage.ts";
import { RequestLimitError } from "./errors.ts";
import type {
	GitServerConfig,
	GitServer,
	NodeHttpRequest,
	NodeHttpResponse,
	RefAdvertisement,
	Rejection,
	ServerHooks,
	ServerPolicy,
	Auth,
	AuthProvider,
	SshChannel,
	SshSessionInfo,
	UpdateEvent,
} from "./types.ts";

const defaultAuthProvider: AuthProvider<Auth> = {
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
	const storage = createStorageAdapter(rawStorage);
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

	const server: GitServer<A> = {
		async fetch(req: Request): Promise<Response> {
			if (!enter()) return new Response("Service Unavailable", { status: 503 });
			let auth: A | undefined;
			try {
				const embedded = inProcessAuth.get(req) as A | undefined;
				if (embedded !== undefined) {
					auth = embedded;
				} else {
					if (!buildAuth.http) {
						return new Response("HTTP auth provider not configured", { status: 501 });
					}
					const authOrResponse = await buildAuth.http(req);
					if (authOrResponse instanceof Response) return authOrResponse;
					auth = authOrResponse;
				}

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

					// Protocol v2: return capability advertisement for upload-pack
					const isV2 = isProtocolV2(req);
					if (isV2 && service === "git-upload-pack") {
						const adv = await advertiseRefsWithHooks(
							resolved.repo,
							resolved.repoId,
							service,
							hooks,
							auth,
						);
						if (isRejection(adv)) return forbiddenResponse(adv);
						const body = buildV2CapabilityAdvertisementBytes();
						return new Response(body, {
							headers: {
								"Content-Type": `application/x-${service}-advertisement`,
								"Cache-Control": "no-cache",
							},
						});
					}

					const adv = await advertiseRefsWithHooks(
						resolved.repo,
						resolved.repoId,
						service,
						hooks,
						auth,
					);
					if (isRejection(adv)) return forbiddenResponse(adv);

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

					let authorizedFetchSet: AuthorizedFetchSet | undefined;
					if (hooks?.advertiseRefs) {
						const adv = await advertiseRefsWithHooks(
							resolved.repo,
							resolved.repoId,
							"git-upload-pack",
							hooks,
							auth,
						);
						if (isRejection(adv)) return forbiddenResponse(adv);
						authorizedFetchSet = buildAuthorizedFetchSet(adv);
					}

					const body = await readRequestBody(req, receiveLimits);

					// Protocol v2: command-based dispatch
					if (isProtocolV2(req)) {
						const cmd = parseV2CommandRequest(body);
						const contentType = "application/x-git-upload-pack-result";

						if (cmd.command === "ls-refs") {
							const result = await handleLsRefs(
								resolved.repo,
								resolved.repoId,
								cmd.args,
								hooks,
								auth,
							);
							if (isRejection(result)) return forbiddenResponse(result);
							return new Response(result, { headers: { "Content-Type": contentType } });
						}

						if (cmd.command === "fetch") {
							const responseBody = await handleV2Fetch(resolved.repo, cmd.args, {
								cache: packCache,
								cacheKey: resolved.repoId,
								noDelta: config.packOptions?.noDelta,
								deltaWindow: config.packOptions?.deltaWindow,
								authorizedFetchSet,
							});
							if (isRejection(responseBody)) return forbiddenResponse(responseBody);
							return new Response(responseBody, {
								headers: { "Content-Type": contentType },
							});
						}

						return new Response(`unknown command: ${cmd.command}`, { status: 400 });
					}

					const responseBody = await handleUploadPack(resolved.repo, body, {
						cache: packCache,
						cacheKey: resolved.repoId,
						noDelta: config.packOptions?.noDelta,
						deltaWindow: config.packOptions?.deltaWindow,
						authorizedFetchSet,
					});
					if (isRejection(responseBody)) return forbiddenResponse(responseBody);
					return new Response(responseBody, {
						headers: { "Content-Type": "application/x-git-upload-pack-result" },
					});
				}

				// ── git-receive-pack ────────────────────────────────
				if (pathname.endsWith("/git-receive-pack") && req.method === "POST") {
					const requestPath = extractRepoPath(pathname, "/git-receive-pack");
					const resolved = await resolveRepo(requestPath);
					if (!resolved) return new Response("Not Found", { status: 404 });

					const body = await readRequestBody(req, receiveLimits);
					const ingestResult = await ingestReceivePack(resolved.repo, body, receiveLimits);

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
						auth,
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
				if (err instanceof RequestLimitError) {
					return new Response(err.message, { status: err.status });
				}
				onError?.(err, auth);
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
					auth,
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
				return applyCasRefUpdates(repo, updates);
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
				return commitResult;
			} finally {
				leave();
			}
		},

		nodeHandler(req: NodeHttpRequest, res: NodeHttpResponse): void {
			const chunks: Uint8Array[] = [];
			let totalBytes = 0;
			let tooLarge = false;
			req.on("data", (chunk: Uint8Array) => {
				if (tooLarge) return;
				totalBytes += chunk.byteLength;
				if (
					req.method !== "GET" &&
					req.method !== "HEAD" &&
					receiveLimits.maxRequestBytes !== undefined &&
					totalBytes > receiveLimits.maxRequestBytes
				) {
					tooLarge = true;
					chunks.length = 0;
					res.writeHead(413);
					res.end("Request body too large");
					try {
						(req as { destroy?: () => void }).destroy?.();
					} catch {
						// ignore
					}
					return;
				}
				chunks.push(new Uint8Array(chunk));
			});
			req.on("error", () => {
				res.writeHead(500);
				res.end("Internal Server Error");
			});
			req.on("end", () => {
				if (tooLarge) return;
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
				const repo = await server.requireRepo(repoId);

				let extraTips: string[] | undefined;
				if (rawStorage.listForks && rawStorage.getForkParent) {
					const parentId = await rawStorage.getForkParent(repoId);
					if (!parentId) {
						// This is a root repo — include fork ref tips
						const forkIds = await rawStorage.listForks(repoId);
						if (forkIds.length > 0) {
							extraTips = [];
							for (const forkId of forkIds) {
								const forkRepo = await storage.repo(forkId);
								if (!forkRepo) continue;
								const refs = await forkRepo.refStore.listRefs();
								for (const ref of refs) extraTips.push(ref.hash);
							}
						}
					}
				}

				return gcRepo(repo, rawStorage, repoId, options, extraTips);
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

function forbiddenResponse(r: Rejection): Response {
	return new Response(r.message ?? "Forbidden", { status: 403 });
}

function isProtocolV2(req: Request): boolean {
	const proto = req.headers.get("git-protocol");
	return proto !== null && proto.includes("version=2");
}

function extractRepoPath(pathname: string, suffix: string): string {
	let repoPath = pathname.slice(0, -suffix.length);
	if (repoPath.startsWith("/")) {
		repoPath = repoPath.slice(1);
	}
	return repoPath;
}

async function readRequestBody(
	req: Request,
	limits: {
		maxRequestBytes?: number;
		maxInflatedBytes?: number;
	},
): Promise<Uint8Array> {
	const contentLength = req.headers.get("content-length");
	if (contentLength) {
		const parsed = Number(contentLength);
		if (
			Number.isFinite(parsed) &&
			limits.maxRequestBytes !== undefined &&
			parsed > limits.maxRequestBytes
		) {
			throw new RequestLimitError("Request body too large");
		}
	}

	const raw = await readStreamWithMax(req.body, limits.maxRequestBytes, "Request body too large");
	const encoding = req.headers.get("content-encoding");
	if (encoding === "gzip" || encoding === "x-gzip") {
		const ds = new DecompressionStream("gzip");
		const writer = ds.writable.getWriter();
		const copy = new Uint8Array(raw.byteLength);
		copy.set(raw);
		await writer.write(copy);
		await writer.close();
		return readStreamWithMax(ds.readable, limits.maxInflatedBytes, "Decompressed body too large");
	}
	return raw;
}

async function readStreamWithMax(
	stream: ReadableStream<Uint8Array> | null,
	maxBytes: number | undefined,
	errorMessage: string,
): Promise<Uint8Array> {
	if (!stream) return new Uint8Array(0);

	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			if (!value) continue;
			totalBytes += value.byteLength;
			if (maxBytes !== undefined && totalBytes > maxBytes) {
				throw new RequestLimitError(errorMessage);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	if (chunks.length === 0) return new Uint8Array(0);
	const result = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return result;
}

// ── Node.js adapter internals ───────────────────────────────────────

async function nodeRequestToFetch(
	server: Pick<GitServer<any>, "fetch">,
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

function mergePolicyAndHooks<A>(
	policy: ServerPolicy | undefined,
	hooks: ServerHooks<A> | undefined,
): ServerHooks<A> | undefined {
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
export function composeHooks<A = Auth>(
	...hookSets: (ServerHooks<A> | undefined)[]
): ServerHooks<A> {
	const sets = hookSets.filter((h): h is ServerHooks<A> => h != null);
	if (sets.length === 0) return {};
	if (sets.length === 1) return sets[0]!;

	const composed: ServerHooks<A> = {};

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
