import { describe, expect, test } from "bun:test";
import { createProxy, corsProxy } from "../../src/proxy/index.ts";
import type { GitProxyConfig } from "../../src/proxy/index.ts";

// ── Helpers ─────────────────────────────────────────────────────────

function proxy(overrides?: Partial<GitProxyConfig>) {
	return createProxy({ allowed: ["github.com", "gitlab.com"], ...overrides });
}

function req(url: string, init?: RequestInit): Request {
	return new Request(`http://proxy${url}`, init);
}

function getInfoRefs(host = "github.com", repo = "user/repo.git") {
	return req(`/${host}/${repo}/info/refs?service=git-upload-pack`);
}

function postUploadPack(host = "github.com", repo = "user/repo.git") {
	return req(`/${host}/${repo}/git-upload-pack`, {
		method: "POST",
		headers: { "Content-Type": "application/x-git-upload-pack-request" },
		body: "dummy",
	});
}

function postReceivePack(host = "github.com", repo = "user/repo.git") {
	return req(`/${host}/${repo}/git-receive-pack`, {
		method: "POST",
		headers: { "Content-Type": "application/x-git-receive-pack-request" },
		body: "dummy",
	});
}

function optionsReq(path: string) {
	return req(path, {
		method: "OPTIONS",
		headers: { Origin: "https://myapp.com" },
	});
}

// Fake upstream that records what it received and returns a canned response
function mockFetch(
	status = 200,
	body: string | Uint8Array = "ok",
	headers: Record<string, string> = {},
) {
	const calls: { url: string; method: string; headers: Headers; body: any }[] = [];
	const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const method = init?.method ?? "GET";
		const reqHeaders =
			init?.headers instanceof Headers
				? init.headers
				: new Headers(init?.headers as Record<string, string>);
		calls.push({ url, method, headers: reqHeaders, body: init?.body });
		return new Response(body, {
			status,
			headers: { "Content-Type": "application/x-git-upload-pack-advertisement", ...headers },
		});
	};
	return { fn, calls };
}

// ── Request validation ──────────────────────────────────────────────

describe("request validation", () => {
	test("rejects requests with no path", async () => {
		const p = proxy();
		const res = await p.fetch(req("/"));
		expect(res.status).toBe(404);
	});

	test("rejects non-git GET requests", async () => {
		const p = proxy();
		const res = await p.fetch(req("/github.com/user/repo/README.md"));
		expect(res.status).toBe(403);
	});

	test("rejects GET info/refs without service param", async () => {
		const p = proxy();
		const res = await p.fetch(req("/github.com/user/repo.git/info/refs"));
		expect(res.status).toBe(403);
	});

	test("rejects GET info/refs with invalid service", async () => {
		const p = proxy();
		const res = await p.fetch(req("/github.com/user/repo.git/info/refs?service=git-whatever"));
		expect(res.status).toBe(403);
	});

	test("rejects POST with wrong content-type", async () => {
		const p = proxy();
		const res = await p.fetch(
			req("/github.com/user/repo.git/git-upload-pack", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "{}",
			}),
		);
		expect(res.status).toBe(403);
	});

	test("rejects PUT/DELETE/PATCH methods", async () => {
		const p = proxy();
		for (const method of ["PUT", "DELETE", "PATCH"]) {
			const res = await p.fetch(
				req("/github.com/user/repo.git/info/refs?service=git-upload-pack", { method }),
			);
			expect(res.status).toBe(403);
		}
	});

	test("allows GET info/refs with git-upload-pack service", async () => {
		const { fn } = mockFetch();
		const p = proxy({ fetch: fn as any });
		const res = await p.fetch(getInfoRefs());
		expect(res.status).toBe(200);
	});

	test("allows GET info/refs with git-receive-pack service", async () => {
		const { fn } = mockFetch();
		const p = proxy({ fetch: fn as any });
		const res = await p.fetch(req("/github.com/user/repo.git/info/refs?service=git-receive-pack"));
		expect(res.status).toBe(200);
	});

	test("allows POST git-upload-pack", async () => {
		const { fn } = mockFetch();
		const p = proxy({ fetch: fn as any });
		const res = await p.fetch(postUploadPack());
		expect(res.status).toBe(200);
	});

	test("allows POST git-receive-pack", async () => {
		const { fn } = mockFetch();
		const p = proxy({ fetch: fn as any });
		const res = await p.fetch(postReceivePack());
		expect(res.status).toBe(200);
	});
});

