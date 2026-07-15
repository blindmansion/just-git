import { describe, expect, test } from "bun:test";
import { hashObject } from "../../../src/lib/object-db.ts";
import { createDelta, createDeltaIndex } from "../../../src/lib/pack/delta.ts";
import { deflate } from "../../../src/lib/pack/zlib.ts";
import { FsObjectStorage } from "../../../src/store/fs-object-storage.ts";
import { replayCrashCuts } from "./crash-harness.ts";
import type { CrashableDurableFileSystem } from "./crashable-durable-fs.ts";

const encoder = new TextEncoder();

describe("FsObjectStorage crash durability", () => {
	test("putObject leaves one absent or complete hash-valid loose object", async () => {
		const object = await blob("single");
		await replayCrashCuts({
			setup: setupRepo,
			operation: (fs) => storage(fs).putObject(object.hash, "blob", object.content),
			verifyCut: (input) => assertObjectAbsentOrEqual(input.fs, object),
			verifySuccess: (fs) => assertObjectEqual(fs, object),
			retry: async (fs) => {
				await storage(fs).putObject(object.hash, "blob", object.content);
				await assertObjectEqual(fs.reboot(), object);
			},
		});
	});

	test("one-object putObjects has the same durable insertion protocol", async () => {
		const object = await blob("one-object batch");
		await replayCrashCuts({
			setup: setupRepo,
			operation: (fs) => storage(fs).putObjects([object]),
			verifyCut: (input) => assertObjectAbsentOrEqual(input.fs, object),
			verifySuccess: (fs) => assertObjectEqual(fs, object),
			retry: async (fs) => {
				await storage(fs).putObjects([object]);
				await assertObjectEqual(fs.reboot(), object);
			},
		});
	});

	test("batch insertion leaves an independently valid subset and retry converges", async () => {
		const objects = await Promise.all([blob("first"), blob("second"), blob("third")]);
		const input = [...objects, objects[0]!];

		await replayCrashCuts({
			setup: setupRepo,
			operation: (fs) => storage(fs).putObjects(input),
			verifyCut: async ({ fs }) => {
				for (const object of objects) await assertObjectAbsentOrEqual(fs, object);
			},
			verifySuccess: async (fs) => {
				await assertCatalog(fs, objects);
			},
			retry: async (fs) => {
				await storage(fs).putObjects(input);
				await assertCatalog(fs.reboot(), objects);
			},
		});
	});

	test("delta compaction keeps every object readable across pack publication and cleanup", async () => {
		const base = await blob(`${"stable line\n".repeat(200)}old ending\n`);
		const target = await blob(`${"stable line\n".repeat(200)}new ending\n`);
		const delta = createDelta(createDeltaIndex(base.content), target.content);
		expect(delta).not.toBeNull();
		const rows = [
			{
				hash: target.hash,
				type: "blob",
				encoding: "delta-zlib",
				baseHash: base.hash,
				content: await deflate(delta!),
			},
			{
				hash: base.hash,
				type: "blob",
				encoding: "raw-zlib",
				content: await deflate(base.content),
			},
		] as const;

		await replayCrashCuts({
			setup: async (fs) => {
				await setupRepo(fs);
				await storage(fs).putObjects([base, target]);
			},
			operation: (fs) => storage(fs).putDeltaObjects(rows),
			verifyCut: async ({ fs }) => {
				await assertCatalog(fs, [base, target]);
				await assertNoIndexWithoutPack(fs);
			},
			verifySuccess: async (fs) => {
				await assertCatalog(fs, [base, target]);
				const files = await fs.readdir("/repo/objects/pack");
				expect(files.filter((file) => file.endsWith(".pack"))).toHaveLength(1);
				expect(files.filter((file) => file.endsWith(".idx"))).toHaveLength(1);
			},
		});
	});

	test("loose deletion leaves each object complete or durably absent", async () => {
		const objects = await Promise.all([blob("delete one"), blob("delete two"), blob("keep")]);
		const deleted = objects.slice(0, 2);

		await replayCrashCuts({
			setup: async (fs) => {
				await setupRepo(fs);
				await storage(fs).putObjects(objects);
			},
			operation: (fs) => storage(fs).deleteObjects(deleted.map((object) => object.hash)),
			verifyCut: async ({ fs }) => {
				for (const object of deleted) await assertObjectAbsentOrEqual(fs, object);
				await assertObjectEqual(fs, objects[2]!);
			},
			verifySuccess: async (fs) => {
				for (const object of deleted) expect(await storage(fs).getObject(object.hash)).toBeNull();
				await assertObjectEqual(fs, objects[2]!);
			},
			retry: async (fs) => {
				await storage(fs).deleteObjects(deleted.map((object) => object.hash));
				for (const object of deleted) {
					expect(await storage(fs.reboot()).getObject(object.hash)).toBeNull();
				}
			},
		});
	});

	test("loose deletion never removes a pack-backed copy", async () => {
		const base = await blob(`${"packed base\n".repeat(100)}old\n`);
		const target = await blob(`${"packed base\n".repeat(100)}new\n`);
		const delta = createDelta(createDeltaIndex(base.content), target.content);
		expect(delta).not.toBeNull();

		await replayCrashCuts({
			setup: async (fs) => {
				await setupRepo(fs);
				const store = storage(fs);
				await store.putObjects([base, target]);
				await store.putDeltaObjects([
					{
						hash: target.hash,
						type: "blob",
						encoding: "delta-zlib",
						baseHash: base.hash,
						content: await deflate(delta!),
					},
					{
						hash: base.hash,
						type: "blob",
						encoding: "raw-zlib",
						content: await deflate(base.content),
					},
				]);
				// Recreate redundant loose copies after compaction removed them.
				await store.putObjects([base, target]);
			},
			operation: (fs) => storage(fs).deleteObjects([base.hash, target.hash]),
			verifyCut: ({ fs }) => assertCatalog(fs, [base, target]),
			verifySuccess: (fs) => assertCatalog(fs, [base, target]),
		});
	});
});

