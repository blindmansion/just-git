import { describe, expect, test } from "bun:test";
import type { FetchFunction } from "../../src/hooks.ts";
import type { CapabilityContext } from "../../src/lib/types.ts";
import { allowlist, httpTransport, pipe, withAuth, withRetry } from "../../src/transport.ts";

function ok(): Response {
	return new Response("ok", { status: 200 });
}

/** A minimal CapabilityContext carrying just the url a resolver reads. */
function ctxFor(url: string): CapabilityContext {
	return {
		operation: "fetch",
		repo: { objectStore: {} as never, refStore: {} as never },
		config: { get: () => undefined, getAll: () => [] },
		url,
	};
}

describe("allowlist", () => {
	test("permits an allowed host and forwards the request", async () => {
		let called = false;
		const fetchFn = allowlist(["github.com"])((input) => {
			called = true;
			expect(String(input)).toBe("https://github.com/repo.git/info/refs");
			return Promise.resolve(ok());
		});
		const res = await fetchFn("https://github.com/repo.git/info/refs");
		expect(res.status).toBe(200);
		expect(called).toBe(true);
	});

	test("throws before fetching a disallowed host", async () => {
		const fetchFn = allowlist(["github.com"])(() => Promise.resolve(ok()));
		await expect(fetchFn("https://evil.com/x")).rejects.toThrow("not allowed");
	});
});

describe("withAuth", () => {
	test("adds a bearer Authorization header", async () => {
		const fetchFn = withAuth({ type: "bearer", token: "t0ken" })((_input, init) => {
			const headers = init?.headers as Record<string, string>;
			expect(headers.Authorization).toBe("Bearer t0ken");
			return Promise.resolve(ok());
		});
		await fetchFn("https://github.com/repo.git");
	});

	test("resolves a per-URL credential provider", async () => {
		const seen: string[] = [];
		const fetchFn = withAuth((url) => {
			seen.push(url);
			return { type: "basic", username: "u", password: "p" };
		})((_input, init) => {
			const headers = init?.headers as Record<string, string>;
			expect(headers.Authorization).toBe(`Basic ${btoa("u:p")}`);
			return Promise.resolve(ok());
		});
		await fetchFn("https://example.com/r");
		expect(seen).toEqual(["https://example.com/r"]);
	});

	test("passes through unchanged when the provider returns null", async () => {
		const fetchFn = withAuth(() => null)((_input, init) => {
			expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBeUndefined();
			return Promise.resolve(ok());
		});
		await fetchFn("https://example.com/r");
	});
});

describe("withRetry", () => {
	test("retries a 500 then succeeds", async () => {
		let attempts = 0;
		const fetchFn = withRetry({ maxAttempts: 3, backoffMs: 1 })(() => {
			attempts++;
			return Promise.resolve(
				attempts < 2 ? new Response("err", { status: 500 }) : new Response("ok", { status: 200 }),
			);
		});
		const res = await fetchFn("https://example.com/r");
		expect(res.status).toBe(200);
		expect(attempts).toBe(2);
	});

	test("does not retry a 401", async () => {
		let attempts = 0;
		const fetchFn = withRetry({ maxAttempts: 3, backoffMs: 1 })(() => {
			attempts++;
			return Promise.resolve(new Response("no", { status: 401 }));
		});
		const res = await fetchFn("https://example.com/r");
		expect(res.status).toBe(401);
		expect(attempts).toBe(1);
	});

	test("retries a 429 then succeeds", async () => {
		let attempts = 0;
		const fetchFn = withRetry({ maxAttempts: 3, backoffMs: 1 })(() => {
			attempts++;
			return Promise.resolve(
				attempts < 2 ? new Response("slow down", { status: 429 }) : new Response("ok"),
			);
		});
		const res = await fetchFn("https://example.com/r");
		expect(res.status).toBe(200);
		expect(attempts).toBe(2);
	});

	test("honors a numeric Retry-After header over the computed backoff", async () => {
		let attempts = 0;
		const start = Date.now();
		const fetchFn = withRetry({ maxAttempts: 2, backoffMs: 10_000 })(() => {
			attempts++;
			return Promise.resolve(
				attempts < 2
					? new Response("slow down", { status: 429, headers: { "Retry-After": "0" } })
					: new Response("ok"),
			);
		});
		const res = await fetchFn("https://example.com/r");
		expect(res.status).toBe(200);
		expect(attempts).toBe(2);
		// Retry-After: 0 wins, so we do not wait the 10s computed backoff.
		expect(Date.now() - start).toBeLessThan(1000);
	});

	test("does not retry a 404", async () => {
		let attempts = 0;
		const fetchFn = withRetry({ maxAttempts: 3, backoffMs: 1 })(() => {
			attempts++;
			return Promise.resolve(new Response("missing", { status: 404 }));
		});
		const res = await fetchFn("https://example.com/r");
		expect(res.status).toBe(404);
		expect(attempts).toBe(1);
	});

	test("retries thrown errors then rethrows the last", async () => {
		let attempts = 0;
		const fetchFn = withRetry({ maxAttempts: 2, backoffMs: 1 })(() => {
			attempts++;
			return Promise.reject(new Error("boom"));
		});
		await expect(fetchFn("https://example.com/r")).rejects.toThrow("boom");
		expect(attempts).toBe(2);
	});
});

describe("pipe", () => {
	test("applies the first wrapper outermost", async () => {
		const order: string[] = [];
		const a =
			(next: FetchFunction): FetchFunction =>
			(input, init) => {
				order.push("a");
				return next(input, init);
			};
		const b =
			(next: FetchFunction): FetchFunction =>
			(input, init) => {
				order.push("b");
				return next(input, init);
			};
		const fetchFn = pipe(
			a,
			b,
		)(() => {
			order.push("base");
			return Promise.resolve(ok());
		});
		await fetchFn("https://example.com");
		expect(order).toEqual(["a", "b", "base"]);
	});
});

describe("httpTransport", () => {
	test("returns an http target with the composed fetch for HTTP urls", async () => {
		const resolver = httpTransport({
			credentials: { type: "bearer", token: "abc" },
			fetch: (_input, init) => {
				const headers = init?.headers as Record<string, string>;
				expect(headers.Authorization).toBe("Bearer abc");
				return Promise.resolve(ok());
			},
		});
		const target = await resolver(ctxFor("https://github.com/r.git"));
		expect(target?.kind).toBe("http");
		if (target?.kind === "http") await target.fetch("https://github.com/r.git/info/refs");
	});

	test("blocks all hosts when allowed is false", async () => {
		const resolver = httpTransport({ allowed: false });
		const target = await resolver(ctxFor("https://github.com/r.git"));
		expect(target?.kind).toBe("http");
		if (target?.kind === "http") {
			await expect(target.fetch("https://github.com/r.git")).rejects.toThrow(
				"network access is disabled",
			);
		}
	});

	test("resolves non-HTTP urls in-process and defers when unresolved", async () => {
		const fakeRepo = { objectStore: {} as never, refStore: {} as never };
		const resolver = httpTransport({
			resolveInProcess: (url) => (url === "repo://x" ? fakeRepo : null),
		});
		const hit = await resolver(ctxFor("repo://x"));
		expect(hit).toEqual({ kind: "repo", repo: fakeRepo });
		const miss = await resolver(ctxFor("repo://other"));
		expect(miss).toBeNull();
	});
});
