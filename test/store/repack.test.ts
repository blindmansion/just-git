import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { BunSqliteStorage } from "../../src/store/bun-sqlite-storage.ts";
import { MemoryStorage } from "../../src/store/memory-storage.ts";
import { createRepoStore } from "../../src/store/repo-store.ts";
import type { RepoPool } from "../../src/store/repo-pool.ts";
import { commit, createCommit, writeBlob, writeTree } from "../../src/repo/writing.ts";
import { resolveRef } from "../../src/repo/reading.ts";
import type { GitRepo, Identity } from "../../src/lib/types.ts";
import type { RepoStore } from "../../src/store/repo-store.ts";

const ID: Identity = {
	name: "Test",
	email: "test@test.com",
	timestamp: 1000000000,
	timezone: "+0000",
};

function idAt(ts: number): Identity {
	return { ...ID, timestamp: ts };
}

/** Build a deterministic ~200-line document, mutating a few lines by seed. */
function makeDoc(seed: number): string {
	const lines: string[] = [];
	for (let i = 0; i < 200; i++) {
		// Most lines stay identical across seeds; a few change — the shape of
		// a sync workload (small edits to a large doc).
		const churn = i % 40 === seed % 40 ? `edited@${seed}` : "stable";
		lines.push(`line ${i}: lorem ipsum dolor sit amet ${churn} consectetur`);
	}
	return lines.join("\n");
}

/** Capture every stored object's reconstructed body via a *fresh* repo handle. */
async function captureAll(store: RepoStore, repoId: string, driver: RepoPool) {
	const hashes = await (await driver.open(repoId)).listObjectHashes();
	const repo = (await store.repo(repoId))!;
	const map = new Map<string, { type: string; content: Uint8Array }>();
	for (const hash of hashes) {
		const obj = await repo.objectStore.read(hash);
		map.set(hash, { type: obj.type, content: new Uint8Array(obj.content) });
	}
	return map;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.byteLength !== b.byteLength) return false;
	for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
	return true;
}

interface BackendCase {
	name: string;
	make: () => RepoPool;
}

const BACKENDS: BackendCase[] = [
	{ name: "MemoryStorage", make: () => new MemoryStorage() },
	{ name: "BunSqliteStorage", make: () => new BunSqliteStorage(new Database(":memory:")) },
];

