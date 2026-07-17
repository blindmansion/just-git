import { describe, expect, test } from "bun:test";
import { hashObject } from "../../src/lib/object-db.ts";
import { writePack } from "../../src/lib/pack/packfile.ts";
import {
	concatPktLines,
	encodePktLine,
	flushPkt,
	parsePktLineStream,
} from "../../src/lib/transport/pkt-line.ts";
import { createServer } from "../../src/server/server.ts";
import { MemoryStorage } from "../../src/store/memory-storage.ts";

const encoder = new TextEncoder();
const ZERO_HASH = "0".repeat(40);

function buildPushBody(
	oldHash: string,
	newHash: string,
	refName: string,
	packData: Uint8Array = new Uint8Array(0),
	capabilities = "report-status side-band-64k",
): Uint8Array {
	const command = encoder.encode(`${oldHash} ${newHash} ${refName}\0${capabilities}\n`);
	return concatPktLines(encodePktLine(command), flushPkt(), packData);
}

function chunkedStream(
	body: Uint8Array,
	chunkSizes: readonly number[] = [1, 2, 3, 5, 8, 13],
): ReadableStream<Uint8Array> {
	let offset = 0;
	let index = 0;
	return new ReadableStream({
		pull(controller) {
			if (offset >= body.byteLength) {
				controller.close();
				return;
			}
			const size = chunkSizes[index++ % chunkSizes.length]!;
			const end = Math.min(offset + size, body.byteLength);
			controller.enqueue(body.slice(offset, end));
			offset = end;
		},
	});
}

function receivePackRequest(
	body: Uint8Array,
	headers?: Record<string, string>,
	chunkSizes?: readonly number[],
): Request {
	return new Request("http://localhost/repo/git-receive-pack", {
		method: "POST",
		headers,
		body: chunkedStream(body, chunkSizes),
		duplex: "half",
	} as RequestInit);
}

async function gzipBytes(data: Uint8Array): Promise<Uint8Array> {
	const cs = new CompressionStream("gzip");
	const response = new Response(cs.readable);
	const pump = (async () => {
		const writer = cs.writable.getWriter();
		const copy = new Uint8Array(data.byteLength);
		copy.set(data);
		await writer.write(copy);
		await writer.close();
	})();
	const compressed = new Uint8Array(await response.arrayBuffer());
	await pump;
	return compressed;
}

function raceTimeout<T>(promise: Promise<T>, ms = 4000): Promise<T> {
	return Promise.race([
		promise,
		new Promise<T>((_, reject) => {
			setTimeout(() => reject(new Error(`request did not resolve within ${ms}ms`)), ms);
		}),
	]);
}

