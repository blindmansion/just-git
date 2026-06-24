import { readConfig } from "../config.ts";
import type { GitContext } from "../types.ts";
import type { CredentialStore, NetworkPolicy } from "../../hooks.ts";
import type { HttpAuth } from "./transport.ts";

/** Render an {@link HttpAuth} as the HTTP `Authorization` header(s). */
export function authHeaders(auth?: HttpAuth): Record<string, string> {
	if (!auth) return {};
	if (auth.type === "bearer") {
		return { Authorization: `Bearer ${auth.token}` };
	}
	const encoded = btoa(`${auth.username}:${auth.password}`);
	return { Authorization: `Basic ${encoded}` };
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
 * Strip embedded credentials from a URL and remember them by origin in the
 * given {@link CredentialStore}. Returns the sanitized URL.
 */
export async function stripAndCacheCredentials(
	raw: string,
	store: CredentialStore | undefined,
): Promise<ParsedRemoteUrl> {
	const parsed = parseRemoteUrl(raw);
	if (parsed.embeddedAuth && store) {
		try {
			await store.remember(new URL(parsed.url).origin, parsed.embeddedAuth);
		} catch {
			// malformed URL — skip caching
		}
	}
	return parsed;
}

export interface RemoteConfig {
	name: string;
	url: string;
	fetchRefspec: string;
}

/**
 * Resolve a remote name to its config (url + fetch refspec).
 * Reads from `.git/config` section `[remote "<name>"]`.
 */
export async function getRemoteConfig(
	ctx: GitContext,
	remoteName: string,
): Promise<RemoteConfig | null> {
	const config = await readConfig(ctx);
	const section = config[`remote "${remoteName}"`];
	if (!section?.url) return null;

	return {
		name: remoteName,
		url: section.url,
		fetchRefspec: section.fetch ?? "+refs/heads/*:refs/remotes/origin/*",
	};
}

export function isHttpUrl(url: string): boolean {
	return url.startsWith("http://") || url.startsWith("https://");
}

export function isSshUrl(url: string): boolean {
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

/** Resolve HTTP auth from git's env vars (`GIT_HTTP_BEARER_TOKEN` / `GIT_HTTP_USER`+`_PASSWORD`). */
export function resolveAuth(env: ReadonlyMap<string, string>): HttpAuth | undefined {
	const bearer = env.get("GIT_HTTP_BEARER_TOKEN");
	if (bearer) return { type: "bearer", token: bearer };

	const user = env.get("GIT_HTTP_USER");
	const pass = env.get("GIT_HTTP_PASSWORD");
	if (user && pass) return { type: "basic", username: user, password: pass };

	return undefined;
}

export type { HttpAuth } from "./transport.ts";
