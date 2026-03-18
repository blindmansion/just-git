import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Bash, InMemoryFs } from "just-bash";
import { createGit } from "../../src/index.ts";
import { findRepo } from "../../src/lib/repo.ts";
import { resolveRef } from "../../src/lib/refs.ts";
import { readCommit } from "../../src/lib/object-db.ts";
import { flattenTree } from "../../src/lib/tree-ops.ts";
import { SqliteStorage } from "../../src/server/sqlite-storage.ts";
import { createWorktree, readonlyRepo } from "../../src/repo/helpers.ts";

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

describe("hybrid worktree (VFS + SQLite stores)", () => {
	let db: Database;
	let storage: SqliteStorage;

	beforeAll(async () => {
		db = new Database(":memory:");
		storage = new SqliteStorage(db);

		const repo = storage.repo("test-repo");
		await repo.refStore.writeRef("HEAD", { type: "symbolic", target: "refs/heads/main" });

		const seedFs = new InMemoryFs();
		const seedGit = createGit();
		const seedBash = new Bash({ fs: seedFs, cwd: "/repo", customCommands: [seedGit] });
		await seedBash.writeFile("/repo/README.md", "# Hello World");
		await seedBash.writeFile("/repo/src/index.ts", 'console.log("hello");');
		await seedBash.exec("git init");
		await seedBash.exec("git add .");
		await seedBash.exec('git commit -m "initial commit"', { env: envAt(1000000000) });

		const seedCtx = await findRepo(seedFs, "/repo");
		if (!seedCtx) throw new Error("failed to find seed repo");
		const pushGit = createGit({ resolveRemote: () => repo });
		const pushBash = new Bash({ fs: seedFs, cwd: "/repo", customCommands: [pushGit] });
		await pushBash.exec("git remote add origin sqlite://test-repo");
		await pushBash.exec("git push origin main", { env: envAt(1000000000) });
	});

	afterAll(() => db?.close());

	test("createWorktree populates VFS with worktree files and index", async () => {
		const repo = storage.repo("test-repo");
		const fs = new InMemoryFs();

		const result = await createWorktree(repo, fs, { workTree: "/repo" });

		expect(result.filesWritten).toBe(2);
		expect(result.commitHash).toMatch(/^[0-9a-f]{40}$/);
		expect(result.treeHash).toMatch(/^[0-9a-f]{40}$/);

		expect(await fs.readFile("/repo/README.md")).toBe("# Hello World");
		expect(await fs.readFile("/repo/src/index.ts")).toBe('console.log("hello");');
		expect(await fs.exists("/repo/.git")).toBe(true);
	});

	test("agent commits through hybrid context — objects go to SQLite", async () => {
		const repo = storage.repo("test-repo");
		const fs = new InMemoryFs();

		await createWorktree(repo, fs, { workTree: "/repo" });

		const git = createGit({
			objectStore: repo.objectStore,
			refStore: repo.refStore,
		});
		const bash = new Bash({ fs, cwd: "/repo", customCommands: [git] });

		await bash.writeFile("/repo/new-file.txt", "created by agent");
		const addResult = await bash.exec("git add .");
		expect(addResult.exitCode).toBe(0);

		const commitResult = await bash.exec('git commit -m "agent commit"', {
			env: envAt(1000000100),
		});
		expect(commitResult.exitCode).toBe(0);

		const newHash = await resolveRef(repo, "refs/heads/main");
		expect(newHash).toBeTruthy();
		const commit = await readCommit(repo, newHash!);
		expect(commit.message).toBe("agent commit\n");

		const tree = await flattenTree(repo, commit.tree);
		const paths = tree.map((e) => e.path).sort();
		expect(paths).toEqual(["README.md", "new-file.txt", "src/index.ts"]);
	});

	test("git status works in hybrid context", async () => {
		const repo = storage.repo("test-repo");
		const fs = new InMemoryFs();

		await createWorktree(repo, fs, { workTree: "/repo" });

		const git = createGit({
			objectStore: repo.objectStore,
			refStore: repo.refStore,
		});
		const bash = new Bash({ fs, cwd: "/repo", customCommands: [git] });

		const cleanStatus = await bash.exec("git status");
		expect(cleanStatus.exitCode).toBe(0);
		expect(cleanStatus.stdout).toContain("nothing to commit");

		await bash.writeFile("/repo/dirty.txt", "uncommitted");
		const dirtyStatus = await bash.exec("git status");
		expect(dirtyStatus.exitCode).toBe(0);
		expect(dirtyStatus.stdout).toContain("dirty.txt");
	});

	test("git log works in hybrid context", async () => {
		const repo = storage.repo("test-repo");
		const fs = new InMemoryFs();

		await createWorktree(repo, fs, { workTree: "/repo" });

		const git = createGit({
			objectStore: repo.objectStore,
			refStore: repo.refStore,
		});
		const bash = new Bash({ fs, cwd: "/repo", customCommands: [git] });

		const log = await bash.exec("git log --oneline");
		expect(log.exitCode).toBe(0);
		expect(log.stdout).toContain("initial commit");
	});

	test("git diff works in hybrid context", async () => {
		const repo = storage.repo("test-repo");
		const fs = new InMemoryFs();

		await createWorktree(repo, fs, { workTree: "/repo" });

		const git = createGit({
			objectStore: repo.objectStore,
			refStore: repo.refStore,
		});
		const bash = new Bash({ fs, cwd: "/repo", customCommands: [git] });

		await bash.writeFile("/repo/README.md", "# Modified");
		const diff = await bash.exec("git diff");
		expect(diff.exitCode).toBe(0);
		expect(diff.stdout).toContain("-# Hello World");
		expect(diff.stdout).toContain("+# Modified");
	});

	test("two agents with separate VFS share the same SQLite store", async () => {
		const repo = storage.repo("test-repo");

		const fs1 = new InMemoryFs();
		await createWorktree(repo, fs1, { workTree: "/repo" });
		const git1 = createGit({
			objectStore: repo.objectStore,
			refStore: repo.refStore,
		});
		const agent1 = new Bash({ fs: fs1, cwd: "/repo", customCommands: [git1] });

		await agent1.writeFile("/repo/agent1.txt", "from agent 1");
		await agent1.exec("git add .");
		await agent1.exec('git commit -m "agent 1 commit"', { env: envAt(1000000200) });

		const hashAfterAgent1 = await resolveRef(repo, "refs/heads/main");
		expect(hashAfterAgent1).toBeTruthy();

		const fs2 = new InMemoryFs();
		await createWorktree(repo, fs2, { workTree: "/repo" });
		const git2 = createGit({
			objectStore: repo.objectStore,
			refStore: repo.refStore,
		});
		const agent2 = new Bash({ fs: fs2, cwd: "/repo", customCommands: [git2] });

		expect(await fs2.readFile("/repo/agent1.txt")).toBe("from agent 1");

		const log = await agent2.exec("git log --oneline");
		expect(log.exitCode).toBe(0);
		expect(log.stdout).toContain("agent 1 commit");
	});

	test("round-trip: checkout → edit → commit → fresh checkout sees changes", async () => {
		const repo = storage.repo("test-repo");

		const fs1 = new InMemoryFs();
		await createWorktree(repo, fs1, { workTree: "/repo" });
		const git1 = createGit({
			objectStore: repo.objectStore,
			refStore: repo.refStore,
		});
		const bash1 = new Bash({ fs: fs1, cwd: "/repo", customCommands: [git1] });

		await bash1.writeFile("/repo/src/index.ts", 'console.log("updated");');
		await bash1.exec("git add .");
		await bash1.exec('git commit -m "update index.ts"', { env: envAt(1000000300) });

		const fs2 = new InMemoryFs();
		const result = await createWorktree(repo, fs2, { workTree: "/repo" });

		expect(await fs2.readFile("/repo/src/index.ts")).toBe('console.log("updated");');

		const commit = await readCommit(repo, result.commitHash);
		expect(commit.message).toBe("update index.ts\n");
	});

	test("checkout by commit hash instead of ref", async () => {
		const repo = storage.repo("test-repo");
		const mainHash = await resolveRef(repo, "refs/heads/main");
		expect(mainHash).toBeTruthy();

		const fs = new InMemoryFs();
		const result = await createWorktree(repo, fs, {
			ref: mainHash!,
			workTree: "/repo",
		});

		expect(result.commitHash).toBe(mainHash!);
		expect(await fs.exists("/repo/README.md")).toBe(true);
	});

	test("checkout with custom workTree and gitDir paths", async () => {
		const repo = storage.repo("test-repo");
		const fs = new InMemoryFs();

		const result = await createWorktree(repo, fs, {
			workTree: "/workspace",
			gitDir: "/workspace/.git",
		});

		expect(result.ctx.workTree).toBe("/workspace");
		expect(result.ctx.gitDir).toBe("/workspace/.git");
		expect(await fs.readFile("/workspace/README.md")).toBeTruthy();
		expect(await fs.exists("/workspace/.git")).toBe(true);
	});

	test("agent can create branches in hybrid context", async () => {
		const repo = storage.repo("test-repo");
		const fs = new InMemoryFs();
		await createWorktree(repo, fs, { workTree: "/repo" });

		const git = createGit({
			objectStore: repo.objectStore,
			refStore: repo.refStore,
		});
		const bash = new Bash({ fs, cwd: "/repo", customCommands: [git] });

		const brResult = await bash.exec("git checkout -b feature-branch");
		expect(brResult.exitCode).toBe(0);

		await bash.writeFile("/repo/feature.txt", "feature work");
		await bash.exec("git add .");
		await bash.exec('git commit -m "feature commit"', { env: envAt(1000000400) });

		const featureHash = await resolveRef(repo, "refs/heads/feature-branch");
		expect(featureHash).toBeTruthy();

		const mainHash = await resolveRef(repo, "refs/heads/main");
		expect(mainHash).not.toBe(featureHash);
	});
});

