// ── Zlib abstraction ─────────────────────────────────────────────────
// Thin wrapper over platform-specific zlib. Uses zlib format (RFC 1950)
// with the 2-byte header and adler32 checksum, matching what git expects
// inside packfiles and loose objects.

interface InflateResult {
	result: Uint8Array;
	bytesConsumed: number;
}

interface ZlibProvider {
	deflateSync(data: Uint8Array): Uint8Array | Promise<Uint8Array>;
	inflateSync(data: Uint8Array): Uint8Array | Promise<Uint8Array>;
	/** When the platform's zlib supports `{ info: true }` (Bun, Node),
	 *  a single inflate call that also reports compressed bytes consumed.
	 *  Undefined on Deno (declares but doesn't implement) and browsers. */
	inflateWithConsumed?: (data: Uint8Array) => InflateResult;
}

async function detect(): Promise<ZlibProvider> {
	// Try node:zlib — require() for Bun / Node CJS / Deno,
	// then import() for Node ESM where require() is unavailable.
	// String construction hides the specifier from bundlers.
	let zlib: any;
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

	if (zlib && typeof zlib.deflateSync === "function" && typeof zlib.inflateSync === "function") {
		let iwc: ZlibProvider["inflateWithConsumed"];
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
			// { info: true } not supported on this runtime — leave undefined
		}
		return {
			deflateSync: (data) => new Uint8Array(zlib.deflateSync(data)),
			inflateSync: (data) => new Uint8Array(zlib.inflateSync(data)),
			inflateWithConsumed: iwc,
		};
	}

	// Browser: CompressionStream/DecompressionStream with "deflate" (RFC 1950 zlib).
	// DecompressionStream throws on trailing data per WHATWG Compression spec,
	// so this path only works for loose objects (one zlib stream per file).
	// Packfile parsing requires node:zlib.
	if (
		typeof globalThis.CompressionStream === "function" &&
		typeof globalThis.DecompressionStream === "function"
	) {
		return {
			async deflateSync(data) {
				const cs = new CompressionStream("deflate");
				const writer = cs.writable.getWriter();
				writer.write(data as Uint8Array<ArrayBuffer>);
				writer.close();
				return new Uint8Array(await new Response(cs.readable).arrayBuffer());
			},
			async inflateSync(data) {
				const ds = new DecompressionStream("deflate");
				const writer = ds.writable.getWriter();
				writer.write(data as Uint8Array<ArrayBuffer>);
				writer.close();
				return new Uint8Array(await new Response(ds.readable).arrayBuffer());
			},
		};
	}

	throw new Error(
		"No zlib implementation available. Requires Bun, Node.js, Deno, or a browser with CompressionStream.",
	);
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
 * When the platform supports it (Bun, Node) this is a single zlib call
 * using `{ info: true }`. Otherwise falls back to inflate + binary search.
 */
export async function inflateObject(
	data: Uint8Array,
	expectedSize: number,
): Promise<InflateResult> {
	const p = await provider();

	if (p.inflateWithConsumed) {
		const { result, bytesConsumed } = p.inflateWithConsumed(data);
		if (result.byteLength !== expectedSize) {
			throw new Error(`Inflate size mismatch: got ${result.byteLength}, expected ${expectedSize}`);
		}
		return { result, bytesConsumed };
	}

	// Fallback: inflate the whole remaining buffer, then binary search
	// for the exact compressed length. ~log2(N) extra inflate calls.
	const full = await p.inflateSync(data);
	if (full.byteLength !== expectedSize) {
		throw new Error(`Inflate size mismatch: got ${full.byteLength}, expected ${expectedSize}`);
	}

	let lo = 2; // minimum zlib stream is 2 bytes (header)
	let hi = data.byteLength;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		try {
			const trial = await p.inflateSync(data.subarray(0, mid));
			if (trial.byteLength === expectedSize) {
				hi = mid;
			} else {
				lo = mid + 1;
			}
		} catch {
			lo = mid + 1;
		}
	}

	return { result: full, bytesConsumed: lo };
}
