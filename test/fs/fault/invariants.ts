import { expect } from "bun:test";
import type { FileSystem } from "../../../src/fs/index.ts";

export async function readFileIfPresent(fs: FileSystem, path: string): Promise<string | undefined> {
	return (await fs.exists(path)) ? fs.readFile(path) : undefined;
}

export async function assertOldOrNewFile(
	fs: FileSystem,
	path: string,
	oldContent: string | undefined,
	newContent: string,
): Promise<void> {
	expect([oldContent, newContent]).toContain(await readFileIfPresent(fs, path));
}

export async function assertAbsentOrComplete(
	fs: FileSystem,
	path: string,
	content: string,
): Promise<void> {
	expect([undefined, content]).toContain(await readFileIfPresent(fs, path));
}

export async function expectNoTemporaryEntries(fs: FileSystem, directory: string): Promise<void> {
	const entries = await fs.readdir(directory);
	expect(entries.filter((entry) => entry.includes(".tmp-"))).toEqual([]);
}
