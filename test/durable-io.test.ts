import { afterEach, describe, expect, test } from "bun:test";
import * as nodeFs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createFile,
	createFileDurable,
	ensureDirectoryDurable,
	installPackPair,
	removeFileDurable,
	replaceFile,
	replaceFileDurable,
	withFileLock,
} from "../src/fs/durable-io.ts";
import { MemoryFileSystem } from "../src/fs/memory-fs.ts";
import { durableFileSystemFromNodeFs } from "../src/fs/node-durable-fs.ts";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await nodeFs.mkdtemp(join(tmpdir(), "just-git-durable-io-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(
		tempDirs.splice(0).map((dir) => nodeFs.rm(dir, { recursive: true, force: true })),
	);
});

describe("durable I/O helpers", () => {
	test("creates hierarchies and atomically replaces files without temp leftovers", async () => {
		const root = await tempDir();
		const fs = durableFileSystemFromNodeFs(nodeFs);
		const dir = join(root, "one", "two");
		const path = join(dir, "value");

		await ensureDirectoryDurable(fs, dir);
		await fs.writeFile(path, "old");
		await replaceFileDurable(fs, path, "new");

		expect(await fs.readFile(path)).toBe("new");
		expect(await fs.readdir(dir)).toEqual(["value"]);
	});

	test("installs immutable files once and removes them durably", async () => {
		const root = await tempDir();
		const fs = durableFileSystemFromNodeFs(nodeFs);
		const path = join(root, "objects", "value");

		expect(await createFileDurable(fs, path, "first")).toBe(true);
		expect(await createFileDurable(fs, path, "second")).toBe(false);
		expect(await fs.readFile(path)).toBe("first");
		expect(await removeFileDurable(fs, path)).toBe(true);
		expect(await removeFileDurable(fs, path)).toBe(false);
		expect(await fs.readdir(join(root, "objects"))).toEqual([]);
	});

	test("installs the pack before its visibility-gating index", async () => {
		const root = await tempDir();
		const fs = durableFileSystemFromNodeFs(nodeFs);
		const packPath = join(root, "objects", "pack", "pack-a.pack");
		const indexPath = join(root, "objects", "pack", "pack-a.idx");

		await installPackPair(fs, packPath, new Uint8Array([1, 2]), indexPath, new Uint8Array([3, 4]));

		expect(await fs.readFileBuffer(packPath)).toEqual(new Uint8Array([1, 2]));
		expect(await fs.readFileBuffer(indexPath)).toEqual(new Uint8Array([3, 4]));
		expect((await fs.readdir(join(root, "objects", "pack"))).sort()).toEqual([
			"pack-a.idx",
			"pack-a.pack",
		]);
	});

	test("queues same-process lock users and cleans up the lock", async () => {
		const root = await tempDir();
		const fs = durableFileSystemFromNodeFs(nodeFs);
		const lockPath = join(root, "refs.lock");
		const events: string[] = [];
		let releaseFirst!: () => void;
		const firstCanFinish = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});

		const first = withFileLock(fs, lockPath, async () => {
			events.push("first:start");
			await firstCanFinish;
			events.push("first:end");
		});
		const second = withFileLock(fs, lockPath, async () => {
			events.push("second");
		});

		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(events).toEqual(["first:start"]);
		releaseFirst();
		await Promise.all([first, second]);

		expect(events).toEqual(["first:start", "first:end", "second"]);
		expect(await fs.exists(lockPath)).toBe(false);
		expect(await fs.readdir(root)).toEqual([]);

		await expect(
			withFileLock(fs, lockPath, async () => {
				throw new Error("callback failed");
			}),
		).rejects.toThrow("callback failed");
		expect(await fs.exists(lockPath)).toBe(false);
		expect(await fs.readdir(root)).toEqual([]);
	});

	test("best-effort wrappers preserve plain filesystem behavior", async () => {
		const fs = new MemoryFileSystem();
		await fs.mkdir("/repo", { recursive: true });

		await replaceFile(fs, "/repo/config", "one");
		await replaceFile(fs, "/repo/config", "two");
		expect(await fs.readFile("/repo/config")).toBe("two");

		expect(await createFile(fs, "/repo/object", "first")).toBe(true);
		expect(await createFile(fs, "/repo/object", "second")).toBe(false);
		expect(await fs.readFile("/repo/object")).toBe("first");
	});
});
