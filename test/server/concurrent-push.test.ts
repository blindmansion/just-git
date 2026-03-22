import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Bash, InMemoryFs } from "just-bash";
import { createGit } from "../../src/index.ts";
import { findRepo } from "../../src/lib/repo.ts";
import type { GitContext } from "../../src/lib/types.ts";
import { BunSqliteDriver } from "../../src/server/bun-sqlite-storage.ts";
import { createStorage } from "../../src/server/storage.ts";
import type { Storage } from "../../src/server/storage.ts";
import { envAt, createServerClient, startServer } from "./util.ts";

// ── Concurrent HTTP pushes to a VFS-backed server ────────────────────

describe("concurrent push safety (VFS-backed server)", () => {
	let srv: ReturnType<typeof Bun.serve>;
	let serverFs: InMemoryFs;
	let serverRepo: GitContext;
	let port: number;

	beforeAll(async () => {
		serverFs = new InMemoryFs();
		const git = createGit();
		const bash = new Bash({ fs: serverFs, cwd: "/repo", customCommands: [git] });

		await bash.writeFile("/repo/README.md", "# Hello");
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "initial"', { env: envAt(1000000000) });

		const ctx = await findRepo(serverFs, "/repo");
		if (!ctx) throw new Error("failed to find git dir");
		serverRepo = ctx;

		const s = startServer({ resolveRepo: async () => serverRepo });
		srv = s.srv;
		port = s.port;
	});

	afterAll(() => srv?.stop());

	test("concurrent pushes to same ref — one wins, one gets rejected", async () => {
		const alice = createServerClient();
		const bob = createServerClient();

		await alice.exec(`git clone http://localhost:${port}/repo /local`, { env: envAt(1000000100) });
		await bob.exec(`git clone http://localhost:${port}/repo /local`, { env: envAt(1000000100) });

		await alice.writeFile("/local/alice.txt", "alice");
		await alice.exec("git add .", { cwd: "/local" });
		await alice.exec('git commit -m "alice"', { cwd: "/local", env: envAt(1000000200) });

		await bob.writeFile("/local/bob.txt", "bob");
		await bob.exec("git add .", { cwd: "/local" });
		await bob.exec('git commit -m "bob"', { cwd: "/local", env: envAt(1000000300) });

		const [a, b] = await Promise.all([
			alice.exec("git push origin main", { cwd: "/local", env: envAt(1000000200) }),
			bob.exec("git push origin main", { cwd: "/local", env: envAt(1000000300) }),
		]);

		const exits = [a.exitCode, b.exitCode].sort();
		expect(exits).toEqual([0, 1]);

		const failed = a.exitCode === 1 ? a : b;
		expect(failed.stderr).toContain("rejected");
	});

	test("concurrent pushes to different refs both succeed", async () => {
		const alice = createServerClient();
		const bob = createServerClient();

		await alice.exec(`git clone http://localhost:${port}/repo /local`, { env: envAt(1000000400) });
		await bob.exec(`git clone http://localhost:${port}/repo /local`, { env: envAt(1000000400) });

		await alice.exec("git checkout -b feat-a", { cwd: "/local", env: envAt(1000000500) });
		await alice.writeFile("/local/a.txt", "a");
		await alice.exec("git add .", { cwd: "/local" });
		await alice.exec('git commit -m "feat-a"', { cwd: "/local", env: envAt(1000000500) });

		await bob.exec("git checkout -b feat-b", { cwd: "/local", env: envAt(1000000600) });
		await bob.writeFile("/local/b.txt", "b");
		await bob.exec("git add .", { cwd: "/local" });
		await bob.exec('git commit -m "feat-b"', { cwd: "/local", env: envAt(1000000600) });

		const [a, b] = await Promise.all([
			alice.exec("git push origin feat-a", { cwd: "/local", env: envAt(1000000500) }),
			bob.exec("git push origin feat-b", { cwd: "/local", env: envAt(1000000600) }),
		]);

		expect(a.exitCode).toBe(0);
		expect(b.exitCode).toBe(0);
	});
});

// ── Concurrent pushes to an SQLite-backed server ─────────────────────

