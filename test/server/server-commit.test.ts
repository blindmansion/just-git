import { describe, expect, test } from "bun:test";
import { createServer } from "../../src/server/handler.ts";
import { MemoryStorage } from "../../src/server/memory-storage.ts";
import { buildCommit, readFileAtCommit, resolveRef, readCommit } from "../../src/repo/index.ts";
import type { CommitIdentity } from "../../src/repo/writing.ts";

const AUTHOR: CommitIdentity = {
	name: "Test",
	email: "test@test.com",
	date: new Date("2025-01-01T00:00:00Z"),
};

describe("server.commit", () => {
	test("creates a root commit on a new branch", async () => {
		const server = createServer({ storage: new MemoryStorage() });
		await server.createRepo("test");

		const hash = await server.commit("test", {
			files: { "README.md": "# Hello\n" },
			message: "initial commit",
			author: AUTHOR,
			branch: "main",
		});

		expect(hash).toBeString();
		expect(hash).toHaveLength(40);

		const repo = await server.requireRepo("test");
		const ref = await resolveRef(repo, "refs/heads/main");
		expect(ref).toBe(hash);

		const content = await readFileAtCommit(repo, hash, "README.md");
		expect(content).toBe("# Hello\n");
	});

	test("chains commits with parent resolution", async () => {
		const server = createServer({ storage: new MemoryStorage() });
		await server.createRepo("test");

		const hash1 = await server.commit("test", {
			files: { "a.txt": "first" },
			message: "first",
			author: AUTHOR,
			branch: "main",
		});

		const hash2 = await server.commit("test", {
			files: { "b.txt": "second" },
			message: "second",
			author: AUTHOR,
			branch: "main",
		});

		expect(hash2).not.toBe(hash1);

		const repo = await server.requireRepo("test");
		const commit = await readCommit(repo, hash2);
		expect(commit.parents).toEqual([hash1]);

		const a = await readFileAtCommit(repo, hash2, "a.txt");
		expect(a).toBe("first");
		const b = await readFileAtCommit(repo, hash2, "b.txt");
		expect(b).toBe("second");
	});

	test("deletes files with null", async () => {
		const server = createServer({ storage: new MemoryStorage() });
		await server.createRepo("test");

		await server.commit("test", {
			files: { "a.txt": "keep", "b.txt": "remove" },
			message: "add files",
			author: AUTHOR,
			branch: "main",
		});

		const hash2 = await server.commit("test", {
			files: { "b.txt": null },
			message: "delete b",
			author: AUTHOR,
			branch: "main",
		});

		const repo = await server.requireRepo("test");
		const a = await readFileAtCommit(repo, hash2, "a.txt");
		expect(a).toBe("keep");
		const b = await readFileAtCommit(repo, hash2, "b.txt");
		expect(b).toBeNull();
	});

	test("accepts Uint8Array for binary content", async () => {
		const server = createServer({ storage: new MemoryStorage() });
		await server.createRepo("test");

		const binary = new Uint8Array([0x00, 0xff, 0x42]);
		const hash = await server.commit("test", {
			files: { "data.bin": binary },
			message: "binary file",
			author: AUTHOR,
			branch: "main",
		});

		const repo = await server.requireRepo("test");
		const content = await readFileAtCommit(repo, hash, "data.bin");
		expect(content).not.toBeNull();
	});

	test("does not fire hooks", async () => {
		let hookCalled = false;
		const server = createServer({
			storage: new MemoryStorage(),
			hooks: {
				preReceive: () => {
					hookCalled = true;
					return { reject: true, message: "should not reach here" };
				},
			},
		});
		await server.createRepo("test");

		const hash = await server.commit("test", {
			files: { "file.txt": "content" },
			message: "bypasses hooks",
			author: AUTHOR,
			branch: "main",
		});

		expect(hash).toHaveLength(40);
		expect(hookCalled).toBe(false);
	});

	// ── CAS protection ──────────────────────────────────────────────

	test("CAS protects against concurrent branch updates", async () => {
		const server = createServer({ storage: new MemoryStorage() });
		await server.createRepo("test");

		await server.commit("test", {
			files: { "file.txt": "initial" },
			message: "init",
			author: AUTHOR,
			branch: "main",
		});

		const repo = await server.requireRepo("test");

		// Build a commit against the current branch tip
		const { hash, parentHash } = await buildCommit(repo, {
			files: { "file.txt": "update" },
			message: "my update",
			author: AUTHOR,
			branch: "main",
		});

		// Simulate a concurrent write that advances the branch
		const { hash: sneakyHash } = await buildCommit(repo, {
			files: { "concurrent.txt": "sneaky" },
			message: "concurrent",
			author: AUTHOR,
			branch: "main",
		});
		await repo.refStore.writeRef("refs/heads/main", { type: "direct", hash: sneakyHash });

		// updateRefs with the stale oldHash should fail
		const result = await server.updateRefs("test", [
			{ ref: "refs/heads/main", newHash: hash, oldHash: parentHash },
		]);
		expect(result.refResults[0]!.ok).toBe(false);
		expect(result.refResults[0]!.error).toBe("failed to lock");
	});

	// ── Error handling ──────────────────────────────────────────────

	test("throws for non-existent repo", async () => {
		const server = createServer({ storage: new MemoryStorage() });

		await expect(
			server.commit("nonexistent", {
				files: { "file.txt": "hello" },
				message: "should fail",
				author: AUTHOR,
				branch: "main",
			}),
		).rejects.toThrow('Repository "nonexistent" not found');
	});

	test("throws when server is closed", async () => {
		const server = createServer({ storage: new MemoryStorage() });
		await server.createRepo("test");
		await server.close();

		await expect(
			server.commit("test", {
				files: { "file.txt": "hello" },
				message: "should fail",
				author: AUTHOR,
				branch: "main",
			}),
		).rejects.toThrow("Server is shutting down");
	});

	// ── buildCommit standalone ──────────────────────────────────────

	test("buildCommit creates objects without advancing refs", async () => {
		const server = createServer({ storage: new MemoryStorage() });
		const repo = await server.createRepo("test");

		const { hash, parentHash } = await buildCommit(repo, {
			files: { "README.md": "# Test\n" },
			message: "built but not committed",
			author: AUTHOR,
			branch: "main",
		});

		expect(hash).toHaveLength(40);
		expect(parentHash).toBeNull();

		const ref = await resolveRef(repo, "refs/heads/main");
		expect(ref).toBeNull();

		const commit = await readCommit(repo, hash);
		expect(commit.message.trim()).toBe("built but not committed");
	});

	test("buildCommit resolves parent from existing branch", async () => {
		const server = createServer({ storage: new MemoryStorage() });
		await server.createRepo("test");

		const firstHash = await server.commit("test", {
			files: { "a.txt": "first" },
			message: "first",
			author: AUTHOR,
			branch: "main",
		});

		const repo = await server.requireRepo("test");
		const { hash, parentHash } = await buildCommit(repo, {
			files: { "b.txt": "second" },
			message: "second",
			author: AUTHOR,
			branch: "main",
		});

		expect(parentHash).toBe(firstHash);

		const ref = await resolveRef(repo, "refs/heads/main");
		expect(ref).toBe(firstHash);

		const commit = await readCommit(repo, hash);
		expect(commit.parents).toEqual([firstHash]);
	});

	test("buildCommit without branch creates a root commit", async () => {
		const server = createServer({ storage: new MemoryStorage() });
		const repo = await server.createRepo("test");

		const { hash, parentHash } = await buildCommit(repo, {
			files: { "file.txt": "content" },
			message: "orphan",
			author: AUTHOR,
		});

		expect(parentHash).toBeNull();

		const commit = await readCommit(repo, hash);
		expect(commit.parents).toEqual([]);
	});
});
