import { describe, expect, test } from "bun:test";
import {
	applyDelta,
	type PackInput,
	type PackObject,
	readPack,
	readPackStreaming,
	writePack,
} from "../../src/lib/pack/packfile.ts";
import { deflate, inflate } from "../../src/lib/pack/zlib.ts";

// ── zlib ─────────────────────────────────────────────────────────────

describe("zlib", () => {
	test("round-trips empty data", async () => {
		const data = new Uint8Array(0);
		expect(await inflate(await deflate(data))).toEqual(data);
	});

	test("round-trips binary data", async () => {
		const data = new Uint8Array([0, 1, 2, 255, 128, 64, 0, 0, 0]);
		expect(await inflate(await deflate(data))).toEqual(data);
	});

	test("round-trips text", async () => {
		const enc = new TextEncoder();
		const data = enc.encode("Hello, world! This is a test of zlib compression.");
		const result = await inflate(await deflate(data));
		expect(result).toEqual(data);
	});

	test("compressed output is different from input", async () => {
		const data = new Uint8Array(1000).fill(0x42);
		const compressed = await deflate(data);
		expect(compressed.byteLength).toBeLessThan(data.byteLength);
	});
});

// ── Pack writer + reader round-trip ──────────────────────────────────

const enc = new TextEncoder();

function blob(content: string): PackInput {
	return { type: "blob", content: enc.encode(content) };
}

function commit(content: string): PackInput {
	return { type: "commit", content: enc.encode(content) };
}

// function tree(bytes: Uint8Array): PackInput {
// 	return { type: "tree", content: bytes };
// }

describe("writePack", () => {
	test("produces valid header", async () => {
		const pack = await writePack([blob("hello")]);
		const view = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
		expect(view.getUint32(0)).toBe(0x5041434b); // "PACK"
		expect(view.getUint32(4)).toBe(2); // version
		expect(view.getUint32(8)).toBe(1); // object count
	});

	test("produces valid trailer (20-byte SHA-1)", async () => {
		const pack = await writePack([blob("hello")]);
		expect(pack.byteLength).toBeGreaterThan(32);
	});

	test("empty pack (0 objects)", async () => {
		const pack = await writePack([]);
		const view = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
		expect(view.getUint32(0)).toBe(0x5041434b);
		expect(view.getUint32(4)).toBe(2);
		expect(view.getUint32(8)).toBe(0);
		// 12 header + 20 trailer
		expect(pack.byteLength).toBe(32);
	});
});

