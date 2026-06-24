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
		const store = createRepoStore(new MemoryStorage(), {
			capabilities: { network: false },
		});
		const created = await store.createRepo("r");
		expect(created.capabilities?.network).toBe(false);

		const fetched = await store.repo("r");
		expect(fetched?.capabilities?.network).toBe(false);
	});

	test("per-handle override layers over the store defaults", async () => {
		const resolveRemote = () => null;
		const store = createRepoStore(new MemoryStorage(), {
			capabilities: { network: false },
		});
		await store.createRepo("r");

		const repo = await store.repo("r", { resolveRemote });
		expect(repo?.capabilities?.network).toBe(false); // default survives
		expect(repo?.capabilities?.resolveRemote).toBe(resolveRemote); // override added
	});

	test("per-handle override replaces a default field per override-wins", async () => {
		const store = createRepoStore(new MemoryStorage(), {
			capabilities: { network: false },
		});
		await store.createRepo("r");

		const repo = await store.repo("r", { network: { allowed: ["github.com"] } });
		expect(repo?.capabilities?.network).toEqual({ allowed: ["github.com"] });
	});

	test("repo() returns null (no wrapping) for an unknown repo", async () => {
		const store = createRepoStore(new MemoryStorage(), {
			capabilities: { network: false },
		});
		expect(await store.repo("missing")).toBeNull();
	});
});

// ── createServer capability sugar ───────────────────────────────────

describe("createServer capabilities", () => {
	test("forwards default capabilities onto server handles", async () => {
		const server = createServer({ capabilities: { network: false } });
		await server.createRepo("r");

		const repo = await server.repo("r");
		expect(repo?.capabilities?.network).toBe(false);

		const required = await server.requireRepo("r");
		expect(required.capabilities?.network).toBe(false);
	});

	test("per-handle override layers over server defaults", async () => {
		const resolveRemote = () => null;
		const server = createServer({ capabilities: { network: false } });
		await server.createRepo("r");

		const repo = await server.repo("r", { resolveRemote });
		expect(repo?.capabilities?.network).toBe(false);
		expect(repo?.capabilities?.resolveRemote).toBe(resolveRemote);
	});

	test("handles are inert when no capabilities are configured", async () => {
		const server = createServer();
		await server.createRepo("r");
		expect((await server.repo("r"))?.capabilities).toBeUndefined();
	});
});
