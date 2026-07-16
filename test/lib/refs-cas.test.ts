import { describe, expect, test } from "bun:test";
import { InMemoryFs } from "just-bash";
import { FileSystemRefStore } from "../../src/lib/refs/store.ts";

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

	test("update succeeds with matching direct ref", async () => {
		const store = await setup();
		await store.writeRef("refs/heads/main", { type: "direct", hash: HASH_A });

		const ok = await store.compareAndSwapRef(
			"refs/heads/main",
			{ type: "direct", hash: HASH_A },
			{
				type: "direct",
				hash: HASH_B,
			},
		);
		expect(ok).toBe(true);
		expect(await store.readRef("refs/heads/main")).toEqual({ type: "direct", hash: HASH_B });
	});

	test("update fails with wrong direct ref", async () => {
		const store = await setup();
		await store.writeRef("refs/heads/main", { type: "direct", hash: HASH_A });

		const ok = await store.compareAndSwapRef(
			"refs/heads/main",
			{ type: "direct", hash: HASH_C },
			{
				type: "direct",
				hash: HASH_B,
			},
		);
		expect(ok).toBe(false);
		expect(await store.readRef("refs/heads/main")).toEqual({ type: "direct", hash: HASH_A });
	});

	test("update fails when ref does not exist", async () => {
		const store = await setup();
		const ok = await store.compareAndSwapRef(
			"refs/heads/main",
			{ type: "direct", hash: HASH_A },
			{
				type: "direct",
				hash: HASH_B,
			},
		);
		expect(ok).toBe(false);
	});

	test("conditional delete succeeds with matching direct ref", async () => {
		const store = await setup();
		await store.writeRef("refs/heads/main", { type: "direct", hash: HASH_A });

		const ok = await store.compareAndSwapRef(
			"refs/heads/main",
			{ type: "direct", hash: HASH_A },
			null,
		);
		expect(ok).toBe(true);
		expect(await store.readRef("refs/heads/main")).toBeNull();
	});

	test("conditional delete fails with wrong direct ref", async () => {
		const store = await setup();
		await store.writeRef("refs/heads/main", { type: "direct", hash: HASH_A });

		const ok = await store.compareAndSwapRef(
			"refs/heads/main",
			{ type: "direct", hash: HASH_C },
			null,
		);
		expect(ok).toBe(false);
		expect(await store.readRef("refs/heads/main")).toEqual({ type: "direct", hash: HASH_A });
	});

	test("CAS compares and replaces the exact raw symbolic ref", async () => {
		const store = await setup();
		await store.writeRef("refs/heads/main", { type: "direct", hash: HASH_A });
		await store.writeRef("HEAD", { type: "symbolic", target: "refs/heads/main" });

		const ok = await store.compareAndSwapRef(
			"HEAD",
			{ type: "symbolic", target: "refs/heads/main" },
			{
				type: "symbolic",
				target: "refs/heads/dev",
			},
		);
		expect(ok).toBe(true);
		expect(await store.readRef("HEAD")).toEqual({ type: "symbolic", target: "refs/heads/dev" });
		expect(await store.readRef("refs/heads/main")).toEqual({ type: "direct", hash: HASH_A });
	});

	test("CAS rejects a direct expectation for a symbolic ref", async () => {
		const store = await setup();
		await store.writeRef("refs/heads/main", { type: "direct", hash: HASH_A });
		await store.writeRef("HEAD", { type: "symbolic", target: "refs/heads/main" });

		const ok = await store.compareAndSwapRef(
			"HEAD",
			{ type: "direct", hash: HASH_A },
			{
				type: "symbolic",
				target: "refs/heads/dev",
			},
		);
		expect(ok).toBe(false);
		expect(await store.readRef("HEAD")).toEqual({ type: "symbolic", target: "refs/heads/main" });
	});

	test("CAS rejects a different raw symbolic target", async () => {
		const store = await setup();
		await store.writeRef("HEAD", { type: "symbolic", target: "refs/heads/main" });

		const ok = await store.compareAndSwapRef(
			"HEAD",
			{ type: "symbolic", target: "refs/heads/other" },
			{ type: "symbolic", target: "refs/heads/dev" },
		);
		expect(ok).toBe(false);
		expect(await store.readRef("HEAD")).toEqual({ type: "symbolic", target: "refs/heads/main" });
	});
});
