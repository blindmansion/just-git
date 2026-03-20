import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Bash, InMemoryFs } from "just-bash";
import { createGit } from "../../src/index.ts";
import { BunSqliteStorage } from "../../src/server/bun-sqlite-storage.ts";
import {
	envAt,
	realGit,
	createRealGitHome,
	createSandbox,
	createServerClient,
	startServer,
} from "./util.ts";

describe("SQLite-backed server roundtrip", () => {
	let db: Database;
	let storage: BunSqliteStorage;
	let srv: ReturnType<typeof Bun.serve>;
	let port: number;
	let home: string;

	beforeAll(async () => {
		home = await createRealGitHome();
		db = new Database(":memory:");
		storage = new BunSqliteStorage(db);

		const s = startServer({
			resolveRepo: async (repoPath) => storage.repo(repoPath),
		});
		srv = s.srv;
		port = s.port;

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

		await seedBash.exec("git push origin v0.1");

		const repo = storage.repo("my-repo");
		await repo.refStore.writeRef("HEAD", { type: "symbolic", target: "refs/heads/main" });
	});

	afterAll(async () => {
		srv?.stop();
		if (home) await rm(home, { recursive: true, force: true });
	});

	test("just-git clone from SQLite-backed server", async () => {
		const client = createServerClient();
		const clientFs = client.fs as InMemoryFs;

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
		const sandbox = await createSandbox("just-git-sqlite-rt-");
		try {
			const cloneDir = join(sandbox, "local");
			const result = await realGit(
				home,
				sandbox,
				`clone http://localhost:${port}/my-repo ${cloneDir}`,
			);
			expect(result.exitCode).toBe(0);

			expect(readFileSync(join(cloneDir, "README.md"), "utf8")).toBe("# SQLite Test Repo");
			expect(readFileSync(join(cloneDir, "src/index.ts"), "utf8")).toBe("export const x = 1;");

			const head = readFileSync(join(cloneDir, ".git/HEAD"), "utf8").trim();
			expect(head).toBe("ref: refs/heads/main");

			const branchResult = await realGit(home, cloneDir, "branch -r");
			expect(branchResult.stdout).toContain("origin/main");
		} finally {
			await rm(sandbox, { recursive: true, force: true });
		}
	});

	test("real git push to SQLite-backed server", async () => {
		const sandbox = await createSandbox("just-git-sqlite-rt-");
		try {
			const cloneDir = join(sandbox, "local");
			await realGit(home, sandbox, `clone http://localhost:${port}/my-repo ${cloneDir}`);

			const repo = storage.repo("my-repo");
			const mainBefore = await repo.refStore.readRef("refs/heads/main");
			const hashBefore = mainBefore?.type === "direct" ? mainBefore.hash : null;

			writeFileSync(join(cloneDir, "new-file.txt"), "pushed from real git");
			await realGit(home, cloneDir, "add .");
			await realGit(home, cloneDir, 'commit -m "real git push"');

			const pushResult = await realGit(home, cloneDir, "push origin main");
			expect(pushResult.exitCode).toBe(0);

			const mainAfter = await repo.refStore.readRef("refs/heads/main");
			const hashAfter = mainAfter?.type === "direct" ? mainAfter.hash : null;
			expect(hashAfter).not.toBe(hashBefore);
			expect(await repo.objectStore.exists(hashAfter!)).toBe(true);
		} finally {
			await rm(sandbox, { recursive: true, force: true });
		}
	});

	test("just-git fetch after real git push", async () => {
		const sandbox = await createSandbox("just-git-sqlite-rt-");
		try {
			const client = createServerClient();
			const clientFs = client.fs as InMemoryFs;
			await client.exec(`git clone http://localhost:${port}/my-repo /local`, {
				env: envAt(1000001000),
			});

			const trackingBefore = await clientFs.readFile("/local/.git/refs/remotes/origin/main");

			const cloneDir = join(sandbox, "local");
			await realGit(home, sandbox, `clone http://localhost:${port}/my-repo ${cloneDir}`);
			writeFileSync(join(cloneDir, "cross.txt"), "cross-stack data");
			await realGit(home, cloneDir, "add .");
			await realGit(home, cloneDir, 'commit -m "sqlite cross-stack"');
			const pushResult = await realGit(home, cloneDir, "push origin main");
			expect(pushResult.exitCode).toBe(0);

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
		const sandbox = await createSandbox("just-git-sqlite-rt-");
		try {
			const cloneDir = join(sandbox, "local");
			await realGit(home, sandbox, `clone http://localhost:${port}/my-repo ${cloneDir}`);

			await realGit(home, cloneDir, "checkout -b sqlite-feature");
			writeFileSync(join(cloneDir, "feature.txt"), "feature content");
			await realGit(home, cloneDir, "add .");
			await realGit(home, cloneDir, 'commit -m "feature on sqlite"');

			const pushResult = await realGit(home, cloneDir, "push origin sqlite-feature");
			expect(pushResult.exitCode).toBe(0);

			const repo = storage.repo("my-repo");
			const branchRef = await repo.refStore.readRef("refs/heads/sqlite-feature");
			expect(branchRef).not.toBeNull();

			const deleteResult = await realGit(home, cloneDir, "push origin --delete sqlite-feature");
			expect(deleteResult.exitCode).toBe(0);

			const afterDelete = await repo.refStore.readRef("refs/heads/sqlite-feature");
			expect(afterDelete).toBeNull();
		} finally {
			await rm(sandbox, { recursive: true, force: true });
		}
	});

	test("multiple repos in same database", async () => {
		const seedFs = new InMemoryFs();
		const seedGit = createGit();
		const seedBash = new Bash({ fs: seedFs, cwd: "/seed2", customCommands: [seedGit] });

		await seedBash.exec("git init");
		await seedBash.writeFile("/seed2/other.txt", "different repo");
		await seedBash.exec("git add .");
		await seedBash.exec('git commit -m "other repo init"', { env: envAt(1000002000) });
		await seedBash.exec(`git remote add origin http://localhost:${port}/other-repo`);
		await seedBash.exec("git push -u origin main");

		const client1 = createServerClient();
		const client1Fs = client1.fs as InMemoryFs;
		const clone1 = await client1.exec(`git clone http://localhost:${port}/my-repo /r1`, {
			env: envAt(1000002100),
		});
		expect(clone1.exitCode).toBe(0);
		expect(await client1Fs.readFile("/r1/README.md")).toBe("# SQLite Test Repo");

		const client2 = createServerClient();
		const client2Fs = client2.fs as InMemoryFs;
		const clone2 = await client2.exec(`git clone http://localhost:${port}/other-repo /r2`, {
			env: envAt(1000002200),
		});
		expect(clone2.exitCode).toBe(0);
		expect(await client2Fs.readFile("/r2/other.txt")).toBe("different repo");

		expect(await client1Fs.exists("/r1/other.txt")).toBe(false);
		expect(await client2Fs.exists("/r2/README.md")).toBe(false);
	});
});
