import { describe, expect, test } from "bun:test";
import { createGit, MemoryFileSystem } from "../src";
import { diffCommits, readFileAtCommit, resolveRef, walkCommitHistory } from "../src/repo";
import { findRepo, resolveGitDirFile } from "../src/lib/repo.ts";
import { TEST_ENV } from "./fixtures";

describe("Git.findRepo", () => {
	test("returns null before init", async () => {
		const fs = new MemoryFileSystem();
		const git = createGit({ fs, cwd: "/repo" });
		expect(await git.findRepo()).toBeNull();
	});

	test("discovers repo after init", async () => {
		const fs = new MemoryFileSystem();
		const git = createGit({ fs, cwd: "/repo" });
		await git.exec("init");

		const repo = await git.findRepo();
		expect(repo).not.toBeNull();
		expect(repo!.gitDir).toBe("/repo/.git");
		expect(repo!.workTree).toBe("/repo");
		// In a plain repo the private and common dirs coincide, but both must
		// be populated so subsystems can route shared vs per-worktree state.
		expect(repo!.commonDir).toBe("/repo/.git");
	});

	test("uses instance defaults for fs and cwd", async () => {
		const fs = new MemoryFileSystem();
		const git = createGit({ fs, cwd: "/repo" });
		await git.exec("init");

		const repo = await git.findRepo();
		expect(repo).not.toBeNull();
		expect(repo!.fs).toBe(fs);
	});

	test("per-call cwd override", async () => {
		const fs = new MemoryFileSystem();
		const git = createGit({ fs, cwd: "/repo" });
		await git.exec("init");
		await git.exec("init", { cwd: "/other" });

		const repo = await git.findRepo({ cwd: "/other" });
		expect(repo).not.toBeNull();
		expect(repo!.gitDir).toBe("/other/.git");
	});

	test("per-call fs override", async () => {
		const fs1 = new MemoryFileSystem();
		const fs2 = new MemoryFileSystem();
		const git = createGit({ fs: fs1, cwd: "/repo" });
		await git.exec("init");

		// fs2 has no repo
		expect(await git.findRepo({ fs: fs2 })).toBeNull();
		// fs1 still works
		expect(await git.findRepo()).not.toBeNull();
	});

	test("throws when no fs available", async () => {
		const git = createGit({ cwd: "/repo" });
		expect(git.findRepo()).rejects.toThrow("No filesystem");
	});

	test("threads operator capabilities onto returned context", async () => {
		const fs = new MemoryFileSystem();
		const onRefUpdate = () => {};
		const git = createGit({
			fs,
			cwd: "/repo",
			identity: { name: "Agent", email: "agent@test.com", locked: true },
			hooks: { onRefUpdate },
		});
		await git.exec("init");

		const repo = await git.findRepo();
		expect(repo).not.toBeNull();
		expect(repo!.capabilities?.identity).toEqual({
			name: "Agent",
			email: "agent@test.com",
			locked: true,
		});
		expect(repo!.capabilities?.hooks).toBeDefined();
		expect(repo!.capabilities!.hooks!.onRefUpdate).toBe(onRefUpdate);
	});

	test("works with repo SDK functions (CLIENT.md example)", async () => {
		const fs = new MemoryFileSystem();
		const git = createGit({ fs, cwd: "/repo" });

		await git.exec("init", { env: TEST_ENV });
		await fs.writeFile("/repo/README.md", "# Hello\n");
		await git.exec("add .", { env: TEST_ENV });
		await git.exec('commit -m "initial"', { env: TEST_ENV });

		const repo = await git.findRepo();
		expect(repo).not.toBeNull();

		const headHash = await resolveRef(repo!, "HEAD");
		expect(headHash).toBeString();
		expect(headHash).toHaveLength(40);

		const content = await readFileAtCommit(repo!, headHash!, "README.md");
		expect(content).toBe("# Hello\n");

		await fs.writeFile("/repo/README.md", "# Updated\n");
		await git.exec("add .", { env: TEST_ENV });
		await git.exec('commit -m "update"', { env: TEST_ENV });

		const newHead = await resolveRef(repo!, "HEAD");
		const diff = await diffCommits(repo!, headHash!, newHead!);
		expect(diff).toHaveLength(1);
		expect(diff[0].path).toBe("README.md");

		const history: string[] = [];
		for await (const info of walkCommitHistory(repo!, newHead!)) {
			history.push(info.message.trim());
		}
		expect(history).toEqual(["update", "initial"]);
	});
});

