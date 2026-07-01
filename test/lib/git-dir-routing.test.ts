import { describe, expect, test } from "bun:test";
import { MemoryFileSystem } from "../../src";
import { getConfigValue, setConfigValue } from "../../src/lib/config.ts";
import { writeObject } from "../../src/lib/object-db.ts";
import { PackedObjectStore } from "../../src/lib/object-store.ts";
import { FileSystemRefStore } from "../../src/lib/refs.ts";
import { appendReflog } from "../../src/lib/reflog.ts";
import type { GitContext } from "../../src/lib/types.ts";

// A linked worktree splits state across two directories. These tests force
// them apart so a mis-route is visible — in a plain repo they coincide and a
// wrong routing decision would be invisible.
const GIT_DIR = "/wt/.git-private";
const COMMON_DIR = "/common/.git";
const HASH_A = "a".repeat(40);
const HASH_B = "b".repeat(40);
const HASH_C = "c".repeat(40);
const HASH_D = "d".repeat(40);

async function splitStore(): Promise<{ fs: MemoryFileSystem; store: FileSystemRefStore }> {
	const fs = new MemoryFileSystem();
	await fs.mkdir(GIT_DIR, { recursive: true });
	await fs.mkdir(COMMON_DIR, { recursive: true });
	return { fs, store: new FileSystemRefStore(fs, GIT_DIR, COMMON_DIR) };
}

async function splitContext(): Promise<{ fs: MemoryFileSystem; ctx: GitContext }> {
	const fs = new MemoryFileSystem();
	await fs.mkdir(GIT_DIR, { recursive: true });
	await fs.mkdir(COMMON_DIR, { recursive: true });
	const ctx: GitContext = {
		fs,
		gitDir: GIT_DIR,
		commonDir: COMMON_DIR,
		workTree: "/wt",
		objectStore: new PackedObjectStore(fs, COMMON_DIR),
		refStore: new FileSystemRefStore(fs, GIT_DIR, COMMON_DIR),
	};
	return { fs, ctx };
}

const ENTRY = {
	oldHash: "0".repeat(40),
	newHash: HASH_A,
	name: "Test",
	email: "test@test.com",
	timestamp: 1000000000,
	tz: "+0000",
	message: "commit: x",
};

