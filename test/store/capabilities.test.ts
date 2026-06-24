import { describe, expect, test } from "bun:test";
import { createServer } from "../../src/server/handler.ts";
import { MemoryStorage } from "../../src/store/memory-storage.ts";
import { createRepoStore } from "../../src/store/repo-store.ts";

// ── createRepoStore capability sugar ────────────────────────────────

describe("createRepoStore capabilities", () => {
	test("handles are inert by default", async () => {
		const store = createRepoStore(new MemoryStorage());
		const repo = await store.createRepo("r");
		expect(repo.capabilities).toBeUndefined();
		expect((await store.repo("r"))?.capabilities).toBeUndefined();
	});

	test("attaches default capabilities to every handle handed out", async () => {
		const onProgress = () => {};
		const store = createRepoStore(new MemoryStorage(), {
			capabilities: { onProgress },
		});
		const created = await store.createRepo("r");
		expect(created.capabilities?.onProgress).toBe(onProgress);

		const fetched = await store.repo("r");
		expect(fetched?.capabilities?.onProgress).toBe(onProgress);
	});

	test("per-handle override layers over the store defaults", async () => {
		const onProgress = () => {};
		const identity = { name: "x", email: "x@y" };
		const store = createRepoStore(new MemoryStorage(), {
			capabilities: { onProgress },
		});
		await store.createRepo("r");

		const repo = await store.repo("r", { identity });
		expect(repo?.capabilities?.onProgress).toBe(onProgress); // default survives
		expect(repo?.capabilities?.identity).toBe(identity); // override added
	});

	test("per-handle override replaces a default field per override-wins", async () => {
		const store = createRepoStore(new MemoryStorage(), {
			capabilities: { identity: { name: "base", email: "base@x" } },
		});
		await store.createRepo("r");

		const repo = await store.repo("r", { identity: { name: "over", email: "over@x" } });
		expect(repo?.capabilities?.identity).toEqual({ name: "over", email: "over@x" });
	});

	test("repo() returns null (no wrapping) for an unknown repo", async () => {
		const store = createRepoStore(new MemoryStorage(), {
			capabilities: { onProgress: () => {} },
		});
		expect(await store.repo("missing")).toBeNull();
	});
});

// ── createServer capability sugar ───────────────────────────────────

describe("createServer capabilities", () => {
	test("forwards default capabilities onto server handles", async () => {
		const onProgress = () => {};
		const server = createServer({ capabilities: { onProgress } });
		await server.createRepo("r");

		const repo = await server.repo("r");
		expect(repo?.capabilities?.onProgress).toBe(onProgress);

		const required = await server.requireRepo("r");
		expect(required.capabilities?.onProgress).toBe(onProgress);
	});

	test("per-handle override layers over server defaults", async () => {
		const onProgress = () => {};
		const identity = { name: "x", email: "x@y" };
		const server = createServer({ capabilities: { onProgress } });
		await server.createRepo("r");

		const repo = await server.repo("r", { identity });
		expect(repo?.capabilities?.onProgress).toBe(onProgress);
		expect(repo?.capabilities?.identity).toBe(identity);
	});

	test("handles are inert when no capabilities are configured", async () => {
		const server = createServer();
		await server.createRepo("r");
		expect((await server.repo("r"))?.capabilities).toBeUndefined();
	});
});