describe("streaming HTTP receive-pack", () => {
	test("orders receive hook output around report-status", async () => {
		const storage = new MemoryStorage();
		const server = createServer({
			storage,
			hooks: {
				preReceive: async ({ output }) => output.writeLine("pre"),
				update: async ({ output }) => output.writeLine("update"),
				postReceive: async ({ output }) => {
					await output.writeLine("post");
					throw new Error("post-receive failures do not change push status");
				},
			},
		});
		await server.createRepo("repo");
		const content = encoder.encode("ordered output");
		const hash = await hashObject("blob", content);
		const pack = await writePack([{ type: "blob", content }]);

		const response = await server.fetch(
			receivePackRequest(buildPushBody(ZERO_HASH, hash, "refs/heads/main", pack)),
		);
		const lines = parsePktLineStream(new Uint8Array(await response.arrayBuffer()));
		const packets = lines
			.filter((line) => line.type === "data")
			.map((line) => ({
				band: line.data[0],
				text: new TextDecoder().decode(line.data.subarray(1)),
			}));

		expect(packets.map((packet) => packet.band)).toEqual([2, 2, 1, 2]);
		expect(packets[0]!.text).toBe("pre\n");
		expect(packets[1]!.text).toBe("update\n");
		expect(packets[2]!.text).toContain("unpack ok");
		expect(packets[3]!.text).toBe("post\n");
		expect(lines.at(-1)!.type).toBe("flush");
	});

	test("delivers hook output before a long-running hook completes", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const server = createServer({
			storage: new MemoryStorage(),
			hooks: {
				preReceive: async ({ output }) => {
					await output.writeLine("still working");
					await gate;
				},
			},
		});
		await server.createRepo("repo");
		const content = encoder.encode("live output");
		const hash = await hashObject("blob", content);
		const pack = await writePack([{ type: "blob", content }]);
		const response = await server.fetch(
			receivePackRequest(buildPushBody(ZERO_HASH, hash, "refs/heads/live", pack)),
		);
		const reader = response.body!.getReader();

		try {
			const first = await raceTimeout(reader.read(), 1000);
			expect(first.done).toBe(false);
			const line = parsePktLineStream(first.value!)[0]!;
			expect(line.type).toBe("data");
			if (line.type === "data") {
				expect(line.data[0]).toBe(2);
				expect(new TextDecoder().decode(line.data.subarray(1))).toBe("still working\n");
			}
		} finally {
			release();
		}

		while (!(await reader.read()).done) {
			// Drain the report-status and outer flush.
		}
	});

	test("does not put hook output on smart HTTP protocol stdout without sideband", async () => {
		const server = createServer({
			storage: new MemoryStorage(),
			hooks: {
				preReceive: async ({ output }) => output.writeLine("must not corrupt status"),
			},
		});
		await server.createRepo("repo");
		const content = encoder.encode("plain status");
		const hash = await hashObject("blob", content);
		const pack = await writePack([{ type: "blob", content }]);
		const body = buildPushBody(ZERO_HASH, hash, "refs/heads/plain", pack, "report-status");

		const response = await server.fetch(receivePackRequest(body));
		const bytes = new Uint8Array(await response.arrayBuffer());
		const lines = parsePktLineStream(bytes);

		expect(new TextDecoder().decode(bytes)).not.toContain("must not corrupt status");
		expect(lines[0]!.type).toBe("data");
		if (lines[0]!.type === "data") {
			expect(new TextDecoder().decode(lines[0]!.data)).toBe("unpack ok\n");
		}
	});

	test("does not start the response before request ingestion finishes", async () => {
		const server = createServer({ storage: new MemoryStorage() });
		await server.createRepo("repo");
		const content = encoder.encode("half duplex");
		const hash = await hashObject("blob", content);
		const pack = await writePack([{ type: "blob", content }]);
		const body = buildPushBody(ZERO_HASH, hash, "refs/heads/half-duplex", pack);
		let requestController!: ReadableStreamDefaultController<Uint8Array>;
		const request = new Request("http://localhost/repo/git-receive-pack", {
			method: "POST",
			body: new ReadableStream({
				start(controller) {
					requestController = controller;
					controller.enqueue(body);
				},
			}),
			duplex: "half",
		} as RequestInit);
		let resolved = false;
		const responsePromise = server.fetch(request).then((response) => {
			resolved = true;
			return response;
		});

		await Bun.sleep(10);
		expect(resolved).toBe(false);

		requestController.close();
		const response = await responsePromise;
		expect(response.status).toBe(200);
		await response.arrayBuffer();
	});

	test("ingests a pack split across pkt-line headers and pack bytes", async () => {
		const storage = new MemoryStorage();
		const server = createServer({ storage });
		const repo = await server.createRepo("repo");
		const content = encoder.encode("streamed object");
		const hash = await hashObject("blob", content);
		const pack = await writePack([{ type: "blob", content }]);
		const body = buildPushBody(ZERO_HASH, hash, "refs/heads/streamed", pack);

		const response = await server.fetch(receivePackRequest(body));

		expect(response.status).toBe(200);
		expect(await repo.objectStore.exists(hash)).toBe(true);
		expect(await repo.refStore.readRef("refs/heads/streamed")).toEqual({
			type: "direct",
			hash,
		});
	});

	test("preserves flush-only and malformed request semantics", async () => {
		const server = createServer({ storage: new MemoryStorage() });
		await server.createRepo("repo");

		const flushResponse = await server.fetch(receivePackRequest(flushPkt(), undefined, [1]));
		expect(flushResponse.status).toBe(200);

		const truncatedResponse = await server.fetch(
			receivePackRequest(encoder.encode("0032"), undefined, [1]),
		);
		expect(truncatedResponse.status).toBe(400);
	});

	test("enforces the raw body limit while streaming", async () => {
		const server = createServer({
			storage: new MemoryStorage(),
			receiveLimits: { maxRequestBytes: 64, maxPackBytes: 1024 },
			onError: false,
		});
		await server.createRepo("repo");
		const body = buildPushBody(
			ZERO_HASH,
			"a".repeat(40),
			"refs/heads/oversized",
			new Uint8Array(256),
		);

		const response = await server.fetch(receivePackRequest(body, undefined, [7]));

		expect(response.status).toBe(413);
		expect(await response.text()).toContain("Request body too large");
	});

	test("drains and limits trailing data when no command needs a pack", async () => {
		const server = createServer({
			storage: new MemoryStorage(),
			receiveLimits: { maxRequestBytes: 64, maxPackBytes: 1024 },
			onError: false,
		});
		await server.createRepo("repo");
		const body = concatPktLines(flushPkt(), new Uint8Array(256));

		const response = await server.fetch(receivePackRequest(body, undefined, [11]));

		expect(response.status).toBe(413);
		expect(await response.text()).toContain("Request body too large");
	});

	test("enforces the inflated limit without gzip backpressure deadlock", async () => {
		const server = createServer({
			storage: new MemoryStorage(),
			receiveLimits: {
				maxRequestBytes: 1024 * 1024,
				maxInflatedBytes: 128,
				maxPackBytes: 1024 * 1024,
			},
			onError: false,
		});
		await server.createRepo("repo");
		const raw = buildPushBody(
			ZERO_HASH,
			"a".repeat(40),
			"refs/heads/inflated",
			new Uint8Array(256 * 1024),
		);
		const compressed = await gzipBytes(raw);

		const response = await raceTimeout(
			server.fetch(
				receivePackRequest(compressed, {
					"Content-Encoding": "gzip",
				}),
			),
		);

		expect(response.status).toBe(413);
		expect(await response.text()).toContain("Decompressed body too large");
	});

	test("rolls back streamed objects when preReceive rejects", async () => {
		const storage = new MemoryStorage();
		const server = createServer({
			storage,
			hooks: {
				preReceive: () => ({ reject: true, message: "blocked" }),
			},
		});
		const repo = await server.createRepo("repo");
		const content = encoder.encode("must be rolled back");
		const hash = await hashObject("blob", content);
		const pack = await writePack([{ type: "blob", content }]);
		const body = buildPushBody(ZERO_HASH, hash, "refs/heads/rejected", pack);

		const response = await server.fetch(receivePackRequest(body, undefined, [4, 1, 9]));

		expect(response.status).toBe(200);
		expect(await repo.objectStore.exists(hash)).toBe(false);
		expect(await repo.refStore.readRef("refs/heads/rejected")).toBeNull();
	});

	test("releases the request reader after a client stream error", async () => {
		const server = createServer({ storage: new MemoryStorage(), onError: false });
		await server.createRepo("repo");
		const prefix = buildPushBody(
			ZERO_HASH,
			"a".repeat(40),
			"refs/heads/aborted",
			encoder.encode("PACK"),
		);
		let sent = false;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (!sent) {
					sent = true;
					controller.enqueue(prefix);
					return;
				}
				controller.error(new Error("client disconnected"));
			},
		});
		const request = new Request("http://localhost/repo/git-receive-pack", {
			method: "POST",
			body,
			duplex: "half",
		} as RequestInit);

		const response = await server.fetch(request);
		expect(response.status).toBe(200);
		expect(await response.text()).toContain("unpack");

		const next = await server.fetch(
			new Request("http://localhost/repo/info/refs?service=git-upload-pack"),
		);
		expect(next.status).toBe(200);
	});
});
