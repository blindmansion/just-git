import { describe, expect, test } from "bun:test";
import type { Identity } from "../../src/lib/types.ts";
import { parsePktLineStream, pktLineText } from "../../src/lib/transport/pkt-line.ts";
import { createCommit, writeBlob, writeTree } from "../../src/repo/writing.ts";
import { collectRefs, PackCache } from "../../src/server/operations.ts";
import { createServer } from "../../src/server/handler.ts";
import { MemoryStorage } from "../../src/server/memory-storage.ts";
import { createStorageAdapter } from "../../src/server/storage.ts";
import type { NodeHttpRequest, NodeHttpResponse } from "../../src/server/types.ts";
import { pathExists, readFile } from "../util.ts";
import { envAt, createServerClient, startServer, defaultHttpAuth } from "./util.ts";

const TEST_IDENTITY: Identity = {
	name: "Test",
	email: "test@test.com",
	timestamp: 1000000000,
	timezone: "+0000",
};

// ── Ref advertisement sorting ───────────────────────────────────────

describe("ref advertisement sorting", () => {
	test("collectRefs returns refs sorted by name (C locale)", async () => {
		const driver = new MemoryStorage();
		const storage = createStorageAdapter(driver);
		const repo = await storage.createRepo("repo");
		const blob = await writeBlob(repo, "content");
		const tree = await writeTree(repo, [{ name: "file.txt", hash: blob }]);
		const commitHash = await createCommit(repo, {
			tree,
			parents: [],
			author: TEST_IDENTITY,
			committer: TEST_IDENTITY,
			message: "init\n",
		});
		await repo.refStore.writeRef("refs/heads/main", { type: "direct", hash: commitHash });
		await repo.refStore.writeRef("refs/heads/zebra", { type: "direct", hash: commitHash });
		await repo.refStore.writeRef("refs/heads/alpha", { type: "direct", hash: commitHash });
		await repo.refStore.writeRef("refs/heads/middle", { type: "direct", hash: commitHash });
		await repo.refStore.writeRef("refs/tags/z-tag", { type: "direct", hash: commitHash });
		await repo.refStore.writeRef("refs/tags/a-tag", { type: "direct", hash: commitHash });

		const { refs } = await collectRefs(repo);

		expect(refs[0]!.name).toBe("HEAD");

		const refNames = refs.slice(1).map((r) => r.name);
		const sorted = refNames.slice().sort();
		expect(refNames).toEqual(sorted);
	});

	test("refs in info/refs response are sorted by name", async () => {
		const driver = new MemoryStorage();
		const storage = createStorageAdapter(driver);
		const repo = await storage.createRepo("repo");
		const blob = await writeBlob(repo, "content");
		const tree = await writeTree(repo, [{ name: "file.txt", hash: blob }]);
		const commitHash = await createCommit(repo, {
			tree,
			parents: [],
			author: TEST_IDENTITY,
			committer: TEST_IDENTITY,
			message: "init\n",
		});
		await repo.refStore.writeRef("refs/heads/main", { type: "direct", hash: commitHash });
		await repo.refStore.writeRef("refs/heads/zebra", { type: "direct", hash: commitHash });
		await repo.refStore.writeRef("refs/heads/alpha", { type: "direct", hash: commitHash });
		await repo.refStore.writeRef("refs/heads/middle", { type: "direct", hash: commitHash });

		const server = createServer({ storage: driver });
		const res = await server.fetch(
			new Request("http://localhost/repo/info/refs?service=git-upload-pack"),
		);
		const body = new Uint8Array(await res.arrayBuffer());
		const lines = parsePktLineStream(body);

		const refNames: string[] = [];
		for (const line of lines) {
			if (line.type === "flush") continue;
			const text = pktLineText(line);
			if (text.startsWith("#")) continue;
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
		const driver = new MemoryStorage();
		const storage = createStorageAdapter(driver);
		const repo = await storage.createRepo("repo");
		const blob = await writeBlob(repo, "content");
		const tree = await writeTree(repo, [{ name: "file.txt", hash: blob }]);
		const commitHash = await createCommit(repo, {
			tree,
			parents: [],
			author: TEST_IDENTITY,
			committer: TEST_IDENTITY,
			message: "init\n",
		});
		await repo.refStore.writeRef("refs/heads/main", { type: "direct", hash: commitHash });

		const zTagContent = `object ${commitHash}\ntype commit\ntag z-tag\ntagger Test <test@test.com> 1000000000 +0000\n\nz tag\n`;
		const zTagHash = await repo.objectStore.write("tag", new TextEncoder().encode(zTagContent));
		await repo.refStore.writeRef("refs/tags/z-tag", { type: "direct", hash: zTagHash });

		const aTagContent = `object ${commitHash}\ntype commit\ntag a-tag\ntagger Test <test@test.com> 1000000000 +0000\n\na tag\n`;
		const aTagHash = await repo.objectStore.write("tag", new TextEncoder().encode(aTagContent));
		await repo.refStore.writeRef("refs/tags/a-tag", { type: "direct", hash: aTagHash });

		const { refs } = await collectRefs(repo);
		const refNames = refs.map((r) => r.name);

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
		const driver = new MemoryStorage();
		const storage = createStorageAdapter(driver);
		const repo = await storage.createRepo("repo");
		const blob = await writeBlob(repo, "content");
		const tree = await writeTree(repo, [{ name: "file.txt", hash: blob }]);
		const commitHash = await createCommit(repo, {
			tree,
			parents: [],
			author: TEST_IDENTITY,
			committer: TEST_IDENTITY,
			message: "init\n",
		});
		await repo.refStore.writeRef("refs/heads/main", { type: "direct", hash: commitHash });

		const tagContent = `object ${commitHash}\ntype commit\ntag v1.0\ntagger Test <test@test.com> 1000000000 +0000\n\nrelease 1.0\n`;
		const tagHash = await repo.objectStore.write("tag", new TextEncoder().encode(tagContent));
		await repo.refStore.writeRef("refs/tags/v1.0", { type: "direct", hash: tagHash });

		const { port, stop } = startServer({ storage: driver });

		try {
			const client = createServerClient();

			const result = await client.exec(`git clone http://localhost:${port}/repo /local`, {
				env: envAt(1000000100),
			});
			expect(result.exitCode).toBe(0);

			expect(await pathExists(client.fs, "/local/.git/refs/tags/v1.0")).toBe(true);

			const showResult = await client.exec("git show v1.0", { cwd: "/local" });
			expect(showResult.exitCode).toBe(0);
			expect(showResult.stdout).toContain("release 1.0");
		} finally {
			stop();
		}
	});

	test("lightweight tags don't generate extra tag objects", async () => {
		const driver = new MemoryStorage();
		const storage = createStorageAdapter(driver);
		const repo = await storage.createRepo("repo");
		const blob = await writeBlob(repo, "content");
		const tree = await writeTree(repo, [{ name: "file.txt", hash: blob }]);
		const commitHash = await createCommit(repo, {
			tree,
			parents: [],
			author: TEST_IDENTITY,
			committer: TEST_IDENTITY,
			message: "init\n",
		});
		await repo.refStore.writeRef("refs/heads/main", { type: "direct", hash: commitHash });
		await repo.refStore.writeRef("refs/tags/v1.0-light", { type: "direct", hash: commitHash });

		const { port, stop } = startServer({ storage: driver });

		try {
			const client = createServerClient();

			const result = await client.exec(`git clone http://localhost:${port}/repo /local`, {
				env: envAt(1000000100),
			});
			expect(result.exitCode).toBe(0);
			expect(await pathExists(client.fs, "/local/.git/refs/tags/v1.0-light")).toBe(true);
		} finally {
			stop();
		}
	});
});

// ── allow-reachable-sha1-in-want ────────────────────────────────────

describe("upload-pack capabilities", () => {
	test("stricter auth model does not advertise allow-reachable-sha1-in-want", async () => {
		const driver = new MemoryStorage();
		const storage = createStorageAdapter(driver);
		const repo = await storage.createRepo("repo");
		const blob = await writeBlob(repo, "content");
		const tree = await writeTree(repo, [{ name: "file.txt", hash: blob }]);
		const commitHash = await createCommit(repo, {
			tree,
			parents: [],
			author: TEST_IDENTITY,
			committer: TEST_IDENTITY,
			message: "init\n",
		});
		await repo.refStore.writeRef("refs/heads/main", { type: "direct", hash: commitHash });

		const server = createServer({ storage: driver });
		const res = await server.fetch(
			new Request("http://localhost/repo/info/refs?service=git-upload-pack"),
		);
		const body = new Uint8Array(await res.arrayBuffer());
		const lines = parsePktLineStream(body);

		let capsFound = false;
		for (const line of lines) {
			if (line.type === "flush") continue;
			if (line.type === "data") {
				const raw = new TextDecoder().decode(line.data);
				if (raw.includes("\0")) {
					expect(raw).not.toContain("allow-reachable-sha1-in-want");
					expect(raw).toContain("multi_ack_detailed");
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

		expect(cache.get("key1")!.objectCount).toBe(1);
	});

	test("stats track hits and misses", () => {
		const cache = new PackCache();
		const entry = { packData: new Uint8Array([1]), objectCount: 1, deltaCount: 0 };
		cache.set("key1", entry);

		cache.get("key1");
		cache.get("key1");
		cache.get("missing");

		expect(cache.stats.hits).toBe(2);
		expect(cache.stats.misses).toBe(1);
		expect(cache.stats.entries).toBe(1);
		expect(cache.stats.bytes).toBe(1);
	});
});

// ── Streaming upload-pack (noDelta) ─────────────────────────────────

describe("streaming upload-pack (noDelta)", () => {
	test("clone succeeds with noDelta pack option", async () => {
		const driver = new MemoryStorage();
		const storage = createStorageAdapter(driver);
		const repo = await storage.createRepo("repo");
		const fileBlob = await writeBlob(repo, "content");
		const mainBlob = await writeBlob(repo, 'console.log("hello");');
		const srcTree = await writeTree(repo, [{ name: "main.ts", hash: mainBlob }]);
		const tree1 = await writeTree(repo, [
			{ name: "file.txt", hash: fileBlob },
			{ name: "src", hash: srcTree },
		]);
		const commit1 = await createCommit(repo, {
			tree: tree1,
			parents: [],
			author: TEST_IDENTITY,
			committer: TEST_IDENTITY,
			message: "init\n",
		});
		const file2Blob = await writeBlob(repo, "more content");
		const tree2 = await writeTree(repo, [
			{ name: "file.txt", hash: fileBlob },
			{ name: "file2.txt", hash: file2Blob },
			{ name: "src", hash: srcTree },
		]);
		const commit2 = await createCommit(repo, {
			tree: tree2,
			parents: [commit1],
			author: { ...TEST_IDENTITY, timestamp: 1000000100 },
			committer: { ...TEST_IDENTITY, timestamp: 1000000100 },
			message: "second\n",
		});
		await repo.refStore.writeRef("refs/heads/main", { type: "direct", hash: commit2 });

		const { port, stop } = startServer({
			storage: driver,
			packOptions: { noDelta: true },
		});

		try {
			const client = createServerClient();

			const result = await client.exec(`git clone http://localhost:${port}/repo /local`, {
				env: envAt(1000000200),
			});
			expect(result.exitCode).toBe(0);

			expect(await readFile(client.fs, "/local/file.txt")).toBe("content");
			expect(await readFile(client.fs, "/local/file2.txt")).toBe("more content");
			expect(await readFile(client.fs, "/local/src/main.ts")).toBe('console.log("hello");');

			const log = await client.exec("git log --oneline", { cwd: "/local" });
			expect(log.stdout).toContain("second");
			expect(log.stdout).toContain("init");
		} finally {
			stop();
		}
	});

	test("incremental fetch works with noDelta", async () => {
		const driver = new MemoryStorage();
		const storage = createStorageAdapter(driver);
		const repo = await storage.createRepo("repo");
		const blob = await writeBlob(repo, "content");
		const tree = await writeTree(repo, [{ name: "file.txt", hash: blob }]);
		const commitHash = await createCommit(repo, {
			tree,
			parents: [],
			author: TEST_IDENTITY,
			committer: TEST_IDENTITY,
			message: "init\n",
		});
		await repo.refStore.writeRef("refs/heads/main", { type: "direct", hash: commitHash });

		const { port, stop } = startServer({
			storage: driver,
			packOptions: { noDelta: true },
		});

		try {
			const client = createServerClient();

			await client.exec(`git clone http://localhost:${port}/repo /local`, {
				env: envAt(1000000100),
			});

			const repo2 = (await storage.repo("repo"))!;
			const newBlob = await writeBlob(repo2, "new file");
			const existingBlob = await writeBlob(repo2, "content");
			const newTree = await writeTree(repo2, [
				{ name: "file.txt", hash: existingBlob },
				{ name: "new.txt", hash: newBlob },
			]);
			const newCommit = await createCommit(repo2, {
				tree: newTree,
				parents: [commitHash],
				author: { ...TEST_IDENTITY, timestamp: 1000000200 },
				committer: { ...TEST_IDENTITY, timestamp: 1000000200 },
				message: "server update\n",
			});
			await repo2.refStore.writeRef("refs/heads/main", { type: "direct", hash: newCommit });

			const fetch = await client.exec("git fetch origin", { cwd: "/local" });
			expect(fetch.exitCode).toBe(0);

			const log = await client.exec("git log origin/main --oneline", { cwd: "/local" });
			expect(log.stdout).toContain("server update");
		} finally {
			stop();
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
		const driver = new MemoryStorage();
		const storage = createStorageAdapter(driver);
		const repo = await storage.createRepo("repo");
		const blob = await writeBlob(repo, "content");
		const tree = await writeTree(repo, [{ name: "file.txt", hash: blob }]);
		const commitHash = await createCommit(repo, {
			tree,
			parents: [],
			author: TEST_IDENTITY,
			committer: TEST_IDENTITY,
			message: "init\n",
		});
		await repo.refStore.writeRef("refs/heads/main", { type: "direct", hash: commitHash });

		const server = createServer({ storage: driver });

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
		const server = createServer({ storage: new MemoryStorage(), resolve: () => null });

		const req = createMockNodeReq("GET", "/repo/info/refs?service=git-upload-pack");
		const res = createMockNodeRes();

		server.nodeHandler(req, res);

		await new Promise((r) => setTimeout(r, 50));

		expect(res.statusCode).toBe(404);
		expect(res.ended).toBe(true);
	});

	test("returns 500 when server handler throws", async () => {
		const server = createServer({
			storage: new MemoryStorage(),
			resolve: async () => {
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

		const server = createServer({
			storage: new MemoryStorage(),
			resolve: () => null,
			auth: {
				http: (req) => {
					capturedHeaders = req.headers;
					return defaultHttpAuth(req);
				},
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

		const server = createServer({
			storage: new MemoryStorage(),
			resolve: () => null,
			auth: {
				http: async (req) => {
					capturedBody = new Uint8Array(await req.clone().arrayBuffer());
					return defaultHttpAuth(req);
				},
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
		const server = createServer({
			storage: new MemoryStorage(),
			resolve: () => null,
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

		const server = createServer({
			storage: new MemoryStorage(),
			resolve: () => null,
			auth: {
				http: (req) => {
					capturedMethod = req.method;
					capturedUrl = new URL(req.url).pathname;
					return defaultHttpAuth(req);
				},
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
