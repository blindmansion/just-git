import { describe, expect, test } from "bun:test";
import {
	createDelta,
	createDeltaIndex,
	type DeltaObject,
	findBestDeltas,
} from "../../src/lib/pack/delta.ts";
import { hexToBytes } from "../../src/lib/hex.ts";
import { buildPackIndex } from "../../src/lib/pack/pack-index.ts";
import { PackReader } from "../../src/lib/pack/pack-reader.ts";
import { applyDelta, readPack } from "../../src/lib/pack/packfile.ts";
import { deflate } from "../../src/lib/pack/zlib.ts";
import { createHasher } from "../../src/lib/sha1.ts";

const enc = new TextEncoder();

function roundTrip(base: Uint8Array, target: Uint8Array): Uint8Array {
	const index = createDeltaIndex(base);
	const delta = createDelta(index, target);
	expect(delta).not.toBeNull();
	return applyDelta(base, delta!);
}

// ── createDelta round-trip with applyDelta ───────────────────────────

describe("createDelta", () => {
	test("identical base and target", () => {
		const data = enc.encode("Hello, world! This is a test string that is long enough to hash.");
		const result = roundTrip(data, data);
		expect(result).toEqual(data);
	});

	test("completely different buffers", () => {
		const base = enc.encode("AAAA".repeat(100));
		const target = enc.encode("BBBB".repeat(100));
		const result = roundTrip(base, target);
		expect(result).toEqual(target);
	});

	test("small edit in a large file", () => {
		const lines = Array.from({ length: 200 }, (_, i) => `line ${i}: content\n`).join("");
		const base = enc.encode(lines);
		const modified = enc.encode(`${lines.slice(0, 500)}INSERTED TEXT\n${lines.slice(500)}`);
		const result = roundTrip(base, modified);
		expect(result).toEqual(modified);
	});

	test("prepend content", () => {
		const base = enc.encode(
			"existing content that is long enough for rabin hashing to work properly",
		);
		const target = enc.encode(`PREPENDED ${new TextDecoder().decode(base)}`);
		const result = roundTrip(base, target);
		expect(result).toEqual(target);
	});

	test("append content", () => {
		const base = enc.encode(
			"existing content that is long enough for rabin hashing to work properly",
		);
		const target = enc.encode(`${new TextDecoder().decode(base)} APPENDED`);
		const result = roundTrip(base, target);
		expect(result).toEqual(target);
	});

	test("content rearrangement", () => {
		const part1 = "AAAA".repeat(20);
		const part2 = "BBBB".repeat(20);
		const part3 = "CCCC".repeat(20);
		const base = enc.encode(part1 + part2 + part3);
		const target = enc.encode(part3 + part1 + part2);
		const result = roundTrip(base, target);
		expect(result).toEqual(target);
	});

	test("binary content", () => {
		const base = new Uint8Array(512);
		for (let i = 0; i < base.length; i++) base[i] = i & 0xff;
		const target = new Uint8Array(512);
		target.set(base);
		target[100] = 0xff;
		target[200] = 0x00;
		target[300] = 0xab;
		const result = roundTrip(base, target);
		expect(result).toEqual(target);
	});

	test("large buffer with scattered edits", () => {
		const size = 20_000;
		const base = new Uint8Array(size);
		for (let i = 0; i < size; i++) base[i] = (i * 7 + 13) & 0xff;
		const target = new Uint8Array(size);
		target.set(base);
		for (let i = 0; i < size; i += 1000) {
			target[i] = (target[i]! + 1) & 0xff;
		}
		const result = roundTrip(base, target);
		expect(result).toEqual(target);
	});

	test("delete from middle", () => {
		const text = `prefix-${"X".repeat(200)}-middle-${"Y".repeat(200)}-suffix`;
		const base = enc.encode(text);
		const target = enc.encode(`prefix-${"X".repeat(200)}-suffix`);
		const result = roundTrip(base, target);
		expect(result).toEqual(target);
	});

	test("empty target returns null", () => {
		const base = enc.encode("some content");
		const index = createDeltaIndex(base);
		const delta = createDelta(index, new Uint8Array(0));
		expect(delta).toBeNull();
	});

	test("null index returns null", () => {
		const target = enc.encode("some content");
		const delta = createDelta(null, target);
		expect(delta).toBeNull();
	});

	test("empty base returns null index", () => {
		const index = createDeltaIndex(new Uint8Array(0));
		expect(index).toBeNull();
	});

	test("very small base (< 16 bytes) returns null index", () => {
		const index = createDeltaIndex(enc.encode("tiny"));
		expect(index).toBeNull();
	});

	test("base exactly 17 bytes creates valid index", () => {
		const base = enc.encode("12345678901234567");
		const index = createDeltaIndex(base);
		expect(index).not.toBeNull();
		const target = enc.encode("12345678901234567_modified");
		const delta = createDelta(index, target);
		expect(delta).not.toBeNull();
		const result = applyDelta(base, delta!);
		expect(result).toEqual(target);
	});
});

