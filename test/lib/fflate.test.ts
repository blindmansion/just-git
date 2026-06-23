import { describe, expect, test } from "bun:test";
import zlib from "node:zlib";
import { pureDeflate, pureInflate, pureInflateWithConsumed } from "../../src/lib/pack/fflate.ts";
import { type PackInput, readPack, writePack } from "../../src/lib/pack/packfile.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

function nativeDeflate(data: Uint8Array): Uint8Array {
	return new Uint8Array(zlib.deflateSync(data));
}

function nativeInflateWithConsumed(data: Uint8Array) {
	const r = zlib.inflateSync(data, { info: true }) as unknown as {
		buffer: Buffer;
		engine: { bytesWritten: number };
	};
	return { result: new Uint8Array(r.buffer), bytesConsumed: r.engine.bytesWritten };
}

// ── pureInflate — cross-check against native zlib ────────────────────

describe("pureInflate", () => {
	test("decompresses empty data", () => {
		const compressed = nativeDeflate(new Uint8Array(0));
		expect(pureInflate(compressed)).toEqual(new Uint8Array(0));
	});

	test("decompresses small text", () => {
		const original = enc.encode("Hello, world!");
		const compressed = nativeDeflate(original);
		expect(pureInflate(compressed)).toEqual(original);
	});

	test("decompresses binary data", () => {
		const original = new Uint8Array([0, 1, 2, 255, 128, 64, 0, 0, 0]);
		const compressed = nativeDeflate(original);
		expect(pureInflate(compressed)).toEqual(original);
	});

	test("decompresses 1 KB of repeated data", () => {
		const original = new Uint8Array(1024).fill(0x42);
		const compressed = nativeDeflate(original);
		expect(pureInflate(compressed)).toEqual(original);
	});

	test("decompresses 100 KB of structured data", () => {
		const lines: string[] = [];
		for (let i = 0; i < 2000; i++) lines.push(`line ${i}: ${"x".repeat(i % 50)}`);
		const original = enc.encode(lines.join("\n"));
		const compressed = nativeDeflate(original);
		const result = pureInflate(compressed);
		expect(result.byteLength).toBe(original.byteLength);
		expect(dec.decode(result)).toBe(dec.decode(original));
	});

	test("decompresses random-ish data (low compressibility)", () => {
		const original = new Uint8Array(4096);
		for (let i = 0; i < original.length; i++) original[i] = (i * 31 + 97) & 0xff;
		const compressed = nativeDeflate(original);
		expect(pureInflate(compressed)).toEqual(original);
	});

	test("decompresses all-zeros", () => {
		const original = new Uint8Array(10000);
		const compressed = nativeDeflate(original);
		expect(pureInflate(compressed)).toEqual(original);
	});

	test("matches native zlib output byte-for-byte", () => {
		const cases = [
			enc.encode(""),
			enc.encode("a"),
			enc.encode("short"),
			enc.encode("x".repeat(1000)),
			new Uint8Array(256).map((_, i) => i),
		];
		for (const original of cases) {
			const compressed = nativeDeflate(original);
			const nativeResult = new Uint8Array(zlib.inflateSync(compressed));
			const pureResult = pureInflate(compressed);
			expect(pureResult).toEqual(nativeResult);
		}
	});
});

// ── pureInflateWithConsumed — the critical packfile scenario ─────────