describe("readonlyRepo", () => {
	let db: Database;
	let storage: SqliteStorage;

	beforeAll(async () => {
		db = new Database(":memory:");
		storage = new SqliteStorage(db);

		const repo = storage.repo("ro-test");
		await repo.refStore.writeRef("HEAD", { type: "symbolic", target: "refs/heads/main" });

		const seedFs = new InMemoryFs();
		const seedGit = createGit();
		const seedBash = new Bash({ fs: seedFs, cwd: "/repo", customCommands: [seedGit] });
		await seedBash.writeFile("/repo/README.md", "# Read Only");
		await seedBash.exec("git init");
		await seedBash.exec("git add .");
		await seedBash.exec('git commit -m "initial"', { env: envAt(1000000000) });

		const pushGit = createGit({ resolveRemote: () => repo });
		const pushBash = new Bash({ fs: seedFs, cwd: "/repo", customCommands: [pushGit] });
		await pushBash.exec("git remote add origin sqlite://ro-test");
		await pushBash.exec("git push origin main", { env: envAt(1000000000) });
	});

	afterAll(() => db?.close());

	test("createWorktree works with a readonly repo", async () => {
		const ro = readonlyRepo(storage.repo("ro-test"));
		const fs = new InMemoryFs();

		const result = await createWorktree(ro, fs, { workTree: "/repo" });
		expect(result.filesWritten).toBe(1);
		expect(await fs.readFile("/repo/README.md")).toBe("# Read Only");
	});

	test("git log and git status work in readonly context", async () => {
		const ro = readonlyRepo(storage.repo("ro-test"));
		const fs = new InMemoryFs();
		await createWorktree(ro, fs, { workTree: "/repo" });

		const git = createGit({
			objectStore: ro.objectStore,
			refStore: ro.refStore,
		});
		const bash = new Bash({ fs, cwd: "/repo", customCommands: [git] });

		const log = await bash.exec("git log --oneline");
		expect(log.exitCode).toBe(0);
		expect(log.stdout).toContain("initial");

		const status = await bash.exec("git status");
		expect(status.exitCode).toBe(0);
		expect(status.stdout).toContain("nothing to commit");
	});

	test("git add fails in readonly context", async () => {
		const ro = readonlyRepo(storage.repo("ro-test"));
		const fs = new InMemoryFs();
		await createWorktree(ro, fs, { workTree: "/repo" });

		const git = createGit({
			objectStore: ro.objectStore,
			refStore: ro.refStore,
		});
		const bash = new Bash({ fs, cwd: "/repo", customCommands: [git] });

		await bash.writeFile("/repo/new.txt", "hello");
		const result = await bash.exec("git add new.txt");
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("read-only");
	});

	test("git commit fails in readonly context", async () => {
		const ro = readonlyRepo(storage.repo("ro-test"));
		const fs = new InMemoryFs();
		await createWorktree(ro, fs, { workTree: "/repo" });

		const git = createGit({
			objectStore: ro.objectStore,
			refStore: ro.refStore,
		});
		const bash = new Bash({ fs, cwd: "/repo", customCommands: [git] });

		const result = await bash.exec('git commit --allow-empty -m "nope"', {
			env: envAt(1000000100),
		});
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("read-only");
	});

	test("git checkout -b fails in readonly context", async () => {
		const ro = readonlyRepo(storage.repo("ro-test"));
		const fs = new InMemoryFs();
		await createWorktree(ro, fs, { workTree: "/repo" });

		const git = createGit({
			objectStore: ro.objectStore,
			refStore: ro.refStore,
		});
		const bash = new Bash({ fs, cwd: "/repo", customCommands: [git] });

		const result = await bash.exec("git checkout -b new-branch");
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("read-only");
	});
});
