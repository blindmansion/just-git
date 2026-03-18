/**
 * Framework-agnostic Git Smart HTTP request handler.
 *
 * Uses web-standard Request/Response, works with Bun.serve, Hono,
 * Cloudflare Workers, or any framework that speaks fetch API.
 */

import {
	PackCache,
	buildRefAdvertisementBytes,
	collectRefs,
	handleUploadPack,
	ingestReceivePack,
} from "./operations.ts";
import { buildReportStatus } from "./protocol.ts";
import type {
	GitServerConfig,
	GitServer,
	Rejection,
	RefUpdate,
	ServerHooks,
	RefAdvertisement,
} from "./types.ts";

/**
 * Create a Git Smart HTTP server handler.
 *
 * ```ts
 * const server = createGitServer({
 *   resolveRepo: async (repoPath, request) => storage.repo(repoPath),
 * });
 * Bun.serve({ fetch: server.fetch });
 * ```
 */
export function createGitServer(config: GitServerConfig): GitServer {
	const { resolveRepo, hooks, basePath } = config;

	const packCache =
		config.packCache === false
			? undefined
			: new PackCache(config.packCache?.maxBytes);

	return {
		async fetch(req: Request): Promise<Response> {
			try {
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

					const repoPath = extractRepoPath(pathname, "/info/refs");
					const repoOrResponse = await resolveRepo(repoPath, req);
					if (repoOrResponse instanceof Response) return repoOrResponse;
					if (!repoOrResponse) return new Response("Not Found", { status: 404 });
					const repo = repoOrResponse;

					const { refs: allRefs, headTarget } = await collectRefs(repo);

					let refs = allRefs;
					if (hooks?.advertiseRefs) {
						const filtered = await hooks.advertiseRefs({
							repo,
							repoPath,
							refs: allRefs,
							service,
							request: req,
						});
						if (filtered) refs = filtered;
					}

					const body = buildRefAdvertisementBytes(refs, service, headTarget);
					return new Response(body, {
						headers: {
							"Content-Type": `application/x-${service}-advertisement`,
							"Cache-Control": "no-cache",
						},
					});
				}

			// ── git-upload-pack ─────────────────────────────────
			if (pathname.endsWith("/git-upload-pack") && req.method === "POST") {
				const repoPath = extractRepoPath(pathname, "/git-upload-pack");
				const repoOrResponse = await resolveRepo(repoPath, req);
				if (repoOrResponse instanceof Response) return repoOrResponse;
				if (!repoOrResponse) return new Response("Not Found", { status: 404 });
				const repo = repoOrResponse;

				const body = await readRequestBody(req);
				const responseBody = await handleUploadPack(repo, body, {
					cache: packCache,
					cacheKey: repoPath,
				});
				return new Response(responseBody, {
					headers: { "Content-Type": "application/x-git-upload-pack-result" },
				});
			}

			// ── git-receive-pack ────────────────────────────────
			if (pathname.endsWith("/git-receive-pack") && req.method === "POST") {
				const repoPath = extractRepoPath(pathname, "/git-receive-pack");
				const repoOrResponse = await resolveRepo(repoPath, req);
				if (repoOrResponse instanceof Response) return repoOrResponse;
				if (!repoOrResponse) return new Response("Not Found", { status: 404 });
				const repo = repoOrResponse;

				const body = await readRequestBody(req);
					const { updates, unpackOk, capabilities } = await ingestReceivePack(repo, body);

					const useSideband = capabilities.includes("side-band-64k");
					const useReportStatus = capabilities.includes("report-status");

					if (!unpackOk) {
						if (useReportStatus) {
							const refResults = updates.map((u) => ({
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

					// Pre-receive hook: abort entire push on rejection
					if (hooks?.preReceive) {
						const result = await hooks.preReceive({ repo, repoPath, updates, request: req });
						if (isRejection(result)) {
							if (useReportStatus) {
								const msg = result.message ?? "pre-receive hook declined";
								const refResults = updates.map((u) => ({
									name: u.ref,
									ok: false,
									error: msg,
								}));
								return new Response(buildReportStatus(true, refResults, useSideband), {
									headers: { "Content-Type": "application/x-git-receive-pack-result" },
								});
							}
							return new Response(new Uint8Array(0), {
								headers: { "Content-Type": "application/x-git-receive-pack-result" },
							});
						}
					}

					// Per-ref update hook + ref application
					const results: { ref: string; ok: boolean; error?: string }[] = [];
					const applied: RefUpdate[] = [];

					for (const update of updates) {
						if (hooks?.update) {
							const result = await hooks.update({ repo, repoPath, update, request: req });
							if (isRejection(result)) {
								results.push({
									ref: update.ref,
									ok: false,
									error: result.message ?? "update hook declined",
								});
								continue;
							}
						}

						try {
							const expectedOld = update.isCreate ? null : update.oldHash;
							const newRef = update.isDelete
								? null
								: { type: "direct" as const, hash: update.newHash };
							const ok = await repo.refStore.compareAndSwapRef(update.ref, expectedOld, newRef);
							if (!ok) {
								results.push({
									ref: update.ref,
									ok: false,
									error: "failed to lock",
								});
								continue;
							}
							results.push({ ref: update.ref, ok: true });
							applied.push(update);
						} catch (err) {
							results.push({
								ref: update.ref,
								ok: false,
								error: err instanceof Error ? err.message : String(err),
							});
						}
					}

					// Post-receive hook (fire-and-forget, only for successful updates)
					if (hooks?.postReceive && applied.length > 0) {
						try {
							await hooks.postReceive({ repo, repoPath, updates: applied, request: req });
						} catch {
							// Post-receive errors don't affect the response
						}
					}

					if (useReportStatus) {
						const refResults = results.map((r) => ({
							name: r.ref,
							ok: r.ok,
							error: r.error,
						}));
						return new Response(buildReportStatus(true, refResults, useSideband), {
							headers: { "Content-Type": "application/x-git-receive-pack-result" },
						});
					}

					return new Response(new Uint8Array(0), {
						headers: { "Content-Type": "application/x-git-receive-pack-result" },
					});
				}

			return new Response("Not Found", { status: 404 });
		} catch (err) {
			console.error("  [server] Internal error:", err);
			return new Response("Internal Server Error", { status: 500 });
		}
		},
	};
}

// ── Internal helpers ────────────────────────────────────────────────

function extractRepoPath(pathname: string, suffix: string): string {
	let repoPath = pathname.slice(0, -suffix.length);
	if (repoPath.startsWith("/")) {
		repoPath = repoPath.slice(1);
	}
	return repoPath;
}

function isRejection(value: void | Rejection | undefined): value is Rejection {
	return value != null && typeof value === "object" && "reject" in value && value.reject === true;
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

/**
 * Compose multiple hook sets into a single `ServerHooks` object.
 *
 * - **Pre-hooks** (`preReceive`, `update`): run in order, short-circuit
 *   on the first `Rejection`.
 * - **Post-hooks** (`postReceive`): run all in order. Each is individually
 *   try/caught so one failure doesn't prevent the rest from running.
 * - **Filter hooks** (`advertiseRefs`): chain — each hook receives the
 *   refs returned by the previous one. Returning void passes through
 *   unchanged.
 */
export function composeHooks(...hookSets: (ServerHooks | undefined)[]): ServerHooks {
	const sets = hookSets.filter((h): h is ServerHooks => h != null);
	if (sets.length === 0) return {};
	if (sets.length === 1) return sets[0]!;

	const composed: ServerHooks = {};

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
				if (result) refs = result;
			}
			return refs;
		};
	}

	return composed;
}