describe("pureInflateWithConsumed", () => {
	test("reports correct bytesConsumed for standalone stream", () => {
		const original = enc.encode("Hello, world!");
		const compressed = nativeDeflate(original);
		const { result, bytesConsumed } = pureInflateWithConsumed(compressed);
		expect(result).toEqual(original);
		expect(bytesConsumed).toBe(compressed.byteLength);
	});

	test("bytesConsumed matches native zlib for various data", () => {
		const cases = [
			enc.encode(""),
			enc.encode("a"),
			enc.encode("hello world"),
			enc.encode("x".repeat(500)),
			enc.encode("abc\ndef\nghi\n".repeat(100)),
			new Uint8Array(256).map((_, i) => i),
			new Uint8Array(8192).fill(0),
		];
		for (const original of cases) {
			const compressed = nativeDeflate(original);
			const native = nativeInflateWithConsumed(compressed);
			const pure = pureInflateWithConsumed(compressed);
			expect(pure.result).toEqual(native.result);
			expect(pure.bytesConsumed).toBe(native.bytesConsumed);
		}
	});

	test("correctly handles trailing data (simulated packfile)", () => {
		const obj1 = enc.encode("blob content one");
		const obj2 = enc.encode("blob content two");
		const compressed1 = nativeDeflate(obj1);
		const compressed2 = nativeDeflate(obj2);

		// Concatenate two compressed streams (like a packfile)
		const combined = new Uint8Array(compressed1.length + compressed2.length);
		combined.set(compressed1, 0);
		combined.set(compressed2, compressed1.length);

		// Inflate first stream — should consume exactly compressed1.length
		const first = pureInflateWithConsumed(combined);
		expect(first.result).toEqual(obj1);
		expect(first.bytesConsumed).toBe(compressed1.length);

		// Use bytesConsumed to find the second stream
		const remaining = combined.subarray(first.bytesConsumed);
		const second = pureInflateWithConsumed(remaining);
		expect(second.result).toEqual(obj2);
		expect(second.bytesConsumed).toBe(compressed2.length);
	});

	test("handles trailing data matching native bytesConsumed", () => {
		const original = enc.encode("git object content here\n");
		const compressed = nativeDeflate(original);

		// Append 100 bytes of random trailing data
		const trailing = new Uint8Array(100);
		for (let i = 0; i < 100; i++) trailing[i] = (i * 7 + 13) & 0xff;
		const withTrailing = new Uint8Array(compressed.length + trailing.length);
		withTrailing.set(compressed, 0);
		withTrailing.set(trailing, compressed.length);

		const native = nativeInflateWithConsumed(withTrailing);
		const pure = pureInflateWithConsumed(withTrailing);

		expect(pure.result).toEqual(native.result);
		expect(pure.bytesConsumed).toBe(native.bytesConsumed);
		expect(pure.bytesConsumed).toBe(compressed.length);
	});

	test("handles many concatenated streams (packfile walk)", () => {
		const objects = [
			"tree 4b825dc642cb6eb9a060e54bf899d69f2e5ef5b6\nauthor A <a@b> 1000 +0000\n\ninit\n",
			"export const x = 42;\n",
			"# README\n\nA project.\n",
			"file content ".repeat(200),
			"",
		];

		const compressed = objects.map((s) => nativeDeflate(enc.encode(s)));
		const totalLen = compressed.reduce((sum, c) => sum + c.length, 0);
		const concatenated = new Uint8Array(totalLen);
		let offset = 0;
		for (const c of compressed) {
			concatenated.set(c, offset);
			offset += c.length;
		}

		// Walk through and inflate each stream sequentially
		let pos = 0;
		for (let i = 0; i < objects.length; i++) {
			const { result, bytesConsumed } = pureInflateWithConsumed(concatenated.subarray(pos));
			expect(dec.decode(result)).toBe(objects[i]);
			expect(bytesConsumed).toBe(compressed[i]!.length);
			pos += bytesConsumed;
		}
		expect(pos).toBe(totalLen);
	});

	test("different compression levels produce same bytesConsumed results", () => {
		const original = enc.encode("test data for compression level variation\n".repeat(50));
		for (const level of [1, 6, 9] as const) {
			const compressed = new Uint8Array(zlib.deflateSync(original, { level }));
			const trailing = new Uint8Array(50).fill(0xaa);
			const withTrailing = new Uint8Array(compressed.length + trailing.length);
			withTrailing.set(compressed, 0);
			withTrailing.set(trailing, compressed.length);

			const native = nativeInflateWithConsumed(withTrailing);
			const pure = pureInflateWithConsumed(withTrailing);
			expect(pure.result).toEqual(native.result);
			expect(pure.bytesConsumed).toBe(native.bytesConsumed);
		}
	});
});

// ── pureInflateWithConsumed — output-size bounding (anti-bomb) ────────

describe("pureInflateWithConsumed output bounding", () => {
	test("exact expectedSize inflates correctly", () => {
		const original = enc.encode("x".repeat(5000));
		const compressed = nativeDeflate(original);
		const { result, bytesConsumed } = pureInflateWithConsumed(compressed, original.length);
		expect(result).toEqual(original);
		expect(bytesConsumed).toBe(compressed.byteLength);
	});

	test("bounds allocation and flags over-production when actual exceeds expectedSize", () => {
		// A stream that inflates to 50 KB, but we claim it should be 100 bytes
		// (as a malformed/hostile object header would). The pure path must not
		// grow its buffer to 50 KB; it caps at expectedSize (+1 sentinel) and
		// the resulting length differs from expectedSize so callers reject it.
		const original = new Uint8Array(50_000).fill(0x41);
		const compressed = nativeDeflate(original);
		const claimed = 100;
		const { result } = pureInflateWithConsumed(compressed, claimed);
		expect(result.byteLength).toBeLessThanOrEqual(claimed + 1);
		expect(result.byteLength).not.toBe(claimed); // over-production observable
	});

	test("without expectedSize, behaves as before (grows to fit)", () => {
		const original = enc.encode("y".repeat(8000));
		const compressed = nativeDeflate(original);
		const { result } = pureInflateWithConsumed(compressed);
		expect(result).toEqual(original);
	});
});

