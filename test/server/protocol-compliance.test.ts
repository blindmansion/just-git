import { describe, expect, test } from "bun:test";
import { Bash, InMemoryFs } from "just-bash";
import { createGit } from "../../src/index.ts";
import { findRepo } from "../../src/lib/repo.ts";
import { parsePktLineStream, pktLineText } from "../../src/lib/transport/pkt-line.ts";
import { collectRefs, PackCache } from "../../src/server/operations.ts";
import { createGitServer } from "../../src/server/handler.ts";
import type { NodeHttpRequest, NodeHttpResponse } from "../../src/server/types.ts";
import {
	envAt,
	createServerClient,
	startServer,
	defaultHttpSession,
	defaultSshSession,
} from "./util.ts";

// ── Ref advertisement sorting ───────────────────────────────────────

describe("ref advertisement sorting", () => {
	test("collectRefs returns refs sorted by name (C locale)", async () => {
		const fs = new InMemoryFs();
		const git = createGit();
		const bash = new Bash({ fs, cwd: "/repo", customCommands: [git] });

		await bash.writeFile("/repo/file.txt", "content");
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "init"', { env: envAt(1000000000) });

		// Create branches in non-alphabetical order
		await bash.exec("git branch zebra");
		await bash.exec("git branch alpha");
		await bash.exec("git branch middle");
		await bash.exec("git tag z-tag");
		await bash.exec("git tag a-tag");

		const ctx = await findRepo(fs, "/repo");
		if (!ctx) throw new Error("no repo");

		const { refs } = await collectRefs(ctx);

		// HEAD should be first
		expect(refs[0]!.name).toBe("HEAD");

		// Remaining refs (after HEAD) should be sorted
		const refNames = refs.slice(1).map((r) => r.name);
		const sorted = refNames.slice().sort();
		expect(refNames).toEqual(sorted);
	});

	test("refs in info/refs response are sorted by name", async () => {
		const fs = new InMemoryFs();
		const git = createGit();
		const bash = new Bash({ fs, cwd: "/repo", customCommands: [git] });

		await bash.writeFile("/repo/file.txt", "content");
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "init"', { env: envAt(1000000000) });

		await bash.exec("git branch zebra");
		await bash.exec("git branch alpha");
		await bash.exec("git branch middle");

		const ctx = await findRepo(fs, "/repo");
		if (!ctx) throw new Error("no repo");

		const server = createGitServer({ resolveRepo: async () => ctx });
		const res = await server.fetch(
			new Request("http://localhost/repo/info/refs?service=git-upload-pack"),
		);
		const body = new Uint8Array(await res.arrayBuffer());
		const lines = parsePktLineStream(body);

		// Extract ref names from the advertisement (skip service line, flush, and final flush)
		const refNames: string[] = [];
		for (const line of lines) {
			if (line.type === "flush") continue;
			const text = pktLineText(line);
			if (text.startsWith("#")) continue;
			// Strip capabilities from first ref line
			const nulIdx = text.indexOf("\0");
			const refPart = nulIdx >= 0 ? text.slice(0, nulIdx) : text;
			const match = refPart.match(/^[0-9a-f]{40} (.+)$/);
			if (match) refNames.push(match[1]!);
		}

		expect(refNames[0]).toBe("HEAD");
		const afterHead = refNames.slice(1);
		expect(afterHead).toEqual(afterHead.slice().sort());
		expect(afterHead).toContain("refs/heads/alpha");
		expect(afterHead).toContain("refs/heads/zebra");
	});

	test("peeled tags follow immediately after their tag ref in sorted order", async () => {
		const fs = new InMemoryFs();
		const git = createGit();
		const bash = new Bash({ fs, cwd: "/repo", customCommands: [git] });

		await bash.writeFile("/repo/file.txt", "content");
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "init"', { env: envAt(1000000000) });

		await bash.exec('git tag -a z-tag -m "z tag"', { env: envAt(1000000000) });
		await bash.exec('git tag -a a-tag -m "a tag"', { env: envAt(1000000000) });

		const ctx = await findRepo(fs, "/repo");
		if (!ctx) throw new Error("no repo");

		const { refs } = await collectRefs(ctx);
		const refNames = refs.map((r) => r.name);

		// a-tag should come before z-tag
		const aIdx = refNames.indexOf("refs/tags/a-tag");
		const aPeelIdx = refNames.indexOf("refs/tags/a-tag^{}");
		const zIdx = refNames.indexOf("refs/tags/z-tag");
		const zPeelIdx = refNames.indexOf("refs/tags/z-tag^{}");

		expect(aIdx).toBeGreaterThan(-1);
		expect(aPeelIdx).toBe(aIdx + 1);
		expect(zIdx).toBeGreaterThan(aPeelIdx);
		expect(zPeelIdx).toBe(zIdx + 1);
	});
});

