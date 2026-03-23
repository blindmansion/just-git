import { describe, expect, test } from "bun:test";
import { createServer } from "../../src/server/handler.ts";
import { MemoryStorage } from "../../src/server/memory-storage.ts";
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
	const server = createServer({ storage: new MemoryStorage() });
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

	return { server, repo, initialHash };
}

describe("server.updateRefs", () => {
	test("creates a new branch ref", async () => {
		const { server, initialHash } = await setupServer();

		const result = await server.updateRefs("test", [
			{ ref: "refs/heads/feature", newHash: initialHash },
		]);

		expect(result.refResults).toHaveLength(1);
		expect(result.refResults[0]!.ok).toBe(true);
		expect(result.applied).toHaveLength(1);

		const repo = await server.requireRepo("test");
		const hash = await resolveRef(repo, "refs/heads/feature");
		expect(hash).toBe(initialHash);
	});

	test("advances an existing branch", async () => {
		const { server, repo, initialHash } = await setupServer();

		const blob2 = await writeBlob(repo, "updated");
		const tree2 = await writeTree(repo, [{ name: "README.md", hash: blob2 }]);
		const secondHash = await createCommit(repo, {
			tree: tree2,
			parents: [initialHash],
			message: "second",
			author: idAt(1000000100),
			committer: idAt(1000000100),
		});

		const result = await server.updateRefs("test", [
			{ ref: "refs/heads/main", newHash: secondHash },
		]);

		expect(result.refResults[0]!.ok).toBe(true);
		const newHash = await resolveRef(repo, "refs/heads/main");
		expect(newHash).toBe(secondHash);
	});

	test("deletes a ref", async () => {
		const { server, repo, initialHash } = await setupServer();

		await repo.refStore.writeRef("refs/heads/to-delete", { type: "direct", hash: initialHash });

		const result = await server.updateRefs("test", [
			{ ref: "refs/heads/to-delete", newHash: null },
		]);

		expect(result.refResults[0]!.ok).toBe(true);
		const hash = await resolveRef(repo, "refs/heads/to-delete");
		expect(hash).toBeNull();
	});

	test("explicit oldHash CAS succeeds when matching", async () => {
		const { server, initialHash } = await setupServer();

		const result = await server.updateRefs("test", [
			{ ref: "refs/heads/feature", newHash: initialHash, oldHash: null },
		]);

		expect(result.refResults[0]!.ok).toBe(true);
	});

	test("explicit oldHash CAS fails when mismatched", async () => {
		const { server, initialHash } = await setupServer();

		const result = await server.updateRefs("test", [
			{
				ref: "refs/heads/main",
				newHash: initialHash,
				oldHash: "0000000000000000000000000000000000000bad",
			},
		]);

		expect(result.refResults[0]!.ok).toBe(false);
		expect(result.refResults[0]!.error).toBeDefined();
	});

	test("create-only (oldHash: null) fails when ref already exists", async () => {
		const { server, initialHash } = await setupServer();

		const result = await server.updateRefs("test", [
			{ ref: "refs/heads/main", newHash: initialHash, oldHash: null },
		]);

		expect(result.refResults[0]!.ok).toBe(false);
	});

	test("auto-reads current hash when oldHash omitted", async () => {
		const { server, repo, initialHash } = await setupServer();

		const blob2 = await writeBlob(repo, "v2");
		const tree2 = await writeTree(repo, [{ name: "README.md", hash: blob2 }]);
		const secondHash = await createCommit(repo, {
			tree: tree2,
			parents: [initialHash],
			message: "second",
			author: idAt(1000000100),
			committer: idAt(1000000100),
		});

		// No oldHash specified — server should read current ref
		const result = await server.updateRefs("test", [
			{ ref: "refs/heads/main", newHash: secondHash },
		]);

		expect(result.refResults[0]!.ok).toBe(true);
		expect(result.applied).toHaveLength(1);
	});

	test("multiple refs in a single call", async () => {
		const { server, initialHash } = await setupServer();

		const result = await server.updateRefs("test", [
			{ ref: "refs/heads/a", newHash: initialHash },
			{ ref: "refs/heads/b", newHash: initialHash },
			{ ref: "refs/tags/v1", newHash: initialHash },
		]);

		expect(result.refResults).toHaveLength(3);
		expect(result.refResults.every((r) => r.ok)).toBe(true);
		expect(result.applied).toHaveLength(3);
	});

	test("hooks fire: preReceive can reject", async () => {
		const server = createServer({
			storage: new MemoryStorage(),
			hooks: {
				preReceive: () => ({ reject: true, message: "blocked by hook" }),
			},
		});
		const repo = await server.createRepo("test");
		const blob = await writeBlob(repo, "x");
		const tree = await writeTree(repo, [{ name: "f", hash: blob }]);
		const hash = await createCommit(repo, {
			tree,
			parents: [],
			message: "init",
			author: ID,
			committer: ID,
			branch: "main",
		});

		const result = await server.updateRefs("test", [{ ref: "refs/heads/feature", newHash: hash }]);

		expect(result.refResults[0]!.ok).toBe(false);
		expect(result.refResults[0]!.error).toBe("blocked by hook");
		expect(result.applied).toHaveLength(0);
	});

	test("hooks fire: update hook rejects one ref but allows others", async () => {
		const server = createServer({
			storage: new MemoryStorage(),
			hooks: {
				update: ({ update }) => {
					if (update.ref === "refs/heads/protected") {
						return { reject: true, message: "protected branch" };
					}
				},
			},
		});
		const repo = await server.createRepo("test");
		const blob = await writeBlob(repo, "x");
		const tree = await writeTree(repo, [{ name: "f", hash: blob }]);
		const hash = await createCommit(repo, {
			tree,
			parents: [],
			message: "init",
			author: ID,
			committer: ID,
			branch: "main",
		});

		const result = await server.updateRefs("test", [
			{ ref: "refs/heads/feature", newHash: hash },
			{ ref: "refs/heads/protected", newHash: hash },
		]);

		expect(result.refResults[0]!.ok).toBe(true);
		expect(result.refResults[1]!.ok).toBe(false);
		expect(result.refResults[1]!.error).toBe("protected branch");
		expect(result.applied).toHaveLength(1);
	});

	test("postReceive hook fires with applied updates", async () => {
		let capturedUpdates: unknown[] = [];
		const server = createServer({
			storage: new MemoryStorage(),
			hooks: {
				postReceive: ({ updates }) => {
					capturedUpdates = [...updates];
				},
			},
		});
		const repo = await server.createRepo("test");
		const blob = await writeBlob(repo, "x");
		const tree = await writeTree(repo, [{ name: "f", hash: blob }]);
		const hash = await createCommit(repo, {
			tree,
			parents: [],
			message: "init",
			author: ID,
			committer: ID,
			branch: "main",
		});

		await server.updateRefs("test", [{ ref: "refs/heads/feature", newHash: hash }]);
		expect(capturedUpdates).toHaveLength(1);
	});

	test("session flows through to hooks", async () => {
		let capturedSession: unknown;
		const server = createServer({
			storage: new MemoryStorage(),
			session: {
				http: () => ({ role: "admin" }),
			},
			hooks: {
				preReceive: ({ session }) => {
					capturedSession = session;
				},
			},
		});
		const repo = await server.createRepo("test");
		const blob = await writeBlob(repo, "x");
		const tree = await writeTree(repo, [{ name: "f", hash: blob }]);
		const hash = await createCommit(repo, {
			tree,
			parents: [],
			message: "init",
			author: ID,
			committer: ID,
			branch: "main",
		});

		await server.updateRefs("test", [{ ref: "refs/heads/feature", newHash: hash }], {
			role: "system",
		});

		expect(capturedSession).toEqual({ role: "system" });
	});

	test("session is undefined when omitted", async () => {
		let capturedSession: unknown = "sentinel";
		const server = createServer({
			storage: new MemoryStorage(),
			hooks: {
				preReceive: ({ session }) => {
					capturedSession = session;
				},
			},
		});
		const repo = await server.createRepo("test");
		const blob = await writeBlob(repo, "x");
		const tree = await writeTree(repo, [{ name: "f", hash: blob }]);
		const hash = await createCommit(repo, {
			tree,
			parents: [],
			message: "init",
			author: ID,
			committer: ID,
			branch: "main",
		});

		await server.updateRefs("test", [{ ref: "refs/heads/feature", newHash: hash }]);
		expect(capturedSession).toBeUndefined();
	});

	test("throws for non-existent repo", async () => {
		const server = createServer({ storage: new MemoryStorage() });

		await expect(
			server.updateRefs("no-such-repo", [{ ref: "refs/heads/main", newHash: "abc" }]),
		).rejects.toThrow('Repository "no-such-repo" not found');
	});

	test("throws when server is closed", async () => {
		const server = createServer({ storage: new MemoryStorage() });
		await server.createRepo("test");
		await server.close();

		await expect(
			server.updateRefs("test", [{ ref: "refs/heads/main", newHash: "abc" }]),
		).rejects.toThrow("Server is shutting down");
	});

	test("policy hooks apply to updateRefs", async () => {
		const { server } = await setupServer();

		await server.close();

		const server2 = createServer({
			storage: new MemoryStorage(),
			policy: { protectedBranches: ["main"] },
		});
		const repo2 = await server2.createRepo("test");
		const blob = await writeBlob(repo2, "hello");
		const tree = await writeTree(repo2, [{ name: "README.md", hash: blob }]);
		await createCommit(repo2, {
			tree,
			parents: [],
			message: "init",
			author: ID,
			committer: ID,
			branch: "main",
		});

		// Divergent commit (not a descendant of hash1)
		const blob2 = await writeBlob(repo2, "divergent");
		const tree2 = await writeTree(repo2, [{ name: "README.md", hash: blob2 }]);
		const hash2 = await createCommit(repo2, {
			tree: tree2,
			parents: [],
			message: "divergent",
			author: idAt(1000000100),
			committer: idAt(1000000100),
		});

		const result = await server2.updateRefs("test", [{ ref: "refs/heads/main", newHash: hash2 }]);

		expect(result.refResults[0]!.ok).toBe(false);
		expect(result.refResults[0]!.error).toContain("non-fast-forward");
	});

	test("computes isFF correctly", async () => {
		let capturedUpdate: unknown;
		const server = createServer({
			storage: new MemoryStorage(),
			hooks: {
				update: ({ update }) => {
					capturedUpdate = update;
				},
			},
		});
		const repo = await server.createRepo("test");
		const blob = await writeBlob(repo, "x");
		const tree = await writeTree(repo, [{ name: "f", hash: blob }]);
		const hash1 = await createCommit(repo, {
			tree,
			parents: [],
			message: "first",
			author: ID,
			committer: ID,
			branch: "main",
		});

		const blob2 = await writeBlob(repo, "y");
		const tree2 = await writeTree(repo, [{ name: "f", hash: blob2 }]);
		const hash2 = await createCommit(repo, {
			tree: tree2,
			parents: [hash1],
			message: "second",
			author: idAt(1000000100),
			committer: idAt(1000000100),
		});

		await server.updateRefs("test", [{ ref: "refs/heads/main", newHash: hash2 }]);

		expect((capturedUpdate as any).isFF).toBe(true);
		expect((capturedUpdate as any).isCreate).toBe(false);
		expect((capturedUpdate as any).isDelete).toBe(false);
	});
});