// ── Host allowlist ──────────────────────────────────────────────────

describe("host allowlist", () => {
	test("rejects hosts not in the allowlist", async () => {
		const p = proxy({ allowed: ["github.com"] });
		const res = await p.fetch(req("/evil.com/user/repo.git/info/refs?service=git-upload-pack"));
		expect(res.status).toBe(403);
	});

	test("allows hosts in the allowlist", async () => {
		const { fn } = mockFetch();
		const p = proxy({ allowed: ["github.com"], fetch: fn as any });
		const res = await p.fetch(getInfoRefs());
		expect(res.status).toBe(200);
	});

	test("host matching is case-insensitive", async () => {
		const { fn } = mockFetch();
		const p = proxy({ allowed: ["GitHub.com"], fetch: fn as any });
		const res = await p.fetch(getInfoRefs("github.com"));
		expect(res.status).toBe(200);
	});
});

// ── CORS headers ────────────────────────────────────────────────────

describe("CORS headers", () => {
	test("responses include Access-Control-Allow-Origin", async () => {
		const { fn } = mockFetch();
		const p = proxy({ fetch: fn as any });
		const res = await p.fetch(getInfoRefs());
		expect(res.headers.get("access-control-allow-origin")).toBe("*");
	});

	test("responses include Access-Control-Expose-Headers", async () => {
		const { fn } = mockFetch();
		const p = proxy({ fetch: fn as any });
		const res = await p.fetch(getInfoRefs());
		expect(res.headers.get("access-control-expose-headers")).toBeTruthy();
	});

	test("custom allowOrigin string is reflected", async () => {
		const { fn } = mockFetch();
		const p = proxy({ allowOrigin: "https://myapp.com", fetch: fn as any });
		const res = await p.fetch(getInfoRefs());
		expect(res.headers.get("access-control-allow-origin")).toBe("https://myapp.com");
	});

	test("allowOrigin array picks matching origin", async () => {
		const { fn } = mockFetch();
		const p = proxy({
			allowOrigin: ["https://a.com", "https://b.com"],
			fetch: fn as any,
		});
		const r = req("/github.com/user/repo.git/info/refs?service=git-upload-pack", {
			headers: { Origin: "https://b.com" },
		});
		const res = await p.fetch(r);
		expect(res.headers.get("access-control-allow-origin")).toBe("https://b.com");
	});

	test("allowOrigin array falls back to first when no match", async () => {
		const { fn } = mockFetch();
		const p = proxy({
			allowOrigin: ["https://a.com", "https://b.com"],
			fetch: fn as any,
		});
		const r = req("/github.com/user/repo.git/info/refs?service=git-upload-pack", {
			headers: { Origin: "https://c.com" },
		});
		const res = await p.fetch(r);
		expect(res.headers.get("access-control-allow-origin")).toBe("https://a.com");
	});

	test("error responses include CORS headers", async () => {
		const p = proxy();
		const res = await p.fetch(req("/evil.com/user/repo.git/info/refs?service=git-upload-pack"));
		expect(res.status).toBe(403);
		expect(res.headers.get("access-control-allow-origin")).toBe("*");
	});
});

// ── OPTIONS preflight ───────────────────────────────────────────────

