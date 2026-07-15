import { describe, expect, test } from "bun:test";
import { hashObject } from "../../../src/lib/object-db.ts";
import { serializeCommit } from "../../../src/lib/objects/commit.ts";
import { serializeTree } from "../../../src/lib/objects/tree.ts";
import { sha1 } from "../../../src/lib/sha1.ts";
import type { ObjectType } from "../../../src/lib/types.ts";
import { createFsRepoPool, recoverFsRepoPool } from "../../../src/store/fs-repo-pool.ts";
import { createFsRepoStorage, recoverFsRepoStorage } from "../../../src/store/fs-repo-storage.ts";
import { createRepoStore } from "../../../src/store/repo-store.ts";
import { replayCrashCuts } from "./crash-harness.ts";
import { assertAllVisibleRefsReachObjects } from "./invariants.ts";

const encoder = new TextEncoder();
const BRANCH = "refs/heads/main";

describe("filesystem repository cross-layer crash durability", () => {
	test("objects become durable before a ref can publish their commit", async () => {
		const oldGraph = await commitGraph("old");
		const newGraph = await commitGraph("new");

		await replayCrashCuts({
			setup: async (fs) => {
				const repo = await createFsRepoStorage(fs, "/repo");
				await repo.putObjects(oldGraph.objects);
				await repo.putRef(BRANCH, { type: "direct", hash: oldGraph.commit });
			},
			operation: async (fs) => {
				const repo = await createFsRepoStorage(fs, "/repo");
				await repo.putObjects(newGraph.objects);
				await repo.atomicRefUpdate(async (ops) => {
					await ops.putRef(BRANCH, { type: "direct", hash: newGraph.commit });
				});
			},
			verifyCut: async ({ fs }) => {
				const repo = await createFsRepoStorage(fs, "/repo");
				const ref = await repo.getRef(BRANCH);
				expect(ref?.type).toBe("direct");
				const hash = ref?.type === "direct" ? ref.hash : undefined;
				expect(hash).toBeDefined();
				expect([oldGraph.commit, newGraph.commit]).toContain(hash!);

				const newObjectsPresent = await Promise.all(
					newGraph.objects.map((object) => repo.hasObject(object.hash)),
				);
				if (newObjectsPresent.includes(false)) expect(hash).toBe(oldGraph.commit);
				if (hash === newGraph.commit) expect(newObjectsPresent).toEqual([true, true, true]);
				await assertAllVisibleRefsReachObjects(repo);
			},
			verifySuccess: async (fs) => {
				const repo = await createFsRepoStorage(fs, "/repo");
				expect(await repo.getRef(BRANCH)).toEqual({
					type: "direct",
					hash: newGraph.commit,
				});
				await assertAllVisibleRefsReachObjects(repo);
			},
		});
	});

	test("fork ref copying may publish a reachable subset and retry converges", async () => {
		const first = await commitGraph("fork first");
		const second = await commitGraph("fork second");
		const targetPath = await poolPathFor("child");

		await replayCrashCuts({
			setup: async (fs) => {
				const pool = await createFsRepoPool(fs, "/pool");
				await pool.createRepo("upstream");
				const source = await pool.open("upstream");
				await source.putObjects([...first.objects, ...second.objects]);
				await source.putRef("refs/heads/first", { type: "direct", hash: first.commit });
				await source.putRef("refs/heads/second", { type: "direct", hash: second.commit });
				await source.putRef("HEAD", { type: "symbolic", target: "refs/heads/first" });
				await pool.createRepo("child");
				await pool.fork?.("upstream", "child");
			},
			operation: async (fs) => {
				const store = createRepoStore(await createFsRepoPool(fs, "/pool"));
				await store.forkRepo("upstream", "child");
			},
			verifyCut: async ({ fs }) => {
				const targetStorage = await createFsRepoStorage(fs, targetPath);
				const sourceStorage = await createFsRepoStorage(fs, await poolPathFor("upstream"));
				const sourceRefs = new Map(
					(await sourceStorage.listRefs()).map((entry) => [entry.name, entry.ref]),
				);
				for (const entry of await targetStorage.listRefs()) {
					const sourceRef = sourceRefs.get(entry.name);
					if (entry.name === "HEAD" && entry.ref.type === "symbolic") {
						expect(["refs/heads/main", "refs/heads/first"]).toContain(entry.ref.target);
					} else {
						expect(sourceRef).toBeDefined();
						expect(entry.ref).toEqual(sourceRef!);
					}
					if (entry.ref.type === "direct") {
						expect(await sourceStorage.hasObject(entry.ref.hash)).toBe(true);
					}
				}
				if (await fs.exists(`${targetPath}/.just-git-ref.lock`)) {
					expect(await fs.readFile(`${targetPath}/.just-git-ref.lock`)).toBe("");
				}
			},
			verifySuccess: async (fs) => {
				await assertForkRefsEqual(fs);
			},
			retry: async (fs) => {
				await recoverFsRepoPool(fs, "/pool");
				await recoverFsRepoStorage(fs, targetPath);
				const store = createRepoStore(await createFsRepoPool(fs, "/pool"));
				await store.forkRepo("upstream", "child");
				await assertForkRefsEqual(fs.reboot());
			},
		});
	});
});

interface ObjectInput {
	hash: string;
	type: ObjectType;
	content: Uint8Array;
}

interface CommitGraph {
	commit: string;
	objects: ObjectInput[];
}

async function commitGraph(label: string): Promise<CommitGraph> {
	const blobContent = encoder.encode(`${label} content\n`);
	const blob = await object("blob", blobContent);
	const treeContent = serializeTree({
		type: "tree",
		entries: [{ mode: "100644", name: "value.txt", hash: blob.hash }],
	});
	const tree = await object("tree", treeContent);
	const identity = {
		name: "Durability Test",
		email: "test@example.com",
		timestamp: label === "old" ? 1 : 2,
		timezone: "+0000",
	};
	const commitContent = serializeCommit({
		type: "commit",
		tree: tree.hash,
		parents: [],
		author: identity,
		committer: identity,
		message: `${label}\n`,
	});
	const commit = await object("commit", commitContent);
	return { commit: commit.hash, objects: [blob, tree, commit] };
}

async function object(type: ObjectType, content: Uint8Array): Promise<ObjectInput> {
	return { hash: await hashObject(type, content), type, content };
}

async function assertForkRefsEqual(fs: Parameters<typeof createFsRepoPool>[0]): Promise<void> {
	const pool = await createFsRepoPool(fs, "/pool");
	const source = await pool.open("upstream");
	const target = await pool.open("child");
	expect(await target.listRefs()).toEqual(await source.listRefs());
}

async function poolPathFor(repoId: string): Promise<string> {
	const bytes = encoder.encode(repoId);
	return `/pool/repos/${(await sha1(bytes)).slice(0, 2)}/r-${base32(bytes)}.git`;
}

function base32(bytes: Uint8Array): string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
	let accumulator = 0;
	let bits = 0;
	let result = "";
	for (const byte of bytes) {
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
