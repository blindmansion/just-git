/**
 * Fetch API adapter for Git smart HTTP.
 *
 * The adapter owns HTTP routing, request decoding, and response/error mapping.
 * Storage, lifecycle state, authentication, and server assembly remain in the
 * composition root and are supplied as resolved dependencies.
 */

import { isRejection } from "../hooks.ts";
import type { GitRepo } from "../lib/types.ts";
import {
	PackCache,
	advertiseRefsWithHooks,
	applyReceivePack,
	buildAuthorizedFetchSet,
	type AuthorizedFetchSet,
	buildRefAdvertisementBytes,
	buildV2CapabilityAdvertisementBytes,
	handleLsRefs,
	handleUploadPack,
	handleV2Fetch,
	ingestReceivePackFromStream,
} from "./operations.ts";
import { buildReportStatus, parseV2CommandRequest } from "./protocol.ts";
import { RequestLimitError } from "./errors.ts";
import { readReceivePackCommands, StreamPktLineReader } from "./request-stream.ts";
import type {
	Auth,
	AuthProvider,
	GitServerConfig,
	Rejection,
	RefUpdate,
	ServerHooks,
} from "./types.ts";

interface ResolvedRepo {
	repo: GitRepo;
	repoId: string;
}

export interface HttpHandlerDependencies<A = Auth> {
	basePath?: string;
	resolveRepo(path: string): Promise<ResolvedRepo | null>;
	hooks?: ServerHooks<A>;
	packCache?: PackCache;
	packOptions?: GitServerConfig<A>["packOptions"];
	receiveLimits: NonNullable<GitServerConfig<A>["receiveLimits"]>;
	fetchLimits: NonNullable<GitServerConfig<A>["fetchLimits"]>;
	auth: AuthProvider<A>;
	getEmbeddedAuth?(request: Request): A | undefined;
	enter(): boolean;
	leave(): void;
	onRefApplied?(repoId: string, repo: GitRepo, applied: readonly RefUpdate[], auth: A): void;
	onError?(error: unknown, auth?: A): void;
}