for (const backend of BACKENDS) {
	describe(`repack/compaction — ${backend.name}`, () => {
		let driver: RepoPool;
		let store: RepoStore;

		beforeEach(() => {
			driver = backend.make();
			store = createRepoStore(driver);
		});

		async function syncRepo(repoId: string, commits: number): Promise<GitRepo> {
			const repo = await store.createRepo(repoId);
			for (let i = 0; i < commits; i++) {
				await commit(repo, {
					files: { "doc.md": makeDoc(i) },
					message: `edit ${i}`,
					author: idAt(1000000000 + i),
					branch: "main",
				});
			}
			return repo;
		}

		// Compress-only maintenance is now `gc({ compact: true, prune: false })`.
		const repack = (
			id: string,
			opts?: { window?: number; depth?: number; dryRun?: boolean; compress?: boolean },
		) => store.gc(id, { compact: true, prune: false, ...opts });

		test("repack preserves every object's reconstructed bytes", async () => {
			await syncRepo("r", 20);
			const before = await captureAll(store, "r", driver);

			const result = await repack("r");
			expect(result.retained).toBe(before.size);

			// Fresh handle → empty cache → forces decode of the stored rows.
			const after = await captureAll(store, "r", driver);
			expect(after.size).toBe(before.size);
			for (const [hash, orig] of before) {
				const got = after.get(hash);
				expect(got).toBeDefined();
				expect(got!.type).toBe(orig.type);
				expect(bytesEqual(got!.content, orig.content)).toBe(true);
			}
		});

		test("repack delta-compresses near-duplicate history", async () => {
			await syncRepo("r", 40);
			const repoStorage = await driver.open("r");
			const before = repoStorage.repoByteSize ? await repoStorage.repoByteSize() : 0;

			const result = await repack("r", { window: 250, depth: 250 });

			expect(result.deltified).toBeGreaterThan(0);
			if (repoStorage.repoByteSize) {
				const after = await repoStorage.repoByteSize();
				expect(after).toBeLessThan(before);
				// Sync workload over a large doc should compress dramatically.
				expect(after).toBeLessThan(before / 2);
			}
		});

		test("HEAD still resolves and content reads after repack", async () => {
			const repo = await syncRepo("r", 15);
			const head = await resolveRef(repo, "refs/heads/main");

			await repack("r", { window: 250, depth: 250 });

			const fresh = (await store.repo("r"))!;
			expect(await resolveRef(fresh, "refs/heads/main")).toBe(head);
		});

		test("re-compaction is stable (decodes from raw, not delta-of-delta)", async () => {
			await syncRepo("r", 25);
			await repack("r", { window: 250, depth: 250 });
			const once = await captureAll(store, "r", driver);

			const second = await repack("r", { window: 250, depth: 250 });
			expect(second.retained).toBe(once.size);

			const twice = await captureAll(store, "r", driver);
			for (const [hash, orig] of once) {
				expect(bytesEqual(twice.get(hash)!.content, orig.content)).toBe(true);
			}
		});

		test("dryRun writes nothing", async () => {
			await syncRepo("r", 10);
			const repoStorage = await driver.open("r");
			const before = repoStorage.repoByteSize ? await repoStorage.repoByteSize() : 0;

			const result = await repack("r", { dryRun: true });
			// dryRun skips compaction entirely (no rewrites), and prune:false
			// deletes nothing — storage is untouched.
			expect(result.retained).toBeGreaterThan(0);
			expect(result.deltified).toBeUndefined();

			if (repoStorage.repoByteSize) {
				expect(await repoStorage.repoByteSize()).toBe(before);
			}
		});

		test("gc({ compact }) prunes unreachable and compresses reachable", async () => {
			const repo = await store.createRepo("r");

			const blob = await writeBlob(repo, "hello");
			const tree = await writeTree(repo, [{ name: "README.md", hash: blob }]);
			const initial = await createCommit(repo, {
				tree,
				parents: [],
				message: "init",
				author: ID,
				committer: ID,
				branch: "main",
			});

			// Build sync-style history on top.
			for (let i = 0; i < 20; i++) {
				await commit(repo, {
					files: { "doc.md": makeDoc(i) },
					message: `edit ${i}`,
					author: idAt(1000000001 + i),
					branch: "main",
				});
			}

			// Orphan a commit via force-reset to initial.
			const orphanBlob = await writeBlob(repo, "orphan");
			const orphanTree = await writeTree(repo, [{ name: "x", hash: orphanBlob }]);
			await createCommit(repo, {
				tree: orphanTree,
				parents: [initial],
				message: "orphan",
				author: idAt(2000000000),
				committer: idAt(2000000000),
				branch: "side",
			});
			await repo.refStore.deleteRef("refs/heads/side");

			const repoStorage = await driver.open("r");
			const sizeBefore = repoStorage.repoByteSize ? await repoStorage.repoByteSize() : 0;
			const result = await store.gc("r", { compact: true, window: 250, depth: 250 });

			expect(result.deleted).toBeGreaterThan(0);
			expect(result.deltified).toBeGreaterThan(0);

			// Orphan blob is gone.
			const hashes = new Set(await repoStorage.listObjectHashes());
			expect(hashes.has(orphanBlob)).toBe(false);

			// Reachable content reads correctly from a fresh handle.
			const fresh = (await store.repo("r"))!;
			expect(await resolveRef(fresh, "refs/heads/main")).toBeTruthy();
			const after = await captureAll(store, "r", driver);
			expect(after.size).toBeGreaterThan(0);

			if (repoStorage.repoByteSize) {
				expect(result.bytesBefore).toBe(sizeBefore);
				expect(result.bytesAfter).toBeLessThan(sizeBefore);
			}
		});

		test("repack with compress:false skips zlib but still delta-encodes", async () => {
			await syncRepo("r", 20);
			const before = await captureAll(store, "r", driver);

			const result = await repack("r", { window: 250, depth: 250, compress: false });
			expect(result.deltified).toBeGreaterThan(0);

			// No stored row is zlib-encoded; only raw / delta.
			const repoStorage = await driver.open("r");
			for (const hash of await repoStorage.listObjectHashes()) {
				const stored = await repoStorage.getObject(hash);
				expect(stored).not.toBeNull();
				expect(stored!.encoding === "raw" || stored!.encoding === "delta").toBe(true);
			}

			// Still reconstructs byte-for-byte from a fresh handle.
			const after = await captureAll(store, "r", driver);
			for (const [hash, orig] of before) {
				expect(bytesEqual(after.get(hash)!.content, orig.content)).toBe(true);
			}
		});

		test("repoStore.gc is fork-safe and honors prune", async () => {
			await syncRepo("r", 20);

			// compress-only (prune: false): compresses, prunes nothing.
			const danglingRepo = (await store.repo("r"))!;
			const dangling = await writeBlob(danglingRepo, "dangling-not-reachable");
			const repacked = await store.gc("r", {
				compact: true,
				prune: false,
				window: 250,
				depth: 250,
			});
			expect(repacked.deltified).toBeGreaterThan(0);
			expect(repacked.deleted).toBe(0);
			const repoStorage = await driver.open("r");
			expect(new Set(await repoStorage.listObjectHashes()).has(dangling)).toBe(true);

			// compact + prune: drops the dangling blob and compresses.
			const gced = await store.gc("r", { compact: true, window: 250, depth: 250 });
			expect(gced.deleted).toBeGreaterThan(0);
			expect(new Set(await repoStorage.listObjectHashes()).has(dangling)).toBe(false);
		});

		test("repack does not delete unreachable objects", async () => {
			const repo = await store.createRepo("r");
			const blob = await writeBlob(repo, "hello");
			const tree = await writeTree(repo, [{ name: "README.md", hash: blob }]);
			await createCommit(repo, {
				tree,
				parents: [],
				message: "init",
				author: ID,
				committer: ID,
				branch: "main",
			});
			// Dangling blob (never referenced by a tree/commit).
			const dangling = await writeBlob(repo, "dangling-unreachable-content");

			await repack("r", { window: 250, depth: 250 });

			const hashes = new Set(await (await driver.open("r")).listObjectHashes());
			expect(hashes.has(dangling)).toBe(true);
		});
	});
}