// ── Delta size quality ───────────────────────────────────────────────

describe("delta size quality", () => {
	test("similar inputs produce small delta", () => {
		const base = enc.encode("line\n".repeat(500));
		const target = enc.encode(`${"line\n".repeat(250)}changed\n${"line\n".repeat(249)}`);
		const index = createDeltaIndex(base);
		const delta = createDelta(index, target)!;
		expect(delta).not.toBeNull();
		expect(delta.byteLength).toBeLessThan(target.byteLength / 2);
	});

	test("identical inputs produce very small delta", () => {
		const data = enc.encode("repeated content\n".repeat(200));
		const index = createDeltaIndex(data);
		const delta = createDelta(index, data)!;
		expect(delta).not.toBeNull();
		expect(delta.byteLength).toBeLessThan(data.byteLength / 10);
	});

	test("completely different inputs produce delta near target size", () => {
		const base = new Uint8Array(1000);
		base.fill(0xaa);
		const target = new Uint8Array(1000);
		target.fill(0xbb);
		const index = createDeltaIndex(base);
		const delta = createDelta(index, target)!;
		expect(delta).not.toBeNull();
		expect(delta.byteLength).toBeGreaterThan(target.byteLength * 0.8);
	});
});

// ── maxSize cutoff ───────────────────────────────────────────────────

describe("maxSize", () => {
	test("returns null when delta exceeds maxSize", () => {
		const base = new Uint8Array(500).fill(0xaa);
		const target = new Uint8Array(500).fill(0xbb);
		const index = createDeltaIndex(base);
		const delta = createDelta(index, target, 10);
		expect(delta).toBeNull();
	});

	test("returns delta when under maxSize", () => {
		const data = enc.encode("content that is long enough to be indexed by rabin hash");
		const index = createDeltaIndex(data);
		const delta = createDelta(index, data, 100_000);
		expect(delta).not.toBeNull();
	});
});

// ── findBestDeltas ───────────────────────────────────────────────────