interface Blob {
	hash: string;
	type: "blob";
	content: Uint8Array;
}

async function blob(value: string): Promise<Blob> {
	const content = encoder.encode(value);
	return { hash: await hashObject("blob", content), type: "blob", content };
}

async function setupRepo(fs: CrashableDurableFileSystem): Promise<void> {
	await fs.mkdir("/repo");
	await fs.mkdir("/repo/objects");
}

function storage(fs: CrashableDurableFileSystem): FsObjectStorage {
	return new FsObjectStorage(fs, "/repo");
}

async function assertObjectAbsentOrEqual(
	fs: CrashableDurableFileSystem,
	object: Blob,
): Promise<void> {
	const actual = await storage(fs).getObject(object.hash);
	if (actual === null) return;
	expect(actual).toEqual({
		type: object.type,
		encoding: "raw",
		content: object.content,
	});
}

async function assertObjectEqual(fs: CrashableDurableFileSystem, object: Blob): Promise<void> {
	expect(await storage(fs).getObject(object.hash)).toEqual({
		type: object.type,
		encoding: "raw",
		content: object.content,
	});
}

async function assertCatalog(
	fs: CrashableDurableFileSystem,
	objects: readonly Blob[],
): Promise<void> {
	const fresh = storage(fs);
	for (const object of objects) {
		expect((await fresh.getObject(object.hash))?.content).toEqual(object.content);
	}
	expect(await fresh.listObjectHashes()).toEqual(objects.map((object) => object.hash).sort());
}

async function assertNoIndexWithoutPack(fs: CrashableDurableFileSystem): Promise<void> {
	if (!(await fs.exists("/repo/objects/pack"))) return;
	const files = await fs.readdir("/repo/objects/pack");
	for (const index of files.filter((file) => file.endsWith(".idx"))) {
		expect(files).toContain(`${index.slice(0, -4)}.pack`);
	}
}
