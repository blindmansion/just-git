import { describe, expect, test } from "bun:test";
import { TEST_ENV as ENV } from "../fixtures";
import { createTestBash, pathExists, readFile, setupClonePair } from "../util";

describe("git pull", () => {
	test("fast-forward pull updates working tree", async () => {
		const bash = await setupClonePair();

		// Add a commit on the remote
		await bash.exec("cd /remote && echo 'v2' > README.md && git add . && git commit -m 'update'");

		const result = await bash.exec("git pull", { cwd: "/local" });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Fast-forward");

		// Working tree should be updated
		expect(await readFile(bash.fs, "/local/README.md")).toBe("v2\n");
	});

	test("pull fetches and updates tracking refs", async () => {
		const bash = await setupClonePair();

		await bash.exec("cd /remote && echo v2 > README.md && git add . && git commit -m update");

		await bash.exec("git pull", { cwd: "/local" });

		// Remote tracking ref should be updated
		const remoteMainBefore = await readFile(bash.fs, "/remote/.git/refs/heads/main");
		const trackingRef = await readFile(bash.fs, "/local/.git/refs/remotes/origin/main");
		expect(trackingRef?.trim()).toBe(remoteMainBefore?.trim());
	});

	test("already up-to-date pull", async () => {
		const bash = await setupClonePair();

		const result = await bash.exec("git pull", { cwd: "/local" });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Already up to date");
	});

	test("three-way merge pull", async () => {
		const bash = await setupClonePair();

		// Make different changes on remote and local
		await bash.exec(
			"cd /remote && echo 'remote change' > remote.txt && git add . && git commit -m 'remote commit'",
		);
		await bash.exec(
			"cd /local && echo 'local change' > local.txt && git add . && git commit -m 'local commit'",
		);

		const result = await bash.exec("git pull --no-rebase", { cwd: "/local" });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Merge made by");

		// Both files should exist
		expect(await readFile(bash.fs, "/local/remote.txt")).toBe("remote change\n");
		expect(await readFile(bash.fs, "/local/local.txt")).toBe("local change\n");
	});

	test("pull with conflict", async () => {
		const bash = await setupClonePair();

		// Make conflicting changes
		await bash.exec(
			"cd /remote && echo 'remote version' > README.md && git add . && git commit -m 'remote change'",
		);
		await bash.exec(
			"cd /local && echo 'local version' > README.md && git add . && git commit -m 'local change'",
		);

		const result = await bash.exec("git pull --no-rebase", { cwd: "/local" });
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain("CONFLICT");
		expect(result.stdout).toContain("Automatic merge failed");

		// MERGE_HEAD should exist
		expect(await pathExists(bash.fs, "/local/.git/MERGE_HEAD")).toBe(true);
	});

	test("--ff-only fails on diverged branches", async () => {
		const bash = await setupClonePair();

		await bash.exec("cd /remote && echo remote > remote.txt && git add . && git commit -m remote");
		await bash.exec("cd /local && echo local > local.txt && git add . && git commit -m local");

		const result = await bash.exec("git pull --ff-only", {
			cwd: "/local",
		});
		expect(result.exitCode).toBe(128);
		expect(result.stderr).toContain("Not possible to fast-forward");
	});

	test("--ff-only succeeds on fast-forward", async () => {
		const bash = await setupClonePair();

		await bash.exec("cd /remote && echo v2 > README.md && git add . && git commit -m update");

		const result = await bash.exec("git pull --ff-only", {
			cwd: "/local",
		});
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Fast-forward");
	});

	test("pull uses tracking branch config", async () => {
		const bash = await setupClonePair();

		// Clone already sets up tracking config for main
		await bash.exec("cd /remote && echo v2 > README.md && git add . && git commit -m update");

		// Should work without specifying remote/branch
		const result = await bash.exec("git pull", { cwd: "/local" });
		expect(result.exitCode).toBe(0);
	});

	test("pull preserves commit history", async () => {
		const bash = await setupClonePair();

		await bash.exec("cd /remote && echo v2 > README.md && git add . && git commit -m second");
		await bash.exec("cd /remote && echo v3 > README.md && git add . && git commit -m third");

		await bash.exec("git pull", { cwd: "/local" });

		const log = await bash.exec("git log --oneline", { cwd: "/local" });
		expect(log.stdout.trim().split("\n").length).toBe(3);
	});

	test("fails when not a repo", async () => {
		const bash = createTestBash({ env: ENV, cwd: "/tmp" });
		await bash.exec("mkdir -p /tmp");
		const result = await bash.exec("git pull", { cwd: "/tmp" });
		expect(result.exitCode).toBe(128);
	});

	test("writes FETCH_HEAD", async () => {
		const bash = await setupClonePair();

		await bash.exec("cd /remote && echo v2 > README.md && git add . && git commit -m update");

		await bash.exec("git pull", { cwd: "/local" });

		const fetchHead = await readFile(bash.fs, "/local/.git/FETCH_HEAD");
		expect(fetchHead).toBeDefined();
	});

	test("pull auto-follows reachable tags during fetch phase", async () => {
		const bash = await setupClonePair();

		await bash.exec("cd /remote && echo v2 > README.md && git add . && git commit -m update");
		await bash.exec('cd /remote && git tag -a -m "remote tag" v1.1 HEAD');

		const result = await bash.exec("git pull", { cwd: "/local" });
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain("[new tag]");
		expect(result.stderr).toContain("v1.1");
		expect(await pathExists(bash.fs, "/local/.git/refs/tags/v1.1")).toBe(true);
	});

	test("pull fetch phase follows reachable tags before no-tracking error", async () => {
		const bash = await setupClonePair();

		await bash.exec("cd /local && git switch -c feature");
		await bash.exec("cd /remote && echo v2 > README.md && git add . && git commit -m update");
		await bash.exec('cd /remote && git tag -a -m "remote tag" v1.2 HEAD');

		const result = await bash.exec("git pull", { cwd: "/local" });
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("[new tag]");
		expect(result.stderr).toContain("v1.2");
		expect(result.stderr).toContain("There is no tracking information for the current branch.");
		expect(await pathExists(bash.fs, "/local/.git/refs/tags/v1.2")).toBe(true);
	});

	test("pull --rebase fails before fetch on dirty tracked branch", async () => {
		const bash = await setupClonePair();

		const trackingBefore = await readFile(bash.fs, "/local/.git/refs/remotes/origin/main");
		await bash.exec("git config pull.rebase true", { cwd: "/local" });
		await bash.exec("cd /remote && echo v2 > README.md && git add . && git commit -m update");
		await bash.exec('cd /remote && git tag -a -m "remote tag" v1.3 HEAD');
		await bash.exec("cd /local && echo staged > local-only.txt && git add local-only.txt");

		const result = await bash.exec("git pull", { cwd: "/local" });
		expect(result.exitCode).toBe(128);
		expect(result.stderr).toContain(
			"error: cannot pull with rebase: Your index contains uncommitted changes.",
		);
		expect(result.stderr).toContain("error: Please commit or stash them.");
		expect(result.stderr).not.toContain("From /remote");
		expect(await readFile(bash.fs, "/local/.git/refs/remotes/origin/main")).toBe(trackingBefore);
		expect(await pathExists(bash.fs, "/local/.git/refs/tags/v1.3")).toBe(false);
	});

	test("pull --rebase fails before fetch on dirty no-tracking branch", async () => {
		const bash = await setupClonePair();

		const trackingBefore = await readFile(bash.fs, "/local/.git/refs/remotes/origin/main");
		await bash.exec("git config pull.rebase true", { cwd: "/local" });
		await bash.exec("cd /local && git switch -c feature");
		await bash.exec("cd /remote && echo v2 > README.md && git add . && git commit -m update");
		await bash.exec('cd /remote && git tag -a -m "remote tag" v1.4 HEAD');
		await bash.exec("cd /local && echo dirty >> README.md");
		await bash.exec("cd /local && echo staged > local-only.txt && git add local-only.txt");

		const result = await bash.exec("git pull", { cwd: "/local" });
		expect(result.exitCode).toBe(128);
		expect(result.stderr).toContain("error: cannot pull with rebase: You have unstaged changes.");
		expect(result.stderr).toContain(
			"error: additionally, your index contains uncommitted changes.",
		);
		expect(result.stderr).toContain("error: Please commit or stash them.");
		expect(result.stderr).not.toContain("There is no tracking information for the current branch.");
		expect(result.stderr).not.toContain("From /remote");
		expect(await readFile(bash.fs, "/local/.git/refs/remotes/origin/main")).toBe(trackingBefore);
		expect(await pathExists(bash.fs, "/local/.git/refs/tags/v1.4")).toBe(false);
	});

	// ── pull --rebase ───────────────────────────────────────────────

	describe("pull --rebase", () => {
		test("--rebase rebases local commits on top of remote", async () => {
			const bash = await setupClonePair();

			// Make divergent changes
			await bash.exec(
				"cd /remote && echo 'remote change' > remote.txt && git add . && git commit -m 'remote commit'",
			);
			await bash.exec(
				"cd /local && echo 'local change' > local.txt && git add . && git commit -m 'local commit'",
			);

			const result = await bash.exec("git pull --rebase", { cwd: "/local" });
			expect(result.exitCode).toBe(0);
			expect(result.stderr).toContain("Successfully rebased");

			// Should NOT have a merge commit — linear history
			const log = await bash.exec("git log --oneline", { cwd: "/local" });
			const lines = log.stdout.trim().split("\n");
			expect(lines.length).toBe(3); // initial + remote + local (rebased)
			expect(log.stdout).not.toContain("Merge");

			// Both files should exist
			expect(await readFile(bash.fs, "/local/remote.txt")).toBe("remote change\n");
			expect(await readFile(bash.fs, "/local/local.txt")).toBe("local change\n");
		});

		test("--rebase fast-forwards when no local commits", async () => {
			const bash = await setupClonePair();

			await bash.exec("cd /remote && echo v2 > README.md && git add . && git commit -m update");

			const result = await bash.exec("git pull --rebase", { cwd: "/local" });
			expect(result.exitCode).toBe(0);
			expect(await readFile(bash.fs, "/local/README.md")).toBe("v2\n");
		});

		test("--rebase with conflict stops for resolution", async () => {
			const bash = await setupClonePair();

			await bash.exec(
				"cd /remote && echo 'remote version' > README.md && git add . && git commit -m remote",
			);
			await bash.exec(
				"cd /local && echo 'local version' > README.md && git add . && git commit -m local",
			);

			const result = await bash.exec("git pull --rebase", { cwd: "/local" });
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("could not apply");

			// Should be in rebase state, not merge state
			expect(await pathExists(bash.fs, "/local/.git/rebase-merge")).toBe(true);
			expect(await pathExists(bash.fs, "/local/.git/MERGE_HEAD")).toBe(false);
		});
	});

	// ── pull.rebase config ──────────────────────────────────────────

	describe("pull.rebase config", () => {
		test("pull.rebase=true rebases by default", async () => {
			const bash = await setupClonePair();

			await bash.exec(
				"cd /remote && echo 'remote' > remote.txt && git add . && git commit -m remote",
			);
			await bash.exec("cd /local && echo 'local' > local.txt && git add . && git commit -m local");

			await bash.exec("git config pull.rebase true", { cwd: "/local" });
			const result = await bash.exec("git pull", { cwd: "/local" });

			expect(result.exitCode).toBe(0);
			expect(result.stderr).toContain("Successfully rebased");
			const log = await bash.exec("git log --oneline", { cwd: "/local" });
			expect(log.stdout).not.toContain("Merge");
		});

		test("--no-rebase overrides pull.rebase=true", async () => {
			const bash = await setupClonePair();

			await bash.exec(
				"cd /remote && echo 'remote' > remote.txt && git add . && git commit -m remote",
			);
			await bash.exec("cd /local && echo 'local' > local.txt && git add . && git commit -m local");

			await bash.exec("git config pull.rebase true", { cwd: "/local" });
			const result = await bash.exec("git pull --no-rebase", { cwd: "/local" });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Merge made by");
		});

		test("branch.<name>.rebase=true overrides pull.rebase default", async () => {
			const bash = await setupClonePair();

			await bash.exec(
				"cd /remote && echo 'remote' > remote.txt && git add . && git commit -m remote",
			);
			await bash.exec("cd /local && echo 'local' > local.txt && git add . && git commit -m local");

			await bash.exec("git config branch.main.rebase true", { cwd: "/local" });
			const result = await bash.exec("git pull", { cwd: "/local" });

			expect(result.exitCode).toBe(0);
			expect(result.stderr).toContain("Successfully rebased");
		});

		test("branch.<name>.rebase=false overrides pull.rebase=true", async () => {
			const bash = await setupClonePair();

			await bash.exec(
				"cd /remote && echo 'remote' > remote.txt && git add . && git commit -m remote",
			);
			await bash.exec("cd /local && echo 'local' > local.txt && git add . && git commit -m local");

			await bash.exec("git config pull.rebase true", { cwd: "/local" });
			await bash.exec("git config branch.main.rebase false", { cwd: "/local" });
			const result = await bash.exec("git pull", { cwd: "/local" });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Merge made by");
		});
	});

	// ── pull.ff config ──────────────────────────────────────────────

	describe("pull.ff config", () => {
		test("pull.ff=false forces merge commit on fast-forward pull", async () => {
			const bash = await setupClonePair();

			await bash.exec("cd /remote && echo v2 > README.md && git add . && git commit -m update");

			await bash.exec("git config pull.ff false", { cwd: "/local" });
			const result = await bash.exec("git pull", { cwd: "/local" });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).not.toContain("Fast-forward");
			expect(result.stdout).toContain("Merge made by");
		});

		test("pull.ff=only rejects non-fast-forward pull", async () => {
			const bash = await setupClonePair();

			await bash.exec(
				"cd /remote && echo remote > remote.txt && git add . && git commit -m remote",
			);
			await bash.exec("cd /local && echo local > local.txt && git add . && git commit -m local");

			await bash.exec("git config pull.ff only", { cwd: "/local" });
			const result = await bash.exec("git pull", { cwd: "/local" });

			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("Not possible to fast-forward");
		});

		test("pull.ff=only allows fast-forward pull", async () => {
			const bash = await setupClonePair();

			await bash.exec("cd /remote && echo v2 > README.md && git add . && git commit -m update");

			await bash.exec("git config pull.ff only", { cwd: "/local" });
			const result = await bash.exec("git pull", { cwd: "/local" });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Fast-forward");
		});

		test("--no-ff overrides pull.ff=only", async () => {
			const bash = await setupClonePair();

			await bash.exec("cd /remote && echo v2 > README.md && git add . && git commit -m update");

			await bash.exec("git config pull.ff only", { cwd: "/local" });
			const result = await bash.exec("git pull --no-ff", { cwd: "/local" });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).not.toContain("Fast-forward");
			expect(result.stdout).toContain("Merge made by");
		});

		test("--ff-only overrides pull.ff=false on diverged branches", async () => {
			const bash = await setupClonePair();

			await bash.exec(
				"cd /remote && echo remote > remote.txt && git add . && git commit -m remote",
			);
			await bash.exec("cd /local && echo local > local.txt && git add . && git commit -m local");

			await bash.exec("git config pull.ff false", { cwd: "/local" });
			const result = await bash.exec("git pull --ff-only", { cwd: "/local" });

			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("Not possible to fast-forward");
		});
	});
});