describe("OPTIONS preflight", () => {
	test("returns 200 with CORS preflight headers", async () => {
		const p = proxy();
		const res = await p.fetch(
			optionsReq("/github.com/user/repo.git/info/refs?service=git-upload-pack"),
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("access-control-allow-methods")).toContain("GET");
		expect(res.headers.get("access-control-allow-methods")).toContain("POST");
		expect(res.headers.get("access-control-allow-headers")).toContain("authorization");
		expect(res.headers.get("access-control-allow-headers")).toContain("content-type");
		expect(res.headers.get("access-control-allow-headers")).toContain("git-protocol");
		expect(res.headers.get("access-control-max-age")).toBe("86400");
	});

	test("preflight does not hit upstream", async () => {
		const { fn, calls } = mockFetch();
		const p = proxy({ fetch: fn as any });
		await p.fetch(optionsReq("/github.com/user/repo.git/info/refs?service=git-upload-pack"));
		expect(calls).toHaveLength(0);
	});
});

// ── URL rewriting ───────────────────────────────────────────────────

describe("URL rewriting", () => {
	test("forwards to https upstream by default", async () => {
		const { fn, calls } = mockFetch();
		const p = proxy({ fetch: fn as any });
		await p.fetch(getInfoRefs("github.com", "user/repo.git"));
		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toBe(
			"https://github.com/user/repo.git/info/refs?service=git-upload-pack",
		);
	});

	test("uses http for insecureHosts", async () => {
		const { fn, calls } = mockFetch();
		const p = proxy({ insecureHosts: ["local.dev"], allowed: ["local.dev"], fetch: fn as any });
		await p.fetch(req("/local.dev/repo.git/info/refs?service=git-upload-pack"));
		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toStartWith("http://local.dev/");
	});

	test("preserves query params", async () => {
		const { fn, calls } = mockFetch();
		const p = proxy({ fetch: fn as any });
		await p.fetch(getInfoRefs());
		expect(calls[0]!.url).toContain("?service=git-upload-pack");
	});

	test("POST path is correctly forwarded", async () => {
		const { fn, calls } = mockFetch();
		const p = proxy({ fetch: fn as any });
		await p.fetch(postUploadPack("github.com", "org/project.git"));
		expect(calls[0]!.url).toBe("https://github.com/org/project.git/git-upload-pack");
	});
});

// ── Header forwarding ───────────────────────────────────────────────

describe("header forwarding", () => {
	test("sets User-Agent to git/ prefix by default", async () => {
		const { fn, calls } = mockFetch();
		const p = proxy({ fetch: fn as any });
		await p.fetch(getInfoRefs());
		expect(calls[0]!.headers.get("user-agent")).toBe("git/just-git-proxy");
	});

	test("custom userAgent is forwarded", async () => {
		const { fn, calls } = mockFetch();
		const p = proxy({ userAgent: "git/my-custom-agent", fetch: fn as any });
		await p.fetch(getInfoRefs());
		expect(calls[0]!.headers.get("user-agent")).toBe("git/my-custom-agent");
	});

	test("forwards authorization header", async () => {
		const { fn, calls } = mockFetch();
		const p = proxy({ fetch: fn as any });
		const r = req("/github.com/user/repo.git/info/refs?service=git-upload-pack", {
			headers: { Authorization: "Bearer abc123" },
		});
		await p.fetch(r);
		expect(calls[0]!.headers.get("authorization")).toBe("Bearer abc123");
	});

	test("forwards git-protocol header", async () => {
		const { fn, calls } = mockFetch();
		const p = proxy({ fetch: fn as any });
		const r = req("/github.com/user/repo.git/info/refs?service=git-upload-pack", {
			headers: { "git-protocol": "version=2" },
		});
		await p.fetch(r);
		expect(calls[0]!.headers.get("git-protocol")).toBe("version=2");
	});

	test("forwards content-type for POST", async () => {
		const { fn, calls } = mockFetch();
		const p = proxy({ fetch: fn as any });
		await p.fetch(postUploadPack());
		expect(calls[0]!.headers.get("content-type")).toBe("application/x-git-upload-pack-request");
	});

	test("upstream content-type is preserved in response", async () => {
		const { fn } = mockFetch(200, "data", {
			"Content-Type": "application/x-git-upload-pack-advertisement",
		});
		const p = proxy({ fetch: fn as any });
		const res = await p.fetch(getInfoRefs());
		expect(res.headers.get("content-type")).toBe("application/x-git-upload-pack-advertisement");
	});
});