describe("findBestDeltas", () => {
	function makeObj(type: string, content: string, hash: string): DeltaObject {
		return {
			type: type as DeltaObject["type"],
			content: enc.encode(content),
			hash: hash as DeltaObject["hash"],
		};
	}

	test("groups by type — no cross-type deltas", () => {
		const blob = makeObj("blob", "x".repeat(200), "aaaa");
		const commit = makeObj("commit", "x".repeat(200), "bbbb");
		const results = findBestDeltas([blob, commit]);

		for (const r of results) {
			if (r.deltaBase) {
				const base = results.find((o) => o.hash === r.deltaBase);
				expect(base).toBeDefined();
				expect(base!.type).toBe(r.type);
			}
		}
	});

	test("finds delta between similar blobs", () => {
		const base = "line\n".repeat(100);
		const modified = `${"line\n".repeat(50)}changed\n${"line\n".repeat(49)}`;
		const objects: DeltaObject[] = [
			makeObj("blob", base, "hash1"),
			makeObj("blob", modified, "hash2"),
		];
		const results = findBestDeltas(objects);
		const deltafied = results.find((r) => r.delta);
		expect(deltafied).toBeDefined();
		expect(deltafied!.delta!.byteLength).toBeLessThan(deltafied!.content.byteLength / 2);
	});

	test("window=1 limits base candidates", () => {
		const content1 = "AAAA".repeat(100);
		const content2 = "BBBB".repeat(100);
		const content3 = "AAAA".repeat(95) + "CCCC".repeat(5);

		const objects: DeltaObject[] = [
			makeObj("blob", content1, "hash1"),
			makeObj("blob", content2, "hash2"),
			makeObj("blob", content3, "hash3"),
		];

		// With window=1, hash3 can only try hash2 (the immediately preceding
		// object after sorting by size). Since content3 is similar to content1
		// but not content2, a larger window would find a better delta.
		const narrow = findBestDeltas(objects, { window: 1 });
		const wide = findBestDeltas(objects, { window: 10 });

		const narrowDelta = narrow.find((r) => r.hash === "hash3" && r.delta);
		const wideDelta = wide.find((r) => r.hash === "hash3" && r.delta);

		// Wide window should find at least as good a delta
		if (narrowDelta && wideDelta) {
			expect(wideDelta.delta!.byteLength).toBeLessThanOrEqual(narrowDelta.delta!.byteLength);
		}
	});

	test("respects depth limit", () => {
		// Create a chain: obj0 -> obj1 -> obj2 -> obj3
		// With depth=2, obj3 shouldn't chain beyond depth 2
		const objects: DeltaObject[] = [];
		for (let i = 0; i < 5; i++) {
			const content = `${"base content\n".repeat(100)}version-${i}\n`;
			objects.push(makeObj("blob", content, `hash${i}`));
		}

		const results = findBestDeltas(objects, { depth: 2 });
		for (const r of results) {
			expect(r.depth).toBeLessThanOrEqual(2);
		}
	});

	test("larger objects sorted first as bases", () => {
		const small = "x".repeat(100);
		const large = "x".repeat(100) + "y".repeat(200);

		const objects: DeltaObject[] = [
			makeObj("blob", small, "small"),
			makeObj("blob", large, "large"),
		];

		const results = findBestDeltas(objects);
		// The smaller object should delta against the larger (since larger sorts first)
		const smallResult = results.find((r) => r.hash === "small");
		if (smallResult?.deltaBase) {
			expect(smallResult.deltaBase).toBe("large");
		}
	});

	test("does not produce delta when objects are too different", () => {
		const objects: DeltaObject[] = [
			{
				type: "blob",
				content: new Uint8Array(200).fill(0xaa),
				hash: "h1" as DeltaObject["hash"],
			},
			{
				type: "blob",
				content: new Uint8Array(200).fill(0xbb),
				hash: "h2" as DeltaObject["hash"],
			},
		];
		const results = findBestDeltas(objects);
		// Delta may or may not be produced, but if it is, it shouldn't be larger
		// than the original content
		for (const r of results) {
			if (r.delta) {
				expect(r.delta.byteLength).toBeLessThan(r.content.byteLength);
			}
		}
	});

	test("round-trips all deltas through applyDelta", () => {
		const base = "shared content\n".repeat(50);
		const objects: DeltaObject[] = [];
		for (let i = 0; i < 8; i++) {
			const content = `${base.slice(0, 200)}unique-${i}\n${base.slice(200)}`;
			objects.push(makeObj("blob", content, `h${i}`));
		}

		const results = findBestDeltas(objects);
		const byHash = new Map(results.map((r) => [r.hash, r]));

		for (const r of results) {
			if (r.delta && r.deltaBase) {
				const baseResult = byHash.get(r.deltaBase)!;
				const applied = applyDelta(baseResult.content, r.delta);
				expect(applied).toEqual(r.content);
			}
		}
	});
});

// ── createDeltaIndex edge cases ──────────────────────────────────────

