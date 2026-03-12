// ── pkt-line codec ──────────────────────────────────────────────────
// Wire framing protocol for Git smart transport.
// Spec: https://git-scm.com/docs/gitprotocol-common

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const MAX_PKT_LEN = 65520; // 4 header + 65516 payload
const FLUSH = new Uint8Array([0x30, 0x30, 0x30, 0x30]); // "0000"

// ── Types ────────────────────────────────────────────────────────────

export type PktLine = { type: "data"; data: Uint8Array } | { type: "flush" };

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
	if (line.type === "flush") return "";
	const text = decoder.decode(line.data);
	return text.endsWith("\n") ? text.slice(0, -1) : text;
}

// ── Side-band-64k demuxing ───────────────────────────────────────────

const BAND_DATA = 1;
const BAND_PROGRESS = 2;
const BAND_ERROR = 3;

export function demuxSideband(pktLines: PktLine[]): SidebandResult {
	const packChunks: Uint8Array[] = [];
	const progress: string[] = [];
	const errors: string[] = [];
	let totalPackBytes = 0;

	for (const line of pktLines) {
		if (line.type === "flush") continue;
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
