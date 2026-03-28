// ── pkt-line codec ──────────────────────────────────────────────────
// Wire framing protocol for Git smart transport.
// Spec: https://git-scm.com/docs/gitprotocol-common

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const MAX_PKT_LEN = 65520; // 4 header + 65516 payload
const FLUSH = new Uint8Array([0x30, 0x30, 0x30, 0x30]); // "0000"
const DELIM = new Uint8Array([0x30, 0x30, 0x30, 0x31]); // "0001"
const RESPONSE_END = new Uint8Array([0x30, 0x30, 0x30, 0x32]); // "0002"

// ── Types ────────────────────────────────────────────────────────────

export type PktLine =
	| { type: "data"; data: Uint8Array }
	| { type: "flush" }
	| { type: "delim" }
	| { type: "response-end" };

interface SidebandResult {
	packData: Uint8Array;
	progress: string[];
	errors: string[];
}

// ── Encoding ─────────────────────────────────────────────────────────

export function encodePktLine(data: string | Uint8Array): Uint8Array {
	const payload = typeof data === "string" ? encoder.encode(data) : data;
	const totalLen = 4 + payload.byteLength;
	if (totalLen > MAX_PKT_LEN) {
		throw new Error(`pkt-line too long: ${totalLen} bytes (max ${MAX_PKT_LEN})`);
	}
	const hex = totalLen.toString(16).padStart(4, "0");
	const result = new Uint8Array(totalLen);
	result[0] = hex.charCodeAt(0);
	result[1] = hex.charCodeAt(1);
	result[2] = hex.charCodeAt(2);
	result[3] = hex.charCodeAt(3);
	result.set(payload, 4);
	return result;
}

export function flushPkt(): Uint8Array {
	return FLUSH.slice();
}

export function delimPkt(): Uint8Array {
	return DELIM.slice();
}

export function responseEndPkt(): Uint8Array {
	return RESPONSE_END.slice();
}

export function concatPktLines(...lines: Uint8Array[]): Uint8Array {
	let total = 0;
	for (const l of lines) total += l.byteLength;
	const result = new Uint8Array(total);
	let offset = 0;
	for (const l of lines) {
		result.set(l, offset);
		offset += l.byteLength;
	}
	return result;
}

// ── Parsing ──────────────────────────────────────────────────────────

export function parsePktLineStream(buf: Uint8Array): PktLine[] {
	const lines: PktLine[] = [];
	let offset = 0;
	while (offset < buf.byteLength) {
		if (offset + 4 > buf.byteLength) {
			throw new Error("Truncated pkt-line header");
		}
		const lenHex = decoder.decode(buf.subarray(offset, offset + 4));
		const len = parseInt(lenHex, 16);
		if (Number.isNaN(len)) {
			throw new Error(`Invalid pkt-line length: ${lenHex}`);
		}
		if (len === 0) {
			lines.push({ type: "flush" });
			offset += 4;
			continue;
		}
		if (len === 1) {
			lines.push({ type: "delim" });
			offset += 4;
			continue;
		}
		if (len === 2) {
			lines.push({ type: "response-end" });
			offset += 4;
			continue;
		}
		if (len < 4) {
			throw new Error(`Invalid pkt-line length: ${len}`);
		}
		if (offset + len > buf.byteLength) {
			throw new Error(
				`Truncated pkt-line: need ${len} bytes at offset ${offset}, have ${buf.byteLength - offset}`,
			);
		}
		lines.push({ type: "data", data: buf.subarray(offset + 4, offset + len) });
		offset += len;
	}
	return lines;
}

/**
 * Read pkt-line text, stripping optional trailing LF.
 */
export function pktLineText(line: PktLine): string {
	if (line.type !== "data") return "";
	const text = decoder.decode(line.data);
	return text.endsWith("\n") ? text.slice(0, -1) : text;
}

// ── Streaming parser ─────────────────────────────────────────────────

const INIT_BUF_SIZE = 65536;

/**
 * Incrementally parse pkt-lines from a ReadableStream, yielding each
 * PktLine as soon as it is fully received. Handles network chunks that
 * split across pkt-line boundaries.
 */
