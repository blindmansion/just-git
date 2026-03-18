/**
 * Framework-agnostic Git Smart HTTP request handler.
 *
 * Uses web-standard Request/Response, works with Bun.serve, Hono,
 * Cloudflare Workers, or any framework that speaks fetch API.
 */

import {
	buildRefAdvertisementBytes,
	collectRefs,
	handleUploadPack,
	ingestReceivePack,
} from "./operations.ts";
import { buildReportStatus } from "./protocol.ts";
import type { GitServerConfig, GitServer, Rejection, RefUpdate } from "./types.ts";

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
					const repo = await resolveRepo(repoPath, req);
					if (!repo) return new Response("Not Found", { status: 404 });

					const { refs: allRefs, headTarget } = await collectRefs(repo);

					let refs = allRefs;
					if (hooks?.advertiseRefs) {
						const filtered = await hooks.advertiseRefs({
							repo,
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
					const repo = await resolveRepo(repoPath, req);
					if (!repo) return new Response("Not Found", { status: 404 });

					const body = new Uint8Array(await req.arrayBuffer());
					const responseBody = await handleUploadPack(repo, body);
					return new Response(responseBody, {
						headers: { "Content-Type": "application/x-git-upload-pack-result" },
					});
				}

				// ── git-receive-pack ────────────────────────────────
				if (pathname.endsWith("/git-receive-pack") && req.method === "POST") {
					const repoPath = extractRepoPath(pathname, "/git-receive-pack");
					const repo = await resolveRepo(repoPath, req);
					if (!repo) return new Response("Not Found", { status: 404 });

					const body = new Uint8Array(await req.arrayBuffer());
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
						const result = await hooks.preReceive({ repo, updates, request: req });
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
							const result = await hooks.update({ repo, update, request: req });
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
							if (update.isDelete) {
								await repo.refStore.deleteRef(update.ref);
							} else {
								await repo.refStore.writeRef(update.ref, {
									type: "direct",
									hash: update.newHash,
								});
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
							await hooks.postReceive({ repo, updates: applied, request: req });
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
			} catch {
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
