import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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

async function realGit(cwd: string, command: string, extraEnv?: Record<string, string>) {
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/local/bin",
		HOME: realGitHome,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_PROTOCOL_VERSION: "1",
		GIT_AUTHOR_NAME: "Real Git",
		GIT_AUTHOR_EMAIL: "real@test.com",
		GIT_COMMITTER_NAME: "Real Git",
		GIT_COMMITTER_EMAIL: "real@test.com",
		...extraEnv,
	};
	const proc = Bun.spawn(["sh", "-c", `git ${command}`], {
		cwd,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, exitCode };
}

let realGitHome: string;

describe("server with real git client", () => {
	let srv: ReturnType<typeof Bun.serve>;
	let serverFs: InMemoryFs;
	let serverBash: Bash;
	let serverRepo: ServerRepoContext;
	let port: number;

	beforeAll(async () => {
		realGitHome = await mkdtemp(join(tmpdir(), "just-git-server-home-"));

		serverFs = new InMemoryFs();
		const git = createGit();
		serverBash = new Bash({ fs: serverFs, cwd: "/repo", customCommands: [git] });

		await serverBash.writeFile("/repo/README.md", "# Hello World");
		await serverBash.writeFile("/repo/src/main.ts", 'console.log("hello");');
		await serverBash.exec("git init");
		await serverBash.exec("git add .");
		await serverBash.exec('git commit -m "initial commit"', { env: envAt(1000000000) });

		await serverBash.writeFile("/repo/src/util.ts", "export const VERSION = 1;");
		await serverBash.exec("git add .");
		await serverBash.exec('git commit -m "add util"', { env: envAt(1000000100) });

		await serverBash.exec("git tag v1.0");
		await serverBash.exec("git branch feature");

		const ctx = await findGitDir(serverFs, "/repo");
		if (!ctx) throw new Error("failed to find git dir");

		serverRepo = {
			objects: new PackedObjectStore(ctx.fs, ctx.gitDir),
			refs: new FileSystemRefStore(ctx.fs, ctx.gitDir),
		};

		const server = createGitServer({ resolve: async () => serverRepo });
		srv = Bun.serve({ fetch: (req) => server.handle(req), port: 0 });
		port = srv.port!;
	});

	afterAll(async () => {
		srv?.stop();
		if (realGitHome) await rm(realGitHome, { recursive: true, force: true });
	});

	test("clone from server", async () => {
		const sandbox = await mkdtemp(join(tmpdir(), "just-git-realclient-"));
		try {
			const cloneDir = join(sandbox, "local");
			const result = await realGit(sandbox, `clone http://localhost:${port}/repo ${cloneDir}`);
			expect(result.exitCode).toBe(0);

			expect(readFileSync(join(cloneDir, "README.md"), "utf8")).toBe("# Hello World");
			expect(readFileSync(join(cloneDir, "src/main.ts"), "utf8")).toBe('console.log("hello");');
			expect(readFileSync(join(cloneDir, "src/util.ts"), "utf8")).toBe("export const VERSION = 1;");

			const head = readFileSync(join(cloneDir, ".git/HEAD"), "utf8").trim();
			expect(head).toBe("ref: refs/heads/main");

			// Verify tag was fetched
			const tagResult = await realGit(cloneDir, "tag -l");
			expect(tagResult.stdout).toContain("v1.0");

			// Verify remote tracking
			const branchResult = await realGit(cloneDir, "branch -r");
			expect(branchResult.stdout).toContain("origin/main");
		} finally {
			await rm(sandbox, { recursive: true, force: true });
		}
	});

	test("push to server", async () => {
		const sandbox = await mkdtemp(join(tmpdir(), "just-git-realclient-"));
		try {
			const cloneDir = join(sandbox, "local");
			await realGit(sandbox, `clone http://localhost:${port}/repo ${cloneDir}`);

			const mainBefore = await serverRepo.refs.readRef("refs/heads/main");
			const hashBefore = mainBefore?.type === "direct" ? mainBefore.hash : null;

			writeFileSync(join(cloneDir, "pushed.txt"), "from real git");
			await realGit(cloneDir, "add .");
			await realGit(cloneDir, 'commit -m "push from real git"');

			const pushResult = await realGit(cloneDir, "push origin main");
			expect(pushResult.exitCode).toBe(0);

			const mainAfter = await serverRepo.refs.readRef("refs/heads/main");
			const hashAfter = mainAfter?.type === "direct" ? mainAfter.hash : null;
			expect(hashAfter).not.toBe(hashBefore);
			expect(hashAfter).toBeTruthy();
			expect(await serverRepo.objects.exists(hashAfter!)).toBe(true);
		} finally {
			await rm(sandbox, { recursive: true, force: true });
		}
	});

	test("fetch from server after new server-side commit", async () => {
		const sandbox = await mkdtemp(join(tmpdir(), "just-git-realclient-"));
		try {
			const cloneDir = join(sandbox, "local");
			await realGit(sandbox, `clone http://localhost:${port}/repo ${cloneDir}`);

			const trackingBefore = await realGit(cloneDir, "rev-parse origin/main");

			await serverBash.writeFile("/repo/server-change.txt", "from server");
			await serverBash.exec("git add .");
			await serverBash.exec('git commit -m "server commit for real-git"', {
				env: envAt(1000001000),
			});

			const fetchResult = await realGit(cloneDir, "fetch origin");
			expect(fetchResult.exitCode).toBe(0);

			const trackingAfter = await realGit(cloneDir, "rev-parse origin/main");
			expect(trackingAfter.stdout.trim()).not.toBe(trackingBefore.stdout.trim());

			const logResult = await realGit(cloneDir, "log origin/main --oneline -3");
			expect(logResult.stdout).toContain("server commit for real-git");
		} finally {
			await rm(sandbox, { recursive: true, force: true });
		}
	});

	test("push new branch to server", async () => {
		const sandbox = await mkdtemp(join(tmpdir(), "just-git-realclient-"));
		try {
			const cloneDir = join(sandbox, "local");
			await realGit(sandbox, `clone http://localhost:${port}/repo ${cloneDir}`);

			await realGit(cloneDir, "checkout -b real-git-branch");
			writeFileSync(join(cloneDir, "branch-file.txt"), "branch content");
			await realGit(cloneDir, "add .");
			await realGit(cloneDir, 'commit -m "new branch from real git"');

			const pushResult = await realGit(cloneDir, "push origin real-git-branch");
			expect(pushResult.exitCode).toBe(0);

			const newBranch = await serverRepo.refs.readRef("refs/heads/real-git-branch");
			expect(newBranch).not.toBeNull();
			expect(newBranch!.type).toBe("direct");
		} finally {
			await rm(sandbox, { recursive: true, force: true });
		}
	});

	test("delete remote branch via push", async () => {
		const before = await serverRepo.refs.readRef("refs/heads/feature");
		expect(before).not.toBeNull();

		const sandbox = await mkdtemp(join(tmpdir(), "just-git-realclient-"));
		try {
			const cloneDir = join(sandbox, "local");
			await realGit(sandbox, `clone http://localhost:${port}/repo ${cloneDir}`);

			const deleteResult = await realGit(cloneDir, "push origin --delete feature");
			expect(deleteResult.exitCode).toBe(0);

			const after = await serverRepo.refs.readRef("refs/heads/feature");
			expect(after).toBeNull();
		} finally {
			await rm(sandbox, { recursive: true, force: true });
		}
	});

	test("just-git client can fetch after real git pushes", async () => {
		const sandbox = await mkdtemp(join(tmpdir(), "just-git-realclient-"));
		try {
			// Clone with just-git first
			const clientFs = new InMemoryFs();
			const jgGit = createGit();
			const jgClient = new Bash({ fs: clientFs, cwd: "/", customCommands: [jgGit] });

			await jgClient.exec(`git clone http://localhost:${port}/repo /local`, {
				env: envAt(1000002000),
			});

			const trackingBefore = await clientFs.readFile("/local/.git/refs/remotes/origin/main");

			// Push from real git
			const cloneDir = join(sandbox, "local");
			await realGit(sandbox, `clone http://localhost:${port}/repo ${cloneDir}`);
			writeFileSync(join(cloneDir, "cross-test.txt"), "real git wrote this");
			await realGit(cloneDir, "add .");
			await realGit(cloneDir, 'commit -m "cross-pollination commit"');
			const pushResult = await realGit(cloneDir, "push origin main");
			expect(pushResult.exitCode).toBe(0);

			// Fetch from just-git
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
		const sandbox = await mkdtemp(join(tmpdir(), "just-git-realclient-"));
		try {
			// Clone with real git first
			const cloneDir = join(sandbox, "local");
			await realGit(sandbox, `clone http://localhost:${port}/repo ${cloneDir}`);
			const trackingBefore = await realGit(cloneDir, "rev-parse origin/main");

			// Push from just-git
			const clientFs = new InMemoryFs();
			const jgGit = createGit();
			const jgClient = new Bash({ fs: clientFs, cwd: "/", customCommands: [jgGit] });

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

			// Fetch from real git
			const fetchResult = await realGit(cloneDir, "fetch origin");
			expect(fetchResult.exitCode).toBe(0);

			const trackingAfter = await realGit(cloneDir, "rev-parse origin/main");
			expect(trackingAfter.stdout.trim()).not.toBe(trackingBefore.stdout.trim());

			const logResult = await realGit(cloneDir, "log origin/main --oneline -3");
			expect(logResult.stdout).toContain("just-git push for cross test");
		} finally {
			await rm(sandbox, { recursive: true, force: true });
		}
	});
});