describe("repack — forks (MemoryStorage)", () => {
	test("fork reads still work after compacting the root partition", async () => {
		const driver = new MemoryStorage();
		const store = createRepoStore(driver);

		const root = await store.createRepo("root");
		for (let i = 0; i < 15; i++) {
			await commit(root, {
				files: { "doc.md": makeDoc(i) },
				message: `edit ${i}`,
				author: idAt(1000000000 + i),
				branch: "main",
			});
		}

		const fork = await store.forkRepo("root", "fork");
		// Fork adds its own commits (written to the fork partition).
		for (let i = 15; i < 20; i++) {
			await commit(fork, {
				files: { "doc.md": makeDoc(i) },
				message: `fork edit ${i}`,
				author: idAt(1000000000 + i),
				branch: "main",
			});
		}
		const forkHead = await resolveRef(fork, "refs/heads/main");

		// Compact the root partition — fork-reachable root objects must survive
		// (delta bases stay in the root partition the fork falls through to).
		await store.gc("root", { compact: true, prune: false, window: 250, depth: 250 });

		// Fork can still reconstruct everything (its deltas/bases reachable via
		// parent fallthrough) from a fresh handle.
		const freshFork = (await store.repo("fork"))!;
		expect(await resolveRef(freshFork, "refs/heads/main")).toBe(forkHead);

		const hashes = await driver.open("fork").listObjectHashes();
		for (const hash of hashes) {
			await freshFork.objectStore.read(hash); // must not throw
		}
		// Also read a root-partition object through the fork (fallthrough).
		const rootHead = await resolveRef((await store.repo("root"))!, "refs/heads/main");
		expect(await freshFork.objectStore.read(rootHead!)).toBeTruthy();
	});
});
