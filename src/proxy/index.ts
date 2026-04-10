// ── Git CORS Proxy ──────────────────────────────────────────────────
// Stateless HTTP forwarder that adds CORS headers to git smart HTTP
// requests, enabling browser-based clients to clone/fetch/push against
// hosts like GitHub that lack CORS support.

import type { FetchFunction, NetworkPolicy } from "../hooks.ts";
import type { NodeHttpRequest, NodeHttpResponse } from "../node-http.ts";

export type { NodeHttpRequest, NodeHttpResponse } from "../node-http.ts";

// ── Types ───────────────────────────────────────────────────────────

export interface GitProxyLimits {
	/**
	 * Maximum request body size accepted by the Node.js adapter.
	 *
	 * Default: `512 * 1024 * 1024` (512 MiB)
	 */
	maxRequestBytes?: number;
}

export interface GitProxyRedirectConfig {
	/**
	 * Redirect handling mode for upstream fetches.
	 *
	 * - `"follow"` manually follows validated redirects
	 * - `"error"` rejects any upstream redirect
	 *
	 * Default: `"follow"`
	 */
	mode?: "follow" | "error";

	/**
	 * Maximum number of redirects to follow when `mode` is `"follow"`.
	 *
	 * Default: `5`
	 */
	maxHops?: number;
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
	 * origin, or an array of allowed origins.
	 *
	 * When an array is provided, requests with a mismatched `Origin`
	 * receive 403 and requests without an `Origin` header proceed
	 * without `Access-Control-Allow-Origin`.
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
	fetch?: FetchFunction;

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

	/** Limits for the Node.js adapter. */
	limits?: GitProxyLimits;

	/** Redirect handling policy for upstream fetches. */
	redirects?: GitProxyRedirectConfig;
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

// ── Constants ───────────────────────────────────────────────────────

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
const DEFAULT_MAX_REQUEST_BYTES = 512 * 1024 * 1024;
const DEFAULT_REDIRECT_MAX_HOPS = 5;
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);
const RESPONSE_VARY_HEADERS = ["Authorization", "Git-Protocol"];
const PREFLIGHT_VARY_HEADERS = ["Access-Control-Request-Headers", "Access-Control-Request-Method"];

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

