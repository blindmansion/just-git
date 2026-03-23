import { describe, expect, test } from "bun:test";
import { createServer } from "../../src/server/handler.ts";
import { MemoryStorage } from "../../src/server/memory-storage.ts";
import { gcRepo } from "../../src/server/gc.ts";
import { createCommit, writeBlob, writeTree } from "../../src/repo/writing.ts";
import { resolveRef } from "../../src/repo/reading.ts";
import type { Identity } from "../../src/lib/types.ts";

const ID: Identity = {
	name: "Test",
	email: "test@test.com",
	timestamp: 1000000000,
	timezone: "+0000",
};

function idAt(ts: number): Identity {
	return { ...ID, timestamp: ts };
}

async function setupServer() {
	const driver = new MemoryStorage();
	const server = createServer({ storage: driver });
	const repo = await server.createRepo("test");

	const blob = await writeBlob(repo, "hello");
	const tree = await writeTree(repo, [{ name: "README.md", hash: blob }]);
	const initialHash = await createCommit(repo, {
		tree,
		parents: [],
		message: "init",
		author: ID,
		committer: ID,
		branch: "main",
	});

	return { server, driver, repo, initialHash };
}

describe("server.gc", () => {
	test("empty repo — no objects, no refs beyond HEAD", async () => {
		const driver = new MemoryStorage();
		const server = createServer({ storage: driver });
		await server.createRepo("empty");

		const result = await server.gc("empty");
		expect(result.deleted).toBe(0);
		expect(result.retained).toBe(0);
		expect(result.aborted).toBeUndefined();
	});

	test("all objects reachable — nothing deleted", async () => {
		const { server, driver } = await setupServer();

		const beforeCount = driver.listObjectHashes("test").length;
		expect(beforeCount).toBeGreaterThan(0);

		const result = await server.gc("test");
		expect(result.deleted).toBe(0);
		expect(result.retained).toBe(beforeCount);

		const afterCount = driver.listObjectHashes("test").length;
		expect(afterCount).toBe(beforeCount);
	});

	test("unreachable objects from force-pushed-away commit are deleted", async () => {
		const { server, driver, repo, initialHash } = await setupServer();

		const blob2 = await writeBlob(repo, "second");
		const tree2 = await writeTree(repo, [{ name: "README.md", hash: blob2 }]);
		await createCommit(repo, {
			tree: tree2,
			parents: [initialHash],
			message: "second",
			author: idAt(1000000001),
			committer: idAt(1000000001),
			branch: "main",
		});

		// Force-push main back to initial, making second commit + its blob/tree unreachable
		await server.updateRefs("test", [{ ref: "refs/heads/main", newHash: initialHash }]);

		const beforeCount = driver.listObjectHashes("test").length;
		const result = await server.gc("test");

		expect(result.deleted).toBeGreaterThan(0);
		expect(result.retained).toBeGreaterThan(0);

		const afterCount = driver.listObjectHashes("test").length;
		expect(afterCount).toBe(beforeCount - result.deleted);

		// The initial commit should still resolve
		const freshRepo = (await server.repo("test"))!;
		const headHash = await resolveRef(freshRepo, "refs/heads/main");
		expect(headHash).toBe(initialHash);
	});

	test("unreachable objects deleted — verified via object store", async () => {
		const { server, driver, repo, initialHash } = await setupServer();

		// Create a second commit on main
		const blob2 = await writeBlob(repo, "orphan-content");
		const tree2 = await writeTree(repo, [{ name: "file.txt", hash: blob2 }]);
		await createCommit(repo, {
			tree: tree2,
			parents: [initialHash],
			message: "will be orphaned",
			author: idAt(1000000001),
			committer: idAt(1000000001),
			branch: "main",
		});

		// Force main back to initial commit
		await server.updateRefs("test", [{ ref: "refs/heads/main", newHash: initialHash }]);

		const beforeHashes = new Set(driver.listObjectHashes("test"));
		expect(beforeHashes.has(blob2)).toBe(true);

		const result = await server.gc("test");
		expect(result.deleted).toBeGreaterThan(0);

		const afterHashes = new Set(driver.listObjectHashes("test"));
		expect(afterHashes.has(blob2)).toBe(false);
	});

	test("dry run reports counts without deleting", async () => {
		const { server, driver, repo, initialHash } = await setupServer();

		const blob2 = await writeBlob(repo, "dry-run-content");
		const tree2 = await writeTree(repo, [{ name: "file.txt", hash: blob2 }]);
		await createCommit(repo, {
			tree: tree2,
			parents: [initialHash],
			message: "orphan",
			author: idAt(1000000001),
			committer: idAt(1000000001),
			branch: "main",
		});

		await server.updateRefs("test", [{ ref: "refs/heads/main", newHash: initialHash }]);

		const beforeCount = driver.listObjectHashes("test").length;

		const result = await server.gc("test", { dryRun: true });
		expect(result.deleted).toBeGreaterThan(0);
		expect(result.retained).toBeGreaterThan(0);

		// Objects should NOT be deleted in dry run
		const afterCount = driver.listObjectHashes("test").length;
		expect(afterCount).toBe(beforeCount);
	});

	test("aborts when refs change during walk", async () => {
		const { driver, repo, initialHash } = await setupServer();

		const blob2 = await writeBlob(repo, "concurrent");
		const tree2 = await writeTree(repo, [{ name: "file.txt", hash: blob2 }]);
		const secondHash = await createCommit(repo, {
			tree: tree2,
			parents: [initialHash],
			message: "concurrent push",
			author: idAt(1000000001),
			committer: idAt(1000000001),
		});

		// Test the core gcRepo function directly so we can simulate
		// a ref change between the walk and deletion.
		// We do this by wrapping the refStore to mutate refs after
		// the first listRefs call.
		let listCallCount = 0;
		const originalListRefs = repo.refStore.listRefs.bind(repo.refStore);
		repo.refStore.listRefs = async (prefix?: string) => {
			const result = await originalListRefs(prefix);
			listCallCount++;
			if (listCallCount === 1) {
				// Simulate a concurrent push completing after the first snapshot
				await repo.refStore.writeRef("refs/heads/main", secondHash);
			}
			return result;
		};

		const result = await gcRepo(repo, driver, "test");
		expect(result.aborted).toBe(true);
		expect(result.deleted).toBe(0);
	});

	test("throws for non-existent repo", async () => {
		const server = createServer({ storage: new MemoryStorage() });

		expect(server.gc("nonexistent")).rejects.toThrow('Repository "nonexistent" not found');
	});

	test("throws when server is closed", async () => {
		const { server } = await setupServer();
		await server.close();

		expect(server.gc("test")).rejects.toThrow("Server is shutting down");
	});

	test("multiple branches keep all reachable objects", async () => {
		const { server, driver, repo, initialHash } = await setupServer();

		// Create a second branch with different content
		const blob2 = await writeBlob(repo, "feature-content");
		const tree2 = await writeTree(repo, [{ name: "feature.txt", hash: blob2 }]);
		const featureHash = await createCommit(repo, {
			tree: tree2,
			parents: [initialHash],
			message: "feature",
			author: idAt(1000000001),
			committer: idAt(1000000001),
		});

		await server.updateRefs("test", [{ ref: "refs/heads/feature", newHash: featureHash }]);

		const beforeCount = driver.listObjectHashes("test").length;
		const result = await server.gc("test");

		expect(result.deleted).toBe(0);
		expect(result.retained).toBe(beforeCount);
	});

	test("tags keep objects reachable", async () => {
		const { server, driver, repo, initialHash } = await setupServer();

		// Create a second commit, tag it, then move main away
		const blob2 = await writeBlob(repo, "tagged");
		const tree2 = await writeTree(repo, [{ name: "file.txt", hash: blob2 }]);
		const taggedHash = await createCommit(repo, {
			tree: tree2,
			parents: [initialHash],
			message: "tagged commit",
			author: idAt(1000000001),
			committer: idAt(1000000001),
			branch: "main",
		});

		await server.updateRefs("test", [{ ref: "refs/tags/v1.0", newHash: taggedHash }]);

		// Force main back — the tagged commit is still reachable via the tag
		await server.updateRefs("test", [{ ref: "refs/heads/main", newHash: initialHash }]);

		const result = await server.gc("test");
		expect(result.deleted).toBe(0);

		// The tagged commit's blob should still exist
		const afterHashes = new Set(driver.listObjectHashes("test"));
		expect(afterHashes.has(blob2)).toBe(true);
	});
});
