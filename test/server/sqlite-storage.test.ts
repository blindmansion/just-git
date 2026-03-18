import { Database } from "bun:sqlite";
import { describe, expect, test, beforeEach } from "bun:test";
import { SqliteStorage } from "../../src/server/sqlite-storage.ts";
import { envelope } from "../../src/lib/object-store.ts";
import { sha1 } from "../../src/lib/sha1.ts";
import { writePack } from "../../src/lib/pack/packfile.ts";
import type { ObjectType } from "../../src/lib/types.ts";

const encoder = new TextEncoder();

async function makeHash(type: ObjectType, content: Uint8Array): Promise<string> {
	return sha1(envelope(type, content));
}

describe("SqliteStorage", () => {
	let db: Database;
	let storage: SqliteStorage;

	beforeEach(() => {
		db = new Database(":memory:");
		storage = new SqliteStorage(db);
	});

	// ── ObjectStore ──────────────────────────────────────────────

	describe("ObjectStore", () => {
		test("write and read an object", async () => {
			const { objectStore: objects } = storage.repo("test-repo");
			const content = encoder.encode("hello world");
			const hash = await objects.write("blob", content);

			expect(hash).toMatch(/^[0-9a-f]{40}$/);

			const obj = await objects.read(hash);
			expect(obj.type).toBe("blob");
			expect(new TextDecoder().decode(obj.content)).toBe("hello world");
		});

		test("write is idempotent", async () => {
			const { objectStore: objects } = storage.repo("test-repo");
			const content = encoder.encode("same content");
			const hash1 = await objects.write("blob", content);
			const hash2 = await objects.write("blob", content);
			expect(hash1).toBe(hash2);
		});

		test("read throws for missing object", async () => {
			const { objectStore: objects } = storage.repo("test-repo");
			const fakeHash = "0000000000000000000000000000000000000000";
			expect(objects.read(fakeHash)).rejects.toThrow("not found");
		});

		test("exists returns true/false", async () => {
			const { objectStore: objects } = storage.repo("test-repo");
			const content = encoder.encode("exists test");
			const hash = await objects.write("blob", content);

			expect(await objects.exists(hash)).toBe(true);
			expect(await objects.exists("0000000000000000000000000000000000000000")).toBe(false);
		});

		test("findByPrefix", async () => {
			const { objectStore: objects } = storage.repo("test-repo");
			const content = encoder.encode("prefix test");
			const hash = await objects.write("blob", content);
			const prefix = hash.slice(0, 8);

			const matches = await objects.findByPrefix(prefix);
			expect(matches).toContain(hash);
		});

		test("findByPrefix returns empty for short prefix", async () => {
			const { objectStore: objects } = storage.repo("test-repo");
			const matches = await objects.findByPrefix("ab");
			expect(matches).toEqual([]);
		});

		test("ingestPack stores all objects", async () => {
			const { objectStore: objects } = storage.repo("test-repo");

			const blob1 = encoder.encode("file one");
			const blob2 = encoder.encode("file two");
			const packData = await writePack([
				{ type: "blob", content: blob1 },
				{ type: "blob", content: blob2 },
			]);

			const count = await objects.ingestPack(packData);
			expect(count).toBe(2);

			const hash1 = await makeHash("blob", blob1);
			const hash2 = await makeHash("blob", blob2);
			expect(await objects.exists(hash1)).toBe(true);
			expect(await objects.exists(hash2)).toBe(true);

			const obj1 = await objects.read(hash1);
			expect(new TextDecoder().decode(obj1.content)).toBe("file one");
		});

		test("ingestPack handles empty/small data", async () => {
			const { objectStore: objects } = storage.repo("test-repo");
			expect(await objects.ingestPack(new Uint8Array(0))).toBe(0);
			expect(await objects.ingestPack(new Uint8Array(10))).toBe(0);
		});
	});

	// ── RefStore ────────────────────────────────────────────────

	describe("RefStore", () => {
		test("write and read a direct ref", async () => {
			const { refStore: refs } = storage.repo("test-repo");
			const hash = "abcdef0123456789abcdef0123456789abcdef01";
			await refs.writeRef("refs/heads/main", { type: "direct", hash });

			const ref = await refs.readRef("refs/heads/main");
			expect(ref).toEqual({ type: "direct", hash });
		});

		test("write and read a symbolic ref", async () => {
			const { refStore: refs } = storage.repo("test-repo");
			await refs.writeRef("HEAD", { type: "symbolic", target: "refs/heads/main" });

			const ref = await refs.readRef("HEAD");
			expect(ref).toEqual({ type: "symbolic", target: "refs/heads/main" });
		});

		test("readRef returns null for missing ref", async () => {
			const { refStore: refs } = storage.repo("test-repo");
			expect(await refs.readRef("refs/heads/nonexistent")).toBeNull();
		});

		test("writeRef overwrites existing ref", async () => {
			const { refStore: refs } = storage.repo("test-repo");
			const hash1 = "1111111111111111111111111111111111111111";
			const hash2 = "2222222222222222222222222222222222222222";

			await refs.writeRef("refs/heads/main", { type: "direct", hash: hash1 });
			await refs.writeRef("refs/heads/main", { type: "direct", hash: hash2 });

			const ref = await refs.readRef("refs/heads/main");
			expect(ref).toEqual({ type: "direct", hash: hash2 });
		});

		test("deleteRef removes a ref", async () => {
			const { refStore: refs } = storage.repo("test-repo");
			await refs.writeRef("refs/heads/main", {
				type: "direct",
				hash: "abcdef0123456789abcdef0123456789abcdef01",
			});

			await refs.deleteRef("refs/heads/main");
			expect(await refs.readRef("refs/heads/main")).toBeNull();
		});

		test("deleteRef is a no-op for missing ref", async () => {
			const { refStore: refs } = storage.repo("test-repo");
			await refs.deleteRef("refs/heads/nonexistent");
		});

		test("listRefs with prefix", async () => {
			const { refStore: refs } = storage.repo("test-repo");
			await refs.writeRef("refs/heads/main", {
				type: "direct",
				hash: "1111111111111111111111111111111111111111",
			});
			await refs.writeRef("refs/heads/feature", {
				type: "direct",
				hash: "2222222222222222222222222222222222222222",
			});
			await refs.writeRef("refs/tags/v1.0", {
				type: "direct",
				hash: "3333333333333333333333333333333333333333",
			});

			const heads = await refs.listRefs("refs/heads");
			expect(heads).toHaveLength(2);
			const names = heads.map((r) => r.name).sort();
			expect(names).toEqual(["refs/heads/feature", "refs/heads/main"]);

			const tags = await refs.listRefs("refs/tags");
			expect(tags).toHaveLength(1);
			expect(tags[0]!.name).toBe("refs/tags/v1.0");
		});

		test("listRefs without prefix returns all", async () => {
			const { refStore: refs } = storage.repo("test-repo");
			await refs.writeRef("refs/heads/main", {
				type: "direct",
				hash: "1111111111111111111111111111111111111111",
			});
			await refs.writeRef("HEAD", { type: "symbolic", target: "refs/heads/main" });

			const all = await refs.listRefs();
			expect(all).toHaveLength(2);
		});

		test("listRefs resolves symrefs", async () => {
			const { refStore: refs } = storage.repo("test-repo");
			const hash = "abcdef0123456789abcdef0123456789abcdef01";
			await refs.writeRef("refs/heads/main", { type: "direct", hash });
			await refs.writeRef("HEAD", { type: "symbolic", target: "refs/heads/main" });

			const all = await refs.listRefs();
			const head = all.find((r) => r.name === "HEAD");
			expect(head).toBeDefined();
			expect(head!.hash).toBe(hash);
		});
	});

	// ── compareAndSwapRef ───────────────────────────────────────

	describe("compareAndSwapRef", () => {
		const HASH_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
		const HASH_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
		const HASH_C = "cccccccccccccccccccccccccccccccccccccccc";

		test("create succeeds when ref does not exist", async () => {
			const { refStore } = storage.repo("test-repo");
			const ok = await refStore.compareAndSwapRef("refs/heads/main", null, {
				type: "direct",
				hash: HASH_A,
			});
			expect(ok).toBe(true);
			const ref = await refStore.readRef("refs/heads/main");
			expect(ref).toEqual({ type: "direct", hash: HASH_A });
		});

		test("create fails when ref already exists", async () => {
			const { refStore } = storage.repo("test-repo");
			await refStore.writeRef("refs/heads/main", { type: "direct", hash: HASH_A });

			const ok = await refStore.compareAndSwapRef("refs/heads/main", null, {
				type: "direct",
				hash: HASH_B,
			});
			expect(ok).toBe(false);
			const ref = await refStore.readRef("refs/heads/main");
			expect(ref).toEqual({ type: "direct", hash: HASH_A });
		});

		test("update succeeds with matching expected hash", async () => {
			const { refStore } = storage.repo("test-repo");
			await refStore.writeRef("refs/heads/main", { type: "direct", hash: HASH_A });

			const ok = await refStore.compareAndSwapRef("refs/heads/main", HASH_A, {
				type: "direct",
				hash: HASH_B,
			});
			expect(ok).toBe(true);
			const ref = await refStore.readRef("refs/heads/main");
			expect(ref).toEqual({ type: "direct", hash: HASH_B });
		});

		test("update fails with wrong expected hash", async () => {
			const { refStore } = storage.repo("test-repo");
			await refStore.writeRef("refs/heads/main", { type: "direct", hash: HASH_A });

			const ok = await refStore.compareAndSwapRef("refs/heads/main", HASH_C, {
				type: "direct",
				hash: HASH_B,
			});
			expect(ok).toBe(false);
			const ref = await refStore.readRef("refs/heads/main");
			expect(ref).toEqual({ type: "direct", hash: HASH_A });
		});

		test("update fails when ref does not exist", async () => {
			const { refStore } = storage.repo("test-repo");
			const ok = await refStore.compareAndSwapRef("refs/heads/main", HASH_A, {
				type: "direct",
				hash: HASH_B,
			});
			expect(ok).toBe(false);
		});

		test("conditional delete succeeds with matching hash", async () => {
			const { refStore } = storage.repo("test-repo");
			await refStore.writeRef("refs/heads/main", { type: "direct", hash: HASH_A });

			const ok = await refStore.compareAndSwapRef("refs/heads/main", HASH_A, null);
			expect(ok).toBe(true);
			expect(await refStore.readRef("refs/heads/main")).toBeNull();
		});

		test("conditional delete fails with wrong hash", async () => {
			const { refStore } = storage.repo("test-repo");
			await refStore.writeRef("refs/heads/main", { type: "direct", hash: HASH_A });

			const ok = await refStore.compareAndSwapRef("refs/heads/main", HASH_C, null);
			expect(ok).toBe(false);
			expect(await refStore.readRef("refs/heads/main")).toEqual({ type: "direct", hash: HASH_A });
		});

		test("CAS resolves symbolic refs for hash comparison", async () => {
			const { refStore } = storage.repo("test-repo");
			await refStore.writeRef("refs/heads/main", { type: "direct", hash: HASH_A });
			await refStore.writeRef("HEAD", { type: "symbolic", target: "refs/heads/main" });

			const ok = await refStore.compareAndSwapRef("HEAD", HASH_A, {
				type: "symbolic",
				target: "refs/heads/dev",
			});
			expect(ok).toBe(true);
			const ref = await refStore.readRef("HEAD");
			expect(ref).toEqual({ type: "symbolic", target: "refs/heads/dev" });
		});

		test("two repo instances race — only one CAS wins", async () => {
			const repo1 = storage.repo("test-repo");
			const repo2 = storage.repo("test-repo");

			await repo1.refStore.writeRef("refs/heads/main", { type: "direct", hash: HASH_A });

			const [ok1, ok2] = await Promise.all([
				repo1.refStore.compareAndSwapRef("refs/heads/main", HASH_A, {
					type: "direct",
					hash: HASH_B,
				}),
				repo2.refStore.compareAndSwapRef("refs/heads/main", HASH_A, {
					type: "direct",
					hash: HASH_C,
				}),
			]);

			const results = [ok1, ok2].sort();
			expect(results).toEqual([false, true]);
		});
	});

	// ── Multi-repo isolation ────────────────────────────────────

	describe("multi-repo isolation", () => {
		test("objects are isolated between repos", async () => {
			const repo1 = storage.repo("repo-1");
			const repo2 = storage.repo("repo-2");

			const content = encoder.encode("shared content");
			const hash = await repo1.objectStore.write("blob", content);

			expect(await repo1.objectStore.exists(hash)).toBe(true);
			expect(await repo2.objectStore.exists(hash)).toBe(false);
		});

		test("refs are isolated between repos", async () => {
			const repo1 = storage.repo("repo-1");
			const repo2 = storage.repo("repo-2");

			await repo1.refStore.writeRef("refs/heads/main", {
				type: "direct",
				hash: "1111111111111111111111111111111111111111",
			});

			expect(await repo1.refStore.readRef("refs/heads/main")).not.toBeNull();
			expect(await repo2.refStore.readRef("refs/heads/main")).toBeNull();
		});

		test("deleteRepo only affects the target repo", async () => {
			const repo1 = storage.repo("repo-1");
			const repo2 = storage.repo("repo-2");

			const content = encoder.encode("keep this");
			const hash = await repo1.objectStore.write("blob", content);
			await repo2.objectStore.write("blob", content);

			await repo1.refStore.writeRef("refs/heads/main", { type: "direct", hash });
			await repo2.refStore.writeRef("refs/heads/main", { type: "direct", hash });

			storage.deleteRepo("repo-1");

			expect(await repo1.objectStore.exists(hash)).toBe(false);
			expect(await repo2.objectStore.exists(hash)).toBe(true);
			expect(await repo1.refStore.readRef("refs/heads/main")).toBeNull();
			expect(await repo2.refStore.readRef("refs/heads/main")).not.toBeNull();
		});
	});
});