// ── include-tag capability ──────────────────────────────────────────

describe("include-tag via server", () => {
	test("annotated tag objects are included when their target is in the pack", async () => {
		const fs = new InMemoryFs();
		const git = createGit();
		const bash = new Bash({ fs, cwd: "/repo", customCommands: [git] });

		await bash.writeFile("/repo/file.txt", "content");
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "init"', { env: envAt(1000000000) });
		await bash.exec('git tag -a v1.0 -m "release 1.0"', { env: envAt(1000000000) });

		const ctx = await findRepo(fs, "/repo");
		if (!ctx) throw new Error("no repo");

		const { srv, port } = startServer({ resolveRepo: async () => ctx });

		try {
			const client = createServerClient();
			const clientFs = client.fs as InMemoryFs;

			const result = await client.exec(`git clone http://localhost:${port}/repo /local`, {
				env: envAt(1000000100),
			});
			expect(result.exitCode).toBe(0);

			// The annotated tag should be present after clone
			expect(await clientFs.exists("/local/.git/refs/tags/v1.0")).toBe(true);

			// The tag object should be readable (not just a lightweight tag)
			const showResult = await client.exec("git show v1.0", { cwd: "/local" });
			expect(showResult.exitCode).toBe(0);
			expect(showResult.stdout).toContain("release 1.0");
		} finally {
			srv.stop();
		}
	});

	test("lightweight tags don't generate extra tag objects", async () => {
		const fs = new InMemoryFs();
		const git = createGit();
		const bash = new Bash({ fs, cwd: "/repo", customCommands: [git] });

		await bash.writeFile("/repo/file.txt", "content");
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "init"', { env: envAt(1000000000) });
		await bash.exec("git tag v1.0-light");

		const ctx = await findRepo(fs, "/repo");
		if (!ctx) throw new Error("no repo");

		const { srv, port } = startServer({ resolveRepo: async () => ctx });

		try {
			const client = createServerClient();
			const clientFs = client.fs as InMemoryFs;

			const result = await client.exec(`git clone http://localhost:${port}/repo /local`, {
				env: envAt(1000000100),
			});
			expect(result.exitCode).toBe(0);
			expect(await clientFs.exists("/local/.git/refs/tags/v1.0-light")).toBe(true);
		} finally {
			srv.stop();
		}
	});
});

// ── allow-reachable-sha1-in-want ────────────────────────────────────

describe("allow-reachable-sha1-in-want", () => {
	test("capability is advertised for upload-pack", async () => {
		const fs = new InMemoryFs();
		const git = createGit();
		const bash = new Bash({ fs, cwd: "/repo", customCommands: [git] });

		await bash.writeFile("/repo/file.txt", "content");
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "init"', { env: envAt(1000000000) });

		const ctx = await findRepo(fs, "/repo");
		if (!ctx) throw new Error("no repo");

		const server = createGitServer({ resolveRepo: async () => ctx });
		const res = await server.fetch(
			new Request("http://localhost/repo/info/refs?service=git-upload-pack"),
		);
		const body = new Uint8Array(await res.arrayBuffer());
		const lines = parsePktLineStream(body);

		// Find capabilities in the first ref line
		let capsFound = false;
		for (const line of lines) {
			if (line.type === "flush") continue;
			if (line.type === "data") {
				const raw = new TextDecoder().decode(line.data);
				if (raw.includes("\0")) {
					expect(raw).toContain("allow-reachable-sha1-in-want");
					capsFound = true;
					break;
				}
			}
		}
		expect(capsFound).toBe(true);
	});
});

