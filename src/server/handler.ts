/**
 * Layer 2: Framework-agnostic Git Smart HTTP request handler.
 *
 * Uses web-standard Request/Response, works with Bun.serve, Hono,
 * Cloudflare Workers, or any framework that speaks fetch API.
 */

import { advertiseRefs, handleReceivePack, handleUploadPack } from "./operations.ts";
import type { GitServerOptions } from "./types.ts";

export interface GitServer {
	/** Handle a Git Smart HTTP request. Returns a Response. */
	handle(req: Request): Promise<Response>;
}

/**
 * Create a Git Smart HTTP server handler.
 *
 * ```ts
 * const server = createGitServer({
 *   resolve: async (repoPath) => ({
 *     objects: myObjectStore,
 *     refs: myRefStore,
 *   }),
 * });
 * Bun.serve({ fetch: (req) => server.handle(req) });
 * ```
 */
export function createGitServer(options: GitServerOptions): GitServer {
	const { resolve, authorize, onPush, basePath, denyNonFastForwards } = options;

	return {
		async handle(req: Request): Promise<Response> {
			try {
				const url = new URL(req.url);
				let pathname = decodeURIComponent(url.pathname);

				// Strip basePath prefix
				if (basePath) {
					const normalized = basePath.replace(/\/+$/, "");
					if (!pathname.startsWith(normalized)) {
						return new Response("Not Found", { status: 404 });
					}
					pathname = pathname.slice(normalized.length);
				}

				// Ensure leading slash
				if (!pathname.startsWith("/")) {
					pathname = `/${pathname}`;
				}

				// Match Git endpoints at the end of the path
				if (pathname.endsWith("/info/refs") && req.method === "GET") {
					return await handleInfoRefs(pathname, url, resolve);
				}

				if (pathname.endsWith("/git-upload-pack") && req.method === "POST") {
					const repoPath = extractRepoPath(pathname, "/git-upload-pack");
					if (authorize) {
						const authResult = await authorize(req, repoPath, "upload-pack");
						if (!authResult.ok) {
							return new Response(authResult.message ?? "Forbidden", {
								status: authResult.status ?? 403,
							});
						}
					}
					const repo = await resolve(repoPath);
					const body = new Uint8Array(await req.arrayBuffer());
					const responseBody = await handleUploadPack(repo, body);
					return new Response(responseBody, {
						headers: {
							"Content-Type": "application/x-git-upload-pack-result",
						},
					});
				}

				if (pathname.endsWith("/git-receive-pack") && req.method === "POST") {
					const repoPath = extractRepoPath(pathname, "/git-receive-pack");
					if (authorize) {
						const authResult = await authorize(req, repoPath, "receive-pack");
						if (!authResult.ok) {
							return new Response(authResult.message ?? "Forbidden", {
								status: authResult.status ?? 403,
							});
						}
					}
					const repo = await resolve(repoPath);
					const body = new Uint8Array(await req.arrayBuffer());
					const { response: responseBody, refUpdates } = await handleReceivePack(repo, body, {
						denyNonFastForwards,
					});

					if (onPush) {
						const successfulUpdates = refUpdates.filter((u) => u.ok);
						if (successfulUpdates.length > 0) {
							await onPush(repoPath, successfulUpdates);
						}
					}

					return new Response(responseBody, {
						headers: {
							"Content-Type": "application/x-git-receive-pack-result",
						},
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

async function handleInfoRefs(
	pathname: string,
	url: URL,
	resolve: GitServerOptions["resolve"],
): Promise<Response> {
	const service = url.searchParams.get("service");
	if (service !== "git-upload-pack" && service !== "git-receive-pack") {
		return new Response("Unsupported service", { status: 403 });
	}

	const repoPath = extractRepoPath(pathname, "/info/refs");
	const repo = await resolve(repoPath);
	const body = await advertiseRefs(repo, service);

	return new Response(body, {
		headers: {
			"Content-Type": `application/x-${service}-advertisement`,
			"Cache-Control": "no-cache",
		},
	});
}

/** Extract the repo path by removing the endpoint suffix. */
function extractRepoPath(pathname: string, suffix: string): string {
	let repoPath = pathname.slice(0, -suffix.length);
	// Strip leading slash
	if (repoPath.startsWith("/")) {
		repoPath = repoPath.slice(1);
	}
	return repoPath;
}