describe("FileSystemRefStore routing (split gitDir/commonDir)", () => {
	test("writes shared refs under commonDir and per-worktree refs under gitDir", async () => {
		const { fs, store } = await splitStore();
		await store.writeRef("refs/heads/main", { type: "direct", hash: HASH_A });
		await store.writeRef("refs/tags/v1", { type: "direct", hash: HASH_D });
		await store.writeRef("HEAD", { type: "symbolic", target: "refs/heads/main" });
		await store.writeRef("ORIG_HEAD", { type: "direct", hash: HASH_B });
		await store.writeRef("refs/bisect/bad", { type: "direct", hash: HASH_C });

		// Shared refs live under commonDir, and not under gitDir.
		expect(await fs.exists(`${COMMON_DIR}/refs/heads/main`)).toBe(true);
		expect(await fs.exists(`${GIT_DIR}/refs/heads/main`)).toBe(false);
		expect(await fs.exists(`${COMMON_DIR}/refs/tags/v1`)).toBe(true);

		// Per-worktree refs live under gitDir, and not under commonDir.
		expect(await fs.exists(`${GIT_DIR}/HEAD`)).toBe(true);
		expect(await fs.exists(`${COMMON_DIR}/HEAD`)).toBe(false);
		expect(await fs.exists(`${GIT_DIR}/ORIG_HEAD`)).toBe(true);
		expect(await fs.exists(`${GIT_DIR}/refs/bisect/bad`)).toBe(true);
		expect(await fs.exists(`${COMMON_DIR}/refs/bisect/bad`)).toBe(false);
	});

	test("reads each ref back from its correct directory", async () => {
		const { store } = await splitStore();
		await store.writeRef("refs/heads/main", { type: "direct", hash: HASH_A });
		await store.writeRef("HEAD", { type: "symbolic", target: "refs/heads/main" });
		await store.writeRef("refs/bisect/bad", { type: "direct", hash: HASH_C });

		expect(await store.readRef("refs/heads/main")).toEqual({ type: "direct", hash: HASH_A });
		expect(await store.readRef("HEAD")).toEqual({ type: "symbolic", target: "refs/heads/main" });
		expect(await store.readRef("refs/bisect/bad")).toEqual({ type: "direct", hash: HASH_C });
	});

	test("listRefs merges shared and per-worktree loose refs across both dirs", async () => {
		const { store } = await splitStore();
		await store.writeRef("refs/heads/main", { type: "direct", hash: HASH_A });
		await store.writeRef("refs/tags/v1", { type: "direct", hash: HASH_D });
		await store.writeRef("refs/bisect/bad", { type: "direct", hash: HASH_C });

		const names = (await store.listRefs("refs")).map((r) => r.name);
		expect(names).toEqual(["refs/bisect/bad", "refs/heads/main", "refs/tags/v1"]);
	});

	test("listRefs surfaces only this worktree's per-worktree refs, agreeing with readRef", async () => {
		const { fs, store } = await splitStore();
		// Per-worktree refs that do NOT belong to this linked worktree: the main
		// worktree's loose bisect ref in the common dir, and a per-worktree ref
		// wrongly present in the shared packed-refs. readRef() surfaces neither.
		await fs.mkdir(`${COMMON_DIR}/refs/bisect`, { recursive: true });
		await fs.writeFile(`${COMMON_DIR}/refs/bisect/bad`, `${HASH_C}\n`);
		await fs.writeFile(`${COMMON_DIR}/packed-refs`, `${HASH_D} refs/bisect/packed\n`);
		// This worktree's own bisect ref, and a shared branch.
		await store.writeRef("refs/bisect/good", { type: "direct", hash: HASH_B });
		await store.writeRef("refs/heads/main", { type: "direct", hash: HASH_A });

		// The listing must match readRef: only this worktree's own bisect ref,
		// never the common dir's loose ref or a packed per-worktree ref.
		expect(await store.readRef("refs/bisect/packed")).toBeNull();
		expect((await store.listRefs("refs/bisect")).map((r) => r.name)).toEqual(["refs/bisect/good"]);
		expect((await store.listRefs("refs")).map((r) => r.name)).toEqual([
			"refs/bisect/good",
			"refs/heads/main",
		]);
	});

	test("deleting a shared ref removes it from the common dir", async () => {
		const { fs, store } = await splitStore();
		await store.writeRef("refs/heads/feature", { type: "direct", hash: HASH_A });
		await store.deleteRef("refs/heads/feature");
		expect(await fs.exists(`${COMMON_DIR}/refs/heads/feature`)).toBe(false);
		expect(await store.readRef("refs/heads/feature")).toBeNull();
	});

	test("a per-worktree ref with no loose file does not fall through to packed-refs", async () => {
		const { fs, store } = await splitStore();
		// packed-refs in the common dir holds only shared refs.
		await fs.writeFile(
			`${COMMON_DIR}/packed-refs`,
			`# pack-refs with: peeled fully-peeled sorted\n${HASH_A} refs/heads/main\n`,
		);
		expect(await store.readRef("refs/heads/main")).toEqual({ type: "direct", hash: HASH_A });
		expect(await store.readRef("MERGE_HEAD")).toBeNull();
	});
});

describe("subsystem routing (split gitDir/commonDir)", () => {
	test("reflog: HEAD's log is private, branch logs are shared", async () => {
		const { fs, ctx } = await splitContext();
		await appendReflog(ctx, "HEAD", { ...ENTRY });
		await appendReflog(ctx, "refs/heads/main", { ...ENTRY });

		expect(await fs.exists(`${GIT_DIR}/logs/HEAD`)).toBe(true);
		expect(await fs.exists(`${COMMON_DIR}/logs/HEAD`)).toBe(false);
		expect(await fs.exists(`${COMMON_DIR}/logs/refs/heads/main`)).toBe(true);
		expect(await fs.exists(`${GIT_DIR}/logs/refs/heads/main`)).toBe(false);
	});

	test("config is shared (common dir)", async () => {
		const { fs, ctx } = await splitContext();
		await setConfigValue(ctx, "user.name", "Alice");

		expect(await fs.exists(`${COMMON_DIR}/config`)).toBe(true);
		expect(await fs.exists(`${GIT_DIR}/config`)).toBe(false);
		expect(await getConfigValue(ctx, "user.name")).toBe("Alice");
	});

	test("objects are shared (common dir)", async () => {
		const { fs, ctx } = await splitContext();
		const hash = await writeObject(ctx, "blob", new TextEncoder().encode("hi"));

		expect(await fs.exists(`${COMMON_DIR}/objects/${hash.slice(0, 2)}/${hash.slice(2)}`)).toBe(
			true,
		);
		expect(await fs.exists(`${GIT_DIR}/objects/${hash.slice(0, 2)}/${hash.slice(2)}`)).toBe(false);
	});
});
