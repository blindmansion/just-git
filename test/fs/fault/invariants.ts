import { expect } from "bun:test";
import type { FileSystem } from "../../../src/fs/index.ts";
import { parseCommit } from "../../../src/lib/objects/commit.ts";
import { parseTag } from "../../../src/lib/objects/tag.ts";
import { parseTree } from "../../../src/lib/objects/tree.ts";
import type { RepoStorage } from "../../../src/store/repo-storage.ts";

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

/** Assert that every direct visible ref has a complete reachable object graph. */
export async function assertAllVisibleRefsReachObjects(storage: RepoStorage): Promise<void> {
	const pending = (await storage.listRefs())
		.map((entry) => entry.ref)
		.filter((ref) => ref.type === "direct")
		.map((ref) => ref.hash);
	const visited = new Set<string>();

	while (pending.length > 0) {
		const hash = pending.pop()!;
		if (visited.has(hash)) continue;
		visited.add(hash);
		const object = await storage.getObject(hash);
		if (!object) throw new Error(`visible ref reaches missing object ${hash}`);
		if (object.encoding !== "raw") {
			throw new Error(`reachability invariant requires materialized object ${hash}`);
		}
		if (object.type === "commit") {
			const commit = parseCommit(object.content);
			pending.push(commit.tree, ...commit.parents);
		} else if (object.type === "tree") {
			pending.push(...parseTree(object.content).entries.map((entry) => entry.hash));
		} else if (object.type === "tag") {
			pending.push(parseTag(object.content).object);
		}
	}
}
