import { bytesToHex } from "./hex.ts";
import type { ObjectId } from "./types.ts";

// ── Hasher interface ────────────────────────────────────────────────

interface Sha1Hasher {
	update(data: Uint8Array | string): Sha1Hasher;
	hex(): Promise<ObjectId>;
}

// ── Platform detection (runs once at module load) ───────────────────

const encoder = new TextEncoder();

function toBytes(data: Uint8Array | string): Uint8Array {
	return typeof data === "string" ? encoder.encode(data) : data;
}

type HasherFactory = () => Sha1Hasher;

function detectHasher(): HasherFactory {
	// Bun
	if (typeof globalThis.Bun !== "undefined") {
		return () => {
			const h = new Bun.CryptoHasher("sha1");
			const hasher: Sha1Hasher = {
				update(data) {
					h.update(toBytes(data));
					return hasher;
				},
				hex: () => Promise.resolve(h.digest("hex") as ObjectId),
			};
			return hasher;
		};
	}

	// Node.js / Deno (Deno supports node:crypto via its Node compat layer).
	// String construction hides the specifier from bundlers that would
	// otherwise try to resolve/polyfill it for browser targets.
	try {
		const nodeCrypto = require(["node", "crypto"].join(":"));
		if (typeof nodeCrypto.createHash === "function") {
			return () => {
				const h = nodeCrypto.createHash("sha1");
				const hasher: Sha1Hasher = {
					update(data) {
						h.update(toBytes(data));
						return hasher;
					},
					hex: () => Promise.resolve(h.digest("hex") as ObjectId),
				};
				return hasher;
			};
		}
	} catch {
		// Fall through
	}

	// Browser: Web Crypto API (async-only)
	if (typeof globalThis.crypto?.subtle?.digest === "function") {
		return () => {
			const chunks: Uint8Array[] = [];
			const hasher: Sha1Hasher = {
				update(data) {
					chunks.push(toBytes(data));
					return hasher;
				},
				async hex() {
					let total = 0;
					for (const c of chunks) total += c.byteLength;
					const merged = new Uint8Array(total);
					let offset = 0;
					for (const c of chunks) {
						merged.set(c, offset);
						offset += c.byteLength;
					}
					const buf = await crypto.subtle.digest("SHA-1", merged);
					return bytesToHex(new Uint8Array(buf));
				},
			};
			return hasher;
		};
	}

	throw new Error(
		"No SHA-1 implementation available. Requires Bun, Node.js, Deno, or a browser with Web Crypto.",
	);
}

const _createHasher = detectHasher();

// ── Public API ──────────────────────────────────────────────────────

/** Create an incremental SHA-1 hasher. */
export const createHasher: () => Sha1Hasher = _createHasher;

/** Compute the SHA-1 hash of raw bytes, returned as a 40-char hex string. */
export async function sha1(data: Uint8Array): Promise<ObjectId> {
	return _createHasher().update(data).hex();
}