describe("findRepo with linked worktrees", () => {
	/** Lay out a main repo plus one linked worktree on a fresh memory fs. */
	async function seedWorktree(): Promise<MemoryFileSystem> {
		const fs = new MemoryFileSystem();
		await fs.mkdir("/repo/.git/worktrees/wt1", { recursive: true });
		await fs.writeFile("/repo/.git/HEAD", "ref: refs/heads/main\n");
		await fs.writeFile("/repo/.git/worktrees/wt1/commondir", "../..\n");
		await fs.writeFile("/repo/.git/worktrees/wt1/HEAD", "ref: refs/heads/wt\n");
		await fs.writeFile("/repo/.git/worktrees/wt1/gitdir", "/wt1/.git\n");
		await fs.mkdir("/wt1", { recursive: true });
		await fs.writeFile("/wt1/.git", "gitdir: /repo/.git/worktrees/wt1\n");
		return fs;
	}

	test("resolves the private gitDir and shared commonDir from a .git file", async () => {
		const fs = await seedWorktree();

		const ctx = await findRepo(fs, "/wt1");
		expect(ctx).not.toBeNull();
		expect({ gitDir: ctx!.gitDir, commonDir: ctx!.commonDir, workTree: ctx!.workTree }).toEqual({
			gitDir: "/repo/.git/worktrees/wt1",
			commonDir: "/repo/.git",
			workTree: "/wt1",
		});
	});

	test("a .git file with a dangling pointer is a hard stop (null, no walk-up)", async () => {
		const fs = new MemoryFileSystem();
		// A real repo sits at the root, so a walk-up would wrongly find it.
		await fs.mkdir("/.git", { recursive: true });
		await fs.writeFile("/.git/HEAD", "ref: refs/heads/main\n");
		await fs.mkdir("/wt", { recursive: true });
		await fs.writeFile("/wt/.git", "gitdir: /nonexistent/worktrees/x\n");

		expect(await findRepo(fs, "/wt")).toBeNull();
	});

	test("a .git file without a gitdir: prefix returns null", async () => {
		const fs = new MemoryFileSystem();
		await fs.mkdir("/wt", { recursive: true });
		await fs.writeFile("/wt/.git", "this is not a pointer\n");

		expect(await findRepo(fs, "/wt")).toBeNull();
	});
});

describe("resolveGitDirFile", () => {
	test("absolute pointer with commondir", async () => {
		const fs = new MemoryFileSystem();
		await fs.mkdir("/repo/.git/worktrees/wt1", { recursive: true });
		await fs.writeFile("/repo/.git/worktrees/wt1/commondir", "../..\n");
		await fs.mkdir("/wt1", { recursive: true });
		await fs.writeFile("/wt1/.git", "gitdir: /repo/.git/worktrees/wt1\n");

		expect(await resolveGitDirFile(fs, "/wt1/.git", "/wt1")).toEqual({
			gitDir: "/repo/.git/worktrees/wt1",
			commonDir: "/repo/.git",
		});
	});

	test("relative pointer resolves against the worktree", async () => {
		const fs = new MemoryFileSystem();
		await fs.mkdir("/repo/.git/worktrees/wt1", { recursive: true });
		await fs.writeFile("/repo/.git/worktrees/wt1/commondir", "../..\n");
		await fs.mkdir("/repo/wt1", { recursive: true });
		await fs.writeFile("/repo/wt1/.git", "gitdir: ../.git/worktrees/wt1\n");

		expect(await resolveGitDirFile(fs, "/repo/wt1/.git", "/repo/wt1")).toEqual({
			gitDir: "/repo/.git/worktrees/wt1",
			commonDir: "/repo/.git",
		});
	});

	test("missing commondir defaults commonDir to the gitDir", async () => {
		const fs = new MemoryFileSystem();
		await fs.mkdir("/private", { recursive: true });
		await fs.mkdir("/wt", { recursive: true });
		await fs.writeFile("/wt/.git", "gitdir: /private\n");

		expect(await resolveGitDirFile(fs, "/wt/.git", "/wt")).toEqual({
			gitDir: "/private",
			commonDir: "/private",
		});
	});

	test("dangling pointer returns null", async () => {
		const fs = new MemoryFileSystem();
		await fs.mkdir("/wt", { recursive: true });
		await fs.writeFile("/wt/.git", "gitdir: /nonexistent\n");

		expect(await resolveGitDirFile(fs, "/wt/.git", "/wt")).toBeNull();
	});

	test("missing gitdir: prefix returns null", async () => {
		const fs = new MemoryFileSystem();
		await fs.mkdir("/wt", { recursive: true });
		await fs.writeFile("/wt/.git", "garbage\n");

		expect(await resolveGitDirFile(fs, "/wt/.git", "/wt")).toBeNull();
	});
});
