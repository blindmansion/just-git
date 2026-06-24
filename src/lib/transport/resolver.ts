import type { FileSystem } from "../../fs.ts";
import type { CredentialProvider, FetchFunction } from "../../hooks.ts";
import { buildCapabilityContext } from "../config.ts";
import { findRepo } from "../repo.ts";
import type {
	GitContext,
	GitOperation,
	GitRepo,
	RepoCapabilities,
	TransportResolver,
} from "../types.ts";
import {
	authHeaders,
	type CredentialCache,
	getRemoteConfig,
	isHttpUrl,
	isSshUrl,
	parseRemoteUrl,
	type RemoteConfig,
	resolveAuth,
	stripAndCacheCredentials,
	validateNetworkAccess,
} from "./remote.ts";
import { LocalTransport, SmartHttpTransport, type HttpAuth, type Transport } from "./transport.ts";

/** Wrap a fetch so every request carries the resolved `Authorization` header. */
function withAuthHeader(auth: HttpAuth, next: FetchFunction): FetchFunction {
	const headers = authHeaders(auth);
	return (input, init) =>
		next(input, {
			...init,
			headers: { ...(init?.headers as Record<string, string> | undefined), ...headers },
		});
}

/**
 * Resolve HTTP auth for a URL, in git's precedence order:
 * credential provider → `GIT_HTTP_*` env vars → instance credential cache.
 */
async function resolveAuthForUrl(
	credentials: HttpAuth | CredentialProvider | undefined,
	env: ReadonlyMap<string, string> | undefined,
	cache: CredentialCache | undefined,
	url: string,
): Promise<HttpAuth | undefined> {
	if (credentials) {
		const provider = typeof credentials === "function" ? credentials : () => credentials;
		const auth = await provider(url);
		if (auth) return auth;
	}
	if (env) {
		const envAuth = resolveAuth(env);
		if (envAuth) return envAuth;
	}
	if (cache) {
		try {
			return cache.get(new URL(url).origin);
		} catch {
			return undefined;
		}
	}
	return undefined;
}

/**
 * The git-faithful built-in transport resolver, synthesized from a handle's
 * interim network capabilities (`network` / `credentials` / `resolveRemote`)
 * plus the instance credential cache. Used whenever a handle has no explicit
 * `capabilities.transport`. Returns `null` for non-HTTP URLs it cannot resolve
 * in-process, letting the caller fall back to filesystem repo discovery.
 */
export function makeDefaultTransport(
	caps: RepoCapabilities | undefined,
	cache: CredentialCache | undefined,
): TransportResolver {
	return async (ctx) => {
		const url = ctx.url;
		if (!url) return null;

		if (isHttpUrl(url)) {
			const policy = caps?.network;
			const networkErr = validateNetworkAccess(url, policy);
			if (networkErr) throw new Error(networkErr);
			const auth = await resolveAuthForUrl(caps?.credentials, ctx.env, cache, url);
			const baseFetch: FetchFunction =
				(policy && typeof policy === "object" ? policy.fetch : undefined) ?? globalThis.fetch;
			return { kind: "http", fetch: auth ? withAuthHeader(auth, baseFetch) : baseFetch };
		}

		if (caps?.resolveRemote) {
			const repo = await caps.resolveRemote(url);
			if (repo) return { kind: "repo", repo };
		}
		return null;
	};
}

interface OpenTransportOptions {
	env?: ReadonlyMap<string, string>;
	/** Pre-resolved in-process remote (e.g. a local clone source). */
	remoteRepo?: GitRepo;
	/** Instance credential cache; a fresh per-call map is used when omitted. */
	credentialCache?: CredentialCache;
	/** Filesystem for local-path repo discovery (CLI only). */
	fs?: FileSystem;
}

/**
 * Open a {@link Transport} for a URL via the handle's `capabilities.transport`
 * resolver (or the built-in default). HTTP targets become a
 * {@link SmartHttpTransport} over the resolver-provided fetch; in-process
 * targets become a {@link LocalTransport}. Returns `null` only on the CLI path
 * (when `fs` is given) for a non-HTTP URL that resolves to no repository.
 */
export async function openTransport(
	handle: GitRepo,
	operation: GitOperation,
	rawUrl: string,
	options?: OpenTransportOptions,
): Promise<Transport | null> {
	const { env, remoteRepo, fs } = options ?? {};
	const cache = options?.credentialCache ?? new Map<string, HttpAuth>();
	stripAndCacheCredentials(rawUrl, cache);
	const cleanUrl = parseRemoteUrl(rawUrl).url;

	if (remoteRepo) return new LocalTransport(handle, remoteRepo);

	const resolver =
		handle.capabilities?.transport ?? makeDefaultTransport(handle.capabilities, cache);
	const ctx = await buildCapabilityContext(handle, operation, { env, url: cleanUrl });
	const target = await resolver(ctx);
	if (target) {
		return target.kind === "http"
			? new SmartHttpTransport(handle, cleanUrl, target.fetch, handle.capabilities?.onProgress)
			: new LocalTransport(handle, target.repo);
	}

	if (fs) {
		const found = await findRepo(fs, cleanUrl);
		if (found) return new LocalTransport(handle, found);
	}
	if (isSshUrl(cleanUrl)) {
		throw new Error(`SSH transport is not supported. Use an HTTPS URL instead of '${cleanUrl}'.`);
	}
	if (fs) return null;
	throw new Error(`'${cleanUrl}' does not appear to be a git repository`);
}

/**
 * Open a transport for a URL, asserting a non-null result. For the SDK and
 * clone paths where local repos are pre-resolved (passed as `remoteRepo`) or
 * the URL is HTTP, so filesystem fallback never applies.
 */
export async function createTransportForUrl(
	handle: GitRepo,
	operation: GitOperation,
	rawUrl: string,
	options?: OpenTransportOptions,
): Promise<Transport> {
	const transport = await openTransport(handle, operation, rawUrl, options);
	if (!transport) {
		throw new Error(`'${parseRemoteUrl(rawUrl).url}' does not appear to be a git repository`);
	}
	return transport;
}

/**
 * Resolve a configured remote name to a Transport instance plus its resolved
 * config (url + fetch refspec). Returns `null` when the remote is unknown or a
 * non-HTTP URL resolves to no repository on disk.
 */
export async function resolveRemoteTransport(
	ctx: GitContext,
	remoteName: string,
	operation: GitOperation,
	env?: Map<string, string>,
	credentialCache?: CredentialCache,
): Promise<{ transport: Transport; config: RemoteConfig } | null> {
	const remote = await getRemoteConfig(ctx, remoteName);
	if (!remote) return null;

	const cleanUrl = parseRemoteUrl(remote.url).url;
	const transport = await openTransport(ctx, operation, remote.url, {
		env,
		credentialCache,
		fs: ctx.fs,
	});
	if (!transport) return null;

	return { transport, config: { ...remote, url: cleanUrl } };
}