// ── PackCache ───────────────────────────────────────────────────────

describe("PackCache", () => {
	test("key returns null when haves are present", () => {
		const key = PackCache.key("repo", ["abc"], ["def"]);
		expect(key).toBeNull();
	});

	test("key returns a string for full clones (no haves)", () => {
		const key = PackCache.key("repo", ["abc", "def"], []);
		expect(key).not.toBeNull();
		expect(typeof key).toBe("string");
	});

	test("key is deterministic regardless of want order", () => {
		const key1 = PackCache.key("repo", ["abc", "def"], []);
		const key2 = PackCache.key("repo", ["def", "abc"], []);
		expect(key1).toBe(key2);
	});

	test("different repos produce different keys", () => {
		const key1 = PackCache.key("repo1", ["abc"], []);
		const key2 = PackCache.key("repo2", ["abc"], []);
		expect(key1).not.toBe(key2);
	});

	test("get/set round-trip", () => {
		const cache = new PackCache();
		const entry = { packData: new Uint8Array([1, 2, 3]), objectCount: 1, deltaCount: 0 };
		cache.set("key1", entry);

		const result = cache.get("key1");
		expect(result).toBeDefined();
		expect(result!.packData).toEqual(new Uint8Array([1, 2, 3]));
		expect(result!.objectCount).toBe(1);
	});

	test("get returns undefined for missing key", () => {
		const cache = new PackCache();
		expect(cache.get("missing")).toBeUndefined();
	});

	test("LRU eviction when maxBytes exceeded", () => {
		const cache = new PackCache(10);
		const entry1 = { packData: new Uint8Array(6), objectCount: 1, deltaCount: 0 };
		const entry2 = { packData: new Uint8Array(6), objectCount: 1, deltaCount: 0 };

		cache.set("key1", entry1);
		expect(cache.get("key1")).toBeDefined();

		cache.set("key2", entry2);
		// key1 should have been evicted to make room
		expect(cache.get("key1")).toBeUndefined();
		expect(cache.get("key2")).toBeDefined();
	});

	test("entry larger than maxBytes is not cached", () => {
		const cache = new PackCache(5);
		const entry = { packData: new Uint8Array(10), objectCount: 1, deltaCount: 0 };
		cache.set("key1", entry);
		expect(cache.get("key1")).toBeUndefined();
	});

	test("duplicate set is ignored", () => {
		const cache = new PackCache();
		const entry1 = { packData: new Uint8Array([1]), objectCount: 1, deltaCount: 0 };
		const entry2 = { packData: new Uint8Array([2]), objectCount: 2, deltaCount: 0 };

		cache.set("key1", entry1);
		cache.set("key1", entry2);

		// First one should still be there
		expect(cache.get("key1")!.objectCount).toBe(1);
	});

	test("stats track hits and misses", () => {
		const cache = new PackCache();
		const entry = { packData: new Uint8Array([1]), objectCount: 1, deltaCount: 0 };
		cache.set("key1", entry);

		cache.get("key1"); // hit
		cache.get("key1"); // hit
		cache.get("missing"); // miss

		expect(cache.stats.hits).toBe(2);
		expect(cache.stats.misses).toBe(1);
		expect(cache.stats.entries).toBe(1);
		expect(cache.stats.bytes).toBe(1);
	});
});

// ── Streaming upload-pack (noDelta) ─────────────────────────────────