// ── pureDeflate — compression, cross-checked against native zlib ─────

describe("pureDeflate", () => {
	const samples: [string, Uint8Array][] = [
		["empty", new Uint8Array(0)],
		["single byte", enc.encode("a")],
		["small text", enc.encode("Hello, world!")],
		["repeated text", enc.encode("x".repeat(1000))],
		["all zeros (10 KB)", new Uint8Array(10000)],
		["repeated byte (1 KB)", new Uint8Array(1024).fill(0x42)],
		[
			"structured (100 KB)",
			enc.encode(
				Array.from({ length: 2000 }, (_, i) => `line ${i}: ${"x".repeat(i % 50)}`).join("\n"),
			),
		],
		["low compressibility (4 KB)", new Uint8Array(4096).map((_, i) => (i * 31 + 97) & 0xff)],
		["multi-block (70 KB)", new Uint8Array(70000).map((_, i) => (i * 131 + 7) & 0xff)],
	];

	test("output is valid zlib that native can decompress", () => {
		for (const [name, data] of samples) {
			const compressed = pureDeflate(data);
			const roundTrip = Uint8Array.from(zlib.inflateSync(compressed));
			expect(roundTrip, name).toEqual(Uint8Array.from(data));
		}
	});

	test("output is readable by our own pure inflate (full pure round-trip)", () => {
		for (const [name, data] of samples) {
			const roundTrip = pureInflate(pureDeflate(data));
			expect(roundTrip, name).toEqual(data);
		}
	});

	test("can read native-deflated output (inflate cross-check)", () => {
		for (const [name, data] of samples) {
			const compressed = new Uint8Array(zlib.deflateSync(data));
			expect(pureInflate(compressed), name).toEqual(data);
		}
	});

	test("respects compression level argument", () => {
		const data = enc.encode("compress me ".repeat(500));
		for (const level of [1, 6, 9] as const) {
			const compressed = pureDeflate(data, level);
			expect(new Uint8Array(zlib.inflateSync(compressed))).toEqual(data);
		}
	});

	test("emits a well-formed zlib header (CMF/FLG checksum)", () => {
		const compressed = pureDeflate(enc.encode("header check"));
		expect(compressed[0] & 0x0f).toBe(8); // deflate compression method
		expect(((compressed[0] << 8) | compressed[1]) % 31).toBe(0); // FCHECK
		expect(compressed[1] & 0x20).toBe(0); // no preset dictionary
	});
});

// ── Packfile round-trip via pure inflate ─────────────────────────────
// Verifies the vendored path works for actual packfile parsing by
// replacing the native zlib provider.

