import { describe, expect, test } from "bun:test";
import { TEST_ENV as ENV } from "../fixtures";
import { createTestBash, pathExists, readFile, setupClonePair } from "../util";

describe("git fetch", () => {
	test("fetches new commits from remote", async () => {
		const bash = await setupClonePair();

		// Add a new commit to the remote
		await bash.exec("cd /remote && echo 'v2' > README.md && git add . && git commit -m 'update'");

		const result = await bash.exec("git fetch", { cwd: "/local" });
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain("From /remote");
	});

	test("updates remote tracking refs", async () => {
		const bash = await setupClonePair();

		// Get the initial tracking ref
		const before = await readFile(bash.fs, "/local/.git/refs/remotes/origin/main");

		// Add a commit to remote
		await bash.exec("cd /remote && echo 'v2' > README.md && git add . && git commit -m 'update'");

		await bash.exec("git fetch", { cwd: "/local" });

		const after = await readFile(bash.fs, "/local/.git/refs/remotes/origin/main");
		expect(after).not.toBe(before);
	});

	test("reports new branches", async () => {
		const bash = await setupClonePair();

		// Create a new branch on remote
		await bash.exec(
			"cd /remote && git checkout -b feature && echo feat > feat.txt && git add . && git commit -m 'feature'",
		);
		await bash.exec("cd /remote && git checkout main");

		const result = await bash.exec("git fetch", { cwd: "/local" });
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain("[new branch]");
		expect(result.stderr).toContain("feature");

		expect(await pathExists(bash.fs, "/local/.git/refs/remotes/origin/feature")).toBe(true);
	});

	test("does not modify working tree", async () => {
		const bash = await setupClonePair();

		await bash.exec("cd /remote && echo 'v2' > README.md && git add . && git commit -m 'update'");

		await bash.exec("git fetch", { cwd: "/local" });

		// Working tree should still have original content
		expect(await readFile(bash.fs, "/local/README.md")).toBe("# Hello");
	});

	test("writes FETCH_HEAD", async () => {
		const bash = await setupClonePair();

		await bash.exec("git fetch", { cwd: "/local" });

		const fetchHead = await readFile(bash.fs, "/local/.git/FETCH_HEAD");
		expect(fetchHead).toBeDefined();
		expect(fetchHead).toContain("/remote");
	});

	test("is idempotent when nothing changed", async () => {
		const bash = await setupClonePair();

		const r1 = await bash.exec("git fetch", { cwd: "/local" });
		const r2 = await bash.exec("git fetch", { cwd: "/local" });

		expect(r1.exitCode).toBe(0);
		expect(r2.exitCode).toBe(0);
	});

	test("fetches from explicit remote name", async () => {
		const bash = await setupClonePair();

		await bash.exec("cd /remote && echo v2 > README.md && git add . && git commit -m update");

		const result = await bash.exec("git fetch origin", { cwd: "/local" });
		expect(result.exitCode).toBe(0);
	});

	test("fails for unknown remote", async () => {
		const bash = await setupClonePair();

		const result = await bash.exec("git fetch nonexistent", {
			cwd: "/local",
		});
		expect(result.exitCode).toBe(128);
		expect(result.stderr).toContain("does not appear to be");
	});

	test("fetches tags with --tags", async () => {
		const bash = await setupClonePair();

		await bash.exec("cd /remote && git tag v1.0");

		const result = await bash.exec("git fetch --tags", { cwd: "/local" });
		expect(result.exitCode).toBe(0);
		expect(await pathExists(bash.fs, "/local/.git/refs/tags/v1.0")).toBe(true);
	});

	test("prunes stale remote tracking refs with --prune", async () => {
		const bash = await setupClonePair();

		// Create a branch on remote, fetch it
		await bash.exec(
			"cd /remote && git checkout -b stale && echo x > x.txt && git add . && git commit -m stale",
		);
		await bash.exec("cd /remote && git checkout main");
		await bash.exec("git fetch", { cwd: "/local" });

		expect(await pathExists(bash.fs, "/local/.git/refs/remotes/origin/stale")).toBe(true);

		// Force-delete the branch on remote (not fully merged so -D is needed)
		await bash.exec("cd /remote && git branch -D stale");

		// Fetch with prune
		const result = await bash.exec("git fetch --prune", {
			cwd: "/local",
		});
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain("[deleted]");
		expect(await pathExists(bash.fs, "/local/.git/refs/remotes/origin/stale")).toBe(false);
	});

	test("fetches with bare branch refspec (git fetch origin main)", async () => {
		const bash = await setupClonePair();

		await bash.exec("cd /remote && echo v2 > README.md && git add . && git commit -m update");

		const before = await readFile(bash.fs, "/local/.git/refs/remotes/origin/main");

		const result = await bash.exec("git fetch origin main", { cwd: "/local" });
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toMatch(/main\s+-> origin\/main/);

		const after = await readFile(bash.fs, "/local/.git/refs/remotes/origin/main");
		expect(after).not.toBe(before);
	});

	test("fetches with fully-qualified refspec without colon", async () => {
		const bash = await setupClonePair();

		await bash.exec("cd /remote && echo v2 > README.md && git add . && git commit -m update");

		const before = await readFile(bash.fs, "/local/.git/refs/remotes/origin/main");

		const result = await bash.exec("git fetch origin refs/heads/main", { cwd: "/local" });
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain("From /remote");
		expect(result.stderr).toMatch(/\[new branch\]|\.\./);

		const after = await readFile(bash.fs, "/local/.git/refs/remotes/origin/main");
		expect(after).not.toBe(before);
	});

	test("fetches with explicit src:dst refspec", async () => {
		const bash = await setupClonePair();

		await bash.exec("cd /remote && echo v2 > README.md && git add . && git commit -m update");
		await bash.fs.rm("/local/.git/refs/remotes/origin/HEAD");

		const result = await bash.exec("git fetch origin refs/heads/main:refs/custom/main", {
			cwd: "/local",
		});
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain("From /remote");
		expect(result.stderr).toContain("main");

		expect(await pathExists(bash.fs, "/local/.git/refs/custom/main")).toBe(true);
		expect(await pathExists(bash.fs, "/local/.git/refs/remotes/origin/HEAD")).toBe(false);
	});

	test("fails when explicit refspec source does not exist on remote", async () => {
		const bash = await setupClonePair();

		const result = await bash.exec(
			"git fetch origin refs/heads/nonexistent:refs/remotes/origin/nonexistent",
			{
				cwd: "/local",
			},
		);
		expect(result.exitCode).toBe(128);
		expect(result.stderr).toBe("fatal: couldn't find remote ref refs/heads/nonexistent\n");
	});

	test("not a repo error", async () => {
		const bash = createTestBash({ env: ENV, cwd: "/tmp" });
		await bash.exec("mkdir -p /tmp");
		const result = await bash.exec("git fetch", { cwd: "/tmp" });
		expect(result.exitCode).toBe(128);
		expect(result.stderr).toContain("not a git repository");
	});

	test("fetch --all fetches from all configured remotes", async () => {
		const bash = await setupClonePair();

		// Add a second remote pointing at a different repo
		await bash.exec("git init --bare /remote2");
		await bash.exec("cd /remote2 && git config receive.denyCurrentBranch ignore");
		// Push current local state to remote2 so it has a main branch
		await bash.exec("git remote add upstream /remote2", { cwd: "/local" });
		await bash.exec("git push upstream main", { cwd: "/local" });

		// Add new commit on origin
		await bash.exec(
			"cd /remote && echo 'origin-update' > o.txt && git add . && git commit -m 'origin update'",
		);

		const result = await bash.exec("git fetch --all", { cwd: "/local" });
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain("From /remote");
	});

	test("fetch --all errors when remote name also given", async () => {
		const bash = await setupClonePair();
		const result = await bash.exec("git fetch --all origin", { cwd: "/local" });
		expect(result.exitCode).toBe(128);
		expect(result.stderr).toContain("does not take a remote argument");
	});

	test("fetch --tags rejects clobbering an existing tag", async () => {
		const bash = await setupClonePair();

		await bash.exec("cd /local && git tag v1.0");
		await bash.exec("cd /remote && git tag -f v1.0 HEAD~0");
		await bash.exec("cd /remote && echo remote > remote.txt && git add . && git commit -m remote");
		await bash.exec("cd /remote && git tag -f v1.0 HEAD");

		const localTagBefore = await readFile(bash.fs, "/local/.git/refs/tags/v1.0");
		const result = await bash.exec("git fetch --tags", { cwd: "/local" });
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("[rejected]");
		expect(result.stderr).toContain("would clobber existing tag");
		const localTagAfter = await readFile(bash.fs, "/local/.git/refs/tags/v1.0");
		expect(localTagAfter).toBe(localTagBefore);
	});

	test("auto-follows reachable annotated tags without --tags", async () => {
		const bash = await setupClonePair();

		await bash.exec("cd /remote && echo remote > remote.txt && git add . && git commit -m remote");
		await bash.exec('cd /remote && git tag -a -m "remote tag" v1.1 HEAD');

		const result = await bash.exec("git fetch", { cwd: "/local" });
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain("[new tag]");
		expect(result.stderr).toContain("v1.1");
		expect(await pathExists(bash.fs, "/local/.git/refs/tags/v1.1")).toBe(true);
	});
});