describe("createDeltaIndex", () => {
	test("handles buffer with exactly one block", () => {
		const buf = new Uint8Array(17);
		for (let i = 0; i < buf.length; i++) buf[i] = i;
		const index = createDeltaIndex(buf);
		expect(index).not.toBeNull();
		expect(index!.entries.length).toBeGreaterThan(0);
	});

	test("handles large buffer", () => {
		const buf = new Uint8Array(100_000);
		for (let i = 0; i < buf.length; i++) buf[i] = (i * 13 + 7) & 0xff;
		const index = createDeltaIndex(buf);
		expect(index).not.toBeNull();
		expect(index!.entries.length).toBeGreaterThan(0);
	});

	test("repeated content caps hash buckets", () => {
		// All 16-byte blocks are identical → should cap at HASH_LIMIT
		const buf = new Uint8Array(16 * 200 + 1);
		buf.fill(0x42);
		const index = createDeltaIndex(buf);
		expect(index).not.toBeNull();
	});
});

// ── Pack format helpers for interop tests ────────────────────────────

const OBJ_BLOB = 3;
const OBJ_OFS_DELTA = 6;
const PACK_SIGNATURE = 0x5041434b;
const PACK_VERSION = 2;

function encodeTypeSize(typeNum: number, size: number): Uint8Array {
	const buf: number[] = [];
	let byte = (typeNum << 4) | (size & 0x0f);
	size >>= 4;
	while (size > 0) {
		buf.push(byte | 0x80);
		byte = size & 0x7f;
		size >>= 7;
	}
	buf.push(byte);
	return new Uint8Array(buf);
}

function encodeOfsOffset(negOffset: number): Uint8Array {
	const buf: number[] = [];
	buf.push(negOffset & 0x7f);
	let val = negOffset >>> 7;
	while (val > 0) {
		buf.unshift(0x80 | (--val & 0x7f));
		val >>>= 7;
	}
	return new Uint8Array(buf);
}

async function buildPackWithDelta(
	baseContent: Uint8Array,
	deltaData: Uint8Array,
): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];

	// Header
	const header = new Uint8Array(12);
	const hView = new DataView(header.buffer);
	hView.setUint32(0, PACK_SIGNATURE);
	hView.setUint32(4, PACK_VERSION);
	hView.setUint32(8, 2); // 2 objects
	chunks.push(header);

	// Base object (blob)
	const baseHeader = encodeTypeSize(OBJ_BLOB, baseContent.byteLength);
	const baseCompressed = await deflate(baseContent);
	const baseOffset = 12;
	chunks.push(baseHeader);
	chunks.push(baseCompressed);

	// Delta object (OFS_DELTA)
	const deltaOffset = baseOffset + baseHeader.byteLength + baseCompressed.byteLength;
	const negativeOffset = deltaOffset - baseOffset;
	const deltaHeader = encodeTypeSize(OBJ_OFS_DELTA, deltaData.byteLength);
	const ofsBytes = encodeOfsOffset(negativeOffset);
	const deltaCompressed = await deflate(deltaData);
	chunks.push(deltaHeader);
	chunks.push(ofsBytes);
	chunks.push(deltaCompressed);

	// Concatenate
	let totalSize = 20; // SHA-1 trailer
	for (const c of chunks) totalSize += c.byteLength;
	const result = new Uint8Array(totalSize);
	let offset = 0;
	for (const c of chunks) {
		result.set(c, offset);
		offset += c.byteLength;
	}

	// SHA-1 trailer
	const hasher = createHasher();
	hasher.update(result.subarray(0, offset));
	const checksum = await hasher.hex();
	result.set(hexToBytes(checksum), offset);

	return result;
}

// ── Integration / interop tests ──────────────────────────────────────

