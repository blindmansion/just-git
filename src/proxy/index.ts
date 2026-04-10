// ── Git CORS Proxy ──────────────────────────────────────────────────
// Stateless HTTP forwarder that adds CORS headers to git smart HTTP
// requests, enabling browser-based clients to clone/fetch/push against
// hosts like GitHub that lack CORS support.

import type { NetworkPolicy } from "../hooks.ts";

// ── Types ───────────────────────────────────────────────────────────

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

export interface GitProxyConfig {
	/**
	 * Upstream hosts the proxy will forward to.
	 *
	 * Required to prevent the proxy from being used as an open relay.
	 * Only requests whose extracted upstream host appears in this list
	 * are forwarded; everything else receives a 403.
	 *
	 * ```ts
	 * createProxy({ allowed: ["github.com", "gitlab.com"] })
	 * ```
	 */
	allowed: string[];

	/**
	 * CORS `Access-Control-Allow-Origin` value.
	 *
	 * Can be a single origin (`"https://myapp.com"`), `"*"` for any
	 * origin, or an array of allowed origins (the proxy picks the
	 * matching one from the request's `Origin` header).
	 *
	 * Default: `"*"`
	 */
	allowOrigin?: string | string[];

	/**
	 * Authenticate proxy requests before forwarding.
	 *
	 * Return `void` / `undefined` to allow, or return a `Response`
	 * to short-circuit (e.g. `new Response("Unauthorized", { status: 401 })`).
	 */
	auth?: (request: Request) => void | Response | Promise<void | Response>;

	/**
	 * Custom fetch function for upstream requests.
	 *
	 * Default: `globalThis.fetch`
	 */
	fetch?: typeof globalThis.fetch;

	/**
	 * User-Agent header sent to the upstream server.
	 *
	 * GitHub requires `User-Agent` to start with `git/` for proper
	 * smart HTTP behavior. Default: `"git/just-git-proxy"`
	 */
	userAgent?: string;

	/**
	 * Hosts to connect to via `http://` instead of `https://`.
	 *
	 * All other hosts default to `https://`.
	 */
	insecureHosts?: string[];
}

export interface GitProxy {
	/** Web-standard fetch handler (Bun.serve, CF Workers, Deno Deploy, etc.). */
	fetch(request: Request): Promise<Response>;

	/**
	 * Node.js `http.createServer` compatible handler.
	 *
	 * ```ts
	 * import http from "node:http";
	 * http.createServer(proxy.nodeHandler).listen(9999);
	 * ```
	 */
	nodeHandler(req: NodeHttpRequest, res: NodeHttpResponse): void;
}

// ── CORS constants ──────────────────────────────────────────────────

const ALLOW_HEADERS = [
	"accept-encoding",
	"accept",
	"authorization",
	"content-type",
	"git-protocol",
	"x-authorization",
].join(", ");

const EXPOSE_HEADERS = [
	"content-type",
	"content-length",
	"cache-control",
	"etag",
	"x-redirected-url",
].join(", ");

const ALLOW_METHODS = "GET, POST, OPTIONS";
const MAX_AGE = "86400";

// ── Headers forwarded to upstream ───────────────────────────────────

const FORWARDED_HEADERS = [
	"authorization",
	"content-type",
	"accept-encoding",
	"git-protocol",
	"x-authorization",
];

// ── Request validation ──────────────────────────────────────────────

function isAllowedRequest(method: string, pathname: string, contentType: string | null): boolean {
	const isInfoRefs = pathname.endsWith("/info/refs");

	switch (method) {
		case "GET":
			return isInfoRefs;
		case "POST":
			return (
				(pathname.endsWith("/git-upload-pack") &&
					contentType === "application/x-git-upload-pack-request") ||
				(pathname.endsWith("/git-receive-pack") &&
					contentType === "application/x-git-receive-pack-request")
			);
		case "OPTIONS":
			return (
				isInfoRefs ||
				pathname.endsWith("/git-upload-pack") ||
				pathname.endsWith("/git-receive-pack")
			);
		default:
			return false;
	}
}

function isAllowedService(searchParams: URLSearchParams): boolean {
	const service = searchParams.get("service");
	return service === "git-upload-pack" || service === "git-receive-pack";
}

// ── URL extraction ──────────────────────────────────────────────────

interface UpstreamTarget {
	host: string;
	path: string;
}

