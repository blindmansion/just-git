import { readConfig } from "../config.ts";
import { findRepo } from "../repo.ts";
import type { GitContext, GitRepo } from "../types.ts";
import type { NetworkPolicy } from "../../hooks.ts";
import { type HttpAuth, LocalTransport, SmartHttpTransport, type Transport } from "./transport.ts";

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
 * Resolve auth for a URL. Checks the operator-provided credential provider
 * on GitContext first, then falls back to env vars.
 */
async function resolveAuthForUrl(
	ctx: GitContext,
	url: string,
	env: Map<string, string>,
): Promise<HttpAuth | undefined> {
	if (ctx.credentialProvider) {
		const auth = await ctx.credentialProvider(url);
		if (auth) return auth;
	}
	return resolveAuth(env);
}

/**
 * Create a transport for a URL. Supports local paths and HTTP(S) URLs.
 */
export async function createTransportForUrl(
	ctx: GitContext,
	url: string,
	env: Map<string, string>,
	remoteRepo?: GitRepo,
): Promise<Transport> {
	if (isHttpUrl(url)) {
		const networkErr = validateNetworkAccess(url, ctx.networkPolicy);
		if (networkErr) throw new Error(networkErr);
		const auth = await resolveAuthForUrl(ctx, url, env);
		return new SmartHttpTransport(ctx, url, auth, ctx.fetchFn);
	}
	if (!remoteRepo && ctx.resolveRemote) {
		remoteRepo = (await ctx.resolveRemote(url)) ?? undefined;
	}
	if (!remoteRepo) {
		if (isSshUrl(url)) {
			throw new Error(`SSH transport is not supported. Use an HTTPS URL instead of '${url}'.`);
		}
		throw new Error(`'${url}' does not appear to be a git repository`);
	}
	return new LocalTransport(ctx, remoteRepo);
}

/**
 * Resolve a remote name to a Transport instance.
 * Supports local paths and HTTP(S) URLs.
 */
export async function resolveRemoteTransport(
	ctx: GitContext,
	remoteName: string,
	env?: Map<string, string>,
): Promise<{ transport: Transport; config: RemoteConfig } | null> {
	const remote = await getRemoteConfig(ctx, remoteName);
	if (!remote) return null;

	if (isHttpUrl(remote.url)) {
		const networkErr = validateNetworkAccess(remote.url, ctx.networkPolicy);
		if (networkErr) throw new Error(networkErr);
		const auth = env ? await resolveAuthForUrl(ctx, remote.url, env) : undefined;
		return {
			transport: new SmartHttpTransport(ctx, remote.url, auth, ctx.fetchFn),
			config: remote,
		};
	}

	const remoteRepo: GitRepo | null =
		(ctx.resolveRemote ? await ctx.resolveRemote(remote.url) : null) ??
		(await findRepo(ctx.fs, remote.url));
	if (!remoteRepo) {
		if (isSshUrl(remote.url)) {
			throw new Error(
				`SSH transport is not supported. Use an HTTPS URL instead of '${remote.url}'.`,
			);
		}
		return null;
	}

	return {
		transport: new LocalTransport(ctx, remoteRepo),
		config: remote,
	};
}