describe("concurrent push safety (SQLite-backed server)", () => {
	let srv: ReturnType<typeof Bun.serve>;
	let db: Database;
	let storage: Storage;
	let port: number;

	beforeAll(async () => {
		db = new Database(":memory:");
		storage = createStorage(new BunSqliteDriver(db));

		const seedRepo = await storage.createRepo("test");

		const seedFs = new InMemoryFs();
		const seedGit = createGit();
		const seedBash = new Bash({ fs: seedFs, cwd: "/repo", customCommands: [seedGit] });
		await seedBash.writeFile("/repo/README.md", "# Hello");
		await seedBash.exec("git init");
		await seedBash.exec("git add .");
		await seedBash.exec('git commit -m "initial"', { env: envAt(1000000000) });

		const seedCtx = await findRepo(seedFs, "/repo");
		if (!seedCtx) throw new Error("failed to set up seed repo");

		const seedGitForPush = createGit({
			resolveRemote: () => seedRepo,
		});
		const pushBash = new Bash({ fs: seedFs, cwd: "/repo", customCommands: [seedGitForPush] });
		await pushBash.exec("git remote add origin sqlite://test");
		await pushBash.exec("git push origin main", { env: envAt(1000000000) });

		const s = startServer({
			resolveRepo: async (path) => (await storage.repo(path))!,
		});
		srv = s.srv;
		port = s.port;
	});

	afterAll(() => {
		srv?.stop();
		db?.close();
	});

	test("concurrent HTTP pushes to same SQLite ref — CAS rejects loser", async () => {
		const alice = createServerClient();
		const bob = createServerClient();

		await alice.exec(`git clone http://localhost:${port}/test /local`, { env: envAt(1000000100) });
		await bob.exec(`git clone http://localhost:${port}/test /local`, { env: envAt(1000000100) });

		await alice.writeFile("/local/alice.txt", "alice");
		await alice.exec("git add .", { cwd: "/local" });
		await alice.exec('git commit -m "alice"', { cwd: "/local", env: envAt(1000000200) });

		await bob.writeFile("/local/bob.txt", "bob");
		await bob.exec("git add .", { cwd: "/local" });
		await bob.exec('git commit -m "bob"', { cwd: "/local", env: envAt(1000000300) });

		const [a, b] = await Promise.all([
			alice.exec("git push origin main", { cwd: "/local", env: envAt(1000000200) }),
			bob.exec("git push origin main", { cwd: "/local", env: envAt(1000000300) }),
		]);

		const exits = [a.exitCode, b.exitCode].sort();
		expect(exits).toEqual([0, 1]);

		const failed = a.exitCode === 1 ? a : b;
		expect(failed.stderr).toContain("rejected");
	});
});

// ── Cross-path: LocalTransport push + HTTP push ─────────────────────

describe("cross-path push safety (resolveRemote + HTTP)", () => {
	let srv: ReturnType<typeof Bun.serve>;
	let db: Database;
	let storage: Storage;
	let port: number;

	beforeAll(async () => {
		db = new Database(":memory:");
		storage = createStorage(new BunSqliteDriver(db));

		const seedRepo = await storage.createRepo("shared");

		const seedFs = new InMemoryFs();
		const seedGit = createGit();
		const seedBash = new Bash({ fs: seedFs, cwd: "/repo", customCommands: [seedGit] });
		await seedBash.writeFile("/repo/README.md", "# Shared");
		await seedBash.exec("git init");
		await seedBash.exec("git add .");
		await seedBash.exec('git commit -m "initial"', { env: envAt(1000000000) });

		const seedPushGit = createGit({ resolveRemote: () => seedRepo });
		const pushBash = new Bash({ fs: seedFs, cwd: "/repo", customCommands: [seedPushGit] });
		await pushBash.exec("git remote add origin sqlite://shared");
		await pushBash.exec("git push origin main", { env: envAt(1000000000) });

		const s = startServer({
			resolveRepo: async (path) => (await storage.repo(path))!,
		});
		srv = s.srv;
		port = s.port;
	});

	afterAll(() => {
		srv?.stop();
		db?.close();
	});

	test("resolveRemote push + HTTP push to same ref — one rejected", async () => {
		const agentFs = new InMemoryFs();
		const agentGit = createGit({
			resolveRemote: () => storage.repo("shared"),
		});
		const agent = new Bash({ fs: agentFs, cwd: "/", customCommands: [agentGit] });
		await agent.exec(`git clone http://localhost:${port}/shared /local`, {
			env: envAt(1000000100),
		});
		await agent.exec("git remote set-url origin local://shared", { cwd: "/local" });

		await agent.writeFile("/local/agent.txt", "from agent");
		await agent.exec("git add .", { cwd: "/local" });
		await agent.exec('git commit -m "agent"', { cwd: "/local", env: envAt(1000000200) });

		const httpClient = createServerClient();
		await httpClient.exec(`git clone http://localhost:${port}/shared /local`, {
			env: envAt(1000000100),
		});

		await httpClient.writeFile("/local/http.txt", "from http");
		await httpClient.exec("git add .", { cwd: "/local" });
		await httpClient.exec('git commit -m "http"', { cwd: "/local", env: envAt(1000000300) });

		const [agentResult, httpResult] = await Promise.all([
			agent.exec("git push origin main", { cwd: "/local", env: envAt(1000000200) }),
			httpClient.exec("git push origin main", { cwd: "/local", env: envAt(1000000300) }),
		]);

		const exits = [agentResult.exitCode, httpResult.exitCode].sort();
		expect(exits).toEqual([0, 1]);
	});
});
