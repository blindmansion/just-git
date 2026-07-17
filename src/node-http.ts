/** Node.js `http.IncomingMessage`-compatible request interface. */
export interface NodeHttpRequest {
	method?: string;
	url?: string;
	headers: Record<string, string | string[] | undefined>;
	on(event: string, listener: (...args: any[]) => void): any;
	off?(event: string, listener: (...args: any[]) => void): any;
	pause?(): any;
	resume?(): any;
	destroy?(error?: Error): any;
}

/** Node.js `http.ServerResponse`-compatible response interface. */
export interface NodeHttpResponse {
	writeHead(statusCode: number, headers?: Record<string, string | string[]>): any;
	write(chunk: any): boolean | void;
	end(data?: string): any;
	on?(event: string, listener: (...args: any[]) => void): any;
	once?(event: string, listener: (...args: any[]) => void): any;
	off?(event: string, listener: (...args: any[]) => void): any;
	destroy?(error?: Error): any;
}

/** A Fetch request backed by a Node request stream. */
export interface NodeRequestBridge {
	request: Request;
	/**
	 * Stop an unread request body after an early response.
	 *
	 * This is a no-op once the Node request has reached EOF.
	 */
	cleanup(): void;
}

/** Convert Node's string-or-array header representation to Fetch headers. */
export function nodeHeadersToWeb(headers: Record<string, string | string[] | undefined>): Headers {
	const result = new Headers();
	for (const [name, value] of Object.entries(headers)) {
		if (value === undefined) continue;
		if (Array.isArray(value)) {
			for (const item of value) result.append(name, item);
		} else {
			result.set(name, value);
		}
	}
	return result;
}

/**
 * Construct a Fetch request whose body pulls from a Node request stream.
 *
 * Full request backpressure requires `pause` and `resume`, as provided by a
 * real Node `http.IncomingMessage`.
 */
export function nodeRequestToWebRequest(req: NodeHttpRequest): NodeRequestBridge {
	const method = req.method ?? "GET";
	const host = typeof req.headers.host === "string" ? req.headers.host : "localhost";
	const url = new URL(req.url ?? "/", `http://${host}`);
	const headers = nodeHeadersToWeb(req.headers);

	if (method.toUpperCase() === "GET" || method.toUpperCase() === "HEAD") {
		return {
			request: new Request(url.href, { method, headers }),
			cleanup() {},
		};
	}

	let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
	let active = true;
	let reachedEof = false;

	const onData = (chunk: unknown): void => {
		if (!active || !controller) return;
		try {
			controller.enqueue(copyNodeChunk(chunk));
			if (controller.desiredSize !== null && controller.desiredSize <= 0) {
				req.pause?.();
			}
		} catch (error) {
			failRequestBody(toError(error, "Invalid request body chunk"), true);
		}
	};
	const onEnd = (): void => {
		if (!active || !controller) return;
		active = false;
		reachedEof = true;
		removeRequestListeners();
		controller.close();
	};
	const onError = (error?: unknown): void => {
		failRequestBody(toError(error, "Request stream failed"), false);
	};
	const onAborted = (): void => {
		failRequestBody(new Error("Request aborted"), false);
	};

	function removeRequestListeners(): void {
		req.off?.("data", onData);
		req.off?.("end", onEnd);
		req.off?.("error", onError);
		req.off?.("aborted", onAborted);
	}

	function destroyRequest(error?: Error): void {
		try {
			req.destroy?.(error);
		} catch {
			// The stream is already terminal; destruction is best-effort.
		}
	}

	function failRequestBody(error: Error, destroy: boolean): void {
		if (!active) return;
		active = false;
		removeRequestListeners();
		controller?.error(error);
		if (destroy) destroyRequest(error);
	}

	req.pause?.();
	const body = new ReadableStream<Uint8Array>({
		start(streamController) {
			controller = streamController;
			req.on("data", onData);
			req.on("end", onEnd);
			req.on("error", onError);
			req.on("aborted", onAborted);
		},
		pull() {
			if (active) req.resume?.();
		},
		cancel(reason) {
			if (!active) return;
			active = false;
			removeRequestListeners();
			destroyRequest(reason instanceof Error ? reason : undefined);
		},
	});

	let request: Request;
	try {
		request = new Request(url.href, {
			method,
			headers,
			body,
			duplex: "half",
		} as RequestInit);
	} catch (error) {
		failRequestBody(toError(error, "Could not construct request"), true);
		throw error;
	}

	return {
		request,
		cleanup() {
			if (!active || reachedEof) return;
			const error = new Error("Request body was not fully consumed");
			failRequestBody(error, true);
		},
	};
}

