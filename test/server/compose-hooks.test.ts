import { describe, expect, test } from "bun:test";
import type { GitRepo } from "../../src/lib/types.ts";
import { composeHooks } from "../../src/server/handler.ts";
import type {
	Auth,
	AdvertiseRefsEvent,
	PostReceiveEvent,
	PreReceiveEvent,
	RefUpdate,
	ServerHooks,
	UpdateEvent,
} from "../../src/server/types.ts";

function stubRepo(): GitRepo {
	return {
		objectStore: {} as any,
		refStore: {} as any,
	};
}

function stubAuth(): Auth {
	return { transport: "http", request: new Request("http://localhost/test") };
}

function refUpdate(ref = "refs/heads/main"): RefUpdate {
	return { ref, oldHash: "aaa", newHash: "bbb", isFF: true, isCreate: false, isDelete: false };
}

function preReceiveEvent(overrides?: Partial<PreReceiveEvent>): PreReceiveEvent {
	return {
		repo: stubRepo(),
		repoId: "my-repo",
		updates: [refUpdate()],
		auth: stubAuth(),
		...overrides,
	};
}

function updateEvent(overrides?: Partial<UpdateEvent>): UpdateEvent {
	return {
		repo: stubRepo(),
		repoId: "my-repo",
		update: refUpdate(),
		auth: stubAuth(),
		...overrides,
	};
}

function postReceiveEvent(overrides?: Partial<PostReceiveEvent>): PostReceiveEvent {
	return {
		repo: stubRepo(),
		repoId: "my-repo",
		updates: [refUpdate()],
		auth: stubAuth(),
		...overrides,
	};
}

function advertiseRefsEvent(overrides?: Partial<AdvertiseRefsEvent>): AdvertiseRefsEvent {
	return {
		repo: stubRepo(),
		repoId: "my-repo",
		refs: [
			{ name: "refs/heads/main", hash: "aaa" },
			{ name: "refs/heads/feature", hash: "bbb" },
		],
		service: "git-upload-pack",
		auth: stubAuth(),
		...overrides,
	};
}

describe("composeHooks", () => {
	test("returns empty hooks for no inputs", () => {
		const hooks = composeHooks();
		expect(hooks).toEqual({});
	});

	test("returns the single hook set unchanged", () => {
		const single: ServerHooks = {
			preReceive: async () => {},
		};
		const hooks = composeHooks(single);
		expect(hooks).toBe(single);
	});

	test("skips undefined hook sets", () => {
		const single: ServerHooks = {
			preReceive: async () => {},
		};
		const hooks = composeHooks(undefined, single, undefined);
		expect(hooks).toBe(single);
	});

	// ── preReceive ──────────────────────────────────────────────────

	describe("preReceive", () => {
		test("runs handlers in order", async () => {
			const order: number[] = [];
			const hooks = composeHooks(
				{
					preReceive: async () => {
						order.push(1);
					},
				},
				{
					preReceive: async () => {
						order.push(2);
					},
				},
			);
			await hooks.preReceive!(preReceiveEvent());
			expect(order).toEqual([1, 2]);
		});

		test("short-circuits on first rejection", async () => {
			const order: number[] = [];
			const hooks = composeHooks(
				{
					preReceive: async () => {
						order.push(1);
						return { reject: true, message: "no" };
					},
				},
				{
					preReceive: async () => {
						order.push(2);
					},
				},
			);
			const result = await hooks.preReceive!(preReceiveEvent());
			expect(result).toEqual({ reject: true, message: "no" });
			expect(order).toEqual([1]);
		});

		test("returns void when no handler rejects", async () => {
			const hooks = composeHooks({ preReceive: async () => {} }, { preReceive: async () => {} });
			const result = await hooks.preReceive!(preReceiveEvent());
			expect(result).toBeUndefined();
		});

		test("not set when no hook set has preReceive", () => {
			const hooks = composeHooks({ postReceive: async () => {} }, { update: async () => {} });
			expect(hooks.preReceive).toBeUndefined();
		});
	});

	// ── update ──────────────────────────────────────────────────────

	describe("update", () => {
		test("runs handlers in order", async () => {
			const order: number[] = [];
			const hooks = composeHooks(
				{
					update: async () => {
						order.push(1);
					},
				},
				{
					update: async () => {
						order.push(2);
					},
				},
			);
			await hooks.update!(updateEvent());
			expect(order).toEqual([1, 2]);
		});

		test("short-circuits on first rejection", async () => {
			const order: number[] = [];
			const hooks = composeHooks(
				{
					update: async () => {
						order.push(1);
					},
				},
				{
					update: async () => {
						order.push(2);
						return { reject: true };
					},
				},
				{
					update: async () => {
						order.push(3);
					},
				},
			);
			const result = await hooks.update!(updateEvent());
			expect(result).toEqual({ reject: true });
			expect(order).toEqual([1, 2]);
		});
	});

	// ── postReceive ─────────────────────────────────────────────────

	describe("postReceive", () => {
		test("runs all handlers in order", async () => {
			const order: number[] = [];
			const hooks = composeHooks(
				{
					postReceive: async () => {
						order.push(1);
					},
				},
				{
					postReceive: async () => {
						order.push(2);
					},
				},
			);
			await hooks.postReceive!(postReceiveEvent());
			expect(order).toEqual([1, 2]);
		});

		test("one handler throwing does not block the rest", async () => {
			const order: number[] = [];
			const hooks = composeHooks(
				{
					postReceive: async () => {
						order.push(1);
						throw new Error("boom");
					},
				},
				{
					postReceive: async () => {
						order.push(2);
					},
				},
			);
			await hooks.postReceive!(postReceiveEvent());
			expect(order).toEqual([1, 2]);
		});
	});

	// ── advertiseRefs ───────────────────────────────────────────────

	describe("advertiseRefs", () => {
		test("chains ref filtering", async () => {
			const hooks = composeHooks(
				{
					advertiseRefs: async (event) => event.refs.filter((r) => r.name !== "refs/heads/feature"),
				},
				{
					advertiseRefs: async (event) => event.refs.map((r) => ({ ...r, hash: "filtered" })),
				},
			);
			const result = await hooks.advertiseRefs!(advertiseRefsEvent());
			expect(result).toEqual([{ name: "refs/heads/main", hash: "filtered" }]);
		});

		test("short-circuits on rejection", async () => {
			const order: number[] = [];
			const hooks = composeHooks(
				{
					advertiseRefs: async () => {
						order.push(1);
						return { reject: true, message: "denied" };
					},
				},
				{
					advertiseRefs: async () => {
						order.push(2);
					},
				},
			);
			const result = await hooks.advertiseRefs!(advertiseRefsEvent());
			expect(result).toEqual({ reject: true, message: "denied" });
			expect(order).toEqual([1]);
		});

		test("void return passes refs through unchanged", async () => {
			const hooks = composeHooks(
				{ advertiseRefs: async () => {} },
				{
					advertiseRefs: async (event) => event.refs.filter((r) => r.name === "refs/heads/main"),
				},
			);
			const result = await hooks.advertiseRefs!(advertiseRefsEvent());
			expect(result).toEqual([{ name: "refs/heads/main", hash: "aaa" }]);
		});
	});
});
