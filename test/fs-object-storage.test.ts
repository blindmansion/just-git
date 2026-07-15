import { afterEach, describe, expect, test } from "bun:test";
import * as nodeFs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { durableFileSystemFromNodeFs } from "../src/fs/node-durable-fs.ts";
import { bytesToHex } from "../src/lib/hex.ts";
import { hashObject } from "../src/lib/object-db.ts";
import { PackedObjectStore } from "../src/lib/object-store.ts";
import { createDelta, createDeltaIndex } from "../src/lib/pack/delta.ts";
import { buildPackIndex } from "../src/lib/pack/pack-index.ts";
import { writePack } from "../src/lib/pack/packfile.ts";
import { deflate } from "../src/lib/pack/zlib.ts";
import { FsObjectStorage } from "../src/store/fs-object-storage.ts";

const tempDirs: string[] = [];
const encoder = new TextEncoder();

async function tempRepo() {
	const repoDir = await nodeFs.mkdtemp(join(tmpdir(), "just-git-fs-objects-"));
	tempDirs.push(repoDir);
	const fs = durableFileSystemFromNodeFs(nodeFs);
	await fs.mkdir(join(repoDir, "objects"), { recursive: true });
	return { fs, repoDir, storage: new FsObjectStorage(fs, repoDir) };
}

afterEach(async () => {
	await Promise.all(
		tempDirs.splice(0).map((dir) => nodeFs.rm(dir, { recursive: true, force: true })),
	);
});

