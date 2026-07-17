import { describe, expect, test } from "bun:test";
import {
	nodeHeadersToWeb,
	nodeRequestToWebRequest,
	pipeWebResponseToNode,
	type NodeHttpRequest,
	type NodeHttpResponse,
} from "../src/node-http.ts";

class MockRequest implements NodeHttpRequest {
	method?: string;
	url?: string;
	headers: Record<string, string | string[] | undefined>;
	pauseCalls = 0;
	resumeCalls = 0;
	destroyCalls = 0;
	destroyError?: Error;
	private listeners = new Map<string, Set<(...args: any[]) => void>>();

	constructor(
		method = "POST",
		url = "/git",
		headers: Record<string, string | string[] | undefined> = { host: "example.test" },
	) {
		this.method = method;
		this.url = url;
		this.headers = headers;
	}

	on(event: string, listener: (...args: any[]) => void): void {
		let eventListeners = this.listeners.get(event);
		if (!eventListeners) {
			eventListeners = new Set();
			this.listeners.set(event, eventListeners);
		}
		eventListeners.add(listener);
	}

	off(event: string, listener: (...args: any[]) => void): void {
		this.listeners.get(event)?.delete(listener);
	}

	pause(): void {
		this.pauseCalls++;
	}

	resume(): void {
		this.resumeCalls++;
	}

	destroy(error?: Error): void {
		this.destroyCalls++;
		this.destroyError = error;
	}

	emit(event: string, ...args: unknown[]): void {
		for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
	}

	listenerCount(): number {
		let count = 0;
		for (const listeners of this.listeners.values()) count += listeners.size;
		return count;
	}
}

class MockResponse implements NodeHttpResponse {
	status = 0;
	headers: Record<string, string | string[]> = {};
	chunks: Uint8Array[] = [];
	endCalls = 0;
	destroyCalls = 0;
	destroyError?: Error;
	blockNextWrite = false;
	private listeners = new Map<string, Set<(...args: any[]) => void>>();

	writeHead(status: number, headers?: Record<string, string | string[]>): void {
		this.status = status;
		this.headers = headers ?? {};
	}

	write(chunk: Uint8Array): boolean {
		this.chunks.push(Uint8Array.from(chunk));
		if (this.blockNextWrite) {
			this.blockNextWrite = false;
			return false;
		}
		return true;
	}

	end(): void {
		this.endCalls++;
	}

	on(event: string, listener: (...args: any[]) => void): void {
		let eventListeners = this.listeners.get(event);
		if (!eventListeners) {
			eventListeners = new Set();
			this.listeners.set(event, eventListeners);
		}
		eventListeners.add(listener);
	}

	off(event: string, listener: (...args: any[]) => void): void {
		this.listeners.get(event)?.delete(listener);
	}

	destroy(error?: Error): void {
		this.destroyCalls++;
		this.destroyError = error;
	}

	emit(event: string, ...args: unknown[]): void {
		for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
	}

