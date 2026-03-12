import { describe, expect, test } from "bun:test";
import {
	createDelta,
	createDeltaIndex,
	type DeltaObject,
	findBestDeltas,
} from "../../src/lib/pack/delta.ts";
import { buildPackIndex } from "../../src/lib/pack/pack-index.ts";
import { PackReader } from "../../src/lib/pack/pack-reader.ts";
import { type DeltaPackInput, readPack, writePackDeltified } from "../../src/lib/pack/packfile.ts";
import { createHasher } from "../../src/lib/sha1.ts";
import type { ObjectId } from "../../src/lib/types.ts";

const enc = new TextEncoder();

async function gitHash(type: string, content: Uint8Array): Promise<ObjectId> {
	const header = enc.encode(`${type} ${content.byteLength}\0`);
	const hasher = createHasher();
	hasher.update(header);
	hasher.update(content);
	return hasher.hex();
}

// ── writePackDeltified ───────────────────────────────────────────────

describe("writePackDeltified", () => {
	test("round-trip base + delta object via readPack", async () => {
		const base = enc.encode("Hello, this is base content.\n".repeat(20));
		const target = enc.encode(
			"Hello, this is base content.\n".repeat(10) +
				"This line was modified.\n" +
				"Hello, this is base content.\n".repeat(9),
		);

		const baseHash = await gitHash("blob", base);
		const targetHash = await gitHash("blob", target);

		const index = createDeltaIndex(base);
		const delta = createDelta(index, target)!;
		expect(delta).not.toBeNull();

		const inputs: DeltaPackInput[] = [
			{ hash: baseHash, type: "blob", content: base },
			{
				hash: targetHash,
				type: "blob",
				content: target,
				delta,
				deltaBaseHash: baseHash,
			},
		];

		const { data: packData } = await writePackDeltified(inputs);
		const objects = await readPack(packData);

		expect(objects).toHaveLength(2);
		const baseObj = objects.find((o) => o.hash === baseHash);
		const targetObj = objects.find((o) => o.hash === targetHash);
		expect(baseObj).toBeDefined();
		expect(targetObj).toBeDefined();
		expect(baseObj!.content).toEqual(base);
		expect(targetObj!.content).toEqual(target);
	});

	test("multi-object delta chain A->B->C", async () => {
		const contentA = enc.encode("line of code;\n".repeat(100));
		const contentB = enc.encode(
			"line of code;\n".repeat(50) + "modified line B;\n" + "line of code;\n".repeat(49),
		);
		const contentC = enc.encode(
			"line of code;\n".repeat(50) + "modified line C;\n" + "line of code;\n".repeat(49),
		);

		const hashA = await gitHash("blob", contentA);
		const hashB = await gitHash("blob", contentB);
		const hashC = await gitHash("blob", contentC);

		const idxA = createDeltaIndex(contentA);
		const deltaB = createDelta(idxA, contentB)!;
		expect(deltaB).not.toBeNull();

		const idxB = createDeltaIndex(contentB);
		const deltaC = createDelta(idxB, contentC)!;
		expect(deltaC).not.toBeNull();

		const inputs: DeltaPackInput[] = [
			{ hash: hashA, type: "blob", content: contentA },
			{
				hash: hashB,
				type: "blob",
				content: contentB,
				delta: deltaB,
				deltaBaseHash: hashA,
			},
			{
				hash: hashC,
				type: "blob",
				content: contentC,
				delta: deltaC,
				deltaBaseHash: hashB,
			},
		];

		const { data: packData } = await writePackDeltified(inputs);
		const objects = await readPack(packData);

		expect(objects).toHaveLength(3);
		expect(objects.find((o) => o.hash === hashA)!.content).toEqual(contentA);
		expect(objects.find((o) => o.hash === hashB)!.content).toEqual(contentB);
		expect(objects.find((o) => o.hash === hashC)!.content).toEqual(contentC);
	});

	test("mixed base and delta objects", async () => {
		const content1 = enc.encode("first file content\n".repeat(30));
		const content2 = enc.encode("completely different data\n".repeat(30));
		const content3 = enc.encode(
			"first file content\n".repeat(15) + "edited section\n" + "first file content\n".repeat(14),
		);

		const hash1 = await gitHash("blob", content1);
		const hash2 = await gitHash("blob", content2);
		const hash3 = await gitHash("blob", content3);

		const idx1 = createDeltaIndex(content1);
		const delta3 = createDelta(idx1, content3)!;
		expect(delta3).not.toBeNull();

		const inputs: DeltaPackInput[] = [
			{ hash: hash1, type: "blob", content: content1 },
			{ hash: hash2, type: "blob", content: content2 },
			{
				hash: hash3,
				type: "blob",
				content: content3,
				delta: delta3,
				deltaBaseHash: hash1,
			},
		];

		const { data: packData } = await writePackDeltified(inputs);
		const objects = await readPack(packData);

		expect(objects).toHaveLength(3);
		for (const input of inputs) {
			const obj = objects.find((o) => o.hash === input.hash);
			expect(obj).toBeDefined();
			expect(obj!.content).toEqual(input.content);
		}
	});

	test("PackReader round-trip with deltified pack", async () => {
		const base = enc.encode("repeat this line of text\n".repeat(60));
		const target = enc.encode(
			"repeat this line of text\n".repeat(30) +
				"inserted new text here\n" +
				"repeat this line of text\n".repeat(29),
		);

		const baseHash = await gitHash("blob", base);
		const targetHash = await gitHash("blob", target);

		const idx = createDeltaIndex(base);
		const delta = createDelta(idx, target)!;

		const inputs: DeltaPackInput[] = [
			{ hash: baseHash, type: "blob", content: base },
			{
				hash: targetHash,
				type: "blob",
				content: target,
				delta,
				deltaBaseHash: baseHash,
			},
		];

		const { data: packData } = await writePackDeltified(inputs);
		const idxData = await buildPackIndex(packData);
		const reader = new PackReader(packData, idxData);

		expect(reader.hasObject(baseHash)).toBe(true);
		expect(reader.hasObject(targetHash)).toBe(true);

		const baseObj = await reader.readObject(baseHash);
		expect(baseObj!.type).toBe("blob");
		expect(baseObj!.content).toEqual(base);

		const targetObj = await reader.readObject(targetHash);
		expect(targetObj!.type).toBe("blob");
		expect(targetObj!.content).toEqual(target);
	});

	test("git index-pack accepts deltified pack", async () => {
		const { mkdtemp } = await import("node:fs/promises");
		const { join } = await import("node:path");
		const { tmpdir } = await import("node:os");
		const fs = await import("node:fs");

		const base = enc.encode(`# Large File\n\n${"Some repeated content here.\n".repeat(100)}`);
		const target = enc.encode(
			`# Large File (v2)\n\n${"Some repeated content here.\n".repeat(100)}`,
		);

		const baseHash = await gitHash("blob", base);
		const targetHash = await gitHash("blob", target);

		const idx = createDeltaIndex(base);
		const delta = createDelta(idx, target)!;

		const inputs: DeltaPackInput[] = [
			{ hash: baseHash, type: "blob", content: base },
			{
				hash: targetHash,
				type: "blob",
				content: target,
				delta,
				deltaBaseHash: baseHash,
			},
		];

		const { data: packData } = await writePackDeltified(inputs);

		const tmpDir = await mkdtemp(join(tmpdir(), "writepack-interop-"));
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

	test("findBestDeltas results write and read correctly", async () => {
		const baseText = "shared content line\n".repeat(60);
		const objects: DeltaObject[] = [];
		for (let i = 0; i < 5; i++) {
			const content = `${baseText.slice(0, 200)}version-${i}\n${baseText.slice(200)}`;
			const contentBytes = enc.encode(content);
			const hash = await gitHash("blob", contentBytes);
			objects.push({
				type: "blob",
				content: contentBytes,
				hash: hash as DeltaObject["hash"],
			});
		}

		const results = findBestDeltas(objects);
		const deltafied = results.filter((r) => r.delta);
		expect(deltafied.length).toBeGreaterThan(0);

		const inputs: DeltaPackInput[] = results.map((r) => ({
			hash: r.hash,
			type: r.type,
			content: r.content,
			delta: r.delta,
			deltaBaseHash: r.deltaBase,
		}));

		const { data: packData } = await writePackDeltified(inputs);
		const readBack = await readPack(packData);

		expect(readBack).toHaveLength(objects.length);
		for (const obj of objects) {
			const found = readBack.find((o) => o.hash === obj.hash);
			expect(found).toBeDefined();
			expect(found!.content).toEqual(obj.content);
		}
	});

	test("handles all-base (no deltas) pack correctly", async () => {
		const content1 = enc.encode("file one\n");
		const content2 = enc.encode("file two\n");
		const hash1 = await gitHash("blob", content1);
		const hash2 = await gitHash("blob", content2);

		const inputs: DeltaPackInput[] = [
			{ hash: hash1, type: "blob", content: content1 },
			{ hash: hash2, type: "blob", content: content2 },
		];

		const { data: packData } = await writePackDeltified(inputs);
		const objects = await readPack(packData);

		expect(objects).toHaveLength(2);
		expect(objects.find((o) => o.hash === hash1)!.content).toEqual(content1);
		expect(objects.find((o) => o.hash === hash2)!.content).toEqual(content2);
	});

	test("delta with missing base falls back to base-type entry", async () => {
		const base = enc.encode("base content here\n".repeat(20));
		const target = enc.encode(
			"base content here\n".repeat(10) + "modified\n" + "base content here\n".repeat(9),
		);

		const targetHash = await gitHash("blob", target);

		const idx = createDeltaIndex(base);
		const delta = createDelta(idx, target)!;

		// Reference a non-existent base hash -- writePackDeltified falls back
		const inputs: DeltaPackInput[] = [
			{
				hash: targetHash,
				type: "blob",
				content: target,
				delta,
				deltaBaseHash: "0000000000000000000000000000000000000000" as ObjectId,
			},
		];

		const { data: packData } = await writePackDeltified(inputs);
		const objects = await readPack(packData);

		expect(objects).toHaveLength(1);
		expect(objects[0]!.content).toEqual(target);
	});

	test("multiple types in one pack", async () => {
		const blob = enc.encode("blob data\n".repeat(20));
		const tree = enc.encode("tree data\n".repeat(20));
		const commit = enc.encode("commit data\n".repeat(20));

		const blobHash = await gitHash("blob", blob);
		const treeHash = await gitHash("tree", tree);
		const commitHash = await gitHash("commit", commit);

		const inputs: DeltaPackInput[] = [
			{ hash: blobHash, type: "blob", content: blob },
			{ hash: treeHash, type: "tree", content: tree },
			{ hash: commitHash, type: "commit", content: commit },
		];

		const { data: packData } = await writePackDeltified(inputs);
		const objects = await readPack(packData);

		expect(objects).toHaveLength(3);
		expect(objects.find((o) => o.hash === blobHash)!.type).toBe("blob");
		expect(objects.find((o) => o.hash === treeHash)!.type).toBe("tree");
		expect(objects.find((o) => o.hash === commitHash)!.type).toBe("commit");
	});
});