describe("FsObjectStorage", () => {
	test("stores, batches, lists, prefixes, and deletes loose objects", async () => {
		const { storage } = await tempRepo();
		const first = encoder.encode("first");
		const second = encoder.encode("second");
		const firstHash = await hashObject("blob", first);
		const secondHash = await hashObject("blob", second);

		expect(
			await storage.putObjects([
				{ hash: firstHash, type: "blob", content: first },
				{ hash: secondHash, type: "blob", content: second },
				{ hash: firstHash, type: "blob", content: first },
			]),
		).toEqual([firstHash, secondHash]);
		expect(await storage.putObjects([{ hash: firstHash, type: "blob", content: first }])).toEqual(
			[],
		);

		expect(await storage.getObject(firstHash)).toEqual({
			type: "blob",
			encoding: "raw",
			content: first,
		});
		expect(Array.from((await storage.getObjects([firstHash, "0".repeat(40)])).keys())).toEqual([
			firstHash,
		]);
		expect(await storage.hasObjects([firstHash, "0".repeat(40)])).toEqual(new Set([firstHash]));
		expect(await storage.findObjectsByPrefix(firstHash.slice(0, 8))).toEqual([firstHash]);
		expect(await storage.listObjectHashes()).toEqual([firstHash, secondHash].sort());
		expect(await storage.repoByteSize()).toBeGreaterThan(0);

		expect(await storage.deleteObjects([firstHash, firstHash, "0".repeat(40)])).toBe(1);
		expect(await storage.hasObject(firstHash)).toBe(false);
		expect(await storage.deleteObjects([firstHash])).toBe(0);
	});

	test("reports exactly which concurrent immutable insert won", async () => {
		const { fs, repoDir } = await tempRepo();
		const a = new FsObjectStorage(fs, repoDir);
		const b = new FsObjectStorage(fs, repoDir);
		const content = encoder.encode("concurrent");
		const hash = await hashObject("blob", content);
		const object = [{ hash, type: "blob", content }];

		const results = await Promise.all([a.putObjects(object), b.putObjects(object)]);

		expect(results.flat()).toEqual([hash]);
		expect((await a.getObject(hash))?.content).toEqual(content);
	});

	test("reads pack-only objects through the shared native database", async () => {
		const { fs, repoDir, storage } = await tempRepo();
		const content = encoder.encode("packed");
		const hash = await hashObject("blob", content);
		const pack = await writePack([{ type: "blob", content }]);

		expect(await new PackedObjectStore(fs, repoDir).ingestPack(pack)).toBe(1);

		expect(await storage.getObject(hash)).toEqual({
			type: "blob",
			encoding: "raw",
			content,
		});
		expect(await storage.listObjectHashes()).toEqual([hash]);
		expect(await storage.deleteObjects([hash])).toBe(0);
		expect(await storage.hasObject(hash)).toBe(true);
	});

	test("discovers only complete pack and index pairs", async () => {
		const { fs, repoDir } = await tempRepo();
		const content = encoder.encode("paired");
		const hash = await hashObject("blob", content);
		const pack = await writePack([{ type: "blob", content }]);
		const index = await buildPackIndex(pack);
		const name = `pack-${bytesToHex(pack.subarray(pack.byteLength - 20))}`;
		const packDir = join(repoDir, "objects", "pack");
		await fs.mkdir(packDir, { recursive: true });
		await fs.writeFile(join(packDir, `${name}.pack`), pack);

		expect(await new FsObjectStorage(fs, repoDir).listObjectHashes()).toEqual([]);

		await fs.writeFile(join(packDir, "pack-orphan.idx"), index);
		expect(await new FsObjectStorage(fs, repoDir).listObjectHashes()).toEqual([]);

		await fs.writeFile(join(packDir, `${name}.idx`), index);
		expect(await new FsObjectStorage(fs, repoDir).listObjectHashes()).toEqual([hash]);
	});

	test("rewrites delta rows as a native pack and removes redundant loose copies", async () => {
		const { fs, repoDir, storage } = await tempRepo();
		const base = encoder.encode(`${"stable line\n".repeat(200)}old ending\n`);
		const target = encoder.encode(`${"stable line\n".repeat(200)}new ending\n`);
		const baseHash = await hashObject("blob", base);
		const targetHash = await hashObject("blob", target);
		const delta = createDelta(createDeltaIndex(base), target);
		expect(delta).not.toBeNull();

		await storage.putObjects([
			{ hash: baseHash, type: "blob", content: base },
			{ hash: targetHash, type: "blob", content: target },
		]);
		await storage.putDeltaObjects([
			{
				hash: targetHash,
				type: "blob",
				encoding: "delta-zlib",
				baseHash,
				content: await deflate(delta!),
			},
			{
				hash: baseHash,
				type: "blob",
				encoding: "raw-zlib",
				content: await deflate(base),
			},
		]);

		expect((await storage.getObject(targetHash))?.content).toEqual(target);
		const fresh = new FsObjectStorage(fs, repoDir);
		expect((await fresh.getObject(baseHash))?.content).toEqual(base);
		expect((await fresh.getObject(targetHash))?.content).toEqual(target);
		expect(await fresh.listObjectHashes()).toEqual([baseHash, targetHash].sort());
		expect(await fresh.deleteObjects([baseHash, targetHash])).toBe(0);

		const packDir = join(repoDir, "objects", "pack");
		const files = await fs.readdir(packDir);
		expect(files.filter((file) => file.endsWith(".pack"))).toHaveLength(1);
		expect(files.filter((file) => file.endsWith(".idx"))).toHaveLength(1);
	});

	test("rejects content whose hash or delta dependency is invalid", async () => {
		const { storage } = await tempRepo();
		const content = encoder.encode("content");

		expect(storage.putObject("0".repeat(40), "blob", content)).rejects.toThrow(
			"object hash mismatch",
		);
		expect(storage.getObject("../../outside")).rejects.toThrow("invalid git object id");
		expect(
			storage.putDeltaObjects([
				{
					hash: await hashObject("blob", content),
					type: "blob",
					encoding: "delta",
					baseHash: "1".repeat(40),
					content,
				},
			]),
		).rejects.toThrow("delta base object");

		expect(
			storage.putDeltaObjects([
				{
					hash: "a".repeat(40),
					type: "blob",
					encoding: "delta",
					baseHash: "b".repeat(40),
					content,
				},
				{
					hash: "b".repeat(40),
					type: "blob",
					encoding: "delta",
					baseHash: "a".repeat(40),
					content,
				},
			]),
		).rejects.toThrow("delta cycle");
	});
});
