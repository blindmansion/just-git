import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Bash, InMemoryFs } from "just-bash";
import { createGit } from "../../src/index.ts";
import { findRepo } from "../../src/lib/repo.ts";
import type { GitContext } from "../../src/lib/types.ts";
import { createGitServer } from "../../src/server/handler.ts";
import { envAt, createServerClient, startServer } from "./util.ts";

describe("server roundtrip", () => {
	let srv: ReturnType<typeof Bun.serve>;
	let serverFs: InMemoryFs;
	let serverBash: Bash;
	let serverRepo: GitContext;
	let port: number;

	beforeAll(async () => {
		serverFs = new InMemoryFs();
		const git = createGit();
		serverBash = new Bash({
			fs: serverFs,
			cwd: "/repo",
			customCommands: [git],
		});

		await serverBash.writeFile("/repo/README.md", "# Hello World");
		await serverBash.writeFile("/repo/src/main.ts", 'console.log("hello");');
		await serverBash.exec("git init");
		await serverBash.exec("git add .");
		await serverBash.exec('git commit -m "initial commit"', { env: envAt(1000000000) });

		await serverBash.writeFile("/repo/src/util.ts", "export const VERSION = 1;");
		await serverBash.exec("git add .");
		await serverBash.exec('git commit -m "add util"', { env: envAt(1000000100) });

		await serverBash.exec("git tag v1.0");
		await serverBash.exec('git tag -a v1.0-annotated -m "release v1.0"', {
			env: envAt(1000000100),
		});

		await serverBash.exec("git branch feature");

		const ctx = await findRepo(serverFs, "/repo");
		if (!ctx) throw new Error("failed to find git dir");
		serverRepo = ctx;

		const s = startServer({ resolveRepo: async () => serverRepo });
		srv = s.srv;
		port = s.port;
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

		const mainBefore = await serverRepo.refStore.readRef("refs/heads/main");
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

		const mainAfter = await serverRepo.refStore.readRef("refs/heads/main");
		expect(mainAfter).not.toBeNull();
		const hashAfter = mainAfter!.type === "direct" ? mainAfter!.hash : null;
		expect(hashAfter).not.toBe(hashBefore);

		expect(hashAfter).toBeTruthy();
		const exists = await serverRepo.objectStore.exists(hashAfter!);
		expect(exists).toBe(true);
	});

	test("fetch from server after new server-side commit", async () => {
		const client = createServerClient();
		const clientFs = client.fs as InMemoryFs;

		await client.exec(`git clone http://localhost:${port}/repo /local`, {
			env: envAt(1000000500),
		});

		const trackingBefore = await clientFs.readFile("/local/.git/refs/remotes/origin/main");

		await serverBash.writeFile("/repo/server-change.txt", "server side");
		await serverBash.exec("git add .");
		await serverBash.exec('git commit -m "server commit"', { env: envAt(1000000600) });

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

		const newBranch = await serverRepo.refStore.readRef("refs/heads/new-feature");
		expect(newBranch).not.toBeNull();
		expect(newBranch!.type).toBe("direct");
	});

	test("delete remote branch via push", async () => {
		const before = await serverRepo.refStore.readRef("refs/heads/feature");
		expect(before).not.toBeNull();

		const client = createServerClient();

		await client.exec(`git clone http://localhost:${port}/repo /local`, {
			env: envAt(1000000900),
		});

		const deleteResult = await client.exec("git push origin --delete feature", {
			cwd: "/local",
		});
		expect(deleteResult.exitCode).toBe(0);

		const after = await serverRepo.refStore.readRef("refs/heads/feature");
		expect(after).toBeNull();
	});

	test("postReceive hook is called with repoPath", async () => {
		const pushEvents: Array<{ refCount: number; repoPath: string }> = [];

		const hookedServer = createGitServer({
			resolveRepo: async () => serverRepo,
			hooks: {
				postReceive: async (event) => {
					pushEvents.push({ refCount: event.updates.length, repoPath: event.repoPath });
				},
			},
		});

		const hookedSrv = Bun.serve({
			fetch: hookedServer.fetch,
			port: 0,
		});

		try {
			const client = createServerClient();

			await client.exec(`git clone http://localhost:${hookedSrv.port}/myrepo /local`, {
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
			expect(pushEvents[0]!.repoPath).toBe("myrepo");
		} finally {
			hookedSrv.stop();
		}
	});

	test("preReceive hook receives repoPath", async () => {
		let capturedRepoPath: string | undefined;

		const hookedServer = createGitServer({
			resolveRepo: async () => serverRepo,
			hooks: {
				preReceive: async (event) => {
					capturedRepoPath = event.repoPath;
				},
			},
		});

		const hookedSrv = Bun.serve({
			fetch: hookedServer.fetch,
			port: 0,
		});

		try {
			const client = createServerClient();

			await client.exec(`git clone http://localhost:${hookedSrv.port}/myrepo /local`, {
				env: envAt(1000001000),
			});

			await client.writeFile("/local/repopath-test.txt", "test");
			await client.exec("git add .", { cwd: "/local" });
			await client.exec('git commit -m "repopath test"', {
				cwd: "/local",
				env: envAt(1000001100),
			});

			await client.exec("git push origin main", { cwd: "/local" });

			expect(capturedRepoPath).toBe("myrepo");
		} finally {
			hookedSrv.stop();
		}
	});

	test("preReceive hook can reject a push", async () => {
		const authServer = createGitServer({
			resolveRepo: async () => serverRepo,
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
