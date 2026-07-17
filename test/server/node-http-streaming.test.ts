import { describe, expect, test } from "bun:test";
import {
	createServer as createNodeServer,
	request as nodeRequest,
	type Server as NodeServer,
} from "node:http";
import { hashObject } from "../../src/lib/object-db.ts";
import { writePack } from "../../src/lib/pack/packfile.ts";
import { concatPktLines, encodePktLine, flushPkt } from "../../src/lib/transport/pkt-line.ts";
import { createServer } from "../../src/server/handler.ts";
import type { GitServer } from "../../src/server/types.ts";
import { MemoryStorage } from "../../src/store/memory-storage.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ZERO_HASH = "0".repeat(40);

interface NodeResponseResult {
	status: number;
	headers: Record<string, string | string[] | undefined>;
	body: Uint8Array;
}

function buildPushBody(
	oldHash: string,
	newHash: string,
	refName: string,
	packData: Uint8Array = new Uint8Array(0),
): Uint8Array {
	const command = encoder.encode(`${oldHash} ${newHash} ${refName}\0report-status side-band-64k\n`);
	return concatPktLines(encodePktLine(command), flushPkt(), packData);
}

function splitBytes(
	body: Uint8Array,
	sizes: readonly number[] = [1, 2, 3, 5, 8, 13],
): Uint8Array[] {
	const chunks: Uint8Array[] = [];
	let offset = 0;
	let index = 0;
	while (offset < body.byteLength) {
		const end = Math.min(offset + sizes[index++ % sizes.length]!, body.byteLength);
		chunks.push(body.slice(offset, end));
		offset = end;
	}
	return chunks;
}

async function startNodeServer(server: GitServer): Promise<{
	http: NodeServer;
	port: number;
	close(): Promise<void>;
}> {
	const http = createNodeServer(server.nodeHandler);
	await new Promise<void>((resolve, reject) => {
		const onError = (error: Error): void => reject(error);
		http.once("error", onError);
		http.listen(0, "127.0.0.1", () => {
			http.off("error", onError);
			resolve();
		});
	});
	const address = http.address();
	if (!address || typeof address === "string") throw new Error("Node server did not bind");
	return {
		http,
		port: address.port,
		close: () =>
			new Promise<void>((resolve, reject) => {
				http.close((error) => (error ? reject(error) : resolve()));
			}),
	};
}

function sendRequest(
	port: number,
	path: string,
	chunks: readonly Uint8Array[],
	headers: Record<string, string> = {},
	onChunk?: (chunk: Uint8Array) => void,
): Promise<NodeResponseResult> {
	return new Promise((resolve, reject) => {
		const req = nodeRequest(
			{
				host: "127.0.0.1",
				port,
				path,
				method: "POST",
				headers,
			},
			(res) => {
				const responseChunks: Uint8Array[] = [];
				res.on("data", (chunk: Uint8Array) => {
					const copy = Uint8Array.from(chunk);
					responseChunks.push(copy);
					onChunk?.(copy);
				});
				res.on("error", reject);
				res.on("end", () => {
					const length = responseChunks.reduce((total, chunk) => total + chunk.byteLength, 0);
					const body = new Uint8Array(length);
					let offset = 0;
					for (const chunk of responseChunks) {
						body.set(chunk, offset);
						offset += chunk.byteLength;
					}
					resolve({
						status: res.statusCode ?? 0,
						headers: res.headers,
						body,
					});
				});
			},
		);
		req.on("error", reject);
		void (async () => {
			try {
				for (const chunk of chunks) {
					if (!req.write(chunk)) {
						await new Promise<void>((resolveDrain) => req.once("drain", resolveDrain));
					}
					await new Promise<void>((resolveTurn) => setTimeout(resolveTurn, 0));
				}
				req.end();
			} catch (error) {
				req.destroy(error instanceof Error ? error : new Error("request write failed"));
			}
		})();
	});
}

function timeout<T>(promise: Promise<T>, ms = 2000): Promise<T> {
	return Promise.race([
		promise,
		new Promise<T>((_, reject) => {
			setTimeout(() => reject(new Error(`operation did not resolve within ${ms}ms`)), ms);
		}),
	]);
}

