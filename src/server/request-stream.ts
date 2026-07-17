/**
 * Protocol-aware readers for streamed Git request bodies.
 *
 * Shared by HTTP receive-pack and SSH sessions. The command section is
 * pkt-line framed; bytes after its flush packet are the raw pack stream.
 */

import type { PushCommand } from "../lib/transport/smart-http.ts";
import { RequestLimitError } from "./errors.ts";

interface ByteReader {
	read(): Promise<{ value?: Uint8Array; done: boolean }>;
	releaseLock(): void;
}

const decoder = new TextDecoder();
const MAX_PKT_LINE_LENGTH = 65520;

export interface ReceivePackCommandLimits {
	maxCommandBytes?: number;
	maxCommands?: number;
}

/**
 * Buffered reader over a ReadableStream that supports exact-byte reads and
 * pkt-line parsing. Transport chunks need not align to pkt-line boundaries.
 */
export class StreamPktLineReader {
	private buf = new Uint8Array(0);
	private byteReader: ByteReader;
	private eof = false;

	constructor(readable: ReadableStream<Uint8Array>) {
		this.byteReader = readable.getReader() as ByteReader;
	}

	private async fill(needed: number): Promise<boolean> {
		while (this.buf.byteLength < needed && !this.eof) {
			const result = await this.byteReader.read();
			if (result.done || !result.value) {
				this.eof = true;
				break;
			}
			const value = result.value;
			const merged = new Uint8Array(this.buf.byteLength + value.byteLength);
			merged.set(this.buf);
			merged.set(value, this.buf.byteLength);
			this.buf = merged;
		}
		return this.buf.byteLength >= needed;
	}

	private consume(n: number): Uint8Array {
		const result = this.buf.subarray(0, n);
		this.buf = this.buf.subarray(n);
		return result;
	}

	/** Read a single pkt-line. Returns null on EOF before a complete line. */
	async readPktLine(): Promise<
		| { type: "flush"; raw: Uint8Array }
		| { type: "delim"; raw: Uint8Array }
		| { type: "response-end"; raw: Uint8Array }
		| { type: "data"; raw: Uint8Array; text: string }
		| null
	> {
		if (!(await this.fill(4))) return null;
		const lenHex = decoder.decode(this.buf.subarray(0, 4));
		if (!/^[0-9a-fA-F]{4}$/.test(lenHex)) return null;
		const len = parseInt(lenHex, 16);
		if (len === 0) return { type: "flush", raw: this.consume(4) };
		if (len === 1) return { type: "delim", raw: this.consume(4) };
		if (len === 2) return { type: "response-end", raw: this.consume(4) };
		if (len < 4 || len > MAX_PKT_LINE_LENGTH) return null;
		if (!(await this.fill(len))) return null;
		const raw = new Uint8Array(this.consume(len));
		return { type: "data", raw, text: decoder.decode(raw.subarray(4)) };
	}

	/**
	 * Yield remaining bytes without buffering the full body. Any bytes read
	 * beyond the command flush are yielded before forwarding transport chunks.
	 */
	async *streamRemaining(): AsyncGenerator<Uint8Array> {
		if (this.buf.byteLength > 0) {
			yield this.consume(this.buf.byteLength);
		}
		while (!this.eof) {
			const result = await this.byteReader.read();
			if (result.done || !result.value) {
				this.eof = true;
				break;
			}
			yield result.value;
		}
	}

	release(): void {
		this.byteReader.releaseLock();
	}
}

/**
 * Parse receive-pack commands through their flush packet, leaving raw pack
 * bytes available through `reader.streamRemaining()`.
 */
export async function readReceivePackCommands(
	reader: StreamPktLineReader,
	limits: ReceivePackCommandLimits = {},
): Promise<{ commands: PushCommand[]; capabilities: string[]; sawFlush: boolean }> {
	const commands: PushCommand[] = [];
	let capabilities: string[] = [];
	let first = true;
	let sawFlush = false;
	let commandBytes = 0;

	while (true) {
		const line = await reader.readPktLine();
		if (!line) break;
		if (line.type === "flush") {
			sawFlush = true;
			break;
		}
		if (line.type !== "data") continue;

		commandBytes += line.raw.byteLength;
		if (limits.maxCommandBytes !== undefined && commandBytes > limits.maxCommandBytes) {
			throw new RequestLimitError("Receive-pack command section too large");
		}

		let text = line.text;
		if (text.endsWith("\n")) text = text.slice(0, -1);

		if (first) {
			const nulIdx = text.indexOf("\0");
			if (nulIdx !== -1) {
				capabilities = text
					.slice(nulIdx + 1)
					.split(" ")
					.filter(Boolean);
				text = text.slice(0, nulIdx);
			}
			first = false;
		}

		const parts = text.split(" ");
		if (parts.length >= 3) {
			if (limits.maxCommands !== undefined && commands.length >= limits.maxCommands) {
				throw new RequestLimitError("Too many receive-pack commands");
			}
			commands.push({
				oldHash: parts[0]!,
				newHash: parts[1]!,
				refName: parts[2]!,
			});
		}
	}

	return { commands, capabilities, sawFlush };
}