function isValidGitTarget(
	method: string,
	pathname: string,
	searchParams: URLSearchParams,
	contentType: string | null,
): boolean {
	if (!isAllowedRequest(method, pathname, contentType)) return false;
	if (pathname.endsWith("/info/refs")) return isAllowedService(searchParams);
	return true;
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

function buildUpstreamUrl(
	host: string,
	path: string,
	search: string,
	insecureHosts: Set<string>,
): URL {
	const normalizedHost = host.toLowerCase();
	const protocol = insecureHosts.has(normalizedHost) ? "http" : "https";
	return new URL(`${protocol}://${host}/${path}${search}`);
}

function isAllowedUpstreamUrl(
	url: URL,
	allowedHosts: Set<string>,
	insecureHosts: Set<string>,
	method: string,
	contentType: string | null,
): boolean {
	if (!allowedHosts.has(url.host.toLowerCase())) return false;
	if (
		url.protocol !== "https:" &&
		!(url.protocol === "http:" && insecureHosts.has(url.host.toLowerCase()))
	) {
		return false;
	}
	return isValidGitTarget(method, url.pathname, url.searchParams, contentType);
}

// ── CORS helpers ────────────────────────────────────────────────────

interface ResolvedCors {
	origin: string | null;
	originRejected: boolean;
	varyOnOrigin: boolean;
}

function resolveCors(
	config: string | string[] | undefined,
	requestOrigin: string | null,
): ResolvedCors {
	if (config === undefined || config === "*") {
		return { origin: "*", originRejected: false, varyOnOrigin: false };
	}

	if (typeof config === "string") {
		return { origin: config, originRejected: false, varyOnOrigin: true };
	}

	if (!requestOrigin) {
		return { origin: null, originRejected: false, varyOnOrigin: true };
	}

	if (config.includes(requestOrigin)) {
		return { origin: requestOrigin, originRejected: false, varyOnOrigin: true };
	}

	return { origin: null, originRejected: true, varyOnOrigin: true };
}

function appendVary(headers: Headers, values: string[]): void {
	const existing = headers.get("Vary");
	const merged = new Set(
		(existing ?? "")
			.split(",")
			.map((value) => value.trim())
			.filter(Boolean),
	);
	for (const value of values) merged.add(value);
	if (merged.size > 0) headers.set("Vary", [...merged].join(", "));
}

function applyCorsHeaders(headers: Headers, cors: ResolvedCors, preflight = false): void {
	if (cors.origin !== null) {
		headers.set("Access-Control-Allow-Origin", cors.origin);
		headers.set("Access-Control-Expose-Headers", EXPOSE_HEADERS);
	}

	const varyHeaders = [...RESPONSE_VARY_HEADERS];
	if (cors.varyOnOrigin) varyHeaders.push("Origin");
	if (preflight) varyHeaders.push(...PREFLIGHT_VARY_HEADERS);
	appendVary(headers, varyHeaders);

	if (preflight) {
		headers.set("Access-Control-Allow-Methods", ALLOW_METHODS);
		headers.set("Access-Control-Allow-Headers", ALLOW_HEADERS);
		headers.set("Access-Control-Max-Age", MAX_AGE);
	}
}

function textResponse(
	status: number,
	body: string,
	cors: ResolvedCors,
	headers?: Record<string, string>,
): Response {
	const responseHeaders = new Headers(headers);
	applyCorsHeaders(responseHeaders, cors);
	return new Response(body, { status, headers: responseHeaders });
}

// ── Redirect handling ───────────────────────────────────────────────

interface RedirectResult {
	response: Response;
	finalUrl: string | null;
}

class RequestLimitError extends Error {
	constructor(message = "Request body too large") {
		super(message);
		this.name = "RequestLimitError";
	}
}

function isRequestLimitError(error: unknown): error is RequestLimitError {
	return error instanceof RequestLimitError;
}

async function fetchWithRedirectPolicy(
	initialUrl: URL,
	request: {
		method: string;
		headers: Record<string, string>;
		body: ReadableStream<Uint8Array> | null | undefined;
	},
	options: {
		fetchFn: FetchFunction;
		redirectMode: "follow" | "error";
		maxRedirectHops: number;
		allowedHosts: Set<string>;
		insecureHosts: Set<string>;
		contentType: string | null;
	},
): Promise<RedirectResult> {
	let currentUrl = initialUrl;
	let finalUrl: string | null = null;

	for (let hop = 0; hop <= options.maxRedirectHops; hop++) {
		let response: Response;
		try {
			response = await options.fetchFn(currentUrl, {
				method: request.method,
				headers: request.headers,
				body: request.body,
				redirect: "manual",
				duplex: request.body ? "half" : undefined,
			} as RequestInit);
		} catch (error) {
			if (isRequestLimitError(error)) throw error;
			throw new Error("Bad Gateway");
		}

		if (!REDIRECT_STATUS_CODES.has(response.status)) {
			return { response, finalUrl };
		}

		if (options.redirectMode === "error") {
			throw new Error("Upstream redirect blocked");
		}

		if (request.method !== "GET" || request.body) {
			throw new Error("Redirected git POST requests are not supported");
		}

		if (hop === options.maxRedirectHops) {
			throw new Error("Too many redirects");
		}

		const location = response.headers.get("location");
		if (!location) throw new Error("Upstream redirect missing location");

		const nextUrl = new URL(location, currentUrl);
		if (
			!isAllowedUpstreamUrl(
				nextUrl,
				options.allowedHosts,
				options.insecureHosts,
				request.method,
				options.contentType,
			)
		) {
			throw new Error("Redirect target is not allowed");
		}

		currentUrl = nextUrl;
		finalUrl = currentUrl.href;
	}

	throw new Error("Too many redirects");
}

// ── createProxy ─────────────────────────────────────────────────────

export function createProxy(config: GitProxyConfig): GitProxy {
	const allowedHosts = new Set(config.allowed.map((h) => h.toLowerCase()));
	const insecureHosts = new Set((config.insecureHosts ?? []).map((h) => h.toLowerCase()));
	const userAgent = config.userAgent ?? "git/just-git-proxy";
	const upstreamFetch = config.fetch ?? globalThis.fetch;
	const maxRequestBytes = config.limits?.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
	const redirectMode = config.redirects?.mode ?? "follow";
	const maxRedirectHops = config.redirects?.maxHops ?? DEFAULT_REDIRECT_MAX_HOPS;

	async function handleFetch(req: Request): Promise<Response> {
		const url = new URL(req.url);
		const method = req.method;
		const requestOrigin = req.headers.get("origin");
		const cors = resolveCors(config.allowOrigin, requestOrigin);
		const contentType = req.headers.get("content-type");

		const upstream = extractUpstream(url.pathname);
		if (!upstream) {
			return textResponse(404, "Not Found", cors);
		}

		if (!allowedHosts.has(upstream.host.toLowerCase())) {
			return textResponse(403, "Forbidden", cors);
		}

		const fullPath = `/${upstream.path}`;
		if (!isValidGitTarget(method, fullPath, url.searchParams, contentType)) {
			return textResponse(403, "Forbidden", cors);
		}

		if (cors.originRejected) {
			return textResponse(403, "Origin not allowed", cors);
		}

		if (config.auth) {
			const result = await config.auth(req);
			if (result instanceof Response) {
				const headers = new Headers(result.headers);
				applyCorsHeaders(headers, cors, method === "OPTIONS");
				return new Response(result.body, { status: result.status, headers });
			}
		}

		if (method === "OPTIONS") {
			const headers = new Headers();
			applyCorsHeaders(headers, cors, true);
			return new Response(null, { status: 200, headers });
		}

		const upstreamUrl = buildUpstreamUrl(upstream.host, upstream.path, url.search, insecureHosts);
		const upstreamHeaders: Record<string, string> = { "User-Agent": userAgent };
		for (const name of FORWARDED_HEADERS) {
			const value = req.headers.get(name);
			if (value) upstreamHeaders[name] = value;
		}

		const body = method === "POST" ? req.body : undefined;

		let redirectResult: RedirectResult;
		try {
			redirectResult = await fetchWithRedirectPolicy(
				upstreamUrl,
				{
					method,
					headers: upstreamHeaders,
					body,
				},
				{
					fetchFn: upstreamFetch,
					redirectMode,
					maxRedirectHops,
					allowedHosts,
					insecureHosts,
					contentType,
				},
			);
		} catch (error) {
			if (isRequestLimitError(error)) {
				return textResponse(413, error.message, cors);
			}

			const message =
				error instanceof Error && error.message !== "Bad Gateway" ? error.message : "Bad Gateway";
			return textResponse(502, message, cors);
		}

		const responseHeaders = new Headers();
		applyCorsHeaders(responseHeaders, cors);

		for (const name of ["content-type", "cache-control", "etag", "content-length"]) {
			const value = redirectResult.response.headers.get(name);
			if (value) responseHeaders.set(name, value);
		}

		if (redirectResult.finalUrl) {
			responseHeaders.set("x-redirected-url", redirectResult.finalUrl);
		}

		return new Response(redirectResult.response.body, {
			status: redirectResult.response.status,
			headers: responseHeaders,
		});
	}

	function nodeHandler(req: NodeHttpRequest, res: NodeHttpResponse): void {
		const host = typeof req.headers.host === "string" ? req.headers.host : "localhost";
		const method = req.method ?? "GET";
		const url = new URL(req.url ?? "/", `http://${host}`);
		const headers = nodeHeadersToWeb(req.headers);

		if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
			handleFetch(new Request(url.href, { method, headers })).then(
				(response) => pipeResponseToNode(response, res),
				(error) => nodeError(res, error),
			);
			return;
		}

		const contentLength = readContentLength(headers);
		if (contentLength !== null && contentLength > maxRequestBytes) {
			res.writeHead(413, { "Content-Type": "text/plain" });
			res.end("Request body too large");
			destroyNodeRequest(req);
			return;
		}

		const body = nodeRequestBodyToWebStream(req, maxRequestBytes);
		const request = new Request(url.href, {
			method,
			headers,
			body,
			duplex: "half",
		} as RequestInit);

		handleFetch(request).then(
			(response) => pipeResponseToNode(response, res),
			(error) => nodeError(res, error),
		);
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

function readContentLength(headers: Headers): number | null {
	const value = headers.get("content-length");
	if (!value) return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function nodeRequestBodyToWebStream(
	req: NodeHttpRequest,
	maxRequestBytes: number,
): ReadableStream<Uint8Array> {
	let finished = false;
	let totalBytes = 0;

	return new ReadableStream<Uint8Array>({
		start(controller) {
			req.on("data", (chunk: Buffer | Uint8Array) => {
				if (finished) return;
				const data = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
				totalBytes += data.byteLength;
				if (totalBytes > maxRequestBytes) {
					finished = true;
					controller.error(new RequestLimitError());
					destroyNodeRequest(req);
					return;
				}
				controller.enqueue(data);
			});

			req.on("end", () => {
				if (finished) return;
				finished = true;
				controller.close();
			});

			req.on("error", (error?: unknown) => {
				if (finished) return;
				finished = true;
				controller.error(error instanceof Error ? error : new Error("Bad Request"));
			});
		},
		cancel() {
			finished = true;
			destroyNodeRequest(req);
		},
	});
}

function destroyNodeRequest(req: NodeHttpRequest): void {
	try {
		(req as NodeHttpRequest & { destroy?: () => void }).destroy?.();
	} catch {
		// ignore
	}
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

function nodeError(res: NodeHttpResponse, error: unknown): void {
	const status = isRequestLimitError(error) ? 413 : 502;
	const message = isRequestLimitError(error) ? error.message : "Bad Gateway";
	try {
		res.writeHead(status, { "Content-Type": "text/plain" });
		res.end(message);
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
			const rewritten = url.replace(/^https?:\/\//, `${base}/`);

			if (input instanceof Request) {
				const method = init?.method ?? input.method;
				const body = init?.body ?? (method === "GET" || method === "HEAD" ? undefined : input.body);
				return globalThis.fetch(
					new Request(rewritten, {
						method,
						headers: init?.headers ?? input.headers,
						body,
						cache: init?.cache ?? input.cache,
						credentials: init?.credentials ?? input.credentials,
						integrity: init?.integrity ?? input.integrity,
						keepalive: init?.keepalive ?? input.keepalive,
						mode: init?.mode ?? input.mode,
						redirect: init?.redirect ?? input.redirect,
						referrer: init?.referrer ?? input.referrer,
						referrerPolicy: init?.referrerPolicy ?? input.referrerPolicy,
						signal: init?.signal ?? input.signal,
						duplex: body ? "half" : undefined,
					} as RequestInit),
				);
			}

			return globalThis.fetch(rewritten, init);
		},
	};
}
