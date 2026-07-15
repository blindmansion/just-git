import { describe, expect, test } from "bun:test";
import { hashObject } from "../../../src/lib/object-db.ts";
import { serializeCommit } from "../../../src/lib/objects/commit.ts";
import { serializeTree } from "../../../src/lib/objects/tree.ts";
import type { ObjectType } from "../../../src/lib/types.ts";
import { createFsRepoStorage } from "../../../src/store/fs-repo-storage.ts";
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
