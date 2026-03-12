import { describe, expect, test } from "bun:test";
import { pathExists, readFile, setupClonePair } from "../util";

describe("git push", () => {
	test("pushes current branch to remote", async () => {
		const bash = await setupClonePair();

		// Make a commit in the local repo
		await bash.exec(
			"cd /local && echo 'v2' > README.md && git add . && git commit -m 'local update'",
		);

		const result = await bash.exec("git push", { cwd: "/local" });
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain("To /remote");
	});

	test("updates remote ref after push", async () => {
		const bash = await setupClonePair();

		await bash.exec("cd /local && echo v2 > README.md && git add . && git commit -m update");

		const localLog = await bash.exec("cd /local && git log --oneline");
		await bash.exec("git push", { cwd: "/local" });
		const remoteLog = await bash.exec("cd /remote && git log --oneline");

		// Remote should have the same commits
		expect(remoteLog.stdout.trim().split("\n").length).toBe(
			localLog.stdout.trim().split("\n").length,
		);
	});

	test("pushes new branch with explicit refspec", async () => {
		const bash = await setupClonePair();

		await bash.exec(
			"cd /local && git checkout -b feature && echo feat > feat.txt && git add . && git commit -m feature",
		);

		const result = await bash.exec("git push origin feature:refs/heads/feature", { cwd: "/local" });
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain("[new branch]");

		expect(await pathExists(bash.fs, "/remote/.git/refs/heads/feature")).toBe(true);
	});

	test("pushes all branches with --all", async () => {
		const bash = await setupClonePair();

		await bash.exec(
			"cd /local && git checkout -b feature && echo feat > feat.txt && git add . && git commit -m feature",
		);
		await bash.exec("cd /local && git checkout main");

		const result = await bash.exec("git push --all", { cwd: "/local" });
		expect(result.exitCode).toBe(0);

		expect(await pathExists(bash.fs, "/remote/.git/refs/heads/feature")).toBe(true);
	});

	test("sets upstream with -u", async () => {
		const bash = await setupClonePair();

		await bash.exec("cd /local && echo v2 > README.md && git add . && git commit -m update");

		const result = await bash.exec("git push -u origin", {
			cwd: "/local",
		});
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain("set up to track");

		// Verify config was written
		const config = await readFile(bash.fs, "/local/.git/config");
		expect(config).toContain('branch "main"');
		expect(config).toContain("remote = origin");
	});

	test("reports error for detached HEAD without refspec", async () => {
		const bash = await setupClonePair();

		// Use tag to get to detached HEAD (resolveRevision supports tags)
		await bash.exec("cd /local && git tag v0 && git checkout v0");

		const result = await bash.exec("git push", { cwd: "/local" });
		expect(result.exitCode).toBe(128);
		expect(result.stderr).toContain("not currently on a branch");
	});

	test("fails for unknown remote", async () => {
		const bash = await setupClonePair();
		const result = await bash.exec("git push nonexistent", {
			cwd: "/local",
		});
		expect(result.exitCode).toBe(128);
		expect(result.stderr).toContain("does not appear to be");
	});

	test("pushes tags with --tags", async () => {
		const bash = await setupClonePair();

		await bash.exec("cd /local && git tag v1.0");

		const result = await bash.exec("git push --tags", { cwd: "/local" });
		expect(result.exitCode).toBe(0);

		expect(await pathExists(bash.fs, "/remote/.git/refs/tags/v1.0")).toBe(true);
	});

	test("up-to-date push reports everything up-to-date", async () => {
		const bash = await setupClonePair();

		// Push without changes — remote already has everything
		const result = await bash.exec("git push", { cwd: "/local" });
		// Should succeed (nothing to push, remote already matches)
		expect(result.exitCode).toBe(0);
	});
});
