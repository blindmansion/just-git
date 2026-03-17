import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Bash, InMemoryFs } from "just-bash";
import { createGit } from "../../src/index.ts";
import { createGitServer } from "../../src/server/handler.ts";
import { SqliteStorage } from "../../src/server/sqlite-storage.ts";

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

let realGitHome: string;

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

describe("SQLite-backed server roundtrip", () => {
	let db: Database;
	let storage: SqliteStorage;
	let srv: ReturnType<typeof Bun.serve>;
	let port: number;

	beforeAll(async () => {
		realGitHome = await mkdtemp(join(tmpdir(), "just-git-sqlite-home-"));
		db = new Database(":memory:");
		storage = new SqliteStorage(db);

		// Seed a repo by pushing from a just-git client
		const server = createGitServer({
			resolve: async (repoPath) => storage.repo(repoPath),
		});

		srv = Bun.serve({ fetch: (req) => server.handle(req), port: 0 });
		port = srv.port!;

		// Seed "my-repo" with initial content via just-git push
		const seedFs = new InMemoryFs();
		const seedGit = createGit();
		const seedBash = new Bash({ fs: seedFs, cwd: "/seed", customCommands: [seedGit] });

		await seedBash.exec("git init");
		await seedBash.writeFile("/seed/README.md", "# SQLite Test Repo");
		await seedBash.writeFile("/seed/src/index.ts", "export const x = 1;");
		await seedBash.exec("git add .");
		await seedBash.exec('git commit -m "initial commit"', { env: envAt(1000000000) });
		await seedBash.exec("git tag v0.1");
		await seedBash.writeFile("/seed/src/util.ts", "export const y = 2;");
		await seedBash.exec("git add .");
		await seedBash.exec('git commit -m "add util"', { env: envAt(1000000100) });
		await seedBash.exec(`git remote add origin http://localhost:${port}/my-repo`);
		const pushResult = await seedBash.exec("git push -u origin main");
		expect(pushResult.exitCode).toBe(0);

		// Also push the tag
		await seedBash.exec("git push origin v0.1");

		// Set up HEAD symref (push doesn't create it — real git needs it for checkout)
		const repo = storage.repo("my-repo");
		await repo.refs.writeRef("HEAD", { type: "symbolic", target: "refs/heads/main" });
	});

	afterAll(async () => {
		srv?.stop();
		if (realGitHome) await rm(realGitHome, { recursive: true, force: true });
	});

	test("just-git clone from SQLite-backed server", async () => {
		const clientFs = new InMemoryFs();
		const git = createGit();
		const client = new Bash({ fs: clientFs, cwd: "/", customCommands: [git] });

		const result = await client.exec(`git clone http://localhost:${port}/my-repo /local`, {
			env: envAt(1000000200),
		});
		expect(result.exitCode).toBe(0);

		expect(await clientFs.readFile("/local/README.md")).toBe("# SQLite Test Repo");
		expect(await clientFs.readFile("/local/src/index.ts")).toBe("export const x = 1;");
		expect(await clientFs.readFile("/local/src/util.ts")).toBe("export const y = 2;");

		const head = await clientFs.readFile("/local/.git/HEAD");
		expect(head.trim()).toBe("ref: refs/heads/main");
	});

	test("real git clone from SQLite-backed server", async () => {
		const sandbox = await mkdtemp(join(tmpdir(), "just-git-sqlite-rt-"));
		try {
			const cloneDir = join(sandbox, "local");
			const result = await realGit(sandbox, `clone http://localhost:${port}/my-repo ${cloneDir}`);
			expect(result.exitCode).toBe(0);

			expect(readFileSync(join(cloneDir, "README.md"), "utf8")).toBe("# SQLite Test Repo");
			expect(readFileSync(join(cloneDir, "src/index.ts"), "utf8")).toBe("export const x = 1;");

			const head = readFileSync(join(cloneDir, ".git/HEAD"), "utf8").trim();
			expect(head).toBe("ref: refs/heads/main");

			const branchResult = await realGit(cloneDir, "branch -r");
			expect(branchResult.stdout).toContain("origin/main");
		} finally {
			await rm(sandbox, { recursive: true, force: true });
		}
	});

	test("real git push to SQLite-backed server", async () => {
		const sandbox = await mkdtemp(join(tmpdir(), "just-git-sqlite-rt-"));
		try {
			const cloneDir = join(sandbox, "local");
			await realGit(sandbox, `clone http://localhost:${port}/my-repo ${cloneDir}`);

			const repo = storage.repo("my-repo");
			const mainBefore = await repo.refs.readRef("refs/heads/main");
			const hashBefore = mainBefore?.type === "direct" ? mainBefore.hash : null;

			writeFileSync(join(cloneDir, "new-file.txt"), "pushed from real git");
			await realGit(cloneDir, "add .");
			await realGit(cloneDir, 'commit -m "real git push"');

			const pushResult = await realGit(cloneDir, "push origin main");
			expect(pushResult.exitCode).toBe(0);

			const mainAfter = await repo.refs.readRef("refs/heads/main");
			const hashAfter = mainAfter?.type === "direct" ? mainAfter.hash : null;
			expect(hashAfter).not.toBe(hashBefore);
			expect(await repo.objects.exists(hashAfter!)).toBe(true);
		} finally {
			await rm(sandbox, { recursive: true, force: true });
		}
	});

	test("just-git fetch after real git push", async () => {
		const sandbox = await mkdtemp(join(tmpdir(), "just-git-sqlite-rt-"));
		try {
			// Clone with just-git
			const clientFs = new InMemoryFs();
			const git = createGit();
			const client = new Bash({ fs: clientFs, cwd: "/", customCommands: [git] });
			await client.exec(`git clone http://localhost:${port}/my-repo /local`, {
				env: envAt(1000001000),
			});

			const trackingBefore = await clientFs.readFile("/local/.git/refs/remotes/origin/main");

			// Push from real git
			const cloneDir = join(sandbox, "local");
			await realGit(sandbox, `clone http://localhost:${port}/my-repo ${cloneDir}`);
			writeFileSync(join(cloneDir, "cross.txt"), "cross-stack data");
			await realGit(cloneDir, "add .");
			await realGit(cloneDir, 'commit -m "sqlite cross-stack"');
			const pushResult = await realGit(cloneDir, "push origin main");
			expect(pushResult.exitCode).toBe(0);

			// Fetch from just-git
			const fetchResult = await client.exec("git fetch origin", { cwd: "/local" });
			expect(fetchResult.exitCode).toBe(0);

			const trackingAfter = await clientFs.readFile("/local/.git/refs/remotes/origin/main");
			expect(trackingAfter.trim()).not.toBe(trackingBefore.trim());

			const logResult = await client.exec("git log origin/main --oneline -3", {
				cwd: "/local",
			});
			expect(logResult.stdout).toContain("sqlite cross-stack");
		} finally {
			await rm(sandbox, { recursive: true, force: true });
		}
	});

	test("push new branch and delete it", async () => {
		const sandbox = await mkdtemp(join(tmpdir(), "just-git-sqlite-rt-"));
		try {
			const cloneDir = join(sandbox, "local");
			await realGit(sandbox, `clone http://localhost:${port}/my-repo ${cloneDir}`);

			await realGit(cloneDir, "checkout -b sqlite-feature");
			writeFileSync(join(cloneDir, "feature.txt"), "feature content");
			await realGit(cloneDir, "add .");
			await realGit(cloneDir, 'commit -m "feature on sqlite"');

			const pushResult = await realGit(cloneDir, "push origin sqlite-feature");
			expect(pushResult.exitCode).toBe(0);

			const repo = storage.repo("my-repo");
			const branchRef = await repo.refs.readRef("refs/heads/sqlite-feature");
			expect(branchRef).not.toBeNull();

			// Delete
			const deleteResult = await realGit(cloneDir, "push origin --delete sqlite-feature");
			expect(deleteResult.exitCode).toBe(0);

			const afterDelete = await repo.refs.readRef("refs/heads/sqlite-feature");
			expect(afterDelete).toBeNull();
		} finally {
			await rm(sandbox, { recursive: true, force: true });
		}
	});

	test("multiple repos in same database", async () => {
		// Seed a second repo
		const seedFs = new InMemoryFs();
		const seedGit = createGit();
		const seedBash = new Bash({ fs: seedFs, cwd: "/seed2", customCommands: [seedGit] });

		await seedBash.exec("git init");
		await seedBash.writeFile("/seed2/other.txt", "different repo");
		await seedBash.exec("git add .");
		await seedBash.exec('git commit -m "other repo init"', { env: envAt(1000002000) });
		await seedBash.exec(`git remote add origin http://localhost:${port}/other-repo`);
		await seedBash.exec("git push -u origin main");

		// Clone both repos and verify isolation
		const client1Fs = new InMemoryFs();
		const git1 = createGit();
		const client1 = new Bash({ fs: client1Fs, cwd: "/", customCommands: [git1] });
		const clone1 = await client1.exec(`git clone http://localhost:${port}/my-repo /r1`, {
			env: envAt(1000002100),
		});
		expect(clone1.exitCode).toBe(0);
		expect(await client1Fs.readFile("/r1/README.md")).toBe("# SQLite Test Repo");

		const client2Fs = new InMemoryFs();
		const git2 = createGit();
		const client2 = new Bash({ fs: client2Fs, cwd: "/", customCommands: [git2] });
		const clone2 = await client2.exec(`git clone http://localhost:${port}/other-repo /r2`, {
			env: envAt(1000002200),
		});
		expect(clone2.exitCode).toBe(0);
		expect(await client2Fs.readFile("/r2/other.txt")).toBe("different repo");

		// Verify repos don't bleed into each other
		expect(await client1Fs.exists("/r1/other.txt")).toBe(false);
		expect(await client2Fs.exists("/r2/README.md")).toBe(false);
	});
});
