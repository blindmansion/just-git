import { describe, expect, test } from "bun:test";
import { InMemoryFs } from "just-bash";
import { FileSystemRefStore } from "../../src/lib/refs.ts";

describe("FileSystemRefStore.compareAndSwapRef", () => {
	const HASH_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
	const HASH_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
	const HASH_C = "cccccccccccccccccccccccccccccccccccccccc";

	async function setup() {
		const fs = new InMemoryFs();
		await fs.mkdir("/.git/refs/heads", { recursive: true });
		const store = new FileSystemRefStore(fs, "/.git");
		return store;
	}

	test("create succeeds when ref does not exist", async () => {
		const store = await setup();
		const ok = await store.compareAndSwapRef("refs/heads/main", null, {
			type: "direct",
			hash: HASH_A,
		});
		expect(ok).toBe(true);
		expect(await store.readRef("refs/heads/main")).toEqual({ type: "direct", hash: HASH_A });
	});

	test("create fails when ref already exists", async () => {
		const store = await setup();
		await store.writeRef("refs/heads/main", { type: "direct", hash: HASH_A });

		const ok = await store.compareAndSwapRef("refs/heads/main", null, {
			type: "direct",
			hash: HASH_B,
		});
		expect(ok).toBe(false);
		expect(await store.readRef("refs/heads/main")).toEqual({ type: "direct", hash: HASH_A });
	});

	test("update succeeds with matching hash", async () => {
		const store = await setup();
		await store.writeRef("refs/heads/main", { type: "direct", hash: HASH_A });

		const ok = await store.compareAndSwapRef("refs/heads/main", HASH_A, {
			type: "direct",
			hash: HASH_B,
		});
		expect(ok).toBe(true);
		expect(await store.readRef("refs/heads/main")).toEqual({ type: "direct", hash: HASH_B });
	});

	test("update fails with wrong hash", async () => {
		const store = await setup();
		await store.writeRef("refs/heads/main", { type: "direct", hash: HASH_A });

		const ok = await store.compareAndSwapRef("refs/heads/main", HASH_C, {
			type: "direct",
			hash: HASH_B,
		});
		expect(ok).toBe(false);
		expect(await store.readRef("refs/heads/main")).toEqual({ type: "direct", hash: HASH_A });
	});

	test("update fails when ref does not exist", async () => {
		const store = await setup();
		const ok = await store.compareAndSwapRef("refs/heads/main", HASH_A, {
			type: "direct",
			hash: HASH_B,
		});
		expect(ok).toBe(false);
	});

	test("conditional delete succeeds with matching hash", async () => {
		const store = await setup();
		await store.writeRef("refs/heads/main", { type: "direct", hash: HASH_A });

		const ok = await store.compareAndSwapRef("refs/heads/main", HASH_A, null);
		expect(ok).toBe(true);
		expect(await store.readRef("refs/heads/main")).toBeNull();
	});

	test("conditional delete fails with wrong hash", async () => {
		const store = await setup();
		await store.writeRef("refs/heads/main", { type: "direct", hash: HASH_A });

		const ok = await store.compareAndSwapRef("refs/heads/main", HASH_C, null);
		expect(ok).toBe(false);
		expect(await store.readRef("refs/heads/main")).toEqual({ type: "direct", hash: HASH_A });
	});

	test("CAS resolves symbolic ref chain for hash comparison", async () => {
		const store = await setup();
		await store.writeRef("refs/heads/main", { type: "direct", hash: HASH_A });
		await store.writeRef("HEAD", { type: "symbolic", target: "refs/heads/main" });

		const ok = await store.compareAndSwapRef("HEAD", HASH_A, {
			type: "symbolic",
			target: "refs/heads/dev",
		});
		expect(ok).toBe(true);
		expect(await store.readRef("HEAD")).toEqual({ type: "symbolic", target: "refs/heads/dev" });
	});

	test("CAS with symbolic ref fails on hash mismatch", async () => {
		const store = await setup();
		await store.writeRef("refs/heads/main", { type: "direct", hash: HASH_A });
		await store.writeRef("HEAD", { type: "symbolic", target: "refs/heads/main" });

		const ok = await store.compareAndSwapRef("HEAD", HASH_B, {
			type: "symbolic",
			target: "refs/heads/dev",
		});
		expect(ok).toBe(false);
		expect(await store.readRef("HEAD")).toEqual({ type: "symbolic", target: "refs/heads/main" });
	});
});
