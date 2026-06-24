import { describe, expect, test } from "bun:test";
import { createGit, MemoryFileSystem } from "../../src";
import { withCapabilities } from "../../src/lib/capabilities.ts";
import type { GitRepo } from "../../src/lib/types.ts";
import { readCommit } from "../../src/repo/reading.ts";
import { commit, createCommit, writeTree } from "../../src/repo/writing.ts";
import { MemoryStorage } from "../../src/store/memory-storage.ts";
import { createRepoStore } from "../../src/store/repo-store.ts";

const FIXED = new Date("2024-01-02T03:04:05Z");
const FIXED_SEC = Math.floor(FIXED.getTime() / 1000);
const now = () => FIXED;

const IDENTITY_ENV = {
	GIT_AUTHOR_NAME: "Alice",
	GIT_AUTHOR_EMAIL: "alice@example.com",
	GIT_COMMITTER_NAME: "Alice",
	GIT_COMMITTER_EMAIL: "alice@example.com",
};

describe("injected `now` capability — command path", () => {
	test("drives author/committer time when no GIT_*_DATE is set", async () => {
		const fs = new MemoryFileSystem();
		const git = createGit({ fs, cwd: "/repo", now });
		await git.exec("init", { env: IDENTITY_ENV });
		await fs.writeFile("/repo/file.txt", "hi\n");
		await git.exec("add -A", { env: IDENTITY_ENV });
		const c = await git.exec('commit -m "first"', { env: IDENTITY_ENV });
		expect(c.exitCode).toBe(0);

		const at = await git.exec("log -1 --format=%at", { env: IDENTITY_ENV });
		const ct = await git.exec("log -1 --format=%ct", { env: IDENTITY_ENV });
		expect(at.stdout.trim()).toBe(String(FIXED_SEC));
		expect(ct.stdout.trim()).toBe(String(FIXED_SEC));
	});

	test("GIT_AUTHOR_DATE still wins over the injected clock", async () => {
		const fs = new MemoryFileSystem();
		const git = createGit({ fs, cwd: "/repo", now });
		const env = { ...IDENTITY_ENV, GIT_AUTHOR_DATE: "1718454600" };
		await git.exec("init", { env });
		await fs.writeFile("/repo/file.txt", "hi\n");
		await git.exec("add -A", { env });
		await git.exec('commit -m "first"', { env });

		const at = await git.exec("log -1 --format=%at", { env });
		const ct = await git.exec("log -1 --format=%ct", { env });
		// Author date from env; committer falls back to the injected clock.
		expect(at.stdout.trim()).toBe("1718454600");
		expect(ct.stdout.trim()).toBe(String(FIXED_SEC));
	});
});

describe("injected `now` capability — SDK path", () => {
	async function freshRepo(caps?: GitRepo["capabilities"]): Promise<GitRepo> {
		return createRepoStore(new MemoryStorage(), { capabilities: caps }).createRepo("test");
	}

	test("commit() uses the clock for the default author/committer date", async () => {
		const repo = await freshRepo({ now });
		const hash = await commit(repo, {
			files: { "README.md": "# hi\n" },
			message: "init",
			author: { name: "Alice", email: "alice@example.com" },
			branch: "main",
		});
		const c = await readCommit(repo, hash);
		expect(c.author.timestamp).toBe(FIXED_SEC);
		expect(c.committer.timestamp).toBe(FIXED_SEC);
	});

	test("an explicit author.date overrides the clock", async () => {
		const repo = await freshRepo({ now });
		const explicit = new Date("2020-05-06T07:08:09Z");
		const hash = await commit(repo, {
			files: { "README.md": "# hi\n" },
			message: "init",
			author: { name: "Alice", email: "alice@example.com", date: explicit },
			branch: "main",
		});
		const c = await readCommit(repo, hash);
		expect(c.author.timestamp).toBe(Math.floor(explicit.getTime() / 1000));
	});

	test("withCapabilities attaches the clock to a bare handle", async () => {
		const bare = await freshRepo();
		const repo = withCapabilities(bare, { now });
		const tree = await writeTree(repo, []);
		const hash = await createCommit(repo, {
			tree,
			parents: [],
			author: { name: "Alice", email: "alice@example.com" },
			message: "root",
		});
		const c = await readCommit(repo, hash);
		expect(c.author.timestamp).toBe(FIXED_SEC);
		expect(c.committer.timestamp).toBe(FIXED_SEC);
	});
});
