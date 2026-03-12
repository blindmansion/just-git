// ── Zlib abstraction ─────────────────────────────────────────────────
// Thin wrapper over platform-specific zlib. Uses zlib format (RFC 1950)
// with the 2-byte header and adler32 checksum, matching what git expects
// inside packfiles.

interface ZlibProvider {
	deflate(data: Uint8Array): Promise<Uint8Array>;
	inflate(data: Uint8Array): Promise<Uint8Array>;
}

function detect(): ZlibProvider {
	// Prefer synchronous node:zlib when available (Bun, Node, Deno).
	// String construction hides the specifier from bundlers that would
	// otherwise try to resolve/polyfill it for browser targets — Bun's
	// bundler in particular sees through variable indirection and
	// `__require` wrappers.
	try {
		const zlib = require(["node", "zlib"].join(":"));
		if (typeof zlib.deflateSync === "function" && typeof zlib.inflateSync === "function") {
			return {
				deflate: (data) => Promise.resolve(new Uint8Array(zlib.deflateSync(data))),
				inflate: (data) => Promise.resolve(new Uint8Array(zlib.inflateSync(data))),
			};
		}
	} catch {
		// fall through
	}

	// Browser: CompressionStream/DecompressionStream with "deflate" (RFC 1950 zlib)
	if (
		typeof globalThis.CompressionStream === "function" &&
		typeof globalThis.DecompressionStream === "function"
	) {
		return {
			async deflate(data) {
				const cs = new CompressionStream("deflate");
				const writer = cs.writable.getWriter();
				writer.write(data as Uint8Array<ArrayBuffer>);
				writer.close();
				return new Uint8Array(await new Response(cs.readable).arrayBuffer());
			},
			async inflate(data) {
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

const provider = detect();

export const deflate: (data: Uint8Array) => Promise<Uint8Array> = provider.deflate;
export const inflate: (data: Uint8Array) => Promise<Uint8Array> = provider.inflate;
