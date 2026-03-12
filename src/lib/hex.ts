import type { ObjectId } from "./types.ts";

/** The null/zero SHA-1 hash (40 '0' chars), used to represent "no object" in refs and reflogs. */
export const ZERO_HASH: ObjectId = "0000000000000000000000000000000000000000" as ObjectId;

const LUT = /* @__PURE__ */ (() => {
	const t = new Array<string>(256);
	for (let i = 0; i < 256; i++) t[i] = (i >> 4).toString(16) + (i & 0xf).toString(16);
	return t;
})();

/** Convert 20 raw SHA-1 bytes to a 40-char lowercase hex string. */
export function bytesToHex(bytes: Uint8Array): ObjectId {
	let hex = "";
	for (let i = 0; i < 20; i++) hex += LUT[bytes[i]!]!;
	return hex as ObjectId;
}

/** Read 20 raw SHA-1 bytes at `offset` in `data` and return a 40-char hex string. */
export function hexAt(data: Uint8Array, offset: number): ObjectId {
	let hex = "";
	for (let i = 0; i < 20; i++) hex += LUT[data[offset + i]!]!;
	return hex as ObjectId;
}

/** Convert a 40-char hex hash to 20 raw bytes. */
export function hexToBytes(hex: string): Uint8Array {
	const bytes = new Uint8Array(20);
	for (let i = 0; i < 20; i++) {
		bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	}
	return bytes;
}
