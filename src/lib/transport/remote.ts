import { readConfig } from "../config.ts";
import { findRepo } from "../repo.ts";
import type { GitContext, GitRepo, RemoteResolver } from "../types.ts";
import type {
	CredentialProvider,
	FetchFunction,
	NetworkPolicy,
	ProgressCallback,
} from "../../hooks.ts";
import { type HttpAuth, LocalTransport, SmartHttpTransport, type Transport } from "./transport.ts";

export type CredentialCache = Map<string, HttpAuth>;

/**
 * Transport-layer environment: the subset of {@link GitContext} needed to open
 * a transport for a URL. A `GitContext` satisfies this structurally, and so
 * does a plain `GitRepo` augmented with these fields — letting the programmatic
 * network functions open transports without a filesystem-backed context.
 */
export interface TransportEnv {
	credentialProvider?: CredentialProvider;
	fetchFn?: FetchFunction;
	networkPolicy?: NetworkPolicy | false;
	resolveRemote?: RemoteResolver;
	credentialCache?: CredentialCache;
	onProgress?: ProgressCallback;
}

function toCredentialProvider(c?: HttpAuth | CredentialProvider): CredentialProvider | undefined {
	if (!c) return undefined;
	return typeof c === "function" ? c : () => c;
}

/**
 * Derive the transport-layer environment from a handle's attached
 * `capabilities` (`network`, `credentials`, `resolveRemote`, `onProgress`) and
 * return the handle augmented with it — the single adapter both the CLI command
 * layer and the programmatic SDK use to open a transport from `repo.capabilities`.
 *
 * The `credentialCache` is runtime state, not a capability, so it is injected
 * separately: the CLI passes its instance-scoped cache (so credentials stripped
 * from a URL by `remote add` / `clone` survive to a later `fetch` / `push`),
 * while the SDK gets a fresh per-call cache by default.
 *
 * Interim shape: this whole `TransportEnv` is slated to fold into the
 * `transport` resolver in a later phase; the adapter is the seam that change
 * rides inside.
 */
export function withTransportEnv(
	repo: GitRepo,
	credentialCache: CredentialCache = new Map(),
): GitRepo & TransportEnv {
	const caps = repo.capabilities;
	const policy = caps?.network;
	// Mirror createGit: a NetworkPolicy object may carry the fetch function.
	const fetchFn = policy && typeof policy === "object" ? policy.fetch : undefined;
	return {
		...repo,
		credentialProvider: toCredentialProvider(caps?.credentials),
		fetchFn,
		networkPolicy: policy,
		resolveRemote: caps?.resolveRemote,
		onProgress: caps?.onProgress,
		credentialCache,
	};
}

interface ParsedRemoteUrl {
	url: string;
	embeddedAuth?: HttpAuth;
}

export function parseRemoteUrl(raw: string): ParsedRemoteUrl {
	if (!isHttpUrl(raw)) return { url: raw };
	try {
		const parsed = new URL(raw);
		if (!parsed.username && !parsed.password) return { url: raw };
		const auth: HttpAuth = {
			type: "basic",
			username: decodeURIComponent(parsed.username),
			password: decodeURIComponent(parsed.password),
		};
		parsed.username = "";
		parsed.password = "";
		return { url: parsed.href, embeddedAuth: auth };
	} catch {
		return { url: raw };
	}
}

/**
 * Strip embedded credentials from a URL and cache them by origin.
 * Returns the sanitized URL.
 */
export function stripAndCacheCredentials(
	raw: string,
	cache: CredentialCache | undefined,
): ParsedRemoteUrl {
	const parsed = parseRemoteUrl(raw);
	if (parsed.embeddedAuth && cache) {
		try {
			cache.set(new URL(parsed.url).origin, parsed.embeddedAuth);
		} catch {
			// malformed URL — skip caching
		}
	}
	return parsed;
}

interface RemoteConfig {
	name: string;
	url: string;
	fetchRefspec: string;
}

/**
 * Resolve a remote name to its config (url + fetch refspec).
 * Reads from `.git/config` section `[remote "<name>"]`.
 */
async function getRemoteConfig(ctx: GitContext, remoteName: string): Promise<RemoteConfig | null> {
	const config = await readConfig(ctx);
	const section = config[`remote "${remoteName}"`];
	if (!section?.url) return null;

	return {
		name: remoteName,
		url: section.url,
		fetchRefspec: section.fetch ?? "+refs/heads/*:refs/remotes/origin/*",
	};
}

function isHttpUrl(url: string): boolean {
	return url.startsWith("http://") || url.startsWith("https://");
}

function isSshUrl(url: string): boolean {
	return url.startsWith("ssh://") || url.startsWith("git@") || url.startsWith("git+ssh://");
}

/**
 * Check a URL against a network policy. Returns null if allowed,
 * or an error message string if blocked.
 */
