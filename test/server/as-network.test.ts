import { describe, expect, test } from "bun:test";
import { Bash, InMemoryFs } from "just-bash";
import { createGit } from "../../src/index.ts";
import { createServer } from "../../src/server/handler.ts";
import { MemoryStorage } from "../../src/server/memory-storage.ts";
import type { GitServer, GitServerConfig } from "../../src/server/types.ts";
import { envAt } from "./util.ts";

const BASE = "http://git";

function setup(serverOverrides?: Partial<GitServerConfig>) {
	const driver = new MemoryStorage();
	const server = createServer({ storage: driver, ...serverOverrides });
	return { driver, server };
}

function client(server: GitServer, cwd = "/") {
	const fs = new InMemoryFs();
	const git = createGit({ network: server.asNetwork(BASE) });
	const bash = new Bash({ fs, cwd, customCommands: [git] });
	return bash;
}

describe("asNetwork", () => {
	test("clone via in-process server", async () => {
		const { server } = setup({ autoCreate: true });
		const seeder = client(server);

		await seeder.exec(`git clone ${BASE}/repo /seed`, { env: envAt(1000000000) });
		await seeder.writeFile("/seed/README.md", "# Hello");
		await seeder.exec("git add .", { cwd: "/seed", env: envAt(1000000000) });
		await seeder.exec('git commit -m "init"', { cwd: "/seed", env: envAt(1000000000) });
		await seeder.exec("git push origin main", { cwd: "/seed" });

		const c = client(server);
		const result = await c.exec(`git clone ${BASE}/repo /work`, { env: envAt(1000000100) });
		expect(result.exitCode).toBe(0);

		const fs = c.fs as InMemoryFs;
		expect(await fs.readFile("/work/README.md")).toBe("# Hello");
		expect((await fs.readFile("/work/.git/HEAD")).trim()).toBe("ref: refs/heads/main");
	});

	test("push via in-process server", async () => {
		const { server } = setup({ autoCreate: true });
		const seeder = client(server);

		await seeder.exec(`git clone ${BASE}/repo /seed`, { env: envAt(1000000000) });
		await seeder.writeFile("/seed/README.md", "# Init");
		await seeder.exec("git add .", { cwd: "/seed", env: envAt(1000000000) });
		await seeder.exec('git commit -m "init"', { cwd: "/seed", env: envAt(1000000000) });
		await seeder.exec("git push origin main", { cwd: "/seed" });

		const repo = await server.requireRepo("repo");
		const before = await repo.refStore.readRef("refs/heads/main");
		const hashBefore = before!.type === "direct" ? before!.hash : null;

		const c = client(server);
		await c.exec(`git clone ${BASE}/repo /work`, { env: envAt(1000000100) });
		await c.writeFile("/work/new.txt", "new content");
		await c.exec("git add .", { cwd: "/work", env: envAt(1000000200) });
		await c.exec('git commit -m "add file"', { cwd: "/work", env: envAt(1000000200) });

		const pushResult = await c.exec("git push origin main", { cwd: "/work" });
		expect(pushResult.exitCode).toBe(0);

		const after = await repo.refStore.readRef("refs/heads/main");
		const hashAfter = after!.type === "direct" ? after!.hash : null;
		expect(hashAfter).not.toBe(hashBefore);
	});

	test("fetch via in-process server", async () => {
		const { server } = setup({ autoCreate: true });
		const seeder = client(server);

		await seeder.exec(`git clone ${BASE}/repo /seed`, { env: envAt(1000000000) });
		await seeder.writeFile("/seed/README.md", "# Init");
		await seeder.exec("git add .", { cwd: "/seed", env: envAt(1000000000) });
		await seeder.exec('git commit -m "init"', { cwd: "/seed", env: envAt(1000000000) });
		await seeder.exec("git push origin main", { cwd: "/seed" });

		const fetcher = client(server);
		await fetcher.exec(`git clone ${BASE}/repo /work`, { env: envAt(1000000100) });
		const fs = fetcher.fs as InMemoryFs;
		const trackingBefore = await fs.readFile("/work/.git/refs/remotes/origin/main");

		await seeder.writeFile("/seed/extra.txt", "extra");
		await seeder.exec("git add .", { cwd: "/seed", env: envAt(1000000200) });
		await seeder.exec('git commit -m "more"', { cwd: "/seed", env: envAt(1000000200) });
		await seeder.exec("git push origin main", { cwd: "/seed" });

		const fetchResult = await fetcher.exec("git fetch origin", { cwd: "/work" });
		expect(fetchResult.exitCode).toBe(0);

		const trackingAfter = await fs.readFile("/work/.git/refs/remotes/origin/main");
		expect(trackingAfter.trim()).not.toBe(trackingBefore.trim());

		const log = await fetcher.exec("git log origin/main --oneline -2", { cwd: "/work" });
		expect(log.stdout).toContain("more");
	});

	test("pull via in-process server", async () => {
		const { server } = setup({ autoCreate: true });
		const seeder = client(server);

		await seeder.exec(`git clone ${BASE}/repo /seed`, { env: envAt(1000000000) });
		await seeder.writeFile("/seed/README.md", "# Init");
		await seeder.exec("git add .", { cwd: "/seed", env: envAt(1000000000) });
		await seeder.exec('git commit -m "init"', { cwd: "/seed", env: envAt(1000000000) });
		await seeder.exec("git push origin main", { cwd: "/seed" });

		const puller = client(server);
		await puller.exec(`git clone ${BASE}/repo /work`, { env: envAt(1000000100) });

		await seeder.writeFile("/seed/pulled.txt", "pulled");
		await seeder.exec("git add .", { cwd: "/seed", env: envAt(1000000200) });
		await seeder.exec('git commit -m "to pull"', { cwd: "/seed", env: envAt(1000000200) });
		await seeder.exec("git push origin main", { cwd: "/seed" });

		const pullResult = await puller.exec("git pull origin main", {
			cwd: "/work",
			env: envAt(1000000300),
		});
		expect(pullResult.exitCode).toBe(0);

		const fs = puller.fs as InMemoryFs;
		expect(await fs.readFile("/work/pulled.txt")).toBe("pulled");
	});

	test("server hooks fire through asNetwork", async () => {
		const pushEvents: Array<{ repoId: string; refCount: number }> = [];
		const { server } = setup({
			autoCreate: true,
			hooks: {
				postReceive: (event) => {
					pushEvents.push({ repoId: event.repoId, refCount: event.updates.length });
				},
			},
		});

		const c = client(server);
		await c.exec(`git clone ${BASE}/repo /work`, { env: envAt(1000000000) });
		await c.writeFile("/work/README.md", "# Hook test");
		await c.exec("git add .", { cwd: "/work", env: envAt(1000000000) });
		await c.exec('git commit -m "hook"', { cwd: "/work", env: envAt(1000000000) });
		await c.exec("git push origin main", { cwd: "/work" });

		expect(pushEvents).toHaveLength(1);
		expect(pushEvents[0]!.repoId).toBe("repo");
		expect(pushEvents[0]!.refCount).toBe(1);
	});

	test("preReceive rejection works through asNetwork", async () => {
		const { server } = setup({
			autoCreate: true,
			hooks: {
				preReceive: () => ({ reject: true, message: "denied" }),
			},
		});

		const c = client(server);
		await c.exec(`git clone ${BASE}/repo /work`, { env: envAt(1000000000) });
		await c.writeFile("/work/README.md", "# Blocked");
		await c.exec("git add .", { cwd: "/work", env: envAt(1000000000) });
		await c.exec('git commit -m "blocked"', { cwd: "/work", env: envAt(1000000000) });

		const result = await c.exec("git push origin main", { cwd: "/work" });
		expect(result.exitCode).not.toBe(0);
	});

	test("custom baseUrl is respected", async () => {
		const { server } = setup({ autoCreate: true });
		const customBase = "http://my-server.local:8080";

		const fs = new InMemoryFs();
		const git = createGit({ network: server.asNetwork(customBase) });
		const bash = new Bash({ fs, cwd: "/", customCommands: [git] });

		await bash.exec(`git clone ${customBase}/repo /work`, { env: envAt(1000000000) });
		await bash.writeFile("/work/README.md", "custom url");
		await bash.exec("git add .", { cwd: "/work", env: envAt(1000000000) });
		await bash.exec('git commit -m "custom"', { cwd: "/work", env: envAt(1000000000) });

		const pushResult = await bash.exec("git push origin main", { cwd: "/work" });
		expect(pushResult.exitCode).toBe(0);

		const config = await fs.readFile("/work/.git/config");
		expect(config).toContain(customBase);
	});

	test("default baseUrl works without argument", async () => {
		const { server } = setup({ autoCreate: true });

		const fs = new InMemoryFs();
		const git = createGit({ network: server.asNetwork() });
		const bash = new Bash({ fs, cwd: "/", customCommands: [git] });

		const result = await bash.exec("git clone http://git/repo /work", {
			env: envAt(1000000000),
		});
		expect(result.exitCode).toBe(0);
		expect(await fs.readFile("/work/.git/HEAD")).toContain("refs/heads/main");
	});

	test("auth provider receives proper requests", async () => {
		const seenUrls: string[] = [];
		const { server } = setup({
			autoCreate: true,
			auth: {
				http: (req) => {
					seenUrls.push(new URL(req.url).pathname);
					return { transport: "http" as const, request: req };
				},
			},
		});

		const c = client(server);
		await c.exec(`git clone ${BASE}/repo /work`, { env: envAt(1000000000) });

		expect(seenUrls.some((u) => u.includes("/repo/"))).toBe(true);
	});

	test("asNetwork auth bypasses auth.http", async () => {
		let httpAuthCalls = 0;
		const server = createServer({
			autoCreate: true,
			auth: {
				http: () => {
					httpAuthCalls++;
					return { userId: "from-http", roles: ["read"] };
				},
			},
		});

		const fs = new InMemoryFs();
		const network = server.asNetwork(BASE, { userId: "agent-1", roles: ["push"] });
		const git = createGit({ network });
		const bash = new Bash({ fs, cwd: "/", customCommands: [git] });

		await bash.exec(`git clone ${BASE}/repo /work`, { env: envAt(1000000000) });

		expect(httpAuthCalls).toBe(0);
	});

	test("asNetwork auth flows through to server hooks", async () => {
		const receivedAuth: Array<{ userId: string; roles: string[] }> = [];
		const server = createServer<{ userId: string; roles: string[] }>({
			storage: new MemoryStorage(),
			autoCreate: true,
			auth: {
				http: () => ({ userId: "should-not-appear", roles: [] }),
			},
			hooks: {
				advertiseRefs: ({ auth }) => {
					receivedAuth.push(auth);
				},
				postReceive: ({ auth }) => {
					receivedAuth.push(auth);
				},
			},
		});

		const agentAuth = { userId: "agent-42", roles: ["push", "read"] };
		const fs = new InMemoryFs();
		const network = server.asNetwork(BASE, agentAuth);
		const git = createGit({ network });
		const bash = new Bash({ fs, cwd: "/", customCommands: [git] });

		await bash.exec(`git clone ${BASE}/repo /work`, { env: envAt(1000000000) });
		await bash.writeFile("/work/README.md", "# Auth test");
		await bash.exec("git add .", { cwd: "/work", env: envAt(1000000000) });
		await bash.exec('git commit -m "auth"', { cwd: "/work", env: envAt(1000000000) });
		await bash.exec("git push origin main", { cwd: "/work" });

		expect(receivedAuth.length).toBeGreaterThan(0);
		for (const auth of receivedAuth) {
			expect(auth.userId).toBe("agent-42");
			expect(auth.roles).toEqual(["push", "read"]);
		}
	});

	test("asNetwork without auth still calls auth.http", async () => {
		let httpAuthCalls = 0;
		const server = createServer({
			storage: new MemoryStorage(),
			autoCreate: true,
			auth: {
				http: (req) => {
					httpAuthCalls++;
					return { transport: "http" as const, request: req };
				},
			},
		});

		const fs = new InMemoryFs();
		const network = server.asNetwork(BASE);
		const git = createGit({ network });
		const bash = new Bash({ fs, cwd: "/", customCommands: [git] });

		await bash.exec(`git clone ${BASE}/repo /work`, { env: envAt(1000000000) });

		expect(httpAuthCalls).toBeGreaterThan(0);
	});

	test("asNetwork auth with preReceive rejection uses provided auth", async () => {
		const server = createServer<{ userId: string; canPush: boolean }>({
			storage: new MemoryStorage(),
			autoCreate: true,
			auth: {
				http: () => ({ userId: "http-user", canPush: true }),
			},
			hooks: {
				preReceive: ({ auth }) => {
					if (!auth.canPush) return { reject: true, message: "push denied" };
				},
			},
		});

		const noPush = server.asNetwork(BASE, { userId: "reader", canPush: false });
		const yesPush = server.asNetwork(BASE, { userId: "writer", canPush: true });

		// Seed the repo via the writer
		const writerFs = new InMemoryFs();
		const writerGit = createGit({ network: yesPush });
		const writerBash = new Bash({ fs: writerFs, cwd: "/", customCommands: [writerGit] });
		await writerBash.exec(`git clone ${BASE}/repo /work`, { env: envAt(1000000000) });
		await writerBash.writeFile("/work/README.md", "# Seeded");
		await writerBash.exec("git add .", { cwd: "/work", env: envAt(1000000000) });
		await writerBash.exec('git commit -m "seed"', { cwd: "/work", env: envAt(1000000000) });
		const seedPush = await writerBash.exec("git push origin main", { cwd: "/work" });
		expect(seedPush.exitCode).toBe(0);

		// Reader clones and tries to push — should be rejected
		const readerFs = new InMemoryFs();
		const readerGit = createGit({ network: noPush });
		const readerBash = new Bash({ fs: readerFs, cwd: "/", customCommands: [readerGit] });
		await readerBash.exec(`git clone ${BASE}/repo /work`, { env: envAt(1000000100) });
		await readerBash.writeFile("/work/new.txt", "blocked");
		await readerBash.exec("git add .", { cwd: "/work", env: envAt(1000000200) });
		await readerBash.exec('git commit -m "blocked"', { cwd: "/work", env: envAt(1000000200) });
		const pushResult = await readerBash.exec("git push origin main", { cwd: "/work" });
		expect(pushResult.exitCode).not.toBe(0);
	});

	test("asNetwork auth works without auth.http configured", async () => {
		const server = createServer<{ agentId: string }>({
			storage: new MemoryStorage(),
			autoCreate: true,
			auth: {
				ssh: () => ({ agentId: "ssh-only" }),
			},
		});

		const fs = new InMemoryFs();
		const network = server.asNetwork(BASE, { agentId: "in-process" });
		const git = createGit({ network });
		const bash = new Bash({ fs, cwd: "/", customCommands: [git] });

		// Should work even though auth.http is not configured
		const result = await bash.exec(`git clone ${BASE}/repo /work`, { env: envAt(1000000000) });
		expect(result.exitCode).toBe(0);
	});
});
