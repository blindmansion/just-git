import { afterEach, describe, expect, test } from "bun:test";
import * as nodeFs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { durableFileSystemFromNodeFs } from "../src/fs/node-durable-fs.ts";
import { createFsRepoPool, createFsSingleRepoPool } from "../src/store/fs-repo-pool.ts";
import { createFsRepoStorage } from "../src/store/fs-repo-storage.ts";
import { createNodeFsRepoPool, createNodeFsSingleRepoPool } from "../src/store/node-fs.ts";
import { createRepoStore } from "../src/store/repo-store.ts";

const tempDirs: string[] = [];
const encoder = new TextEncoder();

async function tempRoot() {
	const root = await nodeFs.mkdtemp(join(tmpdir(), "just-git-fs-pool-"));
	tempDirs.push(root);
	return { root, fs: durableFileSystemFromNodeFs(nodeFs) };
}

afterEach(async () => {
	await Promise.all(
		tempDirs.splice(0).map((dir) => nodeFs.rm(dir, { recursive: true, force: true })),
	);
});

describe("createFsRepoPool", () => {
	test("accepts node:fs/promises through the Node convenience factory", async () => {
		const { root } = await tempRoot();
		const pool = await createNodeFsRepoPool(nodeFs, root);

		await pool.createRepo("demo");
		expect(await pool.hasRepo("demo")).toBe(true);
	});

	test("creates, opens, and deletes a deterministically encoded bare repository", async () => {
		const { root, fs } = await tempRoot();
		const pool = await createFsRepoPool(fs, root);

		expect(await pool.hasRepo("demo")).toBe(false);
		await pool.createRepo("demo");
		expect(await pool.hasRepo("demo")).toBe(true);

		const repoDir = join(root, "repos", "89", "r-mrsw23y.git");
		expect(await nodeFs.readFile(join(repoDir, "HEAD"), "utf8")).toBe("ref: refs/heads/main\n");
		const storage = await pool.open("demo");
		await storage.putRef("refs/heads/main", { type: "direct", hash: "a".repeat(40) });
		expect(await storage.getRef("refs/heads/main")).toEqual({
			type: "direct",
			hash: "a".repeat(40),
		});

		await pool.deleteRepo("demo");
		expect(await pool.hasRepo("demo")).toBe(false);
		expect(await nodeFs.readdir(join(root, ".just-git", "tombstones"))).toEqual([]);
	});

	test("rejects unsafe and overlong IDs before touching paths", async () => {
		const { root, fs } = await tempRoot();
		const pool = await createFsRepoPool(fs, root);

		expect(pool.createRepo("../escape")).rejects.toThrow("invalid repository ID");
		expect(pool.hasRepo("a//b")).rejects.toThrow("invalid repository ID");
		expect(pool.createRepo("a".repeat(156))).rejects.toThrow("too long");
		expect(await nodeFs.readdir(join(root, "repos"))).toEqual([]);
	});

	test("serializes concurrent creation through the shared pool lock", async () => {
		const { root, fs } = await tempRoot();
		const first = await createFsRepoPool(fs, root);
		const second = await createFsRepoPool(fs, root);

		const results = await Promise.allSettled([first.createRepo("same"), second.createRepo("same")]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
		expect(await first.hasRepo("same")).toBe(true);
	});

	test("persists forks, writes relative alternates, and enables parent fallback", async () => {
		const { root, fs } = await tempRoot();
		const pool = await createFsRepoPool(fs, root);
		const store = createRepoStore(pool);
		const upstream = await store.createRepo("upstream");
		const hash = await upstream.objectStore.write("blob", encoder.encode("parent object"));

		const fork = await store.forkRepo("upstream", "users/alice");
		expect(new TextDecoder().decode((await fork.objectStore.read(hash)).content)).toBe(
			"parent object",
		);
		expect(await pool.parentOf?.("users/alice")).toBe("upstream");
		expect(await pool.forksOf?.("upstream")).toEqual(["users/alice"]);

		const metadata = JSON.parse(
			await nodeFs.readFile(join(root, ".just-git", "forks.json"), "utf8"),
		);
		expect(metadata).toEqual({ version: 1, forks: { "users/alice": "upstream" } });

		const childObjects = await findObjectsDir(root, "users/alice");
		const rootObjects = await findObjectsDir(root, "upstream");
		expect(await nodeFs.readFile(join(childObjects, "info", "alternates"), "utf8")).toBe(
			`${relative(childObjects, rootObjects)}\n`,
		);
		const nativeRead = Bun.spawn(
			["git", "--git-dir", join(childObjects, ".."), "cat-file", "blob", hash],
			{ stdout: "pipe", stderr: "pipe" },
		);
		expect(await new Response(nativeRead.stdout).text()).toBe("parent object");
		expect(await nativeRead.exited).toBe(0);

		expect(store.deleteRepo("upstream")).rejects.toThrow("has 1 active fork");
		await store.deleteRepo("users/alice");
		await store.deleteRepo("upstream");
	});

	test("cleans safe abandoned entries and reports metadata inconsistencies", async () => {
		const { root, fs } = await tempRoot();
		const pool = await createFsRepoPool(fs, root);
		await pool.createRepo("upstream");
		await pool.createRepo("child");
		await pool.fork?.("upstream", "child");

		const tombstones = join(root, ".just-git", "tombstones");
		const shard = join(root, "repos", "aa");
		await nodeFs.mkdir(join(tombstones, "r-mzxw6.git-dead"), { recursive: true });
		await nodeFs.mkdir(join(shard, ".stage-r-mzxw6.git-dead"), { recursive: true });
		await createFsRepoPool(fs, root);
		expect(await nodeFs.readdir(tombstones)).toEqual([]);
		expect(await nodeFs.readdir(shard)).toEqual([]);

		await nodeFs.writeFile(join(root, ".just-git", "forks.json"), '{"version":1,"forks":{}}\n');
		expect(createFsRepoPool(fs, root)).rejects.toThrow("alternates missing from fork metadata");
	});

	test("rejects malformed and missing-repository fork metadata on startup", async () => {
		const { root, fs } = await tempRoot();
		await createFsRepoPool(fs, root);
		const metadataPath = join(root, ".just-git", "forks.json");

		await nodeFs.writeFile(metadataPath, "{nope");
		expect(createFsRepoPool(fs, root)).rejects.toThrow("malformed");

		await nodeFs.writeFile(
			metadataPath,
			'{"version":1,"forks":{"missing-child":"missing-root"}}\n',
		);
		expect(createFsRepoPool(fs, root)).rejects.toThrow("missing repository");
	});
});

describe("createFsSingleRepoPool", () => {
	test("accepts node:fs/promises through the Node convenience factory", async () => {
		const { root, fs } = await tempRoot();
		const repoDir = join(root, "external.git");
		await createFsRepoStorage(fs, repoDir);
		const pool = await createNodeFsSingleRepoPool(nodeFs, "public/repo", repoDir);

		expect(await pool.hasRepo("public/repo")).toBe(true);
	});

	test("maps exactly one ID to an existing bare repo and rejects mutations", async () => {
		const { root, fs } = await tempRoot();
		const repoDir = join(root, "external.git");
		await createFsRepoStorage(fs, repoDir);
		const pool = await createFsSingleRepoPool(fs, "public/repo", repoDir);

		expect(await pool.hasRepo("public/repo")).toBe(true);
		expect(await pool.hasRepo("other")).toBe(false);
		expect((await pool.open("public/repo")).getRef("HEAD")).resolves.toEqual({
			type: "symbolic",
			target: "refs/heads/main",
		});
		expect(pool.open("other")).rejects.toThrow("not found");
		expect(pool.createRepo("public/repo")).rejects.toThrow("does not support");
		expect(pool.deleteRepo("public/repo")).rejects.toThrow("does not support");
		expect(pool.fork).toBeUndefined();
	});
});

async function findObjectsDir(root: string, repoId: string): Promise<string> {
	const forks = JSON.parse(
		await nodeFs.readFile(join(root, ".just-git", "forks.json"), "utf8"),
	) as { forks: Record<string, string> };
	const ids = new Set<string>([repoId, ...Object.keys(forks.forks), ...Object.values(forks.forks)]);
	for (const shard of await nodeFs.readdir(join(root, "repos"))) {
		for (const name of await nodeFs.readdir(join(root, "repos", shard))) {
			const repoDir = join(root, "repos", shard, name);
			const head = await nodeFs.readFile(join(repoDir, "HEAD"), "utf8").catch(() => "");
			if (!head) continue;
			for (const id of ids) {
				if (name === `r-${base32(id)}.git` && id === repoId) return join(repoDir, "objects");
			}
		}
	}
	throw new Error(`repository path not found for ${repoId}`);
}

function base32(value: string): string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
	let accumulator = 0;
	let bits = 0;
	let result = "";
	for (const byte of encoder.encode(value)) {
		accumulator = (accumulator << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			result += alphabet[(accumulator >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) result += alphabet[(accumulator << (5 - bits)) & 31];
	return result;
}
