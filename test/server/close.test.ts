import { describe, expect, test } from "bun:test";
import { createServer } from "../../src/server/handler.ts";
import { MemoryStorage } from "../../src/server/memory-storage.ts";
import type { SshChannel } from "../../src/server/types.ts";

function makeServer() {
	const server = createServer({ storage: new MemoryStorage() });
	return server;
}

function makeDummyChannel(): SshChannel {
	const stderrChunks: string[] = [];
	return {
		readable: new ReadableStream(),
		writable: new WritableStream(),
		writeStderr(data) {
			stderrChunks.push(new TextDecoder().decode(data));
		},
		get _stderr() {
			return stderrChunks;
		},
	} as SshChannel & { _stderr: string[] };
}

describe("GitServer.close", () => {
	test("closed is false initially", () => {
		const server = makeServer();
		expect(server.closed).toBe(false);
	});

	test("close() resolves immediately when no operations are in-flight", async () => {
		const server = makeServer();
		await server.close();
		expect(server.closed).toBe(true);
	});

	test("close() is idempotent", async () => {
		const server = makeServer();
		await server.close();
		await server.close();
		expect(server.closed).toBe(true);
	});

	test("fetch returns 503 after close", async () => {
		const server = makeServer();
		await server.close();
		const res = await server.fetch(
			new Request("http://localhost/repo/info/refs?service=git-upload-pack"),
		);
		expect(res.status).toBe(503);
	});

	test("handleSession returns 128 after close", async () => {
		const server = makeServer();
		await server.close();
		const channel = makeDummyChannel() as SshChannel & { _stderr: string[] };
		const code = await server.handleSession("git-upload-pack '/repo'", channel);
		expect(code).toBe(128);
		expect(channel._stderr.join("")).toContain("shutting down");
	});

	test("close() drains in-flight operations before resolving", async () => {
		const server = makeServer();
		await server.createRepo("repo");

		let fetchResolved = false;
		const fetchPromise = server
			.fetch(new Request("http://localhost/repo/info/refs?service=git-upload-pack"))
			.then((res) => {
				fetchResolved = true;
				return res;
			});

		// The fetch is fast (just ref advertisement), but we can verify
		// that close() waits for it by checking both resolve.
		const closePromise = server.close().then(() => {
			expect(fetchResolved).toBe(true);
		});

		await Promise.all([fetchPromise, closePromise]);
		expect(server.closed).toBe(true);
	});

	test("close() with already-aborted signal resolves immediately", async () => {
		const server = makeServer();
		const controller = new AbortController();
		controller.abort();
		await server.close({ signal: controller.signal });
		expect(server.closed).toBe(true);
	});

	test("close() with signal timeout resolves when aborted", async () => {
		let hookEntered: () => void;
		const hookEnteredPromise = new Promise<void>((r) => {
			hookEntered = r;
		});
		let releaseHook: () => void;
		const hookGate = new Promise<void>((r) => {
			releaseHook = r;
		});

		const server = createServer({
			storage: new MemoryStorage(),
			hooks: {
				advertiseRefs: async () => {
					hookEntered!();
					await hookGate;
				},
			},
		});
		await server.createRepo("repo");

		const fetchPromise = server.fetch(
			new Request("http://localhost/repo/info/refs?service=git-upload-pack"),
		);

		// Wait until the hook is actually running
		await hookEnteredPromise;

		const controller = new AbortController();
		setTimeout(() => controller.abort(), 100);
		const start = Date.now();
		await server.close({ signal: controller.signal });
		expect(Date.now() - start).toBeLessThan(2000);
		expect(server.closed).toBe(true);

		// Release the hook so the fetch can finish
		releaseHook!();
		await fetchPromise.catch(() => {});
	});

	test("createRepo still works after close", async () => {
		const server = makeServer();
		await server.close();
		// Repo management is not gated by close — only request handling is
		const repo = await server.createRepo("new-repo");
		expect(repo).toBeTruthy();
	});
});
