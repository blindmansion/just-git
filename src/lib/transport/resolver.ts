import type { FileSystem } from "../../fs.ts";
import {
	type CredentialProvider,
	type CredentialStore,
	createMemoryCredentialStore,
	type FetchFunction,
	type NetworkPolicy,
} from "../../hooks.ts";
import { buildCapabilityContext, makeConfigView } from "../config.ts";
import { findRepo } from "../repo.ts";
import type {
	ConfigView,
	GitContext,
	GitOperation,
	GitRepo,
	ObjectStore,
	RefStore,
	RemoteResolver,
	RepoCapabilities,
	TransportResolver,
} from "../types.ts";
import {
	authHeaders,
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

/**
 * Decide which wire-protocol version the client should *request* on discovery.
 *
 * Precedence mirrors git: the `GIT_PROTOCOL` env var (e.g. `version=2`) wins,
 * then `protocol.version` config. Defaults to v2 — discovery falls back to v1
 * transparently when the server declines, so this is safe to leave on.
 */
function resolveProtocolPreference(config: ConfigView, env?: ReadonlyMap<string, string>): 1 | 2 {
	const envProto = env?.get("GIT_PROTOCOL");
	if (envProto) {
		if (/(^|[:\s])version=2($|[:\s])/.test(envProto)) return 2;
		if (/(^|[:\s])version=[01]($|[:\s])/.test(envProto)) return 1;
	}
	const configVersion = config.get("protocol.version");
	if (configVersion === "2") return 2;
	if (configVersion === "1" || configVersion === "0") return 1;
	return 2;
}

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
 * credential provider → `GIT_HTTP_*` env vars → instance credential store.
 */
async function resolveAuthForUrl(
	credentials: HttpAuth | CredentialProvider | undefined,
	env: ReadonlyMap<string, string> | undefined,
	store: CredentialStore | undefined,
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
	if (store) {
		let origin: string;
		try {
			origin = new URL(url).origin;
		} catch {
			return undefined;
		}
		return (await store.get(origin)) ?? undefined;
	}
	return undefined;
}

/**
 * Inputs to the git-faithful default transport — the ergonomic
 * `createGit` network options, compiled into a {@link TransportResolver}. This
 * is the single adapter from the old `network` / `credentials` / `resolveRemote`
 * fields to the unified `transport` seam; an empty config yields the bare
 * git-native default (env auth + URL-embedded credentials, allow-all network).
 */
export interface DefaultTransportConfig {
	credentials?: HttpAuth | CredentialProvider;
	network?: NetworkPolicy | false;
	resolveRemote?: RemoteResolver;
}

/**
 * Build the git-faithful built-in transport resolver from the {@link
 * DefaultTransportConfig} plus the instance credential store. Used whenever a
 * handle has no explicit `capabilities.transport`. Returns `null` for non-HTTP
 * URLs it cannot resolve in-process, letting the caller fall back to filesystem
 * repo discovery.
 */
export function makeDefaultTransport(
	config: DefaultTransportConfig,
	store: CredentialStore | undefined,
): TransportResolver {
	return async (ctx) => {
		const url = ctx.url;
		if (!url) return null;

		if (isHttpUrl(url)) {
			const policy = config.network;
			const networkErr = validateNetworkAccess(url, policy);
			if (networkErr) throw new Error(networkErr);
			const auth = await resolveAuthForUrl(config.credentials, ctx.env, store, url);
			const baseFetch: FetchFunction =
				(policy && typeof policy === "object" ? policy.fetch : undefined) ?? globalThis.fetch;
			return { kind: "http", fetch: auth ? withAuthHeader(auth, baseFetch) : baseFetch };
		}

		if (config.resolveRemote) {
			const repo = await config.resolveRemote(url);
			if (repo) return { kind: "repo", repo };
		}
		return null;
	};
}

/** A handle-less placeholder repo for resolver calls that only read `ctx.url`. */
const NO_REPO = {
	objectStore: undefined as unknown as ObjectStore,
	refStore: undefined as unknown as RefStore,
};

/**
 * Resolve a non-HTTP URL to an in-process {@link GitRepo} via a handle's
 * `transport` resolver (the unified home of the old `resolveRemote`). Used by
 * `clone` for its pre-init source check; returns `null` when the resolver is
 * absent or yields no in-process repo, so the caller falls back to filesystem
 * discovery.
 */
export async function resolveInProcessRemote(
	capabilities: RepoCapabilities | undefined,
	url: string,
	env?: ReadonlyMap<string, string>,
): Promise<GitRepo | null> {
	const resolver = capabilities?.transport;
	if (!resolver) return null;
	const target = await resolver({
		operation: "clone",
		repo: NO_REPO,
		config: makeConfigView({}, capabilities.config),
		env,
		url,
	});
	return target?.kind === "repo" ? target.repo : null;
}

interface OpenTransportOptions {
	env?: ReadonlyMap<string, string>;
	/** Pre-resolved in-process remote (e.g. a local clone source). */
	remoteRepo?: GitRepo;
	/** Instance credential store; a fresh per-call store is used when omitted. */
	credentialStore?: CredentialStore;
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
	const store = options?.credentialStore ?? createMemoryCredentialStore();
	await stripAndCacheCredentials(rawUrl, store);
	const cleanUrl = parseRemoteUrl(rawUrl).url;

	if (remoteRepo) return new LocalTransport(handle, remoteRepo);

	const resolver = handle.capabilities?.transport ?? makeDefaultTransport({}, store);
	const ctx = await buildCapabilityContext(handle, operation, { env, url: cleanUrl });
	const target = await resolver(ctx);
	if (target) {
		return target.kind === "http"
			? new SmartHttpTransport(
					handle,
					cleanUrl,
					target.fetch,
					handle.capabilities?.onProgress,
					resolveProtocolPreference(ctx.config, env),
					handle.capabilities?.discoveryCache,
				)
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
	credentialStore?: CredentialStore,
): Promise<{ transport: Transport; config: RemoteConfig } | null> {
	const remote = await getRemoteConfig(ctx, remoteName);
	if (!remote) return null;

	const cleanUrl = parseRemoteUrl(remote.url).url;
	const transport = await openTransport(ctx, operation, remote.url, {
		env,
		credentialStore,
		fs: ctx.fs,
	});
	if (!transport) return null;

	return { transport, config: { ...remote, url: cleanUrl } };
}