export function createHttpHandler<A = Auth>(
	dependencies: HttpHandlerDependencies<A>,
): (request: Request) => Promise<Response> {
	const {
		basePath,
		resolveRepo,
		hooks,
		packCache,
		packOptions,
		receiveLimits,
		fetchLimits,
		auth: buildAuth,
		getEmbeddedAuth,
		enter,
		leave,
		onRefApplied,
		onError,
	} = dependencies;

	return async (request: Request): Promise<Response> => {
		if (!enter()) return new Response("Service Unavailable", { status: 503 });
		let auth: A | undefined;
		try {
			const embedded = getEmbeddedAuth?.(request);
			if (embedded !== undefined) {
				auth = embedded;
			} else {
				if (!buildAuth.http) {
					return new Response("HTTP auth provider not configured", { status: 501 });
				}
				const authOrResponse = await buildAuth.http(request);
				if (authOrResponse instanceof Response) return authOrResponse;
				auth = authOrResponse;
			}

			const url = new URL(request.url);
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

			if (pathname.endsWith("/info/refs") && request.method === "GET") {
				const service = url.searchParams.get("service");
				if (service !== "git-upload-pack" && service !== "git-receive-pack") {
					return new Response("Unsupported service", { status: 403 });
				}

				const requestPath = extractRepoPath(pathname, "/info/refs");
				const resolved = await resolveRepo(requestPath);
				if (!resolved) return new Response("Not Found", { status: 404 });

				if (isProtocolV2(request) && service === "git-upload-pack") {
					const advertisement = await advertiseRefsWithHooks(
						resolved.repo,
						resolved.repoId,
						service,
						hooks,
						auth,
					);
					if (isRejection(advertisement)) return forbiddenResponse(advertisement);
					const body = buildV2CapabilityAdvertisementBytes();
					return new Response(body, {
						headers: {
							"Content-Type": `application/x-${service}-advertisement`,
							"Cache-Control": "no-cache",
						},
					});
				}

				const advertisement = await advertiseRefsWithHooks(
					resolved.repo,
					resolved.repoId,
					service,
					hooks,
					auth,
				);
				if (isRejection(advertisement)) return forbiddenResponse(advertisement);

				const body = buildRefAdvertisementBytes(
					advertisement.refs,
					service,
					advertisement.headTarget,
				);
				return new Response(body, {
					headers: {
						"Content-Type": `application/x-${service}-advertisement`,
						"Cache-Control": "no-cache",
					},
				});
			}

			if (pathname.endsWith("/git-upload-pack") && request.method === "POST") {
				const requestPath = extractRepoPath(pathname, "/git-upload-pack");
				const resolved = await resolveRepo(requestPath);
				if (!resolved) return new Response("Not Found", { status: 404 });

				let authorizedFetchSet: AuthorizedFetchSet | undefined;
				if (hooks?.advertiseRefs) {
					const advertisement = await advertiseRefsWithHooks(
						resolved.repo,
						resolved.repoId,
						"git-upload-pack",
						hooks,
						auth,
					);
					if (isRejection(advertisement)) return forbiddenResponse(advertisement);
					authorizedFetchSet = buildAuthorizedFetchSet(advertisement);
				}

				const body = await readRequestBody(request, fetchLimits);

				if (isProtocolV2(request)) {
					const command = parseV2CommandRequest(body);
					const contentType = "application/x-git-upload-pack-result";

					if (command.command === "ls-refs") {
						const result = await handleLsRefs(
							resolved.repo,
							resolved.repoId,
							command.args,
							hooks,
							auth,
						);
						if (isRejection(result)) return forbiddenResponse(result);
						return new Response(result, { headers: { "Content-Type": contentType } });
					}

					if (command.command === "fetch") {
						const responseBody = await handleV2Fetch(resolved.repo, command.args, {
							cache: packCache,
							cacheKey: resolved.repoId,
							noDelta: packOptions?.noDelta,
							deltaWindow: packOptions?.deltaWindow,
							authorizedFetchSet,
						});
						if (isRejection(responseBody)) return forbiddenResponse(responseBody);
						return new Response(responseBody, {
							headers: { "Content-Type": contentType },
						});
					}

					return new Response(`unknown command: ${command.command}`, { status: 400 });
				}

				const responseBody = await handleUploadPack(resolved.repo, body, {
					cache: packCache,
					cacheKey: resolved.repoId,
					noDelta: packOptions?.noDelta,
					deltaWindow: packOptions?.deltaWindow,
					authorizedFetchSet,
				});
				if (isRejection(responseBody)) return forbiddenResponse(responseBody);
				return new Response(responseBody, {
					headers: { "Content-Type": "application/x-git-upload-pack-result" },
				});
			}

			if (pathname.endsWith("/git-receive-pack") && request.method === "POST") {
				const requestPath = extractRepoPath(pathname, "/git-receive-pack");
				const resolved = await resolveRepo(requestPath);
				if (!resolved) return new Response("Not Found", { status: 404 });

				if (hooks?.advertiseRefs) {
					const advertisement = await advertiseRefsWithHooks(
						resolved.repo,
						resolved.repoId,
						"git-receive-pack",
						hooks,
						auth,
					);
					if (isRejection(advertisement)) return forbiddenResponse(advertisement);
				}

				const requestStream = openLimitedRequestBody(request, receiveLimits);
				const streamReader = new StreamPktLineReader(requestStream);
				let ingestResult;
				try {
					const { commands, capabilities, sawFlush } = await readReceivePackCommands(streamReader);
					ingestResult = await ingestReceivePackFromStream(
						resolved.repo,
						commands,
						capabilities,
						streamReader.streamRemaining(),
						sawFlush,
						receiveLimits,
						true,
					);
				} finally {
					streamReader.release();
				}

				if (!ingestResult.sawFlush && ingestResult.updates.length === 0) {
					return new Response("Bad Request", { status: 400 });
				}

				const useSideband = ingestResult.capabilities.includes("side-band-64k");
				const useReportStatus = ingestResult.capabilities.includes("report-status");

				if (!ingestResult.unpackOk) {
					if (useReportStatus) {
						const refResults = ingestResult.updates.map((update) => ({
							name: update.ref,
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

				const { refResults, applied } = await applyReceivePack({
					repo: resolved.repo,
					repoId: resolved.repoId,
					ingestResult,
					hooks,
					auth,
				});
				onRefApplied?.(resolved.repoId, resolved.repo, applied, auth);

				if (useReportStatus) {
					const reportResults = refResults.map((result) => ({
						name: result.ref,
						ok: result.ok,
						error: result.error,
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
		} catch (error) {
			if (error instanceof RequestLimitError) {
				return new Response(error.message, { status: error.status });
			}
			onError?.(error, auth);
			return new Response("Internal Server Error", { status: 500 });
		} finally {
			leave();
		}
	};
}

function forbiddenResponse(rejection: Rejection): Response {
	return new Response(rejection.message ?? "Forbidden", { status: 403 });
}

function isProtocolV2(request: Request): boolean {
	const protocol = request.headers.get("git-protocol");
	return protocol !== null && protocol.includes("version=2");
}

function extractRepoPath(pathname: string, suffix: string): string {
	let repoPath = pathname.slice(0, -suffix.length);
	if (repoPath.startsWith("/")) {
		repoPath = repoPath.slice(1);
	}
	return repoPath;
}

async function readRequestBody(
	request: Request,
	limits: {
		maxRequestBytes?: number;
		maxInflatedBytes?: number;
	},
): Promise<Uint8Array> {
	assertContentLength(request, limits.maxRequestBytes);

	const raw = await readStreamWithMax(
		request.body,
		limits.maxRequestBytes,
		"Request body too large",
	);
	const encoding = request.headers.get("content-encoding");
	if (encoding === "gzip" || encoding === "x-gzip") {
		const decompressor = new DecompressionStream("gzip");
		const copy = new Uint8Array(raw.byteLength);
		copy.set(raw);
		const pump = (async () => {
			const writer = decompressor.writable.getWriter();
			try {
				await writer.write(copy);
				await writer.close();
			} catch {
				// The reader may abort after crossing maxInflatedBytes.
			}
		})();
		const inflated = await readStreamWithMax(
			decompressor.readable,
			limits.maxInflatedBytes,
			"Decompressed body too large",
		);
		await pump;
		return inflated;
	}
	return raw;
}

function openLimitedRequestBody(
	request: Request,
	limits: {
		maxRequestBytes?: number;
		maxInflatedBytes?: number;
	},
): ReadableStream<Uint8Array> {
	assertContentLength(request, limits.maxRequestBytes);

	let stream = request.body ?? emptyByteStream();
	stream = limitByteStream(stream, limits.maxRequestBytes, "Request body too large");

	const encoding = request.headers.get("content-encoding");
	if (encoding === "gzip" || encoding === "x-gzip") {
		stream = stream.pipeThrough(new DecompressionStream("gzip"));
		stream = limitByteStream(stream, limits.maxInflatedBytes, "Decompressed body too large");
	}

	return stream;
}

function assertContentLength(request: Request, maxBytes: number | undefined): void {
	const contentLength = request.headers.get("content-length");
	if (!contentLength) return;
	const parsed = Number(contentLength);
	if (Number.isFinite(parsed) && maxBytes !== undefined && parsed > maxBytes) {
		throw new RequestLimitError("Request body too large");
	}
}

function limitByteStream(
	stream: ReadableStream<Uint8Array>,
	maxBytes: number | undefined,
	errorMessage: string,
): ReadableStream<Uint8Array> {
	if (maxBytes === undefined) return stream;
	let totalBytes = 0;
	return stream.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				totalBytes += chunk.byteLength;
				if (totalBytes > maxBytes) {
					throw new RequestLimitError(errorMessage);
				}
				controller.enqueue(chunk);
			},
		}),
	);
}

function emptyByteStream(): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.close();
		},
	});
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
				await reader.cancel(new RequestLimitError(errorMessage)).catch(() => {});
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
