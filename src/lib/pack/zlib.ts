// ── Zlib abstraction ─────────────────────────────────────────────────
// Thin wrapper over platform-specific zlib. Uses zlib format (RFC 1950)
// with the 2-byte header and adler32 checksum, matching what git expects
// inside packfiles and loose objects.
//
// Primary: node:zlib (Bun, Node, Deno) — fastest, synchronous.
// Fallback: vendored fflate (pure JS, works everywhere) for inflation;
//           CompressionStream for deflation, falling back to vendored
//           fflate pure-JS deflate when CompressionStream is absent.

import { pureDeflate, pureInflate, pureInflateWithConsumed } from "./fflate.ts";

interface InflateResult {
	result: Uint8Array;
	bytesConsumed: number;
}

interface ZlibProvider {
	deflateSync(data: Uint8Array): Uint8Array | Promise<Uint8Array>;
	inflateSync(data: Uint8Array): Uint8Array | Promise<Uint8Array>;
	// `maxOutputBytes`, when set, bounds the decompressed output so a single
	// stream cannot inflate beyond the size its object header declares.
	inflateWithConsumed(data: Uint8Array, maxOutputBytes?: number): InflateResult;
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
		let iwc: ((data: Uint8Array, maxOutputBytes?: number) => InflateResult) | null = null;
		try {
			// The packfile walk relies on `{ info: true }` (a) not erroring on
			// trailing data after the stream ends and (b) reporting only the
			// consumed compressed bytes. Probe with a trailing junk byte and
			// require bytesWritten to equal the clean stream length — a polyfill
			// that errors or counts the trailing byte fails this and falls back
			// to the pure consumed-tracking path.
			const clean = zlib.deflateSync(Buffer.from("x")) as Uint8Array;
			const probeInput = new Uint8Array(clean.length + 1);
			probeInput.set(clean);
			const probe = zlib.inflateSync(probeInput, {
				info: true,
			}) as unknown as { engine?: { bytesWritten: number } } | undefined;
			if (probe?.engine && probe.engine.bytesWritten === clean.length) {
				iwc = (data, maxOutputBytes) => {
					// node rejects maxOutputLength <= 0; a 0-byte object can't
					// bomb, so only apply the cap for positive declared sizes.
					const opts =
						maxOutputBytes != null && maxOutputBytes > 0
							? { info: true, maxOutputLength: maxOutputBytes }
							: { info: true };
					const r = zlib.inflateSync(data, opts) as unknown as {
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

	// No node:zlib — use vendored inflate (pure JS) for decompression.
	// For deflation, prefer the native CompressionStream (faster, no JS
	// cost), falling back to the vendored pure-JS deflate so compression
	// works on runtimes that lack both node:zlib and CompressionStream.
	// inflateWithConsumed is always available via fflate.
	let deflateFn: ZlibProvider["deflateSync"];
	if (typeof globalThis.CompressionStream === "function") {
		deflateFn = async (data) => {
			const cs = new CompressionStream("deflate");
			const writer = cs.writable.getWriter();
			// Start draining the readable before awaiting the writes: a
			// backpressured write() may not resolve until the output is being
			// consumed, so awaiting it first could deadlock on large inputs.
			// Reading concurrently lets us still await write/close (surfacing
			// errors instead of leaking an unhandled rejection) without that risk.
			const output = new Response(cs.readable).arrayBuffer();
			await writer.write(data as Uint8Array<ArrayBuffer>);
			await writer.close();
			return new Uint8Array(await output);
		};
	} else {
		deflateFn = pureDeflate;
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
	// Bound the output to the declared size: the node path throws
	// (ERR_BUFFER_TOO_LARGE) and the pure path caps its allocation, so a
	// stream that inflates past its header's declared size is rejected here
	// rather than being allowed to expand unboundedly in memory.
	const { result, bytesConsumed } = p.inflateWithConsumed(data, expectedSize);
	if (result.byteLength !== expectedSize) {
		throw new Error(`Inflate size mismatch: got ${result.byteLength}, expected ${expectedSize}`);
	}
	return { result, bytesConsumed };
}
