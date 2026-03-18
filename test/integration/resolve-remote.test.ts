import { describe, expect, test } from "bun:test";
import { Bash, InMemoryFs } from "just-bash";
import { createGit } from "../../src/index.ts";
import { findRepo } from "../../src/lib/repo.ts";
import type { GitContext } from "../../src/lib/types.ts";

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

async function setupOrigin(): Promise<{ originFs: InMemoryFs; originCtx: GitContext }> {
	const originFs = new InMemoryFs();
	const originGit = createGit();
	const originBash = new Bash({
		fs: originFs,
		cwd: "/repo",
		customCommands: [originGit],
	});
	await originBash.exec("git init");
	await originBash.writeFile("/repo/README.md", "# Hello");
	await originBash.exec("git add .");
	await originBash.exec('git commit -m "initial"', { env: envAt(1000000000) });

	const originCtx = await findRepo(originFs, "/repo");
	if (!originCtx) throw new Error("failed to set up origin");
	return { originFs, originCtx };
}

function createAgentBash(originCtx: GitContext) {
	const agentFs = new InMemoryFs();
	const agentGit = createGit({
		resolveRemote: (url) => (url === "/origin" ? originCtx : null),
	});
	return new Bash({
		fs: agentFs,
		cwd: "/repo",
		customCommands: [agentGit],
	});
}