	listenerCount(): number {
		let count = 0;
		for (const listeners of this.listeners.values()) count += listeners.size;
		return count;
	}
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function tick(): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("Node request bridge", () => {
	test("preserves request metadata and array-valued headers", () => {
		const headers = nodeHeadersToWeb({
			host: "git.example",
			"x-value": ["one", "two"],
			ignored: undefined,
		});
		expect(headers.get("host")).toBe("git.example");
		expect(headers.get("x-value")).toBe("one, two");
		expect(headers.has("ignored")).toBeFalse();

		const req = new MockRequest("POST", "/repo.git/git-upload-pack?version=2", {
			host: "git.example",
			"x-value": ["one", "two"],
		});
		const bridge = nodeRequestToWebRequest(req);
		expect(bridge.request.method).toBe("POST");
		expect(bridge.request.url).toBe("http://git.example/repo.git/git-upload-pack?version=2");
		expect(bridge.request.headers.get("x-value")).toBe("one, two");
		bridge.cleanup();
	});

	test.each(["GET", "HEAD"])("%s requests omit the body", (method) => {
		const req = new MockRequest(method);
		const bridge = nodeRequestToWebRequest(req);
		expect(bridge.request.body).toBeNull();
		expect(req.pauseCalls).toBe(0);
		expect(req.listenerCount()).toBe(0);
		bridge.cleanup();
		expect(req.destroyCalls).toBe(0);
	});

	test("pauses a full Web queue and resumes when it is pulled", async () => {
		const req = new MockRequest();
		const bridge = nodeRequestToWebRequest(req);
		expect(req.pauseCalls).toBe(1);

		req.emit("data", encoder.encode("first"));
		expect(req.pauseCalls).toBe(2);

		const reader = bridge.request.body!.getReader();
		const first = await reader.read();
		expect(decoder.decode(first.value)).toBe("first");
		await tick();
		expect(req.resumeCalls).toBeGreaterThan(0);

		req.emit("end");
		expect((await reader.read()).done).toBeTrue();
		expect(req.listenerCount()).toBe(0);
		expect(req.destroyCalls).toBe(0);
	});

	test.each([
		["error", new Error("broken upload"), "broken upload"],
		["aborted", undefined, "Request aborted"],
	] as const)("%s errors the Web body and removes listeners", async (event, reason, message) => {
		const req = new MockRequest();
		const bridge = nodeRequestToWebRequest(req);
		const reader = bridge.request.body!.getReader();
		req.emit(event, reason);
		await expect(reader.read()).rejects.toThrow(message);
		expect(req.listenerCount()).toBe(0);
	});

	test("Web cancellation is destroyed by bridge cleanup and removes listeners", async () => {
		const req = new MockRequest();
		const bridge = nodeRequestToWebRequest(req);
		await bridge.request.body!.cancel(new Error("consumer stopped"));
		expect(req.destroyCalls).toBe(0);
		bridge.cleanup();
		expect(req.destroyCalls).toBe(1);
		expect(req.destroyError).toBeUndefined();
		expect(req.listenerCount()).toBe(0);
	});

	test("cleanup destroys an unread request but is a no-op after EOF", async () => {
		const unread = new MockRequest();
		const unreadBridge = nodeRequestToWebRequest(unread);
		unreadBridge.cleanup();
		unreadBridge.cleanup();
		expect(unread.destroyCalls).toBe(1);
		expect(unread.listenerCount()).toBe(0);

		const complete = new MockRequest();
		const completeBridge = nodeRequestToWebRequest(complete);
		complete.emit("end");
		await tick();
		completeBridge.cleanup();
		expect(complete.destroyCalls).toBe(0);
	});
});

describe("Node response bridge", () => {
	test("writes response chunks incrementally and ends once", async () => {
		let streamController!: ReadableStreamDefaultController<Uint8Array>;
		const response = new Response(
			new ReadableStream({
				start(controller) {
					streamController = controller;
				},
			}),
			{ status: 201, headers: { "x-result": "created" } },
		);
		const res = new MockResponse();
		const piping = pipeWebResponseToNode(response, res);

		streamController.enqueue(encoder.encode("one"));
		await tick();
		expect(res.status).toBe(201);
		expect(res.headers["x-result"]).toBe("created");
		expect(res.chunks.map((chunk) => decoder.decode(chunk))).toEqual(["one"]);
		expect(res.endCalls).toBe(0);

		streamController.enqueue(encoder.encode("two"));
		streamController.close();
		await piping;
		expect(res.chunks.map((chunk) => decoder.decode(chunk))).toEqual(["one", "two"]);
		expect(res.endCalls).toBe(1);
		expect(res.listenerCount()).toBe(0);
	});

	test("waits for drain before writing the next chunk", async () => {
		let streamController!: ReadableStreamDefaultController<Uint8Array>;
		const response = new Response(
			new ReadableStream({
				start(controller) {
					streamController = controller;
				},
			}),
		);
		const res = new MockResponse();
		res.blockNextWrite = true;
		const piping = pipeWebResponseToNode(response, res);

		streamController.enqueue(encoder.encode("one"));
		streamController.enqueue(encoder.encode("two"));
		streamController.close();
		await tick();
		expect(res.chunks.map((chunk) => decoder.decode(chunk))).toEqual(["one"]);

		res.emit("drain");
		await piping;
		expect(res.chunks.map((chunk) => decoder.decode(chunk))).toEqual(["one", "two"]);
		expect(res.endCalls).toBe(1);
	});

	test("cancels the Web response when the Node client closes", async () => {
		let streamController!: ReadableStreamDefaultController<Uint8Array>;
		let canceledWith: unknown;
		const response = new Response(
			new ReadableStream({
				start(controller) {
					streamController = controller;
				},
				cancel(reason) {
					canceledWith = reason;
				},
			}),
		);
		const res = new MockResponse();
		res.blockNextWrite = true;
		const piping = pipeWebResponseToNode(response, res);
		streamController.enqueue(encoder.encode("one"));
		await tick();

		res.emit("close");
		await expect(piping).rejects.toThrow("Node response closed");
		expect(canceledWith).toBeInstanceOf(Error);
		expect(res.endCalls).toBe(0);
		expect(res.listenerCount()).toBe(0);
	});

	test("ends an empty response once", async () => {
		const res = new MockResponse();
		await pipeWebResponseToNode(new Response(null, { status: 204 }), res);
		expect(res.status).toBe(204);
		expect(res.chunks).toEqual([]);
		expect(res.endCalls).toBe(1);
	});

	test("surfaces an already-failed response stream and destroys Node output", async () => {
		const response = new Response(
			new ReadableStream({
				start(controller) {
					controller.error(new Error("upstream failed"));
				},
			}),
		);
		const res = new MockResponse();
		await expect(pipeWebResponseToNode(response, res)).rejects.toThrow("upstream failed");
		expect(res.destroyCalls).toBe(1);
		expect(res.destroyError?.message).toBe("upstream failed");
		expect(res.endCalls).toBe(0);
		expect(res.listenerCount()).toBe(0);
	});
});
