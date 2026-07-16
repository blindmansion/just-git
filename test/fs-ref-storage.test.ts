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

	test("creates, replaces, and removes exact raw refs with CAS", async () => {
		const { storage } = await tempRepo();
		const symbolicMain = symbolic("refs/heads/main");

		expect(await storage.compareAndSwapRef("HEAD", null, symbolicMain)).toBe(true);
		expect(await storage.compareAndSwapRef("HEAD", symbolicMain, direct(HASH_A))).toBe(true);
		expect(await storage.compareAndSwapRef("HEAD", direct(HASH_A), null)).toBe(true);
		expect(await storage.getRef("HEAD")).toBeNull();
	});

	test("CAS compares the exact raw named ref and leaves mismatches unchanged", async () => {
		const { storage } = await tempRepo();
		await storage.putRef("refs/heads/main", direct(HASH_A));
		await storage.putRef("HEAD", symbolic("refs/heads/main"));

		expect(await storage.compareAndSwapRef("refs/heads/main", direct(HASH_B), direct(HASH_C))).toBe(
			false,
		);
		expect(await storage.getRef("refs/heads/main")).toEqual(direct(HASH_A));

		expect(await storage.compareAndSwapRef("HEAD", direct(HASH_A), direct(HASH_C))).toBe(false);
		expect(await storage.getRef("HEAD")).toEqual(symbolic("refs/heads/main"));

		expect(await storage.compareAndSwapRef("refs/heads/main", direct(HASH_A), direct(HASH_B))).toBe(
			true,
		);
		expect(await storage.getRef("refs/heads/main")).toEqual(direct(HASH_B));
	});

	test("serializes two handles contending for the same canonical ref lock", async () => {
		const { fs, repoDir } = await tempRepo();
		await new FsRefStorage(fs, repoDir).putRef("refs/heads/main", direct(HASH_A));
		const first = new FsRefStorage(fs, repoDir);
		const second = new FsRefStorage(fs, repoDir);
		const originalLink = fs.link.bind(fs);
		let releaseFirst!: () => void;
		const firstMayLink = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let firstBlocked!: () => void;
		const firstReachedLock = new Promise<void>((resolve) => {
			firstBlocked = resolve;
		});
		let blockFirst = true;
		fs.link = async (existingPath, newPath) => {
			if (blockFirst && newPath === join(repoDir, "refs/heads/main.lock")) {
				blockFirst = false;
				firstBlocked();
				await firstMayLink;
			}
			await originalLink(existingPath, newPath);
		};

		const firstUpdate = first.compareAndSwapRef("refs/heads/main", direct(HASH_A), direct(HASH_B));
		await firstReachedLock;
		let secondFinished = false;
		const secondUpdate = second
			.compareAndSwapRef("refs/heads/main", direct(HASH_A), direct(HASH_C))
			.then((result) => {
				secondFinished = true;
				return result;
			});

		await Promise.resolve();
		expect(secondFinished).toBe(false);
		releaseFirst();
		expect(await Promise.all([firstUpdate, secondUpdate])).toEqual([true, false]);
		expect(await first.getRef("refs/heads/main")).toEqual(direct(HASH_B));
		expect(await fs.exists(join(repoDir, "refs/heads/main.lock"))).toBe(false);
	});

	test("rejects caller-supplied paths that can escape the repository", async () => {
		const { storage } = await tempRepo();
		expect(storage.getRef("../../outside")).rejects.toThrow("invalid filesystem ref name");
		expect(storage.putRef("/absolute", direct(HASH_A))).rejects.toThrow("invalid native ref name");
		expect(storage.removeRef("refs//heads/main")).rejects.toThrow("invalid native ref name");
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