describe("resolveRemote", () => {
	test("clone across separate VFS instances", async () => {
		const { originCtx } = await setupOrigin();
		const agent = createAgentBash(originCtx);

		const result = await agent.exec("git clone /origin /repo", {
			cwd: "/",
			env: envAt(1000000100),
		});
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain("Cloning into");

		const readme = await agent.readFile("/repo/README.md");
		expect(readme).toBe("# Hello");

		const log = await agent.exec("git log --oneline", { env: envAt(1000000100) });
		expect(log.stdout).toContain("initial");
	});

	test("fetch new commits across VFS after clone", async () => {
		const { originFs, originCtx } = await setupOrigin();
		const agent = createAgentBash(originCtx);

		await agent.exec("git clone /origin /repo", { cwd: "/", env: envAt(1000000100) });

		// Make a new commit on origin
		const originBash = new Bash({
			fs: originFs,
			cwd: "/repo",
			customCommands: [createGit()],
		});
		await originBash.writeFile("/repo/new-file.txt", "new content");
		await originBash.exec("git add .");
		await originBash.exec('git commit -m "second commit"', { env: envAt(1000000200) });

		// Fetch from agent
		const fetchResult = await agent.exec("git fetch origin", { env: envAt(1000000300) });
		expect(fetchResult.exitCode).toBe(0);

		const log = await agent.exec("git log --oneline origin/main", { env: envAt(1000000300) });
		expect(log.stdout).toContain("second commit");
	});

	test("push commits to origin across VFS", async () => {
		const { originFs, originCtx } = await setupOrigin();
		const agent = createAgentBash(originCtx);

		await agent.exec("git clone /origin /repo", { cwd: "/", env: envAt(1000000100) });

		// Make a commit on the agent side
		await agent.writeFile("/repo/agent-file.txt", "from agent");
		await agent.exec("git add .");
		await agent.exec('git commit -m "agent commit"', { env: envAt(1000000200) });

		// Push to origin
		const pushResult = await agent.exec("git push origin main", { env: envAt(1000000200) });
		expect(pushResult.exitCode).toBe(0);

		// Verify origin received the commit
		const originBash = new Bash({
			fs: originFs,
			cwd: "/repo",
			customCommands: [createGit()],
		});
		const log = await originBash.exec("git log --oneline", { env: envAt(1000000200) });
		expect(log.stdout).toContain("agent commit");
	});

	test("two agents on separate VFS instances collaborate via shared origin", async () => {
		const { originCtx } = await setupOrigin();

		const alice = createAgentBash(originCtx);
		const bob = createAgentBash(originCtx);

		// Both clone
		await alice.exec("git clone /origin /repo", { cwd: "/", env: envAt(1000000100) });
		await bob.exec("git clone /origin /repo", { cwd: "/", env: envAt(1000000100) });

		// Alice pushes a feature branch
		await alice.exec("git checkout -b feature", { env: envAt(1000000200) });
		await alice.writeFile("/repo/alice.txt", "alice's work");
		await alice.exec("git add .");
		await alice.exec('git commit -m "alice feature"', { env: envAt(1000000200) });
		const alicePush = await alice.exec("git push origin feature", { env: envAt(1000000200) });
		expect(alicePush.exitCode).toBe(0);

		// Bob fetches and sees Alice's branch
		const fetch = await bob.exec("git fetch origin", { env: envAt(1000000300) });
		expect(fetch.exitCode).toBe(0);

		const branches = await bob.exec("git branch -a", { env: envAt(1000000300) });
		expect(branches.stdout).toContain("remotes/origin/feature");

		// Bob merges Alice's feature
		const merge = await bob.exec("git merge origin/feature --no-ff -m 'merge alice'", {
			env: envAt(1000000400),
		});
		expect(merge.exitCode).toBe(0);

		const bobLog = await bob.exec("git log --oneline", { env: envAt(1000000400) });
		expect(bobLog.stdout).toContain("alice feature");
		expect(bobLog.stdout).toContain("merge alice");
	});

	test("pull across VFS", async () => {
		const { originFs, originCtx } = await setupOrigin();
		const agent = createAgentBash(originCtx);

		await agent.exec("git clone /origin /repo", { cwd: "/", env: envAt(1000000100) });

		// Make a new commit on origin
		const originBash = new Bash({
			fs: originFs,
			cwd: "/repo",
			customCommands: [createGit()],
		});
		await originBash.writeFile("/repo/pulled-file.txt", "pull me");
		await originBash.exec("git add .");
		await originBash.exec('git commit -m "to be pulled"', { env: envAt(1000000200) });

		// Agent pulls
		const pullResult = await agent.exec("git pull origin main", { env: envAt(1000000300) });
		expect(pullResult.exitCode).toBe(0);

		const content = await agent.readFile("/repo/pulled-file.txt");
		expect(content).toBe("pull me");
	});

	test("falls back to local FS when resolveRemote returns null", async () => {
		const fs = new InMemoryFs();
		const resolver = () => {
			// Only resolve /external, let everything else fall through
			return null;
		};

		const git = createGit({ resolveRemote: resolver });
		const bash = new Bash({ fs, cwd: "/repo", customCommands: [git] });

		// Set up a repo on the local FS
		await bash.exec("git init", { cwd: "/local-origin" });
		const localOriginBash = new Bash({ fs, cwd: "/local-origin", customCommands: [createGit()] });
		await localOriginBash.writeFile("/local-origin/file.txt", "local");
		await localOriginBash.exec("git add .");
		await localOriginBash.exec('git commit -m "local commit"', { env: envAt(1000000000) });

		// Clone from local FS path — resolver returns null, so it falls through
		const result = await bash.exec("git clone /local-origin /repo", {
			cwd: "/",
			env: envAt(1000000100),
		});
		expect(result.exitCode).toBe(0);

		const content = await bash.readFile("/repo/file.txt");
		expect(content).toBe("local");
	});

	test("concurrent pushes to same ref — CAS rejects the stale one", async () => {
		const { originCtx } = await setupOrigin();

		const alice = createAgentBash(originCtx);
		const bob = createAgentBash(originCtx);

		await alice.exec("git clone /origin /repo", { cwd: "/", env: envAt(1000000100) });
		await bob.exec("git clone /origin /repo", { cwd: "/", env: envAt(1000000100) });

		// Both create diverging commits on main
		await alice.writeFile("/repo/alice.txt", "alice");
		await alice.exec("git add .");
		await alice.exec('git commit -m "alice on main"', { env: envAt(1000000200) });

		await bob.writeFile("/repo/bob.txt", "bob");
		await bob.exec("git add .");
		await bob.exec('git commit -m "bob on main"', { env: envAt(1000000300) });

		// Push concurrently — both hold the same oldHash from their clone.
		// CAS ensures the second push fails because the ref has moved.
		const [aliceResult, bobResult] = await Promise.all([
			alice.exec("git push origin main", { env: envAt(1000000200) }),
			bob.exec("git push origin main", { env: envAt(1000000300) }),
		]);

		const exits = [aliceResult.exitCode, bobResult.exitCode].sort();
		expect(exits).toEqual([0, 1]);

		const failedResult = aliceResult.exitCode === 1 ? aliceResult : bobResult;
		expect(failedResult.stderr).toContain("rejected");
	});

	test("concurrent pushes to different branches both succeed", async () => {
		const { originCtx } = await setupOrigin();

		const alice = createAgentBash(originCtx);
		const bob = createAgentBash(originCtx);

		await alice.exec("git clone /origin /repo", { cwd: "/", env: envAt(1000000100) });
		await bob.exec("git clone /origin /repo", { cwd: "/", env: envAt(1000000100) });

		// Each works on a separate branch — no conflict
		await alice.exec("git checkout -b feature-a", { env: envAt(1000000200) });
		await alice.writeFile("/repo/a.txt", "a");
		await alice.exec("git add .");
		await alice.exec('git commit -m "feature a"', { env: envAt(1000000200) });

		await bob.exec("git checkout -b feature-b", { env: envAt(1000000300) });
		await bob.writeFile("/repo/b.txt", "b");
		await bob.exec("git add .");
		await bob.exec('git commit -m "feature b"', { env: envAt(1000000300) });

		const [aliceResult, bobResult] = await Promise.all([
			alice.exec("git push origin feature-a", { env: envAt(1000000200) }),
			bob.exec("git push origin feature-b", { env: envAt(1000000300) }),
		]);

		expect(aliceResult.exitCode).toBe(0);
		expect(bobResult.exitCode).toBe(0);
	});

	test("resolver is not called for HTTP URLs", async () => {
		let resolverCalled = false;
		const git = createGit({
			resolveRemote: () => {
				resolverCalled = true;
				return null;
			},
			network: false,
		});

		const fs = new InMemoryFs();
		const bash = new Bash({ fs, cwd: "/repo", customCommands: [git] });
		await bash.exec("git init");

		// Try to clone an HTTP URL — should hit network policy, not resolver
		const result = await bash.exec("git clone https://example.com/repo.git /clone", {
			cwd: "/",
			env: envAt(1000000000),
		});
		expect(resolverCalled).toBe(false);
		expect(result.exitCode).toBe(128);
	});
});