// ── Auth hook ───────────────────────────────────────────────────────

describe("auth hook", () => {
	test("auth rejection returns the auth response with CORS headers", async () => {
		const p = proxy({
			auth: () => new Response("Unauthorized", { status: 401 }),
		});
		const res = await p.fetch(getInfoRefs());
		expect(res.status).toBe(401);
		expect(await res.text()).toBe("Unauthorized");
		expect(res.headers.get("access-control-allow-origin")).toBe("*");
	});

	test("auth pass-through allows request", async () => {
		const { fn } = mockFetch();
		const p = proxy({ auth: () => {}, fetch: fn as any });
		const res = await p.fetch(getInfoRefs());
		expect(res.status).toBe(200);
	});

	test("async auth works", async () => {
		const p = proxy({
			auth: async () => new Response("No", { status: 403 }),
		});
		const res = await p.fetch(getInfoRefs());
		expect(res.status).toBe(403);
	});

	test("auth runs before upstream fetch", async () => {
		const { fn, calls } = mockFetch();
		const p = proxy({
			auth: () => new Response("Blocked", { status: 401 }),
			fetch: fn as any,
		});
		await p.fetch(getInfoRefs());
		expect(calls).toHaveLength(0);
	});
});

// ── Upstream errors ─────────────────────────────────────────────────

describe("upstream errors", () => {
	test("upstream fetch failure returns 502", async () => {
		const p = proxy({
			fetch: (async () => {
				throw new Error("network error");
			}) as any,
		});
		const res = await p.fetch(getInfoRefs());
		expect(res.status).toBe(502);
		expect(res.headers.get("access-control-allow-origin")).toBe("*");
	});

	test("upstream non-200 status is forwarded", async () => {
		const { fn } = mockFetch(404, "not found");
		const p = proxy({ fetch: fn as any });
		const res = await p.fetch(getInfoRefs());
		expect(res.status).toBe(404);
	});
});

// ── corsProxy client helper ─────────────────────────────────────────