function extractUpstream(pathname: string): UpstreamTarget | null {
	const match = pathname.match(/^\/([^/]+)\/(.*)/);
	if (!match) return null;
	const host = match[1]!;
	const path = match[2]!;
	return { host, path };
}

// ── CORS helpers ────────────────────────────────────────────────────

function resolveOrigin(
	config: string | string[] | undefined,
	requestOrigin: string | null,
): string {
	if (config === undefined || config === "*") return "*";
	if (typeof config === "string") return config;
	if (requestOrigin && config.includes(requestOrigin)) return requestOrigin;
	return config[0] ?? "*";
}

function corsHeaders(origin: string): Record<string, string> {
	return {
		"Access-Control-Allow-Origin": origin,
		"Access-Control-Expose-Headers": EXPOSE_HEADERS,
	};
}

function preflightHeaders(origin: string): Record<string, string> {
	return {
		...corsHeaders(origin),
		"Access-Control-Allow-Methods": ALLOW_METHODS,
		"Access-Control-Allow-Headers": ALLOW_HEADERS,
		"Access-Control-Max-Age": MAX_AGE,
	};
}

// ── createProxy ─────────────────────────────────────────────────────

export function createProxy(config: GitProxyConfig): GitProxy {
	const allowedHosts = new Set(config.allowed.map((h) => h.toLowerCase()));
	const insecureHosts = new Set((config.insecureHosts ?? []).map((h) => h.toLowerCase()));
	const userAgent = config.userAgent ?? "git/just-git-proxy";
	const upstreamFetch = config.fetch ?? globalThis.fetch;

	async function handleFetch(req: Request): Promise<Response> {
		const url = new URL(req.url);
		const method = req.method;
		const requestOrigin = req.headers.get("origin");
		const origin = resolveOrigin(config.allowOrigin, requestOrigin);

		// Preflight
		if (method === "OPTIONS") {
			return new Response(null, { status: 200, headers: preflightHeaders(origin) });
		}

		// Auth
		if (config.auth) {
			const result = await config.auth(req);
			if (result instanceof Response) {
				const h = new Headers(result.headers);
				for (const [k, v] of Object.entries(corsHeaders(origin))) h.set(k, v);
				return new Response(result.body, { status: result.status, headers: h });
			}
		}

		// Extract upstream target from path
		const upstream = extractUpstream(url.pathname);
		if (!upstream) {
			return new Response("Not Found", { status: 404, headers: corsHeaders(origin) });
		}

		// Host allowlist check
		if (!allowedHosts.has(upstream.host.toLowerCase())) {
			return new Response("Forbidden", { status: 403, headers: corsHeaders(origin) });
		}

		// Validate this is a legitimate git operation
		const fullPath = `/${upstream.path}`;
		const contentType = req.headers.get("content-type");
		if (!isAllowedRequest(method, fullPath, contentType)) {
			return new Response("Forbidden", { status: 403, headers: corsHeaders(origin) });
		}

		// For GET info/refs, validate service parameter
		if (
			method === "GET" &&
			fullPath.endsWith("/info/refs") &&
			!isAllowedService(url.searchParams)
		) {
			return new Response("Forbidden", { status: 403, headers: corsHeaders(origin) });
		}

		// Build upstream URL
		const protocol = insecureHosts.has(upstream.host.toLowerCase()) ? "http" : "https";
		const upstreamUrl = `${protocol}://${upstream.host}/${upstream.path}${url.search}`;

		// Forward selected headers
		const upstreamHeaders: Record<string, string> = { "User-Agent": userAgent };
		for (const name of FORWARDED_HEADERS) {
			const value = req.headers.get(name);
			if (value) upstreamHeaders[name] = value;
		}

		// Forward request body for POST
		const body = method === "POST" ? req.body : undefined;

		let upstreamRes: Response;
		try {
			upstreamRes = await upstreamFetch(upstreamUrl, {
				method,
				headers: upstreamHeaders,
				body,
				redirect: "follow",
				duplex: body ? "half" : undefined,
			} as RequestInit);
		} catch {
			return new Response("Bad Gateway", { status: 502, headers: corsHeaders(origin) });
		}

		// Build response with CORS headers, streaming the body through
		const responseHeaders = new Headers();
		for (const [k, v] of Object.entries(corsHeaders(origin))) responseHeaders.set(k, v);

		// Forward selected response headers from upstream
		for (const name of ["content-type", "cache-control", "etag", "content-length"]) {
			const value = upstreamRes.headers.get(name);
			if (value) responseHeaders.set(name, value);
		}

		// Track redirects for the client
		if (upstreamRes.redirected) {
			responseHeaders.set("x-redirected-url", upstreamRes.url);
		}

		return new Response(upstreamRes.body, {
			status: upstreamRes.status,
			headers: responseHeaders,
		});
	}

	function nodeHandler(req: NodeHttpRequest, res: NodeHttpResponse): void {
		const host = typeof req.headers.host === "string" ? req.headers.host : "localhost";
		const method = req.method ?? "GET";

		if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
			const url = new URL(req.url ?? "/", `http://${host}`);
			const headers = nodeHeadersToWeb(req.headers);
			const request = new Request(url.href, { method, headers });

			handleFetch(request).then(
				(response) => pipeResponseToNode(response, res),
				(err) => nodeError(res, err),
			);
			return;
		}

		// Buffer request body for POST
		const chunks: Uint8Array[] = [];
		let size = 0;
		const MAX_BODY = 512 * 1024 * 1024; // 512 MB

		req.on("data", (chunk: Buffer | Uint8Array) => {
			const data = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
			size += data.byteLength;
			if (size <= MAX_BODY) chunks.push(data);
		});

		req.on("end", () => {
			if (size > MAX_BODY) {
				res.writeHead(413, { "Content-Type": "text/plain" });
				res.end("Request body too large");
				return;
			}

			const url = new URL(req.url ?? "/", `http://${host}`);
			const headers = nodeHeadersToWeb(req.headers);

			let body: Uint8Array | undefined;
			if (chunks.length > 0) {
				let len = 0;
				for (const c of chunks) len += c.byteLength;
				body = new Uint8Array(len);
				let off = 0;
				for (const c of chunks) {
					body.set(c, off);
					off += c.byteLength;
				}
			}

			const request = new Request(url.href, { method, headers, body });

			handleFetch(request).then(
				(response) => pipeResponseToNode(response, res),
				(err) => nodeError(res, err),
			);
		});

		req.on("error", () => {
			res.writeHead(400, { "Content-Type": "text/plain" });
			res.end("Bad Request");
		});
	}

	return {
		fetch: handleFetch,
		nodeHandler,
	};
}

