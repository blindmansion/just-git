import { describe, expect, test } from "bun:test";
import { createServer } from "../../src/server/handler.ts";
import { MemoryStorage } from "../../src/storage/memory-storage.ts";
import type { RefChangeEvent } from "../../src/server/types.ts";
import { createServerClient, envAt, startServer } from "./util.ts";

const AUTHOR = { name: "Bot", email: "bot@test.com" };

describe("onRefUpdate notification", () => {
	test("fires on server.commit with source 'commit' and no auth", async () => {
		const events: RefChangeEvent[] = [];
		const server = createServer({
			storage: new MemoryStorage(),
			onRefUpdate: (e) => events.push(e),
		});
		await server.createRepo("r");

		const { hash } = await server.commit("r", {
			files: { "README.md": "# hi\n" },
			message: "init",
			author: AUTHOR,
			branch: "main",
		});

		expect(events).toHaveLength(1);
		const ev = events[0]!;
		expect(ev.source).toBe("commit");
		expect(ev.repoId).toBe("r");
		expect(ev.auth).toBeUndefined();
		expect(ev.updates).toHaveLength(1);
		expect(ev.updates[0]!.ref).toBe("refs/heads/main");
		expect(ev.updates[0]!.newHash).toBe(hash);
	});

	test("fires on server.updateRefs with source 'update-refs'", async () => {
		const events: RefChangeEvent[] = [];
		const server = createServer({
			storage: new MemoryStorage(),
			onRefUpdate: (e) => events.push(e),
		});
		await server.createRepo("r");
		const { hash } = await server.commit("r", {
			files: { "a.txt": "a\n" },
			message: "c1",
			author: AUTHOR,
			branch: "main",
		});
		events.length = 0;

		await server.updateRefs("r", [{ ref: "refs/heads/feature", newHash: hash }]);

		expect(events).toHaveLength(1);
		expect(events[0]!.source).toBe("update-refs");
		expect(events[0]!.updates[0]!.ref).toBe("refs/heads/feature");
	});

	test("does not fire when nothing is applied (failed CAS)", async () => {
		const events: RefChangeEvent[] = [];
		const server = createServer({
			storage: new MemoryStorage(),
			onRefUpdate: (e) => events.push(e),
		});
		await server.createRepo("r");

		// Wrong expected oldHash → CAS fails → no applied updates → no event.
		await server.updateRefs("r", [
			{ ref: "refs/heads/main", newHash: "f".repeat(40), oldHash: "a".repeat(40) },
		]);
		expect(events).toHaveLength(0);
	});

	test("a throwing listener never breaks the write", async () => {
		const server = createServer({
			storage: new MemoryStorage(),
			onRefUpdate: () => {
				throw new Error("boom");
			},
		});
		await server.createRepo("r");
		const { hash } = await server.commit("r", {
			files: { "x.txt": "x\n" },
			message: "c",
			author: AUTHOR,
			branch: "main",
		});
		expect(hash).toBeTruthy();
	});

	test("fires on push (source 'push') with auth context", async () => {
		const events: RefChangeEvent[] = [];
		const { server, port, stop } = startServer({
			storage: new MemoryStorage(),
			onRefUpdate: (e) => events.push(e),
		});
		try {
			await server.createRepo("r");
			const client = createServerClient();
			const url = `http://localhost:${port}/r`;
			await client.exec(`git clone ${url} /repo`, { env: envAt(1000000000) });
			await client.writeFile("/repo/file.txt", "hello\n");
			await client.exec("git add .", { cwd: "/repo", env: envAt(1000000000) });
			await client.exec('git commit -m "c"', { cwd: "/repo", env: envAt(1000000000) });
			await client.exec("git push origin main", { cwd: "/repo", env: envAt(1000000000) });

			const pushEvents = events.filter((e) => e.source === "push");
			expect(pushEvents.length).toBeGreaterThan(0);
			const ev = pushEvents[pushEvents.length - 1]!;
			expect(ev.repoId).toBe("r");
			expect(ev.auth).toBeDefined();
			expect(ev.updates.some((u) => u.ref === "refs/heads/main")).toBe(true);
		} finally {
			stop();
		}
	});
});
