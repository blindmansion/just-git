import { describe, expect, test } from "bun:test";
import { createGit, MemoryFileSystem } from "../src";
import { diffCommits, readFileAtCommit, resolveRef, walkCommitHistory } from "../src/repo";
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

	test("threads operator extensions onto returned context", async () => {
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
		expect(repo!.identityOverride).toEqual({
			name: "Agent",
			email: "agent@test.com",
			locked: true,
		});
		expect(repo!.hooks).toBeDefined();
		expect(repo!.hooks!.onRefUpdate).toBe(onRefUpdate);
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