describe("corsProxy", () => {
	test("rewrites https URL through proxy", () => {
		const network = corsProxy("https://proxy.example.com");
		expect(network.fetch).toBeDefined();

		// Verify the URL rewriting by inspecting the fetch call
		let capturedUrl = "";
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: any) => {
			capturedUrl = typeof input === "string" ? input : input.url;
			return new Response("ok");
		}) as any;

		try {
			network.fetch!("https://github.com/user/repo.git/info/refs?service=git-upload-pack");
			expect(capturedUrl).toBe(
				"https://proxy.example.com/github.com/user/repo.git/info/refs?service=git-upload-pack",
			);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("rewrites http URL through proxy", () => {
		const network = corsProxy("https://proxy.example.com");

		let capturedUrl = "";
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: any) => {
			capturedUrl = typeof input === "string" ? input : input.url;
			return new Response("ok");
		}) as any;

		try {
			network.fetch!("http://local.dev/repo.git/info/refs?service=git-upload-pack");
			expect(capturedUrl).toBe(
				"https://proxy.example.com/local.dev/repo.git/info/refs?service=git-upload-pack",
			);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("handles URL objects", () => {
		const network = corsProxy("https://proxy.example.com");

		let capturedUrl = "";
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: any) => {
			capturedUrl = typeof input === "string" ? input : input.url;
			return new Response("ok");
		}) as any;

		try {
			network.fetch!(new URL("https://github.com/user/repo.git/info/refs"));
			expect(capturedUrl).toBe("https://proxy.example.com/github.com/user/repo.git/info/refs");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("strips trailing slashes from proxy URL", () => {
		const network = corsProxy("https://proxy.example.com///");

		let capturedUrl = "";
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: any) => {
			capturedUrl = typeof input === "string" ? input : input.url;
			return new Response("ok");
		}) as any;

		try {
			network.fetch!("https://github.com/user/repo.git/info/refs");
			expect(capturedUrl).toStartWith("https://proxy.example.com/github.com/");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

// ── Streaming ───────────────────────────────────────────────────────

describe("response streaming", () => {
	test("streams upstream response body through", async () => {
		const chunks = [
			new TextEncoder().encode("chunk1"),
			new TextEncoder().encode("chunk2"),
			new TextEncoder().encode("chunk3"),
		];

		const upstreamBody = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(chunk);
				controller.close();
			},
		});

		const p = proxy({
			fetch: (async () =>
				new Response(upstreamBody, {
					status: 200,
					headers: { "Content-Type": "application/x-git-upload-pack-result" },
				})) as any,
		});

		const res = await p.fetch(postUploadPack());
		const text = await res.text();
		expect(text).toBe("chunk1chunk2chunk3");
	});
});

// ── E2E with just-git server ────────────────────────────────────────

describe("e2e with just-git server as upstream", () => {
	test("proxy can forward clone requests to a just-git server", async () => {
		const { Bash, InMemoryFs } = await import("just-bash");
		const { createGit } = await import("../../src/index.ts");
		const { createServer } = await import("../../src/server/handler.ts");
		const { MemoryStorage } = await import("../../src/server/memory-storage.ts");

		// Set up a just-git server
		const server = createServer({ storage: new MemoryStorage(), autoCreate: true });

		// Seed a repo via direct server access
		const seedFs = new InMemoryFs();
		const seedGit = createGit({ network: server.asNetwork("http://upstream") });
		const seedBash = new Bash({ fs: seedFs, cwd: "/", customCommands: [seedGit] });
		const env = {
			GIT_AUTHOR_NAME: "Test",
			GIT_AUTHOR_EMAIL: "test@test.com",
			GIT_COMMITTER_NAME: "Test",
			GIT_COMMITTER_EMAIL: "test@test.com",
			GIT_AUTHOR_DATE: "1000000000",
			GIT_COMMITTER_DATE: "1000000000",
		};

		await seedBash.exec("git clone http://upstream/test-repo /seed", { env });
		await seedBash.writeFile("/seed/hello.txt", "Hello from server");
		await seedBash.exec("git add .", { cwd: "/seed", env });
		await seedBash.exec('git commit -m "init"', { cwd: "/seed", env });
		await seedBash.exec("git push origin main", { cwd: "/seed" });

		// Create proxy that forwards to the just-git server.
		// server.fetch expects (Request), so wrap to match standard fetch(url, init).
		const serverFetch = (input: any, init?: any) =>
			server.fetch(new Request(input as string, init));
		const gitProxy = createProxy({
			allowed: ["upstream"],
			insecureHosts: ["upstream"],
			fetch: serverFetch as any,
		});

		// Clone through the proxy
		const clientFs = new InMemoryFs();
		const clientGit = createGit({
			network: corsProxy("http://proxy"),
		});
		const clientBash = new Bash({ fs: clientFs, cwd: "/", customCommands: [clientGit] });

		// Override fetch to route through the proxy
		const originalFetch = globalThis.fetch;
		globalThis.fetch = ((input: any, init?: any) => {
			const url = typeof input === "string" ? input : input.url;
			if (url.startsWith("http://proxy/")) {
				return gitProxy.fetch(new Request(url, init));
			}
			return originalFetch(input, init);
		}) as any;

		try {
			const result = await clientBash.exec("git clone http://upstream/test-repo /work", { env });
			expect(result.exitCode).toBe(0);

			const content = await clientFs.readFile("/work/hello.txt");
			expect(content).toBe("Hello from server");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