describe("readPack", () => {
	test("round-trips a single blob", async () => {
		const input = [blob("hello world")];
		const pack = await writePack(input);
		const objects = await readPack(pack);
		expect(objects).toHaveLength(1);
		expect(objects[0]!.type).toBe("blob");
		expect(new TextDecoder().decode(objects[0]!.content)).toBe("hello world");
	});

	test("round-trips multiple objects of different types", async () => {
		const commitContent =
			"tree 0000000000000000000000000000000000000000\n" +
			"author Test <test@test.com> 1000000000 +0000\n" +
			"committer Test <test@test.com> 1000000000 +0000\n\nInitial commit\n";

		const input: PackInput[] = [
			blob("file content A"),
			blob("file content B"),
			commit(commitContent),
		];
		const pack = await writePack(input);
		const objects = await readPack(pack);

		expect(objects).toHaveLength(3);
		expect(objects[0]!.type).toBe("blob");
		expect(objects[1]!.type).toBe("blob");
		expect(objects[2]!.type).toBe("commit");
		expect(new TextDecoder().decode(objects[0]!.content)).toBe("file content A");
		expect(new TextDecoder().decode(objects[1]!.content)).toBe("file content B");
		expect(new TextDecoder().decode(objects[2]!.content)).toBe(commitContent);
	});

	test("computes correct git object hashes", async () => {
		const input = [blob("hello")];
		const pack = await writePack(input);
		const objects = await readPack(pack);
		// echo -n "hello" | git hash-object --stdin
		expect(objects[0]!.hash).toBe("b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0");
	});

	test("round-trips empty blob", async () => {
		const input = [blob("")];
		const pack = await writePack(input);
		const objects = await readPack(pack);
		expect(objects[0]!.type).toBe("blob");
		expect(objects[0]!.content.byteLength).toBe(0);
		// empty blob hash: e69de29bb2d1d6434b8b29ae775ad8c2e48c5391
		expect(objects[0]!.hash).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
	});

	test("round-trips large blob", async () => {
		const bigContent = "x".repeat(100_000);
		const input = [blob(bigContent)];
		const pack = await writePack(input);
		const objects = await readPack(pack);
		expect(objects[0]!.type).toBe("blob");
		expect(new TextDecoder().decode(objects[0]!.content)).toBe(bigContent);
	});

	test("round-trips tag object", async () => {
		const tagContent =
			"object 0000000000000000000000000000000000000000\n" +
			"type commit\n" +
			"tag v1.0\n" +
			"tagger Test <test@test.com> 1000000000 +0000\n\nRelease v1.0\n";
		const input: PackInput[] = [{ type: "tag", content: enc.encode(tagContent) }];
		const pack = await writePack(input);
		const objects = await readPack(pack);
		expect(objects[0]!.type).toBe("tag");
		expect(new TextDecoder().decode(objects[0]!.content)).toBe(tagContent);
	});

	test("rejects invalid signature", async () => {
		const pack = await writePack([blob("x")]);
		pack[0] = 0; // corrupt signature
		expect(readPack(pack)).rejects.toThrow(/Invalid pack signature/);
	});

	test("round-trips many objects", async () => {
		const input: PackInput[] = [];
		for (let i = 0; i < 200; i++) {
			input.push(blob(`content-${i}-${"padding".repeat(i % 20)}`));
		}
		const pack = await writePack(input);
		const objects = await readPack(pack);
		expect(objects).toHaveLength(200);
		for (let i = 0; i < 200; i++) {
			expect(objects[i]!.type).toBe("blob");
			expect(new TextDecoder().decode(objects[i]!.content)).toBe(
				`content-${i}-${"padding".repeat(i % 20)}`,
			);
		}
	});
});

// ── Streaming pack reader ────────────────────────────────────────────

async function collectStream(gen: AsyncGenerator<PackObject>): Promise<PackObject[]> {
	const result: PackObject[] = [];
	for await (const obj of gen) result.push(obj);
	return result;
}

function chunkify(data: Uint8Array, chunkSize: number): AsyncIterable<Uint8Array> {
	return {
		async *[Symbol.asyncIterator]() {
			for (let i = 0; i < data.byteLength; i += chunkSize) {
				yield data.subarray(i, Math.min(i + chunkSize, data.byteLength));
			}
		},
	};
}

function singleChunk(data: Uint8Array): AsyncIterable<Uint8Array> {
	return {
		async *[Symbol.asyncIterator]() {
			yield data;
		},
	};
}