export async function* parsePktLinesFromStream(
	stream: ReadableStream<Uint8Array>,
): AsyncGenerator<PktLine> {
	const reader = stream.getReader();
	let buf = new Uint8Array(INIT_BUF_SIZE);
	let bufLen = 0;

	try {
		for (;;) {
			// Drain complete pkt-lines from the buffer
			for (;;) {
				if (bufLen < 4) break;
				const lenHex = decoder.decode(buf.subarray(0, 4));
				const len = parseInt(lenHex, 16);
				if (Number.isNaN(len)) {
					throw new Error(`Invalid pkt-line length: ${lenHex}`);
				}
				if (len === 0) {
					yield { type: "flush" };
					consume(4);
					continue;
				}
				if (len === 1) {
					yield { type: "delim" };
					consume(4);
					continue;
				}
				if (len === 2) {
					yield { type: "response-end" };
					consume(4);
					continue;
				}
				if (len < 4) {
					throw new Error(`Invalid pkt-line length: ${len}`);
				}
				if (bufLen < len) break; // need more data
				yield { type: "data", data: buf.slice(4, len) };
				consume(len);
			}

			const { done, value } = await reader.read();
			if (done) break;
			if (value.byteLength === 0) continue;

			// Grow buffer if needed
			const needed = bufLen + value.byteLength;
			if (needed > buf.byteLength) {
				let newSize = buf.byteLength;
				while (newSize < needed) newSize *= 2;
				const next = new Uint8Array(newSize);
				next.set(buf.subarray(0, bufLen));
				buf = next;
			}
			buf.set(value, bufLen);
			bufLen += value.byteLength;
		}

		// Drain any remaining complete pkt-lines after stream ends
		for (;;) {
			if (bufLen < 4) break;
			const lenHex = decoder.decode(buf.subarray(0, 4));
			const len = parseInt(lenHex, 16);
			if (Number.isNaN(len)) {
				throw new Error(`Invalid pkt-line length: ${lenHex}`);
			}
			if (len === 0) {
				yield { type: "flush" };
				consume(4);
				continue;
			}
			if (len === 1) {
				yield { type: "delim" };
				consume(4);
				continue;
			}
			if (len === 2) {
				yield { type: "response-end" };
				consume(4);
				continue;
			}
			if (len < 4) {
				throw new Error(`Invalid pkt-line length: ${len}`);
			}
			if (bufLen < len) {
				throw new Error(`Truncated pkt-line: need ${len} bytes, have ${bufLen}`);
			}
			yield { type: "data", data: buf.slice(4, len) };
			consume(len);
		}

		if (bufLen > 0) {
			throw new Error("Truncated pkt-line header");
		}
	} finally {
		reader.releaseLock();
	}

	function consume(n: number) {
		buf.copyWithin(0, n, bufLen);
		bufLen -= n;
	}
}

// ── Side-band constants ──────────────────────────────────────────────

const BAND_DATA = 1;
const BAND_PROGRESS = 2;
const BAND_ERROR = 3;

// ── Streaming sideband demuxer ───────────────────────────────────────

interface StreamingSidebandResult {
	packData: Uint8Array;
	preambleLines: PktLine[];
}

/**
 * Consume an async pkt-line stream, dispatching sideband band-2 to
 * `onProgress` immediately and accumulating band-1 pack data. Preamble
 * lines (ACK/NAK/shallow — anything before sideband framing) are
 * collected and returned for the caller to interpret.
 *
 * Band-3 (error) throws immediately.
 */
export async function demuxSidebandStreaming(
	lines: AsyncIterable<PktLine>,
	onProgress?: (message: string) => void,
): Promise<StreamingSidebandResult> {
	const preambleLines: PktLine[] = [];
	const packChunks: Uint8Array[] = [];
	let totalPackBytes = 0;
	let inSideband = false;

	for await (const line of lines) {
		if (line.type !== "data") {
			if (!inSideband) preambleLines.push(line);
			continue;
		}
		if (line.data.byteLength === 0) {
			if (!inSideband) preambleLines.push(line);
			continue;
		}

		const firstByte = line.data[0]!;

		// Detect transition into sideband mode: band byte is 1, 2, or 3
		if (!inSideband) {
			if (firstByte >= 1 && firstByte <= 3) {
				inSideband = true;
			} else {
				preambleLines.push(line);
				continue;
			}
		}

		const payload = line.data.subarray(1);
		switch (firstByte) {
			case BAND_DATA:
				packChunks.push(payload);
				totalPackBytes += payload.byteLength;
				break;
			case BAND_PROGRESS:
				onProgress?.(decoder.decode(payload));
				break;
			case BAND_ERROR:
				throw new Error(`Remote error: ${decoder.decode(payload)}`);
			default:
				break;
		}
	}

	const packData = new Uint8Array(totalPackBytes);
	let offset = 0;
	for (const chunk of packChunks) {
		packData.set(chunk, offset);
		offset += chunk.byteLength;
	}

	return { packData, preambleLines };
}

// ── Side-band-64k demuxing (batch) ───────────────────────────────────

export function demuxSideband(pktLines: PktLine[]): SidebandResult {
	const packChunks: Uint8Array[] = [];
	const progress: string[] = [];
	const errors: string[] = [];
	let totalPackBytes = 0;

	for (const line of pktLines) {
		if (line.type !== "data") continue;
		if (line.data.byteLength === 0) continue;

		const band = line.data[0];
		if (band === undefined) continue;
		const payload = line.data.subarray(1);

		switch (band) {
			case BAND_DATA:
				packChunks.push(payload);
				totalPackBytes += payload.byteLength;
				break;
			case BAND_PROGRESS:
				progress.push(decoder.decode(payload));
				break;
			case BAND_ERROR:
				errors.push(decoder.decode(payload));
				break;
			default:
				// Ignore unknown sideband channels for forward compatibility
				break;
		}
	}

	const packData = new Uint8Array(totalPackBytes);
	let offset = 0;
	for (const chunk of packChunks) {
		packData.set(chunk, offset);
		offset += chunk.byteLength;
	}

	return { packData, progress, errors };
}