describe("Node HTTP streaming server", () => {
	test("ingests receive-pack split across many real Node request chunks", async () => {
		const storage = new MemoryStorage();
		const server = createServer({ storage });
		const repo = await server.createRepo("repo");
		const content = encoder.encode("node-streamed object");
		const hash = await hashObject("blob", content);
		const pack = await writePack([{ type: "blob", content }]);
		const body = buildPushBody(ZERO_HASH, hash, "refs/heads/node-streamed", pack);
		const node = await startNodeServer(server);

		try {
			const response = await sendRequest(node.port, "/repo/git-receive-pack", splitBytes(body), {
				"Content-Type": "application/x-git-receive-pack-request",
			});

			expect(response.status).toBe(200);
			expect(await repo.objectStore.exists(hash)).toBeTrue();
			expect(await repo.refStore.readRef("refs/heads/node-streamed")).toEqual({
				type: "direct",
				hash,
			});
		} finally {
			await node.close();
		}
	});

	test("returns 413 through the Fetch limit path without applying refs", async () => {
		const server = createServer({
			storage: new MemoryStorage(),
			receiveLimits: { maxRequestBytes: 96, maxPackBytes: 1024 },
			onError: false,
		});
		const repo = await server.createRepo("repo");
		const body = buildPushBody(
			ZERO_HASH,
			"a".repeat(40),
			"refs/heads/oversized",
			new Uint8Array(256),
		);
		const node = await startNodeServer(server);

		try {
			const response = await sendRequest(
				node.port,
				"/repo/git-receive-pack",
				splitBytes(body, [7]),
			);
			expect(response.status).toBe(413);
			expect(decoder.decode(response.body)).toContain("Request body too large");
			expect(await repo.refStore.readRef("refs/heads/oversized")).toBeNull();
		} finally {
			await node.close();
		}
	});

	test("pipes a real upload-pack response without calling arrayBuffer", async () => {
		const server = createServer({ storage: new MemoryStorage() });
		const repo = await server.createRepo("repo");
		const hash = await repo.objectStore.write("blob", encoder.encode("upload me"));
		await repo.refStore.writeRef("refs/heads/main", { type: "direct", hash });
		const originalFetch = server.fetch.bind(server);
		server.fetch = async (request) => {
			const response = await originalFetch(request);
			if (new URL(request.url).pathname.endsWith("/git-upload-pack")) {
				Object.defineProperty(response, "arrayBuffer", {
					value: () => {
						throw new Error("Node adapter buffered the response");
					},
				});
			}
			return response;
		};
		const uploadBody = concatPktLines(
			encodePktLine(`want ${hash} side-band-64k\n`),
			flushPkt(),
			encodePktLine("done\n"),
		);
		const node = await startNodeServer(server);

		try {
			const response = await sendRequest(
				node.port,
				"/repo/git-upload-pack",
				splitBytes(uploadBody),
				{ "Content-Type": "application/x-git-upload-pack-request" },
			);
			expect(response.status).toBe(200);
			expect(response.headers["content-type"]).toBe("application/x-git-upload-pack-result");
			expect(response.body.byteLength).toBeGreaterThan(0);
		} finally {
			await node.close();
		}
	});

	test("delivers the first response chunk before the Fetch body completes", async () => {
		const server = createServer({ storage: new MemoryStorage() });
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		server.fetch = async (request) => {
			await request.arrayBuffer();
			let sentFirst = false;
			return new Response(
				new ReadableStream<Uint8Array>({
					async pull(controller) {
						if (!sentFirst) {
							sentFirst = true;
							controller.enqueue(encoder.encode("first"));
							return;
						}
						await gate;
						controller.enqueue(encoder.encode("second"));
						controller.close();
					},
				}),
			);
		};
		const node = await startNodeServer(server);
		let resolveFirst!: (chunk: string) => void;
		const firstChunk = new Promise<string>((resolve) => {
			resolveFirst = resolve;
		});

		try {
			const responsePromise = sendRequest(
				node.port,
				"/repo/git-upload-pack",
				[encoder.encode("request")],
				{},
				(chunk) => resolveFirst(decoder.decode(chunk)),
			);
			expect(await timeout(firstChunk)).toBe("first");
			release();
			const response = await timeout(responsePromise);
			expect(decoder.decode(response.body)).toBe("firstsecond");
		} finally {
			release();
			await node.close();
		}
	});
});