describe("packfile parsing via pure inflate", () => {
	test("can read a pack using only vendored inflate", async () => {
		const inputs: PackInput[] = [
			{ type: "blob", content: enc.encode("hello world") },
			{ type: "blob", content: enc.encode("second blob\nwith newlines\n") },
			{
				type: "commit",
				content: enc.encode(
					"tree 0000000000000000000000000000000000000000\n" +
						"author Test <t@t> 1000000000 +0000\n" +
						"committer Test <t@t> 1000000000 +0000\n\ninitial\n",
				),
			},
		];

		// Create a pack with native zlib (writePack uses the default provider)
		const pack = await writePack(inputs);

		// Read the pack — the readPack function uses inflateObject internally.
		// To test the pure path, we'll directly test the compressed entries
		// against our vendored inflate. readPack itself always goes through
		// the zlib.ts provider, which uses node:zlib on Bun. So we verify
		// the vendored inflate produces identical results by cross-checking
		// against the readPack output.
		const objects = await readPack(pack);
		expect(objects).toHaveLength(3);

		// Now manually walk the packfile and inflate each entry with the
		// vendored code to verify it produces the same results.
		const view = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
		expect(view.getUint32(0)).toBe(0x5041434b); // PACK
		expect(view.getUint32(4)).toBe(2); // version 2
		expect(view.getUint32(8)).toBe(3); // 3 objects

		let offset = 12;
		for (let i = 0; i < 3; i++) {
			// Parse the variable-length object header
			let byte = pack[offset]!;
			let size = byte & 0x0f;
			let shift = 4;
			while (byte & 0x80) {
				byte = pack[++offset]!;
				size |= (byte & 0x7f) << shift;
				shift += 7;
			}
			offset++;

			// Inflate the compressed data using vendored code
			const compressedSlice = pack.subarray(offset);
			const { result, bytesConsumed } = pureInflateWithConsumed(compressedSlice);

			// Cross-check against what readPack decoded
			expect(result.byteLength).toBe(size);
			expect(result).toEqual(objects[i]!.content);

			// Also cross-check bytesConsumed against native zlib
			const native = nativeInflateWithConsumed(compressedSlice);
			expect(bytesConsumed).toBe(native.bytesConsumed);

			offset += bytesConsumed;
		}
	});

	test("handles a pack with 200 objects", async () => {
		const inputs: PackInput[] = [];
		for (let i = 0; i < 200; i++) {
			inputs.push({
				type: "blob",
				content: enc.encode(`content-${i}-${"padding".repeat(i % 20)}`),
			});
		}

		const pack = await writePack(inputs);
		const objects = await readPack(pack);
		expect(objects).toHaveLength(200);

		// Walk the pack manually with vendored inflate
		let offset = 12; // skip header
		for (let i = 0; i < 200; i++) {
			let byte = pack[offset]!;
			let size = byte & 0x0f;
			let shift = 4;
			while (byte & 0x80) {
				byte = pack[++offset]!;
				size |= (byte & 0x7f) << shift;
				shift += 7;
			}
			offset++;

			const { result, bytesConsumed } = pureInflateWithConsumed(pack.subarray(offset));
			expect(result.byteLength).toBe(size);
			expect(dec.decode(result)).toBe(dec.decode(objects[i]!.content));
			offset += bytesConsumed;
		}
	});
});

// ── Error handling ───────────────────────────────────────────────────

describe("fflate error handling", () => {
	test("throws on invalid zlib header", () => {
		expect(() => pureInflate(new Uint8Array([0x00, 0x00, 0x00, 0x00]))).toThrow(/invalid zlib/);
	});

	test("throws on truncated data", () => {
		const compressed = nativeDeflate(enc.encode("hello world ".repeat(100)));
		// Truncate mid-stream: keep the header and enough DEFLATE data to
		// start a block, but chop before it finishes. The +6 ensures we
		// have at least 2 header bytes + some DEFLATE + room after the -4
		// adler32 strip, so inflt actually starts parsing and hits EOF.
		const truncated = compressed.subarray(0, Math.min(compressed.length - 10, 20));
		expect(() => pureInflate(truncated)).toThrow();
	});

	test("inflateWithConsumed throws on invalid header", () => {
		expect(() => pureInflateWithConsumed(new Uint8Array([0xff, 0xff]))).toThrow(/invalid zlib/);
	});

	// Regression: a streaming caller feeds a growing buffer and relies on
	// inflateWithConsumed throwing until the *entire* stream (DEFLATE body
	// + adler32 trailer) is present. If the body decodes fully but the 4
	// adler bytes haven't arrived, bytesConsumed must not exceed the input
	// (which would over-advance and desync a back-to-back entry walk).
	test("inflateWithConsumed throws when adler32 trailer is truncated", () => {
		const compressed = nativeDeflate(enc.encode("world!"));
		// Drop the trailing adler32 bytes: the DEFLATE body is complete but
		// the zlib envelope is not.
		for (let drop = 1; drop <= 4; drop++) {
			const truncated = compressed.subarray(0, compressed.length - drop);
			expect(() => pureInflateWithConsumed(truncated), `drop=${drop}`).toThrow();
		}
		// Full buffer still reports the exact consumed length.
		const { result, bytesConsumed } = pureInflateWithConsumed(compressed);
		expect(dec.decode(result)).toBe("world!");
		expect(bytesConsumed).toBe(compressed.byteLength);
	});

	test("inflateWithConsumed throws on header-only input", () => {
		// Only the 2-byte zlib header, no DEFLATE body or trailer.
		const compressed = nativeDeflate(enc.encode("anything"));
		expect(() => pureInflateWithConsumed(compressed.subarray(0, 2))).toThrow();
	});
});
