import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Bash, InMemoryFs } from "just-bash";
import { createGit } from "../../src/index.ts";
import { PackedObjectStore } from "../../src/lib/object-store.ts";
import { FileSystemRefStore } from "../../src/lib/refs.ts";
import { findGitDir } from "../../src/lib/repo.ts";
import { createGitServer } from "../../src/server/handler.ts";
import type { ServerRepoContext } from "../../src/server/types.ts";

const TEST_ENV = {
	GIT_AUTHOR_NAME: "Test",
	GIT_AUTHOR_EMAIL: "test@test.com",
	GIT_COMMITTER_NAME: "Test",
	GIT_COMMITTER_EMAIL: "test@test.com",
	GIT_AUTHOR_DATE: "1000000000",
	GIT_COMMITTER_DATE: "1000000000",
};

function envAt(ts: number) {
	return { ...TEST_ENV, GIT_AUTHOR_DATE: String(ts), GIT_COMMITTER_DATE: String(ts) };
}

describe("server roundtrip", () => {
	let srv: ReturnType<typeof Bun.serve>;
	let serverFs: InMemoryFs;
	let serverBash: Bash;
	let serverRepo: ServerRepoContext;
	let port: number;

	beforeAll(async () => {
		// Set up a server-side repo with some commits and a tag
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

		// Create feature branch
		await serverBash.exec("git branch feature");

		// Build the storage backends from the server's VFS
		const ctx = await findGitDir(serverFs, "/repo");
		if (!ctx) throw new Error("failed to find git dir");

		serverRepo = {
			objects: new PackedObjectStore(ctx.fs, ctx.gitDir),
			refs: new FileSystemRefStore(ctx.fs, ctx.gitDir),
		};

		// Start the HTTP server
		const server = createGitServer({
			resolve: async () => serverRepo,
		});

		srv = Bun.serve({
			fetch: (req) => server.handle(req),
			port: 0,
		});
		port = srv.port;
	});

	afterAll(() => {
		srv?.stop();
	});

	test("clone from server", async () => {
		const clientFs = new InMemoryFs();
		const git = createGit();
		const client = new Bash({
			fs: clientFs,
			cwd: "/",
			customCommands: [git],
		});

		const result = await client.exec(`git clone http://localhost:${port}/repo /local`, {
			env: envAt(1000000200),
		});
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain("Cloning into");

		// Verify files were checked out
		const readme = await clientFs.readFile("/local/README.md");
		expect(readme).toBe("# Hello World");

		const main = await clientFs.readFile("/local/src/main.ts");
		expect(main).toBe('console.log("hello");');

		const util = await clientFs.readFile("/local/src/util.ts");
		expect(util).toBe("export const VERSION = 1;");

		// Verify HEAD points to main
		const head = await clientFs.readFile("/local/.git/HEAD");
		expect(head.trim()).toBe("ref: refs/heads/main");

		// Verify remote tracking refs exist
		const originMain = await clientFs.readFile("/local/.git/refs/remotes/origin/main");
		expect(originMain.trim()).toMatch(/^[0-9a-f]{40}$/);

		// Verify the remote URL was configured
		const config = await clientFs.readFile("/local/.git/config");
		expect(config).toContain(`http://localhost:${port}/repo`);

		// Verify tags were fetched
		expect(await clientFs.exists("/local/.git/refs/tags/v1.0")).toBe(true);
	});

	test("push to server", async () => {
		// Create a fresh clone
		const clientFs = new InMemoryFs();
		const git = createGit();
		const client = new Bash({
			fs: clientFs,
			cwd: "/",
			customCommands: [git],
		});

		await client.exec(`git clone http://localhost:${port}/repo /local`, {
			env: envAt(1000000300),
		});

		// Read the server's main ref before push
		const mainBefore = await serverRepo.refs.readRef("refs/heads/main");
		expect(mainBefore).not.toBeNull();
		const hashBefore = mainBefore!.type === "direct" ? mainBefore!.hash : null;

		// Create a new commit on the client
		await client.writeFile("/local/new-file.txt", "pushed content");
		await client.exec("git add .", { cwd: "/local" });
		await client.exec('git commit -m "push test"', {
			cwd: "/local",
			env: envAt(1000000400),
		});

		// Push to server
		const pushResult = await client.exec("git push origin main", { cwd: "/local" });
		expect(pushResult.exitCode).toBe(0);

		// Verify the server's main ref was updated
		const mainAfter = await serverRepo.refs.readRef("refs/heads/main");
		expect(mainAfter).not.toBeNull();
		const hashAfter = mainAfter!.type === "direct" ? mainAfter!.hash : null;
		expect(hashAfter).not.toBe(hashBefore);

		// Verify the pushed object exists in the server's store
		expect(hashAfter).toBeTruthy();
		const exists = await serverRepo.objects.exists(hashAfter!);
		expect(exists).toBe(true);
	});

	test("fetch from server after new server-side commit", async () => {
		// First clone
		const clientFs = new InMemoryFs();
		const git = createGit();
		const client = new Bash({
			fs: clientFs,
			cwd: "/",
			customCommands: [git],
		});

		await client.exec(`git clone http://localhost:${port}/repo /local`, {
			env: envAt(1000000500),
		});

		// Record the tracking ref before fetch
		const trackingBefore = await clientFs.readFile(
			"/local/.git/refs/remotes/origin/main",
		);

		// Create a new commit on the server
		await serverBash.writeFile("/repo/server-change.txt", "server side");
		await serverBash.exec("git add .");
		await serverBash.exec('git commit -m "server commit"', { env: envAt(1000000600) });

		// Fetch from the client
		const fetchResult = await client.exec("git fetch origin", { cwd: "/local" });
		expect(fetchResult.exitCode).toBe(0);

		// Verify tracking ref was updated
		const trackingAfter = await clientFs.readFile(
			"/local/.git/refs/remotes/origin/main",
		);
		expect(trackingAfter.trim()).not.toBe(trackingBefore.trim());

		// Verify we can see the new commit in the log
		const logResult = await client.exec("git log origin/main --oneline -3", {
			cwd: "/local",
		});
		expect(logResult.stdout).toContain("server commit");
	});

	test("push new branch to server", async () => {
		const clientFs = new InMemoryFs();
		const git = createGit();
		const client = new Bash({
			fs: clientFs,
			cwd: "/",
			customCommands: [git],
		});

		await client.exec(`git clone http://localhost:${port}/repo /local`, {
			env: envAt(1000000700),
		});

		// Create a new branch with a commit
		await client.exec("git checkout -b new-feature", { cwd: "/local" });
		await client.writeFile("/local/feature.txt", "new feature");
		await client.exec("git add .", { cwd: "/local" });
		await client.exec('git commit -m "feature work"', {
			cwd: "/local",
			env: envAt(1000000800),
		});

		// Push the new branch
		const pushResult = await client.exec("git push origin new-feature", { cwd: "/local" });
		expect(pushResult.exitCode).toBe(0);

		// Verify the server has the new branch
		const newBranch = await serverRepo.refs.readRef("refs/heads/new-feature");
		expect(newBranch).not.toBeNull();
		expect(newBranch!.type).toBe("direct");
	});

	test("delete remote branch via push", async () => {
		// First verify the branch exists
		const before = await serverRepo.refs.readRef("refs/heads/feature");
		expect(before).not.toBeNull();

		const clientFs = new InMemoryFs();
		const git = createGit();
		const client = new Bash({
			fs: clientFs,
			cwd: "/",
			customCommands: [git],
		});

		await client.exec(`git clone http://localhost:${port}/repo /local`, {
			env: envAt(1000000900),
		});

		// Delete the remote branch
		const deleteResult = await client.exec("git push origin --delete feature", {
			cwd: "/local",
		});
		expect(deleteResult.exitCode).toBe(0);

		// Verify the server no longer has the branch
		const after = await serverRepo.refs.readRef("refs/heads/feature");
		expect(after).toBeNull();
	});

	test("onPush hook is called", async () => {
		const pushEvents: Array<{ repoPath: string; count: number }> = [];

		const hookedServer = createGitServer({
			resolve: async () => serverRepo,
			onPush: async (repoPath, refUpdates) => {
				pushEvents.push({ repoPath, count: refUpdates.length });
			},
		});

		const hookedSrv = Bun.serve({
			fetch: (req) => hookedServer.handle(req),
			port: 0,
		});

		try {
			const clientFs = new InMemoryFs();
			const git = createGit();
			const client = new Bash({
				fs: clientFs,
				cwd: "/",
				customCommands: [git],
			});

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
			expect(pushEvents[0]!.repoPath).toBe("myrepo");
			expect(pushEvents[0]!.count).toBe(1);
		} finally {
			hookedSrv.stop();
		}
	});

	test("authorize hook blocks unauthorized push", async () => {
		const authServer = createGitServer({
			resolve: async () => serverRepo,
			authorize: async (_req, _repoPath, operation) => {
				if (operation === "receive-pack") {
					return { ok: false, status: 403, message: "Push not allowed" };
				}
				return { ok: true };
			},
		});

		const authSrv = Bun.serve({
			fetch: (req) => authServer.handle(req),
			port: 0,
		});

		try {
			const clientFs = new InMemoryFs();
			const git = createGit();
			const client = new Bash({
				fs: clientFs,
				cwd: "/",
				customCommands: [git],
			});

			// Clone should succeed (upload-pack is allowed)
			const cloneResult = await client.exec(
				`git clone http://localhost:${authSrv.port}/repo /local`,
				{ env: envAt(1000001200) },
			);
			expect(cloneResult.exitCode).toBe(0);

			// Push should fail
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