describe("streaming upload-pack (noDelta)", () => {
	test("clone succeeds with noDelta pack option", async () => {
		const fs = new InMemoryFs();
		const git = createGit();
		const bash = new Bash({ fs, cwd: "/repo", customCommands: [git] });

		await bash.writeFile("/repo/file.txt", "content");
		await bash.writeFile("/repo/src/main.ts", 'console.log("hello");');
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "init"', { env: envAt(1000000000) });

		await bash.writeFile("/repo/file2.txt", "more content");
		await bash.exec("git add .");
		await bash.exec('git commit -m "second"', { env: envAt(1000000100) });

		const ctx = await findRepo(fs, "/repo");
		if (!ctx) throw new Error("no repo");

		const { srv, port } = startServer({
			resolveRepo: async () => ctx,
			packOptions: { noDelta: true },
		});

		try {
			const client = createServerClient();
			const clientFs = client.fs as InMemoryFs;

			const result = await client.exec(`git clone http://localhost:${port}/repo /local`, {
				env: envAt(1000000200),
			});
			expect(result.exitCode).toBe(0);

			expect(await clientFs.readFile("/local/file.txt")).toBe("content");
			expect(await clientFs.readFile("/local/file2.txt")).toBe("more content");
			expect(await clientFs.readFile("/local/src/main.ts")).toBe('console.log("hello");');

			const log = await client.exec("git log --oneline", { cwd: "/local" });
			expect(log.stdout).toContain("second");
			expect(log.stdout).toContain("init");
		} finally {
			srv.stop();
		}
	});

	test("incremental fetch works with noDelta", async () => {
		const fs = new InMemoryFs();
		const git = createGit();
		const bash = new Bash({ fs, cwd: "/repo", customCommands: [git] });

		await bash.writeFile("/repo/file.txt", "content");
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "init"', { env: envAt(1000000000) });

		const ctx = await findRepo(fs, "/repo");
		if (!ctx) throw new Error("no repo");

		const { srv, port } = startServer({
			resolveRepo: async () => ctx,
			packOptions: { noDelta: true },
		});

		try {
			const client = createServerClient();

			await client.exec(`git clone http://localhost:${port}/repo /local`, {
				env: envAt(1000000100),
			});

			// Add a new commit on the server
			await bash.writeFile("/repo/new.txt", "new file");
			await bash.exec("git add .");
			await bash.exec('git commit -m "server update"', { env: envAt(1000000200) });

			const fetch = await client.exec("git fetch origin", { cwd: "/local" });
			expect(fetch.exitCode).toBe(0);

			const log = await client.exec("git log origin/main --oneline", { cwd: "/local" });
			expect(log.stdout).toContain("server update");
		} finally {
			srv.stop();
		}
	});
});

// ── nodeHandler ─────────────────────────────────────────────────────