/**
 * Pipe a Fetch response to Node while honoring Node's writable backpressure.
 *
 * Full response backpressure requires `once` or `on` plus `off`, as provided
 * by a real Node `http.ServerResponse`.
 */
export async function pipeWebResponseToNode(
	response: Response,
	res: NodeHttpResponse,
): Promise<void> {
	const headers = webHeadersToNode(response.headers);
	let ended = false;

	const endOnce = (): void => {
		if (ended) return;
		ended = true;
		res.end();
	};

	if (!response.body) {
		res.writeHead(response.status, headers);
		endOnce();
		return;
	}

	const reader = response.body.getReader();
	let committed = false;
	let completed = false;
	let disconnectError: Error | undefined;
	let resolveDisconnect!: (error: Error) => void;
	const disconnected = new Promise<Error>((resolve) => {
		resolveDisconnect = resolve;
	});

	const onClose = (): void => {
		disconnect(new Error("Node response closed"));
	};
	const onError = (error?: unknown): void => {
		disconnect(toError(error, "Node response failed"));
	};
	const removeClose = addResponseListener(res, "close", onClose);
	const removeError = addResponseListener(res, "error", onError);

	function disconnect(error: Error): void {
		if (completed || disconnectError) return;
		disconnectError = error;
		resolveDisconnect(error);
		void reader.cancel(error).catch(() => {});
	}

	try {
		res.writeHead(response.status, headers);
		committed = true;

		for (;;) {
			const result = await raceDisconnect(reader.read(), disconnected);
			if (disconnectError) throw disconnectError;
			if (result.done) break;
			if (res.write(result.value) === false) {
				await waitForDrain(res, disconnected);
			}
		}

		if (disconnectError) throw disconnectError;
		completed = true;
		endOnce();
	} catch (error) {
		completed = true;
		const failure = toError(error, "Response stream failed");
		try {
			await reader.cancel(failure);
		} catch {
			// Preserve the original response or socket failure.
		}

		if (!disconnectError && committed) {
			if (res.destroy) {
				try {
					res.destroy(failure);
				} catch {
					// The response is already terminal.
				}
			} else {
				try {
					endOnce();
				} catch {
					// The response is already terminal.
				}
			}
		}
		throw failure;
	} finally {
		removeClose();
		removeError();
		try {
			reader.releaseLock();
		} catch {
			// A non-standard stream may keep its reader locked after failure.
		}
	}
}

function copyNodeChunk(chunk: unknown): Uint8Array {
	if (typeof chunk === "string") return new TextEncoder().encode(chunk);
	if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk.slice(0));
	if (ArrayBuffer.isView(chunk)) {
		return Uint8Array.from(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
	}
	throw new TypeError("Node request emitted a non-byte chunk");
}

function toError(error: unknown, fallback: string): Error {
	return error instanceof Error ? error : new Error(fallback);
}

function webHeadersToNode(headers: Headers): Record<string, string | string[]> {
	const result: Record<string, string | string[]> = {};
	const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
	const setCookies = getSetCookie?.call(headers);
	headers.forEach((value, name) => {
		if (name === "set-cookie" && setCookies?.length) return;
		result[name] = value;
	});
	if (setCookies?.length) result["set-cookie"] = setCookies;
	return result;
}

function addResponseListener(
	res: NodeHttpResponse,
	event: string,
	listener: (...args: any[]) => void,
): () => void {
	const add = res.once ?? res.on;
	if (!add) return () => {};
	add.call(res, event, listener);
	return () => {
		res.off?.(event, listener);
	};
}

async function raceDisconnect<T>(operation: Promise<T>, disconnected: Promise<Error>): Promise<T> {
	return Promise.race([operation, disconnected.then((error) => Promise.reject(error))]);
}

function waitForDrain(res: NodeHttpResponse, disconnected: Promise<Error>): Promise<void> {
	const add = res.once ?? res.on;
	if (!add) return Promise.resolve();

	return new Promise<void>((resolve, reject) => {
		let settled = false;
		const onDrain = (): void => {
			if (settled) return;
			settled = true;
			res.off?.("drain", onDrain);
			resolve();
		};
		add.call(res, "drain", onDrain);
		void disconnected.then((error) => {
			if (settled) return;
			settled = true;
			res.off?.("drain", onDrain);
			reject(error);
		});
	});
}