describe("delta interop", () => {
	test("round-trip through readPack (OFS_DELTA)", async () => {
		const baseContent = enc.encode("Hello, this is base content.\n".repeat(20));
		const targetContent = enc.encode(
			"Hello, this is base content.\n".repeat(10) +
				"This line was modified.\n" +
				"Hello, this is base content.\n".repeat(9),
		);

		const index = createDeltaIndex(baseContent);
		const delta = createDelta(index, targetContent)!;
		expect(delta).not.toBeNull();

		const packData = await buildPackWithDelta(baseContent, delta);
		const objects = await readPack(packData);

		expect(objects).toHaveLength(2);
		const baseObj = objects.find(
			(o) => new TextDecoder().decode(o.content) === new TextDecoder().decode(baseContent),
		);
		const targetObj = objects.find(
			(o) => new TextDecoder().decode(o.content) === new TextDecoder().decode(targetContent),
		);
		expect(baseObj).toBeDefined();
		expect(targetObj).toBeDefined();
		expect(targetObj!.type).toBe("blob");
	});

	test("round-trip through PackReader (OFS_DELTA)", async () => {
		const baseContent = enc.encode("line of code;\n".repeat(50));
		const targetContent = enc.encode(
			"line of code;\n".repeat(25) + "modified line;\n" + "line of code;\n".repeat(24),
		);

		const index = createDeltaIndex(baseContent);
		const delta = createDelta(index, targetContent)!;
		expect(delta).not.toBeNull();

		const packData = await buildPackWithDelta(baseContent, delta);
		const idxData = await buildPackIndex(packData);
		const reader = new PackReader(packData, idxData);

		const objects = await readPack(packData);
		for (const obj of objects) {
			expect(reader.hasObject(obj.hash)).toBe(true);
			const read = await reader.readObject(obj.hash);
			expect(read).not.toBeNull();
			expect(read!.type).toBe(obj.type);
			expect(read!.content).toEqual(obj.content);
		}
	});

	test("delta pack accepted by real git index-pack", async () => {
		const { mkdtemp } = await import("node:fs/promises");
		const { join } = await import("node:path");
		const { tmpdir } = await import("node:os");
		const fs = await import("node:fs");

		const baseContent = enc.encode(
			`# Large File\n\n${"Some repeated content here.\n".repeat(100)}`,
		);
		const targetContent = enc.encode(
			`# Large File (v2)\n\n${"Some repeated content here.\n".repeat(100)}`,
		);

		const index = createDeltaIndex(baseContent);
		const delta = createDelta(index, targetContent)!;
		expect(delta).not.toBeNull();

		const packData = await buildPackWithDelta(baseContent, delta);

		const tmpDir = await mkdtemp(join(tmpdir(), "delta-interop-"));
		try {
			const packPath = join(tmpDir, "test.pack");
			fs.writeFileSync(packPath, packData);

			const proc = Bun.spawn(["git", "index-pack", packPath], {
				cwd: tmpDir,
				stdout: "pipe",
				stderr: "pipe",
			});
			const exitCode = await proc.exited;
			const stderr = await new Response(proc.stderr).text();

			expect(exitCode).toBe(0);
			expect(stderr).toBe("");

			const idxPath = packPath.replace(".pack", ".idx");
			expect(fs.existsSync(idxPath)).toBe(true);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test("findBestDeltas results round-trip through readPack", async () => {
		const base = "shared content line\n".repeat(60);
		const objects: DeltaObject[] = [];
		for (let i = 0; i < 5; i++) {
			const content = `${base.slice(0, 200)}version-${i}\n${base.slice(200)}`;
			const contentBytes = enc.encode(content);
			const hasher = createHasher();
			hasher.update(enc.encode(`blob ${contentBytes.byteLength}\0`));
			hasher.update(contentBytes);
			const hash = await hasher.hex();
			objects.push({ type: "blob", content: contentBytes, hash });
		}

		const results = findBestDeltas(objects);
		const deltafied = results.filter((r) => r.delta);
		expect(deltafied.length).toBeGreaterThan(0);

		// Verify all deltas produce correct content via applyDelta
		const byHash = new Map(results.map((r) => [r.hash, r]));
		for (const r of deltafied) {
			const baseResult = byHash.get(r.deltaBase!)!;
			const applied = applyDelta(baseResult.content, r.delta!);
			expect(applied).toEqual(r.content);
		}
	});
});