describe("nodeHandler", () => {
	function createMockNodeReq(
		method: string,
		url: string,
		headers: Record<string, string> = {},
		body?: Uint8Array,
	): NodeHttpRequest {
		const listeners: Record<string, ((...args: any[]) => void)[]> = {};
		return {
			method,
			url,
			headers: { host: "localhost:4280", ...headers },
			on(event: string, listener: (...args: any[]) => void) {
				if (!listeners[event]) listeners[event] = [];
				listeners[event]!.push(listener);
				if (event === "end" && !body) {
					queueMicrotask(() => listener());
				}
				if (event === "data" && body) {
					queueMicrotask(() => {
						listener(body);
						for (const end of listeners["end"] ?? []) end();
					});
				}
			},
		};
	}

	function createMockNodeRes(): NodeHttpResponse & {
		statusCode: number;
		writtenHeaders: Record<string, string | string[]>;
		chunks: Uint8Array[];
		ended: boolean;
		endData?: string;
	} {
		const res = {
			statusCode: 0,
			writtenHeaders: {} as Record<string, string | string[]>,
			chunks: [] as Uint8Array[],
			ended: false,
			endData: undefined as string | undefined,
			writeHead(statusCode: number, headers?: Record<string, string | string[]>) {
				res.statusCode = statusCode;
				if (headers) res.writtenHeaders = headers;
			},
			write(chunk: any) {
				if (chunk instanceof Uint8Array) res.chunks.push(chunk);
			},
			end(data?: string) {
				res.ended = true;
				res.endData = data;
			},
		};
		return res;
	}

	test("converts GET request and returns correct status and headers", async () => {
		const fs = new InMemoryFs();
		const git = createGit();
		const bash = new Bash({ fs, cwd: "/repo", customCommands: [git] });

		await bash.writeFile("/repo/file.txt", "content");
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "init"', { env: envAt(1000000000) });

		const ctx = await findRepo(fs, "/repo");
		if (!ctx) throw new Error("no repo");

		const server = createGitServer({ resolveRepo: async () => ctx });

		const req = createMockNodeReq("GET", "/repo/info/refs?service=git-upload-pack");
		const res = createMockNodeRes();

		server.nodeHandler(req, res);

		await new Promise((r) => setTimeout(r, 100));

		expect(res.statusCode).toBe(200);
		expect(res.writtenHeaders["content-type"]).toBe("application/x-git-upload-pack-advertisement");
		expect(res.ended).toBe(true);
		expect(res.chunks.length).toBeGreaterThan(0);
	});

	test("returns 404 for unknown path", async () => {
		const server = createGitServer({ resolveRepo: async () => null });

		const req = createMockNodeReq("GET", "/repo/info/refs?service=git-upload-pack");
		const res = createMockNodeRes();

		server.nodeHandler(req, res);

		await new Promise((r) => setTimeout(r, 50));

		expect(res.statusCode).toBe(404);
		expect(res.ended).toBe(true);
	});

	test("returns 500 when server handler throws", async () => {
		const server = createGitServer({
			resolveRepo: async () => {
				throw new Error("test explosion");
			},
			onError: false,
		});

		const req = createMockNodeReq("GET", "/repo/info/refs?service=git-upload-pack");
		const res = createMockNodeRes();

		server.nodeHandler(req, res);

		await new Promise((r) => setTimeout(r, 50));

		expect(res.statusCode).toBe(500);
		expect(res.ended).toBe(true);
	});

	test("passes array headers through correctly", async () => {
		let capturedHeaders: Headers | undefined;

		const server = createGitServer({
			resolveRepo: async () => null,
			session: {
				http: (req) => {
					capturedHeaders = req.headers;
					return defaultHttpSession(req);
				},
				ssh: defaultSshSession,
			},
		});

		const req = createMockNodeReq("GET", "/test", {
			accept: "text/plain",
			"x-custom": "value",
		});
		const res = createMockNodeRes();

		server.nodeHandler(req, res);

		await new Promise((r) => setTimeout(r, 50));

		expect(capturedHeaders!.get("accept")).toBe("text/plain");
		expect(capturedHeaders!.get("x-custom")).toBe("value");
	});

	test("collects POST body chunks and passes to server", async () => {
		let capturedBody: Uint8Array | undefined;

		const server = createGitServer({
			resolveRepo: async () => null,
			session: {
				http: async (req) => {
					capturedBody = new Uint8Array(await req.clone().arrayBuffer());
					return defaultHttpSession(req);
				},
				ssh: defaultSshSession,
			},
		});

		const body = new TextEncoder().encode("hello world");
		const req = createMockNodeReq("POST", "/test", {}, body);
		const res = createMockNodeRes();

		server.nodeHandler(req, res);

		await new Promise((r) => setTimeout(r, 50));

		expect(res.statusCode).toBe(404);
		expect(capturedBody).toEqual(body);
	});

	test("handles request error event", async () => {
		const server = createGitServer({
			resolveRepo: async () => null,
			onError: false,
		});

		let errorListener: (() => void) | undefined;
		const req: NodeHttpRequest = {
			method: "GET",
			url: "/test",
			headers: { host: "localhost" },
			on(event: string, listener: (...args: any[]) => void) {
				if (event === "error") errorListener = listener;
			},
		};
		const res = createMockNodeRes();

		server.nodeHandler(req, res);
		errorListener!();

		expect(res.statusCode).toBe(500);
		expect(res.ended).toBe(true);
	});

	test("defaults method to GET and url to / when missing", async () => {
		let capturedMethod: string | undefined;
		let capturedUrl: string | undefined;

		const server = createGitServer({
			resolveRepo: async () => null,
			session: {
				http: (req) => {
					capturedMethod = req.method;
					capturedUrl = new URL(req.url).pathname;
					return defaultHttpSession(req);
				},
				ssh: defaultSshSession,
			},
		});

		const req: NodeHttpRequest = {
			headers: { host: "localhost" },
			on(event: string, listener: (...args: any[]) => void) {
				if (event === "end") queueMicrotask(() => listener());
			},
		};
		const res = createMockNodeRes();

		server.nodeHandler(req, res);

		await new Promise((r) => setTimeout(r, 50));

		expect(capturedMethod).toBe("GET");
		expect(capturedUrl).toBe("/");
	});
});
