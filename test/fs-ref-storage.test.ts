import { afterEach, describe, expect, test } from "bun:test";
import * as nodeFs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { durableFileSystemFromNodeFs } from "../src/fs/node-durable-fs.ts";
import type { Ref } from "../src/lib/types.ts";
import { FsRefStorage } from "../src/store/fs-ref-storage.ts";

const HASH_A = "a".repeat(40);
const HASH_B = "b".repeat(40);
const HASH_C = "c".repeat(40);
const tempDirs: string[] = [];

async function tempRepo() {
	const repoDir = await nodeFs.mkdtemp(join(tmpdir(), "just-git-fs-refs-"));
	tempDirs.push(repoDir);
	const fs = durableFileSystemFromNodeFs(nodeFs);
	await fs.mkdir(join(repoDir, "refs"), { recursive: true });
	return { fs, repoDir, storage: new FsRefStorage(fs, repoDir) };
}

afterEach(async () => {
	await Promise.all(
		tempDirs.splice(0).map((dir) => nodeFs.rm(dir, { recursive: true, force: true })),
	);
});

describe("FsRefStorage", () => {
	test("stores direct and symbolic refs in native loose files", async () => {
		const { fs, repoDir, storage } = await tempRepo();
		await storage.putRef("refs/heads/main", direct(HASH_A));
		await storage.putRef("HEAD", symbolic("refs/heads/main"));

		expect(await storage.getRef("refs/heads/main")).toEqual(direct(HASH_A));
		expect(await storage.getRef("HEAD")).toEqual(symbolic("refs/heads/main"));
		expect(await fs.readFile(join(repoDir, "refs/heads/main"))).toBe(`${HASH_A}\n`);
		expect(await fs.readFile(join(repoDir, "HEAD"))).toBe("ref: refs/heads/main\n");
	});

	test("reads loose refs before packed refs and removes both forms", async () => {
		const { fs, repoDir, storage } = await tempRepo();
		await fs.writeFile(
			join(repoDir, "packed-refs"),
			[
				"# pack-refs with: peeled fully-peeled sorted",
				`${HASH_A} refs/heads/main`,
				`${HASH_B} refs/tags/v1`,
				`^${HASH_C}`,
				`${HASH_C} refs/heads/keep`,
				"",
			].join("\n"),
		);

		expect(await storage.getRef("refs/heads/main")).toEqual(direct(HASH_A));
		await storage.putRef("refs/heads/main", direct(HASH_B));
		expect(await storage.getRef("refs/heads/main")).toEqual(direct(HASH_B));

		await storage.removeRef("refs/heads/main");
		expect(await storage.getRef("refs/heads/main")).toBeNull();

		await storage.removeRef("refs/tags/v1");
		const packed = await fs.readFile(join(repoDir, "packed-refs"));
		expect(packed).not.toContain("refs/tags/v1");
		expect(packed).not.toContain(`^${HASH_C}`);
		expect(packed).toContain(`${HASH_C} refs/heads/keep`);
	});

	test("lists raw loose, packed, and uppercase pseudo refs with prefix filtering", async () => {
		const { fs, repoDir, storage } = await tempRepo();
		await fs.writeFile(
			join(repoDir, "packed-refs"),
			`${HASH_A} refs/heads/main\n${HASH_B} refs/tags/v1\n`,
		);
		await storage.putRef("refs/heads/main", direct(HASH_C));
		await storage.putRef("refs/heads/dev", symbolic("refs/heads/main"));
		await storage.putRef("HEAD", symbolic("refs/heads/main"));
		await storage.putRef("ORIG_HEAD", direct(HASH_A));
		await fs.writeFile(join(repoDir, "config"), "[core]\n\tbare = true\n");

		expect(await storage.listRefs()).toEqual([
			{ name: "HEAD", ref: symbolic("refs/heads/main") },
			{ name: "ORIG_HEAD", ref: direct(HASH_A) },
			{ name: "refs/heads/dev", ref: symbolic("refs/heads/main") },
			{ name: "refs/heads/main", ref: direct(HASH_C) },
			{ name: "refs/tags/v1", ref: direct(HASH_B) },
		]);
		expect(await storage.listRefs("refs/heads")).toEqual([
			{ name: "refs/heads/dev", ref: symbolic("refs/heads/main") },
			{ name: "refs/heads/main", ref: direct(HASH_C) },
		]);
		expect(await storage.listRefs("refs/heads/")).toEqual([
			{ name: "refs/heads/dev", ref: symbolic("refs/heads/main") },
			{ name: "refs/heads/main", ref: direct(HASH_C) },
		]);
		expect(await storage.listRefs("refs/tags/")).toEqual([
			{ name: "refs/tags/v1", ref: direct(HASH_B) },
		]);
		expect(await storage.listRefs("HEAD")).toEqual([
			{ name: "HEAD", ref: symbolic("refs/heads/main") },
		]);
	});

	test("commits one staged ref with read-your-writes and rolls back callback failures", async () => {
		const { storage } = await tempRepo();
		await storage.putRef("refs/heads/main", direct(HASH_A));

		const result = await storage.atomicRefUpdate(async (ops) => {
			expect(await ops.getRef("refs/heads/main")).toEqual(direct(HASH_A));
			await ops.putRef("refs/heads/main", direct(HASH_B));
			expect(await ops.getRef("refs/heads/main")).toEqual(direct(HASH_B));
			return "committed";
		});
		expect(result).toBe("committed");
		expect(await storage.getRef("refs/heads/main")).toEqual(direct(HASH_B));

		expect(
			storage.atomicRefUpdate(async (ops) => {
				await ops.removeRef("refs/heads/main");
				expect(await ops.getRef("refs/heads/main")).toBeNull();
				throw new Error("abort");
			}),
		).rejects.toThrow("abort");
		expect(await storage.getRef("refs/heads/main")).toEqual(direct(HASH_B));
	});

	test("supports CAS decisions and rejects multi-ref transactions before commit", async () => {
		const { storage } = await tempRepo();
		await storage.putRef("refs/heads/main", direct(HASH_A));

		expect(await compareAndSwap(storage, "refs/heads/main", HASH_B, direct(HASH_C))).toBe(false);
		expect(await compareAndSwap(storage, "refs/heads/main", HASH_A, direct(HASH_B))).toBe(true);
		expect(await storage.getRef("refs/heads/main")).toEqual(direct(HASH_B));

		expect(
			storage.atomicRefUpdate(async (ops) => {
				await ops.putRef("refs/heads/main", direct(HASH_C));
				await ops.putRef("refs/heads/other", direct(HASH_A));
			}),
		).rejects.toThrow("only one distinct ref");
		expect(await storage.getRef("refs/heads/main")).toEqual(direct(HASH_B));
		expect(await storage.getRef("refs/heads/other")).toBeNull();
	});

	test("queues two handles contending normally for the repository lock", async () => {
		const { fs, repoDir } = await tempRepo();
		const first = new FsRefStorage(fs, repoDir);
		const second = new FsRefStorage(fs, repoDir);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const order: string[] = [];

		const firstUpdate = first.atomicRefUpdate(async (ops) => {
			order.push("first-enter");
			await ops.putRef("refs/heads/main", direct(HASH_A));
			await gate;
			order.push("first-exit");
		});
		await waitFor(() => order.length === 1);
		const secondUpdate = second.atomicRefUpdate(async (ops) => {
			order.push("second-enter");
			expect(await ops.getRef("refs/heads/main")).toEqual(direct(HASH_A));
			await ops.putRef("refs/heads/main", direct(HASH_B));
		});

		await Promise.resolve();
		expect(order).toEqual(["first-enter"]);
		release();
		await Promise.all([firstUpdate, secondUpdate]);
		expect(order).toEqual(["first-enter", "first-exit", "second-enter"]);
		expect(await first.getRef("refs/heads/main")).toEqual(direct(HASH_B));
	});

	test("rejects caller-supplied paths that can escape the repository", async () => {
		const { storage } = await tempRepo();
		expect(storage.getRef("../../outside")).rejects.toThrow("invalid filesystem ref name");
		expect(storage.putRef("/absolute", direct(HASH_A))).rejects.toThrow(
			"invalid filesystem ref name",
		);
		expect(storage.removeRef("refs//heads/main")).rejects.toThrow("invalid filesystem ref name");
		expect(storage.listRefs("../refs")).rejects.toThrow("invalid filesystem ref name");
		for (const prefix of ["/", "refs//", "refs/heads//", "../", "refs/../"]) {
			expect(storage.listRefs(prefix)).rejects.toThrow("invalid filesystem ref name");
		}
	});
});

function direct(hash: string): Ref {
	return { type: "direct", hash };
}

function symbolic(target: string): Ref {
	return { type: "symbolic", target };
}

async function compareAndSwap(
	storage: FsRefStorage,
	name: string,
	expected: string | null,
	replacement: Ref | null,
): Promise<boolean> {
	return storage.atomicRefUpdate(async (ops) => {
		const current = await ops.getRef(name);
		const currentHash = current?.type === "direct" ? current.hash : null;
		if (currentHash !== expected) return false;
		if (replacement) await ops.putRef(name, replacement);
		else await ops.removeRef(name);
		return true;
	});
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let i = 0; i < 100; i++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	throw new Error("timed out waiting for contention test");
}
