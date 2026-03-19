// ── Zlib abstraction ─────────────────────────────────────────────────
// Thin wrapper over platform-specific zlib. Uses zlib format (RFC 1950)
// with the 2-byte header and adler32 checksum, matching what git expects
// inside packfiles and loose objects.
//
// Primary: node:zlib (Bun, Node, Deno) — fastest, synchronous.
// Fallback: vendored fflate inflate (pure JS, works everywhere) +
//           CompressionStream for deflation.

import { pureInflate, pureInflateWithConsumed } from "./fflate.ts";

interface InflateResult {
	result: Uint8Array;
	bytesConsumed: number;
}

interface ZlibProvider {
	deflateSync(data: Uint8Array): Uint8Array | Promise<Uint8Array>;
	inflateSync(data: Uint8Array): Uint8Array | Promise<Uint8Array>;
	inflateWithConsumed(data: Uint8Array): InflateResult;
}

async function detect(): Promise<ZlibProvider> {
	let zlib: any;
	// @ts-ignore — dom types not included; runtime check is intentional
	const isBrowser = typeof document !== "undefined";
	if (!isBrowser) {
		try {
			zlib = require(["node", "zlib"].join(":"));
		} catch {
			try {
				const specifier = ["node", "zlib"].join(":");
				zlib = await import(specifier);
			} catch {
				// neither require nor import worked — not a Node-like runtime
			}
		}
	}

	if (zlib && typeof zlib.deflateSync === "function" && typeof zlib.inflateSync === "function") {
		let iwc: ((data: Uint8Array) => InflateResult) | null = null;
		try {
			const probe = zlib.inflateSync(zlib.deflateSync(Buffer.from("x")), {
				info: true,
			}) as unknown as { engine?: { bytesWritten: number } } | undefined;
			if (probe?.engine && typeof probe.engine.bytesWritten === "number") {
				iwc = (data) => {
					const r = zlib.inflateSync(data, { info: true }) as unknown as {
						buffer: Buffer;
						engine: { bytesWritten: number };
					};
					return {
						result: new Uint8Array(r.buffer),
						bytesConsumed: r.engine.bytesWritten,
					};
				};
			}
		} catch {
			// { info: true } not supported on this runtime (e.g. Deno)
		}
		return {
			deflateSync: (data) => new Uint8Array(zlib.deflateSync(data)),
			inflateSync: (data) => new Uint8Array(zlib.inflateSync(data)),
			inflateWithConsumed: iwc ?? pureInflateWithConsumed,
		};
	}

	// No node:zlib — use vendored inflate (pure JS) and CompressionStream
	// for deflation. inflateWithConsumed is always available via fflate.
	let deflateFn: ZlibProvider["deflateSync"];
	if (typeof globalThis.CompressionStream === "function") {
		deflateFn = async (data) => {
			const cs = new CompressionStream("deflate");
			const writer = cs.writable.getWriter();
			writer.write(data as Uint8Array<ArrayBuffer>);
			writer.close();
			return new Uint8Array(await new Response(cs.readable).arrayBuffer());
		};
	} else {
		deflateFn = () => {
			throw new Error(
				"No deflate implementation available. Requires node:zlib or CompressionStream.",
			);
		};
	}

	return {
		deflateSync: deflateFn,
		inflateSync: pureInflate,
		inflateWithConsumed: pureInflateWithConsumed,
	};
}

// Lazy singleton — resolved on first call to any exported function.
let _promise: Promise<ZlibProvider> | null = null;
function provider(): Promise<ZlibProvider> {
	return (_promise ??= detect());
}

// ── Public API ──────────────────────────────────────────────────────

export async function deflate(data: Uint8Array): Promise<Uint8Array> {
	return await (await provider()).deflateSync(data);
}

export async function inflate(data: Uint8Array): Promise<Uint8Array> {
	return await (await provider()).inflateSync(data);
}

/**
 * Inflate a single zlib-compressed object from a buffer that may contain
 * trailing data (back-to-back entries in a packfile). Returns the
 * decompressed bytes and the number of compressed bytes consumed.
 *
 * Uses node:zlib `{ info: true }` when available (Bun, Node), otherwise
 * falls back to vendored fflate which tracks the DEFLATE bit position.
 */
export async function inflateObject(
	data: Uint8Array,
	expectedSize: number,
): Promise<InflateResult> {
	const p = await provider();
	const { result, bytesConsumed } = p.inflateWithConsumed(data);
	if (result.byteLength !== expectedSize) {
		throw new Error(`Inflate size mismatch: got ${result.byteLength}, expected ${expectedSize}`);
	}
	return { result, bytesConsumed };
}
