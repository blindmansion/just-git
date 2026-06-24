// Public transport builders — compose the network behavior of a
// `capabilities.transport` resolver from small, separately-testable pieces.
// The core never sees policy/auth/retry directly: it only calls the resolver
// these utilities produce and uses the `TransportTarget` it returns.

import type { CredentialProvider, FetchFunction, NetworkPolicy } from "./hooks.ts";
import type { GitRepo, TransportResolver } from "./lib/types.ts";
import { authHeaders, isHttpUrl, validateNetworkAccess } from "./lib/transport/remote.ts";
import type { HttpAuth } from "./lib/transport/transport.ts";

/** A fetch wrapper: takes the next fetch in the chain and returns a new fetch. */
export type FetchWrapper = (next: FetchFunction) => FetchFunction;

function urlOf(input: string | URL | Request): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.href;
	return input.url;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Restrict which hosts the returned fetch may reach. Matches a bare hostname
 * (`github.com`) or a URL prefix (`https://github.com/org/`); a disallowed URL
 * throws before any request is made.
 */
export function allowlist(hosts: string[]): FetchWrapper {
	const policy: NetworkPolicy = { allowed: hosts };
	return (next) => async (input, init) => {
		const err = validateNetworkAccess(urlOf(input), policy);
		if (err) throw new Error(err);
		return next(input, init);
	};
}

/**
 * Inject an `Authorization` header. Accepts static {@link HttpAuth} or a
 * per-URL {@link CredentialProvider} (resolved against each request's URL).
 */
export function withAuth(provider: HttpAuth | CredentialProvider): FetchWrapper {
	const resolve: CredentialProvider = typeof provider === "function" ? provider : () => provider;
	return (next) => async (input, init) => {
		const auth = await resolve(urlOf(input));
		if (!auth) return next(input, init);
		return next(input, {
			...init,
			headers: { ...(init?.headers as Record<string, string> | undefined), ...authHeaders(auth) },
		});
	};
}

/**
 * Retry transient failures (thrown errors and `>= 500` responses) with
 * exponential backoff. Auth failures (`401`/`403`) are not retried.
 */
export function withRetry(policy?: { maxAttempts?: number; backoffMs?: number }): FetchWrapper {
	const maxAttempts = policy?.maxAttempts ?? 3;
	const backoffMs = policy?.backoffMs ?? 100;
	return (next) => async (input, init) => {
		let lastError: unknown;
		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			try {
				const res = await next(input, init);
				if (res.status >= 500 && attempt < maxAttempts - 1) {
					await delay(backoffMs * 2 ** attempt);
					continue;
				}
				return res;
			} catch (err) {
				lastError = err;
				if (attempt < maxAttempts - 1) await delay(backoffMs * 2 ** attempt);
			}
		}
		throw lastError;
	};
}

/**
 * Compose fetch wrappers around a base fetch. The first wrapper is outermost:
 * `pipe(allowlist(...), withAuth(...))(base)` checks the allowlist, then adds
 * auth, then calls `base`.
 */
export function pipe(...wrappers: FetchWrapper[]): (base: FetchFunction) => FetchFunction {
	return (base) => wrappers.reduceRight((acc, wrapper) => wrapper(acc), base);
}

/**
 * Declarative sugar that builds a {@link TransportResolver} from familiar
 * options, so the common case stays a one-liner. Composes
 * `allowlist`/`withAuth`/`withRetry` over a base fetch and optionally resolves
 * non-HTTP URLs to an in-process repo.
 */
export function httpTransport(opts?: {
	/** Allowed hostnames / URL prefixes. Absent = allow any; `false` blocks all. */
	allowed?: string[] | false;
	credentials?: HttpAuth | CredentialProvider;
	retry?: { maxAttempts?: number; backoffMs?: number };
	/** Base fetch; defaults to `globalThis.fetch`. */
	fetch?: FetchFunction;
	/** Resolve non-HTTP URLs to an in-process repo (cross-VFS). */
	resolveInProcess?: (url: string) => GitRepo | null | Promise<GitRepo | null>;
}): TransportResolver {
	const base = opts?.fetch ?? globalThis.fetch;
	const wrappers: FetchWrapper[] = [];
	if (opts?.allowed === false) {
		wrappers.push(() => async () => {
			throw new Error("network access is disabled");
		});
	} else if (opts?.allowed) {
		wrappers.push(allowlist(opts.allowed));
	}
	if (opts?.credentials) wrappers.push(withAuth(opts.credentials));
	if (opts?.retry) wrappers.push(withRetry(opts.retry));
	const fetchFn = pipe(...wrappers)(base);

	const resolveInProcess = opts?.resolveInProcess;
	return async (ctx) => {
		const url = ctx.url;
		if (!url) return null;
		if (!isHttpUrl(url)) {
			if (resolveInProcess) {
				const repo = await resolveInProcess(url);
				if (repo) return { kind: "repo", repo };
			}
			return null;
		}
		return { kind: "http", fetch: fetchFn };
	};
}