// ── Node helpers ────────────────────────────────────────────────────

function nodeHeadersToWeb(headers: Record<string, string | string[] | undefined>): Headers {
	const h = new Headers();
	for (const [key, value] of Object.entries(headers)) {
		if (value === undefined) continue;
		if (Array.isArray(value)) {
			for (const v of value) h.append(key, v);
		} else {
			h.set(key, value);
		}
	}
	return h;
}

async function pipeResponseToNode(response: Response, res: NodeHttpResponse): Promise<void> {
	const headers: Record<string, string> = {};
	response.headers.forEach((value, key) => {
		headers[key] = value;
	});
	res.writeHead(response.status, headers);

	if (!response.body) {
		res.end();
		return;
	}

	// Stream the response body to the Node response
	const reader = response.body.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			res.write(value);
		}
	} catch {
		// Client disconnect or upstream error — just end
	} finally {
		res.end();
	}
}

function nodeError(res: NodeHttpResponse, _err: unknown): void {
	try {
		res.writeHead(502, { "Content-Type": "text/plain" });
		res.end("Bad Gateway");
	} catch {
		// Response already started — nothing we can do
	}
}

// ── Client-side helper ──────────────────────────────────────────────

/**
 * Build a {@link NetworkPolicy} that routes git HTTP requests through
 * a CORS proxy, enabling browser clients to clone/fetch/push against
 * hosts like GitHub.
 *
 * ```ts
 * import { createGit } from "just-git";
 * import { corsProxy } from "just-git/proxy";
 *
 * const git = createGit({
 *   network: corsProxy("https://my-proxy.example.com"),
 * });
 * // Standard GitHub URLs now work from the browser:
 * await git.exec("clone https://github.com/user/repo /work", { fs, cwd: "/" });
 * ```
 *
 * URLs are rewritten so `https://github.com/user/repo` becomes
 * `{proxyUrl}/github.com/user/repo`. The proxy extracts the host
 * from the first path segment and forwards to the upstream.
 */
export function corsProxy(proxyUrl: string): NetworkPolicy {
	const base = proxyUrl.replace(/\/+$/, "");
	return {
		fetch: (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			// https://github.com/user/repo → {base}/github.com/user/repo
			const rewritten = url.replace(/^https?:\/\//, `${base}/`);
			return globalThis.fetch(rewritten, init);
		},
	};
}
