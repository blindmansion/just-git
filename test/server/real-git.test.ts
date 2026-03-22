import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { InMemoryFs } from "just-bash";
import { MemoryDriver } from "../../src/server/memory-storage.ts";
import type { GitServer } from "../../src/server/types.ts";
import {
	envAt,
	realGit,
	createRealGitHome,
	createSandbox,
	createServerClient,
	startServer,
} from "./util.ts";

describe("server with real git client", () => {
	let srv: ReturnType<typeof Bun.serve>;
	let server: GitServer;
	let driver: MemoryDriver;
	let port: number;
	let home: string;

	beforeAll(async () => {
		home = await createRealGitHome();

		driver = new MemoryDriver();
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
		await seedClient.exec("git push origin --tags", { cwd: "/local" });

		const repo = (await server.repo("repo"))!;
		const mainRef = await repo.refStore.readRef("refs/heads/main");
		const mainHash = mainRef!.type === "direct" ? mainRef!.hash : "";
		await repo.refStore.writeRef("refs/heads/feature", mainHash);
	});

	afterAll(async () => {
		srv?.stop();
		if (home) await rm(home, { recursive: true, force: true });
	});

	test("clone from server", async () => {
		const sandbox = await createSandbox("just-git-realclient-");
		try {
			const cloneDir = join(sandbox, "local");
			const result = await realGit(
				home,
				sandbox,
				`clone http://localhost:${port}/repo ${cloneDir}`,
			);
			expect(result.exitCode).toBe(0);

			expect(readFileSync(join(cloneDir, "README.md"), "utf8")).toBe("# Hello World");
			expect(readFileSync(join(cloneDir, "src/main.ts"), "utf8")).toBe('console.log("hello");');
			expect(readFileSync(join(cloneDir, "src/util.ts"), "utf8")).toBe("export const VERSION = 1;");

			const head = readFileSync(join(cloneDir, ".git/HEAD"), "utf8").trim();
			expect(head).toBe("ref: refs/heads/main");

			const tagResult = await realGit(home, cloneDir, "tag -l");
			expect(tagResult.stdout).toContain("v1.0");

			const branchResult = await realGit(home, cloneDir, "branch -r");
			expect(branchResult.stdout).toContain("origin/main");
		} finally {
			await rm(sandbox, { recursive: true, force: true });
		}
	});

	test("push to server", async () => {
		const sandbox = await createSandbox("just-git-realclient-");
		try {
			const cloneDir = join(sandbox, "local");
			await realGit(home, sandbox, `clone http://localhost:${port}/repo ${cloneDir}`);

			const repo = (await server.repo("repo"))!;
			const mainBefore = await repo.refStore.readRef("refs/heads/main");
			const hashBefore = mainBefore?.type === "direct" ? mainBefore.hash : null;

			writeFileSync(join(cloneDir, "pushed.txt"), "from real git");
			await realGit(home, cloneDir, "add .");
			await realGit(home, cloneDir, 'commit -m "push from real git"');

			const pushResult = await realGit(home, cloneDir, "push origin main");
			expect(pushResult.exitCode).toBe(0);

			const mainAfter = await repo.refStore.readRef("refs/heads/main");
			const hashAfter = mainAfter?.type === "direct" ? mainAfter.hash : null;
			expect(hashAfter).not.toBe(hashBefore);
			expect(hashAfter).toBeTruthy();
			expect(await repo.objectStore.exists(hashAfter!)).toBe(true);
		} finally {
			await rm(sandbox, { recursive: true, force: true });
		}
	});

	test("fetch from server after new server-side commit", async () => {
		const sandbox = await createSandbox("just-git-realclient-");
		try {
			const cloneDir = join(sandbox, "local");
			await realGit(home, sandbox, `clone http://localhost:${port}/repo ${cloneDir}`);

			const trackingBefore = await realGit(home, cloneDir, "rev-parse origin/main");

			const pusher = createServerClient();
			await pusher.exec(`git clone http://localhost:${port}/repo /push-local`, {
				env: envAt(1000000950),
			});
			await pusher.writeFile("/push-local/server-change.txt", "from server");
			await pusher.exec("git add .", { cwd: "/push-local" });
			await pusher.exec('git commit -m "server commit for real-git"', {
				cwd: "/push-local",
				env: envAt(1000001000),
			});
			await pusher.exec("git push origin main", { cwd: "/push-local" });

			const fetchResult = await realGit(home, cloneDir, "fetch origin");
			expect(fetchResult.exitCode).toBe(0);

			const trackingAfter = await realGit(home, cloneDir, "rev-parse origin/main");
			expect(trackingAfter.stdout.trim()).not.toBe(trackingBefore.stdout.trim());

			const logResult = await realGit(home, cloneDir, "log origin/main --oneline -3");
			expect(logResult.stdout).toContain("server commit for real-git");
		} finally {
			await rm(sandbox, { recursive: true, force: true });
		}
	});

	test("push new branch to server", async () => {
		const sandbox = await createSandbox("just-git-realclient-");
		try {
			const cloneDir = join(sandbox, "local");
			await realGit(home, sandbox, `clone http://localhost:${port}/repo ${cloneDir}`);

			await realGit(home, cloneDir, "checkout -b real-git-branch");
			writeFileSync(join(cloneDir, "branch-file.txt"), "branch content");
			await realGit(home, cloneDir, "add .");
			await realGit(home, cloneDir, 'commit -m "new branch from real git"');

			const pushResult = await realGit(home, cloneDir, "push origin real-git-branch");
			expect(pushResult.exitCode).toBe(0);

			const repo = (await server.repo("repo"))!;
			const newBranch = await repo.refStore.readRef("refs/heads/real-git-branch");
			expect(newBranch).not.toBeNull();
			expect(newBranch!.type).toBe("direct");
		} finally {
			await rm(sandbox, { recursive: true, force: true });
		}
	});

	test("delete remote branch via push", async () => {
		const repo = (await server.repo("repo"))!;
		const before = await repo.refStore.readRef("refs/heads/feature");
		expect(before).not.toBeNull();

		const sandbox = await createSandbox("just-git-realclient-");
		try {
			const cloneDir = join(sandbox, "local");
			await realGit(home, sandbox, `clone http://localhost:${port}/repo ${cloneDir}`);

			const deleteResult = await realGit(home, cloneDir, "push origin --delete feature");
			expect(deleteResult.exitCode).toBe(0);

			const after = await repo.refStore.readRef("refs/heads/feature");
			expect(after).toBeNull();
		} finally {
			await rm(sandbox, { recursive: true, force: true });
		}
	});

	test("just-git client can fetch after real git pushes", async () => {
		const sandbox = await createSandbox("just-git-realclient-");
		try {
			const jgClient = createServerClient();
			const clientFs = jgClient.fs as InMemoryFs;

			await jgClient.exec(`git clone http://localhost:${port}/repo /local`, {
				env: envAt(1000002000),
			});

			const trackingBefore = await clientFs.readFile("/local/.git/refs/remotes/origin/main");

			const cloneDir = join(sandbox, "local");
			await realGit(home, sandbox, `clone http://localhost:${port}/repo ${cloneDir}`);
			writeFileSync(join(cloneDir, "cross-test.txt"), "real git wrote this");
			await realGit(home, cloneDir, "add .");
			await realGit(home, cloneDir, 'commit -m "cross-pollination commit"');
			const pushResult = await realGit(home, cloneDir, "push origin main");
			expect(pushResult.exitCode).toBe(0);

			const fetchResult = await jgClient.exec("git fetch origin", { cwd: "/local" });
			expect(fetchResult.exitCode).toBe(0);

			const trackingAfter = await clientFs.readFile("/local/.git/refs/remotes/origin/main");
			expect(trackingAfter.trim()).not.toBe(trackingBefore.trim());

			const logResult = await jgClient.exec("git log origin/main --oneline -3", {
				cwd: "/local",
			});
			expect(logResult.stdout).toContain("cross-pollination commit");
		} finally {
			await rm(sandbox, { recursive: true, force: true });
		}
	});

	test("real git can fetch after just-git pushes", async () => {
		const sandbox = await createSandbox("just-git-realclient-");
		try {
			const cloneDir = join(sandbox, "local");
			await realGit(home, sandbox, `clone http://localhost:${port}/repo ${cloneDir}`);
			const trackingBefore = await realGit(home, cloneDir, "rev-parse origin/main");

			const jgClient = createServerClient();

			await jgClient.exec(`git clone http://localhost:${port}/repo /jg-local`, {
				env: envAt(1000003000),
			});
			await jgClient.writeFile("/jg-local/jg-pushed.txt", "just-git wrote this");
			await jgClient.exec("git add .", { cwd: "/jg-local" });
			await jgClient.exec('git commit -m "just-git push for cross test"', {
				cwd: "/jg-local",
				env: envAt(1000003100),
			});
			const pushResult = await jgClient.exec("git push origin main", { cwd: "/jg-local" });
			expect(pushResult.exitCode).toBe(0);

			const fetchResult = await realGit(home, cloneDir, "fetch origin");
			expect(fetchResult.exitCode).toBe(0);

			const trackingAfter = await realGit(home, cloneDir, "rev-parse origin/main");
			expect(trackingAfter.stdout.trim()).not.toBe(trackingBefore.stdout.trim());

			const logResult = await realGit(home, cloneDir, "log origin/main --oneline -3");
			expect(logResult.stdout).toContain("just-git push for cross test");
		} finally {
			await rm(sandbox, { recursive: true, force: true });
		}
	});
});
