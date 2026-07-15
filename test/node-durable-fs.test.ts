import { afterEach, describe, expect, test } from "bun:test";
import * as nodeFs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDurable } from "../src/fs/index.ts";
import { MemoryFileSystem } from "../src/fs/memory-fs.ts";
import { durableFileSystemFromNodeFs } from "../src/fs/node-durable-fs.ts";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await nodeFs.mkdtemp(join(tmpdir(), "just-git-durable-fs-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(
		tempDirs.splice(0).map((dir) => nodeFs.rm(dir, { recursive: true, force: true })),
	);
});

describe("DurableFileSystem", () => {
	test("recognizes only filesystems with every durability primitive", () => {
		expect(isDurable(new MemoryFileSystem())).toBe(false);

		const partial = new MemoryFileSystem() as MemoryFileSystem & {
			fsync: () => Promise<void>;
			rename?: () => Promise<void>;
			link?: () => Promise<void>;
		};
		partial.fsync = async () => {};
		expect(isDurable(partial)).toBe(false);
		partial.rename = async () => {};
		partial.link = async () => {};
		expect(isDurable(partial)).toBe(true);
	});

	test("adapts node fs operations and metadata", async () => {
		const dir = await tempDir();
		const fs = durableFileSystemFromNodeFs(nodeFs);
		const nested = join(dir, "nested");
		const textPath = join(nested, "text.txt");
		const binaryPath = join(nested, "binary");

		expect(isDurable(fs)).toBe(true);
		await fs.mkdir(nested);
		await fs.writeFile(textPath, "hello");
		await fs.writeFile(binaryPath, new Uint8Array([0, 127, 255]));

		expect(await fs.readFile(textPath)).toBe("hello");
		expect(await fs.readFileBuffer(binaryPath)).toEqual(new Uint8Array([0, 127, 255]));
		expect((await fs.readdir(nested)).sort()).toEqual(["binary", "text.txt"]);
		expect(await fs.exists(textPath)).toBe(true);
		expect(await fs.exists(join(nested, "missing"))).toBe(false);

		const stat = await fs.stat(textPath);
		expect(stat.isFile).toBe(true);
		expect(stat.isDirectory).toBe(false);
		expect(stat.isSymbolicLink).toBe(false);
		expect(stat.size).toBe(5);
		expect(stat.mtime).toBeInstanceOf(Date);

		await fs.chmod?.(textPath, 0o600);
		expect((await fs.stat(textPath)).mode & 0o777).toBe(0o600);
		await fs.fsync(textPath);
		await fs.fsync(nested);
	});

	test("renames over an existing destination", async () => {
		const dir = await tempDir();
		const fs = durableFileSystemFromNodeFs(nodeFs);
		const src = join(dir, "src");
		const dest = join(dir, "dest");
		await fs.writeFile(src, "new");
		await fs.writeFile(dest, "old");

		await fs.rename(src, dest);

		expect(await fs.exists(src)).toBe(false);
		expect(await fs.readFile(dest)).toBe("new");
	});

	test("provides exclusive hard links and symlink metadata", async () => {
		const dir = await tempDir();
		const fs = durableFileSystemFromNodeFs(nodeFs);
		const source = join(dir, "source");
		const hardLink = join(dir, "hard-link");
		const symbolicLink = join(dir, "symbolic-link");
		await fs.writeFile(source, "content");

		await fs.link(source, hardLink);
		expect(await fs.readFile(hardLink)).toBe("content");
		expect(fs.link(source, hardLink)).rejects.toMatchObject({ code: "EEXIST" });

		await fs.symlink?.("source", symbolicLink);
		expect(await fs.readlink?.(symbolicLink)).toBe("source");
		expect((await fs.lstat?.(symbolicLink))?.isSymbolicLink).toBe(true);
	});
});