describe("readPackStreaming", () => {
	test("round-trips a single blob", async () => {
		const input = [blob("hello world")];
		const pack = await writePack(input);
		const objects = await collectStream(readPackStreaming(singleChunk(pack)));
		expect(objects).toHaveLength(1);
		expect(objects[0]!.type).toBe("blob");
		expect(new TextDecoder().decode(objects[0]!.content)).toBe("hello world");
	});

	test("produces identical results to readPack", async () => {
		const input: PackInput[] = [
			blob("file content A"),
			blob("file content B"),
			commit(
				"tree 0000000000000000000000000000000000000000\n" +
					"author Test <test@test.com> 1000000000 +0000\n" +
					"committer Test <test@test.com> 1000000000 +0000\n\nInitial\n",
			),
		];
		const pack = await writePack(input);
		const buffered = await readPack(pack);
		const streamed = await collectStream(readPackStreaming(singleChunk(pack)));

		expect(streamed).toHaveLength(buffered.length);
		for (let i = 0; i < buffered.length; i++) {
			expect(streamed[i]!.hash).toBe(buffered[i]!.hash);
			expect(streamed[i]!.type).toBe(buffered[i]!.type);
			expect(streamed[i]!.content).toEqual(buffered[i]!.content);
		}
	});

	test("works with tiny chunks (1-byte)", async () => {
		const input = [blob("hello"), blob("world")];
		const pack = await writePack(input);
		const objects = await collectStream(readPackStreaming(chunkify(pack, 1)));
		expect(objects).toHaveLength(2);
		expect(new TextDecoder().decode(objects[0]!.content)).toBe("hello");
		expect(new TextDecoder().decode(objects[1]!.content)).toBe("world");
	});

	test("works with small chunks (7-byte)", async () => {
		const input = [blob("alpha"), blob("beta"), blob("gamma")];
		const pack = await writePack(input);
		const objects = await collectStream(readPackStreaming(chunkify(pack, 7)));
		expect(objects).toHaveLength(3);
		expect(objects.map((o) => new TextDecoder().decode(o.content))).toEqual([
			"alpha",
			"beta",
			"gamma",
		]);
	});

	test("handles empty blob", async () => {
		const input = [blob("")];
		const pack = await writePack(input);
		const objects = await collectStream(readPackStreaming(singleChunk(pack)));
		expect(objects[0]!.hash).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
		expect(objects[0]!.content.byteLength).toBe(0);
	});

	test("handles large blob", async () => {
		const bigContent = "x".repeat(100_000);
		const input = [blob(bigContent)];
		const pack = await writePack(input);
		const objects = await collectStream(readPackStreaming(chunkify(pack, 4096)));
		expect(new TextDecoder().decode(objects[0]!.content)).toBe(bigContent);
	});

	test("handles many objects", async () => {
		const input: PackInput[] = [];
		for (let i = 0; i < 200; i++) {
			input.push(blob(`content-${i}-${"padding".repeat(i % 20)}`));
		}
		const pack = await writePack(input);
		const buffered = await readPack(pack);
		const streamed = await collectStream(readPackStreaming(chunkify(pack, 512)));

		expect(streamed).toHaveLength(200);
		for (let i = 0; i < 200; i++) {
			expect(streamed[i]!.hash).toBe(buffered[i]!.hash);
		}
	});

	test("verifies pack checksum", async () => {
		const pack = await writePack([blob("test")]);
		// Corrupt the trailing SHA-1 checksum (last 20 bytes)
		pack[pack.byteLength - 1] ^= 0xff;
		const gen = readPackStreaming(singleChunk(pack));
		await expect(collectStream(gen)).rejects.toThrow(/checksum mismatch/);
	});

	test("rejects invalid signature", async () => {
		const pack = await writePack([blob("x")]);
		pack[0] = 0;
		const gen = readPackStreaming(singleChunk(pack));
		await expect(collectStream(gen)).rejects.toThrow(/Invalid pack signature/);
	});

	test("reads delta-compressed packs from real git", async () => {
		const { mkdtemp } = await import("node:fs/promises");
		const { join } = await import("node:path");
		const { tmpdir } = await import("node:os");
		const fs = await import("node:fs");

		const tmpDir = await mkdtemp(join(tmpdir(), "packtest-stream-delta-"));
		try {
			const run = async (cmd: string) => {
				const proc = Bun.spawn(["sh", "-c", cmd], {
					cwd: tmpDir,
					stdout: "pipe",
					stderr: "pipe",
					env: {
						...process.env,
						GIT_AUTHOR_NAME: "Test",
						GIT_AUTHOR_EMAIL: "test@test.com",
						GIT_COMMITTER_NAME: "Test",
						GIT_COMMITTER_EMAIL: "test@test.com",
						GIT_CONFIG_NOSYSTEM: "1",
						GIT_CONFIG_GLOBAL: "/dev/null",
					},
				});
				await proc.exited;
				return {
					stdout: await new Response(proc.stdout).text(),
					stderr: await new Response(proc.stderr).text(),
				};
			};

			await run("git init -b main");

			const baseContent = "line\n".repeat(200);
			fs.writeFileSync(join(tmpDir, "big.txt"), baseContent);
			await run("git add big.txt");
			await run('git commit -m "v1"');

			for (let i = 0; i < 5; i++) {
				const modified = baseContent.slice(0, 100) + `modified-${i}\n` + baseContent.slice(100);
				fs.writeFileSync(join(tmpDir, "big.txt"), modified);
				await run("git add big.txt");
				await run(`git commit -m "v${i + 2}"`);
			}

			const { stdout: objectList } = await run("git rev-list --objects --all");
			const hashes = objectList
				.trim()
				.split("\n")
				.map((line) => line.split(" ")[0]!);

			const hashListPath = join(tmpDir, "hash-list.txt");
			const packPath = join(tmpDir, "test.pack");
			fs.writeFileSync(hashListPath, `${hashes.join("\n")}\n`);
			await run(`git pack-objects --stdout --delta-base-offset < ${hashListPath} > ${packPath}`);
			const packData = new Uint8Array(fs.readFileSync(packPath));

			const buffered = await readPack(packData);
			const streamed = await collectStream(readPackStreaming(chunkify(packData, 256)));

			expect(streamed.length).toBe(buffered.length);
			const streamedHashes = new Set(streamed.map((o) => o.hash));
			for (const obj of buffered) {
				expect(streamedHashes.has(obj.hash)).toBe(true);
			}

			for (const obj of streamed) {
				if (obj.type !== "blob") continue;
				const { stdout } = await run(`git cat-file -p ${obj.hash}`);
				expect(new TextDecoder().decode(obj.content)).toBe(stdout);
			}
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});

// ── Delta application ────────────────────────────────────────────────

describe("applyDelta", () => {
	test("copy-only delta", () => {
		const base = enc.encode("Hello, world!");
		// Delta: base size 13, target size 13, copy all 13 bytes from offset 0
		const delta = buildDelta(base.byteLength, base.byteLength, [
			{ type: "copy", offset: 0, size: base.byteLength },
		]);
		expect(applyDelta(base, delta)).toEqual(base);
	});

	test("insert-only delta", () => {
		const base = enc.encode("Hello");
		const inserted = enc.encode("Goodbye");
		const delta = buildDelta(base.byteLength, inserted.byteLength, [
			{ type: "insert", data: inserted },
		]);
		expect(applyDelta(base, delta)).toEqual(inserted);
	});

	test("copy + insert combination", () => {
		const base = enc.encode("Hello, world!");
		const expected = enc.encode("Hello, universe!");
		// Copy "Hello, " (7 bytes), insert "universe!" (9 bytes)
		const delta = buildDelta(base.byteLength, expected.byteLength, [
			{ type: "copy", offset: 0, size: 7 },
			{ type: "insert", data: enc.encode("universe!") },
		]);
		expect(applyDelta(base, delta)).toEqual(expected);
	});

	test("multiple copies from different offsets", () => {
		const base = enc.encode("ABCDEFGHIJ");
		// Target: "GHIJABC"
		const expected = enc.encode("GHIJABC");
		const delta = buildDelta(base.byteLength, expected.byteLength, [
			{ type: "copy", offset: 6, size: 4 }, // "GHIJ"
			{ type: "copy", offset: 0, size: 3 }, // "ABC"
		]);
		expect(applyDelta(base, delta)).toEqual(expected);
	});

	test("throws on base size mismatch", () => {
		const base = enc.encode("Hello");
		const delta = buildDelta(999, 5, [{ type: "copy", offset: 0, size: 5 }]);
		expect(() => applyDelta(base, delta)).toThrow(/base size mismatch/);
	});
});

// ── Real git interop ─────────────────────────────────────────────────

describe("real git interop", () => {
	test("our packs pass git verify-pack", async () => {
		const { mkdtemp } = await import("node:fs/promises");
		const { join } = await import("node:path");
		const { tmpdir } = await import("node:os");
		const fs = await import("node:fs");

		const tmpDir = await mkdtemp(join(tmpdir(), "packtest-"));
		try {
			const input: PackInput[] = [
				blob("file one content\n"),
				blob("file two content\n"),
				blob("another file\nwith multiple lines\n"),
			];
			const packData = await writePack(input);
			const packPath = join(tmpDir, "test.pack");
			fs.writeFileSync(packPath, packData);

			const proc = Bun.spawn(["git", "index-pack", packPath], {
				cwd: tmpDir,
				stdout: "pipe",
				stderr: "pipe",
			});
			const exitCode = await proc.exited;
			const stderr = await new Response(proc.stderr).text();

			expect(stderr).toBe("");
			expect(exitCode).toBe(0);

			// Verify the generated .idx file exists
			const idxPath = packPath.replace(".pack", ".idx");
			expect(fs.existsSync(idxPath)).toBe(true);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test("we can read packs created by real git", async () => {
		const { mkdtemp } = await import("node:fs/promises");
		const { join } = await import("node:path");
		const { tmpdir } = await import("node:os");
		const fs = await import("node:fs");

		const tmpDir = await mkdtemp(join(tmpdir(), "packtest-"));
		try {
			// Init a real git repo, add files, commit
			const run = async (cmd: string) => {
				const proc = Bun.spawn(["sh", "-c", cmd], {
					cwd: tmpDir,
					stdout: "pipe",
					stderr: "pipe",
					env: {
						...process.env,
						GIT_AUTHOR_NAME: "Test",
						GIT_AUTHOR_EMAIL: "test@test.com",
						GIT_COMMITTER_NAME: "Test",
						GIT_COMMITTER_EMAIL: "test@test.com",
						GIT_CONFIG_NOSYSTEM: "1",
						GIT_CONFIG_GLOBAL: "/dev/null",
					},
				});
				await proc.exited;
				return {
					stdout: await new Response(proc.stdout).text(),
					stderr: await new Response(proc.stderr).text(),
				};
			};

			await run("git init -b main");
			await run("echo 'hello world' > file1.txt");
			await run("echo 'second file' > file2.txt");
			await run("git add .");
			await run('git commit -m "initial"');

			// Pack all objects
			const { stdout: objectList } = await run("git rev-list --objects --all");
			const hashes = objectList
				.trim()
				.split("\n")
				.map((line) => line.split(" ")[0]!);

			// Write object hashes to a file and pack via shell redirect
			const hashListPath = join(tmpDir, "hash-list.txt");
			const packPath = join(tmpDir, "test.pack");
			fs.writeFileSync(hashListPath, `${hashes.join("\n")}\n`);
			await run(`git pack-objects --stdout < ${hashListPath} > ${packPath}`);
			const packData = new Uint8Array(fs.readFileSync(packPath));

			// Now read this pack with our reader
			const objects = await readPack(packData);
			expect(objects.length).toBe(hashes.length);

			// Verify each object's hash against what git reported
			const objectHashes = new Set(objects.map((o) => o.hash));
			for (const hash of hashes) {
				expect(objectHashes.has(hash)).toBe(true);
			}

			// Verify object contents against git cat-file
			for (const obj of objects) {
				const { stdout: catFile } = await run(`git cat-file -p ${obj.hash}`);
				if (obj.type === "blob") {
					const dec = new TextDecoder();
					expect(dec.decode(obj.content)).toBe(catFile);
				}
			}
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test("we can read delta-compressed packs from real git", async () => {
		const { mkdtemp } = await import("node:fs/promises");
		const { join } = await import("node:path");
		const { tmpdir } = await import("node:os");
		const fs = await import("node:fs");

		const tmpDir = await mkdtemp(join(tmpdir(), "packtest-delta-"));
		try {
			const run = async (cmd: string) => {
				const proc = Bun.spawn(["sh", "-c", cmd], {
					cwd: tmpDir,
					stdout: "pipe",
					stderr: "pipe",
					env: {
						...process.env,
						GIT_AUTHOR_NAME: "Test",
						GIT_AUTHOR_EMAIL: "test@test.com",
						GIT_COMMITTER_NAME: "Test",
						GIT_COMMITTER_EMAIL: "test@test.com",
						GIT_CONFIG_NOSYSTEM: "1",
						GIT_CONFIG_GLOBAL: "/dev/null",
					},
				});
				await proc.exited;
				return {
					stdout: await new Response(proc.stdout).text(),
					stderr: await new Response(proc.stderr).text(),
				};
			};

			await run("git init -b main");

			// Create a large-ish file with many versions to encourage deltas
			const baseContent = "line\n".repeat(200);
			fs.writeFileSync(join(tmpDir, "big.txt"), baseContent);
			await run("git add big.txt");
			await run('git commit -m "v1"');

			// Make small changes to encourage delta compression
			for (let i = 0; i < 5; i++) {
				const modified = baseContent.slice(0, 100) + `modified-${i}\n` + baseContent.slice(100);
				fs.writeFileSync(join(tmpDir, "big.txt"), modified);
				await run("git add big.txt");
				await run(`git commit -m "v${i + 2}"`);
			}

			// Pack all objects with aggressive delta compression
			const { stdout: objectList } = await run("git rev-list --objects --all");
			const hashes = objectList
				.trim()
				.split("\n")
				.map((line) => line.split(" ")[0]!);

			const hashListPath = join(tmpDir, "hash-list.txt");
			const packPath = join(tmpDir, "test.pack");
			fs.writeFileSync(hashListPath, `${hashes.join("\n")}\n`);
			await run(`git pack-objects --stdout --delta-base-offset < ${hashListPath} > ${packPath}`);
			const packData = new Uint8Array(fs.readFileSync(packPath));

			// Read the delta-compressed pack
			const objects = await readPack(packData);
			expect(objects.length).toBe(hashes.length);

			// Verify all hashes match
			const objectHashes = new Set(objects.map((o) => o.hash));
			for (const hash of hashes) {
				expect(objectHashes.has(hash)).toBe(true);
			}

			// Spot-check blob contents
			for (const obj of objects) {
				if (obj.type !== "blob") continue;
				const { stdout } = await run(`git cat-file -p ${obj.hash}`);
				expect(new TextDecoder().decode(obj.content)).toBe(stdout);
			}
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});

// ── Delta builder helper ─────────────────────────────────────────────

type DeltaOp =
	| { type: "copy"; offset: number; size: number }
	| { type: "insert"; data: Uint8Array };

function buildDelta(baseSize: number, targetSize: number, ops: DeltaOp[]): Uint8Array {
	const parts: number[] = [];

	// Encode base size
	encodeSizeInto(parts, baseSize);
	// Encode target size
	encodeSizeInto(parts, targetSize);

	for (const op of ops) {
		if (op.type === "copy") {
			let cmd = 0x80;
			const trailing: number[] = [];
			// Offset bytes (little-endian, only include non-zero)
			if (op.offset & 0xff) {
				cmd |= 0x01;
				trailing.push(op.offset & 0xff);
			}
			if (op.offset & 0xff00) {
				cmd |= 0x02;
				trailing.push((op.offset >> 8) & 0xff);
			}
			if (op.offset & 0xff0000) {
				cmd |= 0x04;
				trailing.push((op.offset >> 16) & 0xff);
			}
			if (op.offset & 0xff000000) {
				cmd |= 0x08;
				trailing.push((op.offset >> 24) & 0xff);
			}
			// Size bytes
			const sz = op.size === 0x10000 ? 0 : op.size;
			if (sz & 0xff) {
				cmd |= 0x10;
				trailing.push(sz & 0xff);
			}
			if (sz & 0xff00) {
				cmd |= 0x20;
				trailing.push((sz >> 8) & 0xff);
			}
			if (sz & 0xff0000) {
				cmd |= 0x40;
				trailing.push((sz >> 16) & 0xff);
			}
			parts.push(cmd, ...trailing);
		} else {
			// Insert
			parts.push(op.data.byteLength);
			for (const b of op.data) parts.push(b);
		}
	}

	return new Uint8Array(parts);
}

function encodeSizeInto(parts: number[], size: number): void {
	let s = size;
	do {
		let byte = s & 0x7f;
		s >>= 7;
		if (s > 0) byte |= 0x80;
		parts.push(byte);
	} while (s > 0);
}