export function validateNetworkAccess(url: string, policy?: NetworkPolicy | false): string | null {
	if (policy === undefined) return null;
	if (policy === false) return "network access is disabled";
	if (!policy.allowed) return null;
	if (policy.allowed.length === 0) return "network access is disabled";

	let hostname: string;
	try {
		hostname = new URL(url).hostname;
	} catch {
		return `network policy: access to '${url}' is not allowed`;
	}

	for (const entry of policy.allowed) {
		if (isHttpUrl(entry)) {
			if (url === entry || url.startsWith(entry)) return null;
		} else {
			if (hostname === entry) return null;
		}
	}

	return `network policy: access to '${url}' is not allowed`;
}

function resolveAuth(env: Map<string, string>): HttpAuth | undefined {
	const bearer = env.get("GIT_HTTP_BEARER_TOKEN");
	if (bearer) return { type: "bearer", token: bearer };

	const user = env.get("GIT_HTTP_USER");
	const pass = env.get("GIT_HTTP_PASSWORD");
	if (user && pass) return { type: "basic", username: user, password: pass };

	return undefined;
}

/**
 * Resolve auth for a URL. Priority: credential provider > env vars > credential cache.
 */
async function resolveAuthForUrl(
	ctx: TransportEnv,
	url: string,
	env: Map<string, string>,
): Promise<HttpAuth | undefined> {
	if (ctx.credentialProvider) {
		const auth = await ctx.credentialProvider(url);
		if (auth) return auth;
	}
	const envAuth = resolveAuth(env);
	if (envAuth) return envAuth;
	if (ctx.credentialCache) {
		try {
			return ctx.credentialCache.get(new URL(url).origin);
		} catch {
			return undefined;
		}
	}
	return undefined;
}

/**
 * Create a transport for a URL. Supports local paths and HTTP(S) URLs.
 * Strips embedded credentials from HTTP URLs, caching them for reuse.
 */
export async function createTransportForUrl(
	ctx: GitRepo & TransportEnv,
	url: string,
	env: Map<string, string>,
	remoteRepo?: GitRepo,
): Promise<Transport> {
	const cleanUrl = stripAndCacheCredentials(url, ctx.credentialCache).url;

	if (isHttpUrl(cleanUrl)) {
		const networkErr = validateNetworkAccess(cleanUrl, ctx.networkPolicy);
		if (networkErr) throw new Error(networkErr);
		const auth = await resolveAuthForUrl(ctx, cleanUrl, env);
		return new SmartHttpTransport(ctx, cleanUrl, auth, ctx.fetchFn, ctx.onProgress);
	}
	if (!remoteRepo && ctx.resolveRemote) {
		remoteRepo = (await ctx.resolveRemote(cleanUrl)) ?? undefined;
	}
	if (!remoteRepo) {
		if (isSshUrl(cleanUrl)) {
			throw new Error(`SSH transport is not supported. Use an HTTPS URL instead of '${cleanUrl}'.`);
		}
		throw new Error(`'${cleanUrl}' does not appear to be a git repository`);
	}
	return new LocalTransport(ctx, remoteRepo);
}

/**
 * Resolve a remote name to a Transport instance.
 * Supports local paths and HTTP(S) URLs.
 * Strips embedded credentials from HTTP URLs, caching them for reuse.
 */
export async function resolveRemoteTransport(
	ctx: GitContext,
	remoteName: string,
	env?: Map<string, string>,
	credentialCache?: CredentialCache,
): Promise<{ transport: Transport; config: RemoteConfig } | null> {
	const remote = await getRemoteConfig(ctx, remoteName);
	if (!remote) return null;

	const tctx = withTransportEnv(ctx, credentialCache);
	const cleanUrl = stripAndCacheCredentials(remote.url, tctx.credentialCache).url;

	if (isHttpUrl(cleanUrl)) {
		const networkErr = validateNetworkAccess(cleanUrl, tctx.networkPolicy);
		if (networkErr) throw new Error(networkErr);
		const auth = env ? await resolveAuthForUrl(tctx, cleanUrl, env) : undefined;
		return {
			transport: new SmartHttpTransport(ctx, cleanUrl, auth, tctx.fetchFn, tctx.onProgress),
			config: { ...remote, url: cleanUrl },
		};
	}

	const remoteRepo: GitRepo | null =
		(tctx.resolveRemote ? await tctx.resolveRemote(cleanUrl) : null) ??
		(await findRepo(ctx.fs, cleanUrl));
	if (!remoteRepo) {
		if (isSshUrl(cleanUrl)) {
			throw new Error(`SSH transport is not supported. Use an HTTPS URL instead of '${cleanUrl}'.`);
		}
		return null;
	}

	return {
		transport: new LocalTransport(ctx, remoteRepo),
		config: { ...remote, url: cleanUrl },
	};
}
