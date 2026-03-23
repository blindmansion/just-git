import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { InMemoryFs } from "just-bash";
import { MemoryStorage } from "../../src/server/memory-storage.ts";
import { createServer } from "../../src/server/handler.ts";
import type { GitServer } from "../../src/server/types.ts";
import { envAt, createServerClient, startServer } from "./util.ts";

describe("server roundtrip", () => {
	let srv: ReturnType<typeof Bun.serve>;
	let server: GitServer;
	let driver: MemoryStorage;
	let port: number;

	beforeAll(async () => {
		driver = new MemoryStorage();
		const s = startServer({ storage: driver });
		server = s.server;
		srv = s.srv;
		port = s.port;

		await server.createRepo("repo");

		const seedClient = createServerClient();
		await seedClient.exec(`git clone http://localhost:${port}/repo /local`, {
			env: envAt(1000000000),
		});

		await seedClient.writeFile("/local/README.md", "# Hello World");
		await seedClient.writeFile("/local/src/main.ts", 'console.log("hello");');
		await seedClient.exec("git add .", { cwd: "/local", env: envAt(1000000000) });
		await seedClient.exec('git commit -m "initial commit"', {
			cwd: "/local",
			env: envAt(1000000000),
		});
		await seedClient.exec("git push origin main", { cwd: "/local" });

		await seedClient.writeFile("/local/src/util.ts", "export const VERSION = 1;");
		await seedClient.exec("git add .", { cwd: "/local", env: envAt(1000000100) });
		await seedClient.exec('git commit -m "add util"', {
			cwd: "/local",
			env: envAt(1000000100),
		});

		await seedClient.exec("git push origin main", { cwd: "/local" });

		await seedClient.exec("git tag v1.0", { cwd: "/local" });
		await seedClient.exec('git tag -a v1.0-annotated -m "release v1.0"', {
			cwd: "/local",
			env: envAt(1000000100),
		});
		await seedClient.exec("git push origin --tags", { cwd: "/local" });

		const repo = (await server.repo("repo"))!;
		const mainRef = await repo.refStore.readRef("refs/heads/main");
		const mainHash = mainRef!.type === "direct" ? mainRef!.hash : "";
		await repo.refStore.writeRef("refs/heads/feature", mainHash);
	});

	afterAll(() => {
		srv?.stop();
	});

	test("clone from server", async () => {
		const client = createServerClient();
		const clientFs = client.fs as InMemoryFs;

		const result = await client.exec(`git clone http://localhost:${port}/repo /local`, {
			env: envAt(1000000200),
		});
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain("Cloning into");

		const readme = await clientFs.readFile("/local/README.md");
		expect(readme).toBe("# Hello World");

		const main = await clientFs.readFile("/local/src/main.ts");
		expect(main).toBe('console.log("hello");');

		const util = await clientFs.readFile("/local/src/util.ts");
		expect(util).toBe("export const VERSION = 1;");

		const head = await clientFs.readFile("/local/.git/HEAD");
		expect(head.trim()).toBe("ref: refs/heads/main");

		const originMain = await clientFs.readFile("/local/.git/refs/remotes/origin/main");
		expect(originMain.trim()).toMatch(/^[0-9a-f]{40}$/);

		const config = await clientFs.readFile("/local/.git/config");
		expect(config).toContain(`http://localhost:${port}/repo`);

		expect(await clientFs.exists("/local/.git/refs/tags/v1.0")).toBe(true);
	});

	test("push to server", async () => {
		const client = createServerClient();

		await client.exec(`git clone http://localhost:${port}/repo /local`, {
			env: envAt(1000000300),
		});

		const repo = (await server.repo("repo"))!;
		const mainBefore = await repo.refStore.readRef("refs/heads/main");
		expect(mainBefore).not.toBeNull();
		const hashBefore = mainBefore!.type === "direct" ? mainBefore!.hash : null;

		await client.writeFile("/local/new-file.txt", "pushed content");
		await client.exec("git add .", { cwd: "/local" });
		await client.exec('git commit -m "push test"', {
			cwd: "/local",
			env: envAt(1000000400),
		});

		const pushResult = await client.exec("git push origin main", { cwd: "/local" });
		expect(pushResult.exitCode).toBe(0);

		const mainAfter = await repo.refStore.readRef("refs/heads/main");
		expect(mainAfter).not.toBeNull();
		const hashAfter = mainAfter!.type === "direct" ? mainAfter!.hash : null;
		expect(hashAfter).not.toBe(hashBefore);

		expect(hashAfter).toBeTruthy();
		const exists = await repo.objectStore.exists(hashAfter!);
		expect(exists).toBe(true);
	});

	test("fetch from server after new server-side commit", async () => {
		const client = createServerClient();
		const clientFs = client.fs as InMemoryFs;

		await client.exec(`git clone http://localhost:${port}/repo /local`, {
			env: envAt(1000000500),
		});

		const trackingBefore = await clientFs.readFile("/local/.git/refs/remotes/origin/main");

		const pusher = createServerClient();
		await pusher.exec(`git clone http://localhost:${port}/repo /push-local`, {
			env: envAt(1000000550),
		});
		await pusher.writeFile("/push-local/server-change.txt", "server side");
		await pusher.exec("git add .", { cwd: "/push-local" });
		await pusher.exec('git commit -m "server commit"', {
			cwd: "/push-local",
			env: envAt(1000000600),
		});
		await pusher.exec("git push origin main", { cwd: "/push-local" });

		const fetchResult = await client.exec("git fetch origin", { cwd: "/local" });
		expect(fetchResult.exitCode).toBe(0);

		const trackingAfter = await clientFs.readFile("/local/.git/refs/remotes/origin/main");
		expect(trackingAfter.trim()).not.toBe(trackingBefore.trim());

		const logResult = await client.exec("git log origin/main --oneline -3", {
			cwd: "/local",
		});
		expect(logResult.stdout).toContain("server commit");
	});

	test("push new branch to server", async () => {
		const client = createServerClient();

		await client.exec(`git clone http://localhost:${port}/repo /local`, {
			env: envAt(1000000700),
		});

		await client.exec("git checkout -b new-feature", { cwd: "/local" });
		await client.writeFile("/local/feature.txt", "new feature");
		await client.exec("git add .", { cwd: "/local" });
		await client.exec('git commit -m "feature work"', {
			cwd: "/local",
			env: envAt(1000000800),
		});

		const pushResult = await client.exec("git push origin new-feature", { cwd: "/local" });
		expect(pushResult.exitCode).toBe(0);

		const repo = (await server.repo("repo"))!;
		const newBranch = await repo.refStore.readRef("refs/heads/new-feature");
		expect(newBranch).not.toBeNull();
		expect(newBranch!.type).toBe("direct");
	});

	test("delete remote branch via push", async () => {
		const repo = (await server.repo("repo"))!;
		const before = await repo.refStore.readRef("refs/heads/feature");
		expect(before).not.toBeNull();

		const client = createServerClient();

		await client.exec(`git clone http://localhost:${port}/repo /local`, {
			env: envAt(1000000900),
		});

		const deleteResult = await client.exec("git push origin --delete feature", {
			cwd: "/local",
		});
		expect(deleteResult.exitCode).toBe(0);

		const after = await repo.refStore.readRef("refs/heads/feature");
		expect(after).toBeNull();
	});

	test("postReceive hook is called with repoId", async () => {
		const pushEvents: Array<{ refCount: number; repoId: string }> = [];

		const hookedServer = createServer({
			storage: driver,
			hooks: {
				postReceive: async (event) => {
					pushEvents.push({ refCount: event.updates.length, repoId: event.repoId });
				},
			},
		});

		const hookedSrv = Bun.serve({
			fetch: hookedServer.fetch,
			port: 0,
		});

		try {
			const client = createServerClient();

			await client.exec(`git clone http://localhost:${hookedSrv.port}/repo /local`, {
				env: envAt(1000001000),
			});

			await client.writeFile("/local/hook-test.txt", "hook test");
			await client.exec("git add .", { cwd: "/local" });
			await client.exec('git commit -m "hook test"', {
				cwd: "/local",
				env: envAt(1000001100),
			});

			await client.exec("git push origin main", { cwd: "/local" });

			expect(pushEvents.length).toBe(1);
			expect(pushEvents[0]!.refCount).toBe(1);
			expect(pushEvents[0]!.repoId).toBe("repo");
		} finally {
			hookedSrv.stop();
		}
	});

	test("preReceive hook receives repoId", async () => {
		let capturedRepoId: string | undefined;

		const hookedServer = createServer({
			storage: driver,
			hooks: {
				preReceive: async (event) => {
					capturedRepoId = event.repoId;
				},
			},
		});

		const hookedSrv = Bun.serve({
			fetch: hookedServer.fetch,
			port: 0,
		});

		try {
			const client = createServerClient();

			await client.exec(`git clone http://localhost:${hookedSrv.port}/repo /local`, {
				env: envAt(1000001000),
			});

			await client.writeFile("/local/repopath-test.txt", "test");
			await client.exec("git add .", { cwd: "/local" });
			await client.exec('git commit -m "repopath test"', {
				cwd: "/local",
				env: envAt(1000001100),
			});

			await client.exec("git push origin main", { cwd: "/local" });

			expect(capturedRepoId).toBe("repo");
		} finally {
			hookedSrv.stop();
		}
	});

	test("preReceive hook can reject a push", async () => {
		const authServer = createServer({
			storage: driver,
			hooks: {
				preReceive: async () => {
					return { reject: true, message: "Push not allowed" };
				},
			},
		});

		const authSrv = Bun.serve({
			fetch: authServer.fetch,
			port: 0,
		});

		try {
			const client = createServerClient();

			const cloneResult = await client.exec(
				`git clone http://localhost:${authSrv.port}/repo /local`,
				{ env: envAt(1000001200) },
			);
			expect(cloneResult.exitCode).toBe(0);

			await client.writeFile("/local/blocked.txt", "blocked");
			await client.exec("git add .", { cwd: "/local" });
			await client.exec('git commit -m "blocked"', {
				cwd: "/local",
				env: envAt(1000001300),
			});

			const pushResult = await client.exec("git push origin main", { cwd: "/local" });
			expect(pushResult.exitCode).not.toBe(0);
		} finally {
			authSrv.stop();
		}
	});
});
