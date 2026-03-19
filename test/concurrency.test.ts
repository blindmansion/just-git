import { describe, expect, test } from "bun:test";
import { createGit, MemoryFileSystem } from "../src";

describe("command serialization", () => {
	function makeGitAndFs(files?: Record<string, string>) {
		const fs = new MemoryFileSystem(files);
		const git = createGit({ identity: { name: "Test", email: "test@test.com", locked: true } });
		return { fs, git };
	}

	test("concurrent git add stages all files", async () => {
		const { fs, git } = makeGitAndFs({
			"/repo/a.txt": "a",
			"/repo/b.txt": "b",
			"/repo/c.txt": "c",
		});

		await git.exec("git init", { fs, cwd: "/repo" });
		await git.exec("git add a.txt", { fs, cwd: "/repo" });
		await git.exec('git commit -m "initial"', { fs, cwd: "/repo" });

		await Promise.all([
			git.exec("git add b.txt", { fs, cwd: "/repo" }),
			git.exec("git add c.txt", { fs, cwd: "/repo" }),
		]);

		const r = await git.exec("git status --porcelain", { fs, cwd: "/repo" });
		const staged = r.stdout
			.trim()
			.split("\n")
			.filter((l: string) => l.startsWith("A "));
		expect(staged).toHaveLength(2);
		expect(staged.map((l: string) => l.trim().slice(2).trim()).sort()).toEqual(["b.txt", "c.txt"]);
	});

	test("concurrent git add with more files", async () => {
		const files: Record<string, string> = { "/repo/base.txt": "base" };
		for (let i = 0; i < 10; i++) files[`/repo/f${i}.txt`] = `content-${i}`;

		const { fs, git } = makeGitAndFs(files);
		await git.exec("git init", { fs, cwd: "/repo" });
		await git.exec("git add base.txt", { fs, cwd: "/repo" });
		await git.exec('git commit -m "initial"', { fs, cwd: "/repo" });

		await Promise.all(
			Array.from({ length: 10 }, (_, i) => git.exec(`git add f${i}.txt`, { fs, cwd: "/repo" })),
		);

		const r = await git.exec("git status --porcelain", { fs, cwd: "/repo" });
		const staged = r.stdout
			.trim()
			.split("\n")
			.filter((l: string) => l.startsWith("A "));
		expect(staged).toHaveLength(10);
	});

	test("concurrent add-then-commit chains serialize correctly", async () => {
		const { fs, git } = makeGitAndFs({ "/repo/a.txt": "a" });

		await git.exec("git init", { fs, cwd: "/repo" });
		await git.exec("git add .", { fs, cwd: "/repo" });
		await git.exec('git commit -m "initial"', { fs, cwd: "/repo" });

		await fs.writeFile("/repo/b.txt", "b");
		await fs.writeFile("/repo/c.txt", "c");

		// With per-command serialization, the adds run before the commits.
		// The first commit picks up both files; the second has nothing to commit.
		// This verifies no data corruption — not workflow isolation.
		const [r1, r2] = await Promise.all([
			(async () => {
				await git.exec("git add b.txt", { fs, cwd: "/repo" });
				return git.exec('git commit -m "add b"', { fs, cwd: "/repo" });
			})(),
			(async () => {
				await git.exec("git add c.txt", { fs, cwd: "/repo" });
				return git.exec('git commit -m "add c"', { fs, cwd: "/repo" });
			})(),
		]);

		// One commit succeeds with both files, the other gets "nothing to commit"
		const successes = [r1, r2].filter((r) => r.exitCode === 0);
		const nothings = [r1, r2].filter((r) => r.exitCode !== 0);
		expect(successes).toHaveLength(1);
		expect(nothings).toHaveLength(1);

		// Both files are tracked in the final state
		const log = await git.exec("git log --oneline", { fs, cwd: "/repo" });
		expect(log.stdout.trim().split("\n")).toHaveLength(2);

		const status = await git.exec("git status --porcelain", { fs, cwd: "/repo" });
		expect(status.stdout.trim()).toBe("");
	});

	test("different fs instances run independently", async () => {
		const git = createGit({ identity: { name: "Test", email: "test@test.com", locked: true } });
		const fs1 = new MemoryFileSystem({ "/repo/a.txt": "a" });
		const fs2 = new MemoryFileSystem({ "/repo/b.txt": "b" });

		const [r1, r2] = await Promise.all([
			git.exec("git init", { fs: fs1, cwd: "/repo" }),
			git.exec("git init", { fs: fs2, cwd: "/repo" }),
		]);

		expect(r1.exitCode).toBe(0);
		expect(r2.exitCode).toBe(0);
	});

	test("serialization preserves command order within chains", async () => {
		const { fs, git } = makeGitAndFs({
			"/repo/file.txt": "v1",
		});

		await git.exec("git init", { fs, cwd: "/repo" });
		await git.exec("git add .", { fs, cwd: "/repo" });
		await git.exec('git commit -m "v1"', { fs, cwd: "/repo" });

		await fs.writeFile("/repo/file.txt", "v2");
		await git.exec("git add .", { fs, cwd: "/repo" });
		await git.exec('git commit -m "v2"', { fs, cwd: "/repo" });

		await fs.writeFile("/repo/file.txt", "v3");
		await git.exec("git add .", { fs, cwd: "/repo" });
		await git.exec('git commit -m "v3"', { fs, cwd: "/repo" });

		const log = await git.exec("git log --oneline", { fs, cwd: "/repo" });
		const lines = log.stdout.trim().split("\n");
		expect(lines).toHaveLength(3);
		expect(lines[0]).toContain("v3");
		expect(lines[1]).toContain("v2");
		expect(lines[2]).toContain("v1");
	});

	test("lock does not deadlock on errors", async () => {
		const { fs, git } = makeGitAndFs();

		const r = await git.exec('git commit -m "no repo"', { fs, cwd: "/repo" });
		expect(r.exitCode).not.toBe(0);

		await git.exec("git init", { fs, cwd: "/repo" });
		const r2 = await git.exec("git status", { fs, cwd: "/repo" });
		expect(r2.exitCode).toBe(0);
	});
});
