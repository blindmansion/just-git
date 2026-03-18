import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { Bash, InMemoryFs } from "just-bash";
import { createGit } from "../../src/index.ts";
import type { Identity } from "../../src/lib/types.ts";
import {
	createPlatform,
	MergeError,
	type Platform,
	type PRMergedEvent,
} from "../../src/platform/index.ts";
import {
	createCommit,
	flattenTree,
	readCommit,
	resolveRef,
	writeBlob,
	writeTree,
} from "../../src/server/helpers.ts";

const TEST_IDENTITY: Identity = {
	name: "Test",
	email: "test@test.com",
	timestamp: 1000000000,
	timezone: "+0000",
};

function identityAt(ts: number): Identity {
	return { ...TEST_IDENTITY, timestamp: ts };
}

function freshPlatform(callbacks?: Parameters<typeof createPlatform>[0]["on"]): Platform {
	const db = new Database(":memory:");
	return createPlatform({ database: db, on: callbacks });
}

async function seedRepo(platform: Platform, repoId: string): Promise<{ initialHash: string }> {
	platform.createRepo(repoId);
	const repo = platform.gitRepo(repoId);

	const blobHash = await writeBlob(repo, "initial content\n");
	const treeHash = await writeTree(repo, [{ name: "README.md", hash: blobHash }]);
	const commitHash = await createCommit(repo, {
		tree: treeHash,
		parents: [],
		author: TEST_IDENTITY,
		committer: TEST_IDENTITY,
		message: "initial commit\n",
	});

	await repo.refStore.writeRef("refs/heads/main", { type: "direct", hash: commitHash });

	return { initialHash: commitHash };
}

async function addCommitOnBranch(
	platform: Platform,
	repoId: string,
	branch: string,
	fileName: string,
	content: string,
	ts: number,
): Promise<string> {
	const repo = platform.gitRepo(repoId);
	const parentHash = await resolveRef(repo, `refs/heads/${branch}`);
	if (!parentHash) throw new Error(`branch ${branch} not found`);

	const parentCommit = await readCommit(repo, parentHash);
	const parentEntries = await flattenTree(repo, parentCommit.tree);
	const readmeEntry = parentEntries.find((e) => e.path === "README.md");
	if (!readmeEntry) throw new Error("README.md not found in parent tree");

	const blobHash = await writeBlob(repo, content);
	const treeHash = await writeTree(repo, [
		{ name: "README.md", hash: readmeEntry.hash },
		{ name: fileName, hash: blobHash },
	]);

	const commitHash = await createCommit(repo, {
		tree: treeHash,
		parents: [parentHash],
		author: identityAt(ts),
		committer: identityAt(ts),
		message: `add ${fileName}\n`,
	});

	await repo.refStore.writeRef(`refs/heads/${branch}`, { type: "direct", hash: commitHash });
	return commitHash;
}

async function createBranchFromMain(
	platform: Platform,
	repoId: string,
	branchName: string,
): Promise<void> {
	const repo = platform.gitRepo(repoId);
	const mainHash = await resolveRef(repo, "refs/heads/main");
	if (!mainHash) throw new Error("main not found");
	await repo.refStore.writeRef(`refs/heads/${branchName}`, { type: "direct", hash: mainHash });
}

// ── Repo CRUD ───────────────────────────────────────────────────────

describe("Repo CRUD", () => {
	test("create and get a repo", () => {
		const platform = freshPlatform();
		const repo = platform.createRepo("my-repo");

		expect(repo.id).toBe("my-repo");
		expect(repo.defaultBranch).toBe("main");

		const fetched = platform.getRepo("my-repo");
		expect(fetched).not.toBeNull();
		expect(fetched!.id).toBe("my-repo");
	});

	test("create repo with custom default branch", () => {
		const platform = freshPlatform();
		const repo = platform.createRepo("repo", { defaultBranch: "trunk" });
		expect(repo.defaultBranch).toBe("trunk");
	});

	test("list repos", () => {
		const platform = freshPlatform();
		platform.createRepo("alpha");
		platform.createRepo("beta");

		const repos = platform.listRepos();
		expect(repos).toHaveLength(2);
		expect(repos.map((r) => r.id)).toContain("alpha");
		expect(repos.map((r) => r.id)).toContain("beta");
	});

	test("get nonexistent repo returns null", () => {
		const platform = freshPlatform();
		expect(platform.getRepo("nope")).toBeNull();
	});

	test("delete repo removes it and its PRs", async () => {
		const platform = freshPlatform();
		await seedRepo(platform, "doomed");
		await createBranchFromMain(platform, "doomed", "feature");
		await addCommitOnBranch(platform, "doomed", "feature", "f.txt", "data", 1000000100);

		await platform.createPullRequest("doomed", {
			head: "feature",
			base: "main",
			title: "doomed PR",
			author: { name: "Test", email: "test@test.com" },
		});

		platform.deleteRepo("doomed");

		expect(platform.getRepo("doomed")).toBeNull();
		expect(platform.listPullRequests("doomed")).toHaveLength(0);
	});

	test("HEAD is set as symbolic ref to default branch on create", async () => {
		const platform = freshPlatform();
		platform.createRepo("test-repo");
		const repo = platform.gitRepo("test-repo");
		const head = await repo.refStore.readRef("HEAD");
		expect(head).toEqual({ type: "symbolic", target: "refs/heads/main" });
	});
});

// ── PR lifecycle ────────────────────────────────────────────────────

describe("PR lifecycle", () => {
	test("create a pull request", async () => {
		const platform = freshPlatform();
		await seedRepo(platform, "repo");
		await createBranchFromMain(platform, "repo", "feature");
		await addCommitOnBranch(platform, "repo", "feature", "new.txt", "feature work\n", 1000000100);

		const pr = await platform.createPullRequest("repo", {
			head: "feature",
			base: "main",
			title: "Add new feature",
			body: "This adds a new feature",
			author: { name: "Test", email: "test@test.com" },
		});

		expect(pr.number).toBe(1);
		expect(pr.headRef).toBe("feature");
		expect(pr.baseRef).toBe("main");
		expect(pr.state).toBe("open");
		expect(pr.title).toBe("Add new feature");
		expect(pr.headSha).toBeTruthy();
	});

	test("creates refs/pull/N/head", async () => {
		const platform = freshPlatform();
		await seedRepo(platform, "repo");
		await createBranchFromMain(platform, "repo", "feature");
		const featureHash = await addCommitOnBranch(
			platform,
			"repo",
			"feature",
			"new.txt",
			"work\n",
			1000000100,
		);

		const pr = await platform.createPullRequest("repo", {
			head: "feature",
			base: "main",
			title: "PR",
			author: { name: "Test", email: "test@test.com" },
		});

		const repo = platform.gitRepo("repo");
		const pullRef = await resolveRef(repo, `refs/pull/${pr.number}/head`);
		expect(pullRef).toBe(featureHash);
	});

	test("PR numbers auto-increment per repo", async () => {
		const platform = freshPlatform();
		await seedRepo(platform, "repo");
		await createBranchFromMain(platform, "repo", "a");
		await createBranchFromMain(platform, "repo", "b");
		await addCommitOnBranch(platform, "repo", "a", "a.txt", "a\n", 1000000100);
		await addCommitOnBranch(platform, "repo", "b", "b.txt", "b\n", 1000000200);

		const pr1 = await platform.createPullRequest("repo", {
			head: "a",
			base: "main",
			title: "PR A",
			author: { name: "Test", email: "test@test.com" },
		});
		const pr2 = await platform.createPullRequest("repo", {
			head: "b",
			base: "main",
			title: "PR B",
			author: { name: "Test", email: "test@test.com" },
		});

		expect(pr1.number).toBe(1);
		expect(pr2.number).toBe(2);
	});

	test("list PRs by state", async () => {
		const platform = freshPlatform();
		await seedRepo(platform, "repo");
		await createBranchFromMain(platform, "repo", "a");
		await createBranchFromMain(platform, "repo", "b");
		await addCommitOnBranch(platform, "repo", "a", "a.txt", "a\n", 1000000100);
		await addCommitOnBranch(platform, "repo", "b", "b.txt", "b\n", 1000000200);

		await platform.createPullRequest("repo", {
			head: "a",
			base: "main",
			title: "Open PR",
			author: { name: "Test", email: "test@test.com" },
		});
		const pr2 = await platform.createPullRequest("repo", {
			head: "b",
			base: "main",
			title: "Soon Closed",
			author: { name: "Test", email: "test@test.com" },
		});
		await platform.closePullRequest("repo", pr2.number);

		const open = platform.listPullRequests("repo", { state: "open" });
		expect(open).toHaveLength(1);
		expect(open[0]!.title).toBe("Open PR");

		const closed = platform.listPullRequests("repo", { state: "closed" });
		expect(closed).toHaveLength(1);
		expect(closed[0]!.title).toBe("Soon Closed");
	});

	test("update PR title and body", async () => {
		const platform = freshPlatform();
		await seedRepo(platform, "repo");
		await createBranchFromMain(platform, "repo", "feature");
		await addCommitOnBranch(platform, "repo", "feature", "f.txt", "f\n", 1000000100);

		const pr = await platform.createPullRequest("repo", {
			head: "feature",
			base: "main",
			title: "Original",
			author: { name: "Test", email: "test@test.com" },
		});

		platform.updatePullRequest("repo", pr.number, { title: "Updated", body: "New body" });

		const updated = platform.getPullRequest("repo", pr.number);
		expect(updated!.title).toBe("Updated");
		expect(updated!.body).toBe("New body");
	});

	test("close a PR", async () => {
		const platform = freshPlatform();
		await seedRepo(platform, "repo");
		await createBranchFromMain(platform, "repo", "feature");
		await addCommitOnBranch(platform, "repo", "feature", "f.txt", "f\n", 1000000100);

		const pr = await platform.createPullRequest("repo", {
			head: "feature",
			base: "main",
			title: "Closing",
			author: { name: "Test", email: "test@test.com" },
		});

		await platform.closePullRequest("repo", pr.number);

		const closed = platform.getPullRequest("repo", pr.number);
		expect(closed!.state).toBe("closed");
	});

	test("cannot close an already closed PR", async () => {
		const platform = freshPlatform();
		await seedRepo(platform, "repo");
		await createBranchFromMain(platform, "repo", "feature");
		await addCommitOnBranch(platform, "repo", "feature", "f.txt", "f\n", 1000000100);

		const pr = await platform.createPullRequest("repo", {
			head: "feature",
			base: "main",
			title: "PR",
			author: { name: "Test", email: "test@test.com" },
		});

		await platform.closePullRequest("repo", pr.number);
		await expect(platform.closePullRequest("repo", pr.number)).rejects.toThrow("already closed");
	});

	test("creating PR for nonexistent repo throws", async () => {
		const platform = freshPlatform();
		await expect(
			platform.createPullRequest("nope", {
				head: "feature",
				base: "main",
				title: "PR",
				author: { name: "Test", email: "test@test.com" },
			}),
		).rejects.toThrow("not found");
	});

	test("creating PR with nonexistent head ref throws", async () => {
		const platform = freshPlatform();
		await seedRepo(platform, "repo");
		await expect(
			platform.createPullRequest("repo", {
				head: "nonexistent",
				base: "main",
				title: "PR",
				author: { name: "Test", email: "test@test.com" },
			}),
		).rejects.toThrow("does not exist");
	});
});

// ── Merge strategies ────────────────────────────────────────────────

describe("merge strategies", () => {
	test("merge commit — creates two-parent commit", async () => {
		const platform = freshPlatform();
		await seedRepo(platform, "repo");
		await createBranchFromMain(platform, "repo", "feature");
		await addCommitOnBranch(platform, "repo", "feature", "f.txt", "feature\n", 1000000100);

		const pr = await platform.createPullRequest("repo", {
			head: "feature",
			base: "main",
			title: "Merge PR",
			author: { name: "Test", email: "test@test.com" },
		});

		const result = await platform.mergePullRequest("repo", pr.number, {
			strategy: "merge",
			committer: identityAt(1000000200),
			message: "Merge feature into main\n",
		});

		expect(result.strategy).toBe("merge");
		expect(result.sha).toHaveLength(40);

		const repo = platform.gitRepo("repo");
		const mergeCommit = await readCommit(repo, result.sha);
		expect(mergeCommit.parents).toHaveLength(2);

		const mainRef = await resolveRef(repo, "refs/heads/main");
		expect(mainRef).toBe(result.sha);

		const merged = platform.getPullRequest("repo", pr.number);
		expect(merged!.state).toBe("merged");
		expect(merged!.mergeCommitSha).toBe(result.sha);
		expect(merged!.mergeStrategy).toBe("merge");
	});

	test("squash merge — creates single-parent commit", async () => {
		const platform = freshPlatform();
		await seedRepo(platform, "repo");
		await createBranchFromMain(platform, "repo", "feature");
		await addCommitOnBranch(platform, "repo", "feature", "f.txt", "feature\n", 1000000100);

		const pr = await platform.createPullRequest("repo", {
			head: "feature",
			base: "main",
			title: "Squash PR",
			author: { name: "Test", email: "test@test.com" },
		});

		const result = await platform.mergePullRequest("repo", pr.number, {
			strategy: "squash",
			committer: identityAt(1000000200),
		});

		expect(result.strategy).toBe("squash");

		const repo = platform.gitRepo("repo");
		const commit = await readCommit(repo, result.sha);
		expect(commit.parents).toHaveLength(1);

		const merged = platform.getPullRequest("repo", pr.number);
		expect(merged!.state).toBe("merged");
		expect(merged!.mergeStrategy).toBe("squash");
	});

	test("fast-forward merge — no new commit, advances ref", async () => {
		const platform = freshPlatform();
		await seedRepo(platform, "repo");
		await createBranchFromMain(platform, "repo", "feature");
		const featureHash = await addCommitOnBranch(
			platform,
			"repo",
			"feature",
			"f.txt",
			"feature\n",
			1000000100,
		);

		const pr = await platform.createPullRequest("repo", {
			head: "feature",
			base: "main",
			title: "FF PR",
			author: { name: "Test", email: "test@test.com" },
		});

		const result = await platform.mergePullRequest("repo", pr.number, {
			strategy: "fast-forward",
			committer: identityAt(1000000200),
		});

		expect(result.strategy).toBe("fast-forward");
		expect(result.sha).toBe(featureHash);

		const repo = platform.gitRepo("repo");
		const mainRef = await resolveRef(repo, "refs/heads/main");
		expect(mainRef).toBe(featureHash);
	});

	test("fast-forward fails when histories diverge", async () => {
		const platform = freshPlatform();
		await seedRepo(platform, "repo");
		await createBranchFromMain(platform, "repo", "feature");
		await addCommitOnBranch(platform, "repo", "feature", "f.txt", "feature\n", 1000000100);
		await addCommitOnBranch(platform, "repo", "main", "m.txt", "main\n", 1000000200);

		const pr = await platform.createPullRequest("repo", {
			head: "feature",
			base: "main",
			title: "FF PR",
			author: { name: "Test", email: "test@test.com" },
		});

		try {
			await platform.mergePullRequest("repo", pr.number, {
				strategy: "fast-forward",
				committer: identityAt(1000000300),
			});
			expect(true).toBe(false);
		} catch (e) {
			expect(e).toBeInstanceOf(MergeError);
			expect((e as MergeError).code).toBe("not_fast_forward");
		}
	});

	test("merge with conflicts fails cleanly", async () => {
		const platform = freshPlatform();
		await seedRepo(platform, "repo");
		await createBranchFromMain(platform, "repo", "feature");

		const repo = platform.gitRepo("repo");
		const parentHash = await resolveRef(repo, "refs/heads/main");

		const blobA = await writeBlob(repo, "version A\n");
		const treeA = await writeTree(repo, [{ name: "conflict.txt", hash: blobA }]);
		const commitA = await createCommit(repo, {
			tree: treeA,
			parents: [parentHash!],
			author: identityAt(1000000100),
			committer: identityAt(1000000100),
			message: "main change\n",
		});
		await repo.refStore.writeRef("refs/heads/main", { type: "direct", hash: commitA });

		const blobB = await writeBlob(repo, "version B\n");
		const treeB = await writeTree(repo, [{ name: "conflict.txt", hash: blobB }]);
		const commitB = await createCommit(repo, {
			tree: treeB,
			parents: [parentHash!],
			author: identityAt(1000000200),
			committer: identityAt(1000000200),
			message: "feature change\n",
		});
		await repo.refStore.writeRef("refs/heads/feature", { type: "direct", hash: commitB });

		const pr = await platform.createPullRequest("repo", {
			head: "feature",
			base: "main",
			title: "Conflict PR",
			author: { name: "Test", email: "test@test.com" },
		});

		try {
			await platform.mergePullRequest("repo", pr.number, {
				strategy: "merge",
				committer: identityAt(1000000300),
			});
			expect(true).toBe(false);
		} catch (e) {
			expect(e).toBeInstanceOf(MergeError);
			expect((e as MergeError).code).toBe("conflicts");
		}

		const stillOpen = platform.getPullRequest("repo", pr.number);
		expect(stillOpen!.state).toBe("open");
	});

	test("cannot merge an already-merged PR", async () => {
		const platform = freshPlatform();
		await seedRepo(platform, "repo");
		await createBranchFromMain(platform, "repo", "feature");
		await addCommitOnBranch(platform, "repo", "feature", "f.txt", "feature\n", 1000000100);

		const pr = await platform.createPullRequest("repo", {
			head: "feature",
			base: "main",
			title: "PR",
			author: { name: "Test", email: "test@test.com" },
		});

		await platform.mergePullRequest("repo", pr.number, {
			strategy: "merge",
			committer: identityAt(1000000200),
		});

		try {
			await platform.mergePullRequest("repo", pr.number, {
				strategy: "merge",
				committer: identityAt(1000000300),
			});
			expect(true).toBe(false);
		} catch (e) {
			expect(e).toBeInstanceOf(MergeError);
			expect((e as MergeError).code).toBe("not_open");
		}
	});
});

// ── Callbacks ───────────────────────────────────────────────────────

describe("callbacks", () => {
	test("onPullRequestMerged fires on merge", async () => {
		let mergedEvent: PRMergedEvent | null = null;

		const platform = freshPlatform({
			onPullRequestMerged: (event) => {
				mergedEvent = event;
			},
		});

		await seedRepo(platform, "repo");
		await createBranchFromMain(platform, "repo", "feature");
		await addCommitOnBranch(platform, "repo", "feature", "f.txt", "f\n", 1000000100);

		const pr = await platform.createPullRequest("repo", {
			head: "feature",
			base: "main",
			title: "PR",
			author: { name: "Test", email: "test@test.com" },
		});

		await platform.mergePullRequest("repo", pr.number, {
			strategy: "merge",
			committer: identityAt(1000000200),
		});

		expect(mergedEvent).not.toBeNull();
		expect(mergedEvent!.repoId).toBe("repo");
		expect(mergedEvent!.strategy).toBe("merge");
		expect(mergedEvent!.pr.state).toBe("merged");
	});
});

// ── Git server integration ──────────────────────────────────────────

describe("git server integration", () => {
	test("push via git server updates open PR head_sha", async () => {
		const platform = freshPlatform();
		await seedRepo(platform, "repo");
		await createBranchFromMain(platform, "repo", "feature");
		await addCommitOnBranch(platform, "repo", "feature", "f.txt", "feature\n", 1000000100);

		await platform.createPullRequest("repo", {
			head: "feature",
			base: "main",
			title: "PR",
			author: { name: "Test", email: "test@test.com" },
		});

		const server = platform.gitServer();

		const fs = new InMemoryFs();
		const git = createGit();
		const bash = new Bash({ fs, cwd: "/local", customCommands: [git] });

		const env = {
			GIT_AUTHOR_NAME: "Test",
			GIT_AUTHOR_EMAIL: "test@test.com",
			GIT_COMMITTER_NAME: "Test",
			GIT_COMMITTER_EMAIL: "test@test.com",
			GIT_AUTHOR_DATE: "1000000200",
			GIT_COMMITTER_DATE: "1000000200",
		};

		const port = 49152 + Math.floor(Math.random() * 16000);
		const bunServer = Bun.serve({
			port,
			fetch: server.fetch,
		});

		try {
			const cloneResult = await bash.exec(`git clone http://localhost:${port}/repo /local`, {
				env,
			});
			expect(cloneResult.exitCode).toBe(0);

			const switchResult = await bash.exec("git switch feature", { env });
			expect(switchResult.exitCode).toBe(0);

			await bash.writeFile("/local/new-push.txt", "pushed content\n");
			await bash.exec("git add .", { env });
			await bash.exec('git commit -m "push update"', {
				env: { ...env, GIT_AUTHOR_DATE: "1000000300", GIT_COMMITTER_DATE: "1000000300" },
			});

			const pushResult = await bash.exec("git push origin feature", { env });
			expect(pushResult.exitCode).toBe(0);

			const pr = platform.getPullRequest("repo", 1);
			expect(pr).not.toBeNull();

			const repo = platform.gitRepo("repo");
			const featureHash = await resolveRef(repo, "refs/heads/feature");
			expect(pr!.headSha).toBe(featureHash);

			const pullRef = await resolveRef(repo, "refs/pull/1/head");
			expect(pullRef).toBe(featureHash);
		} finally {
			bunServer.stop(true);
		}
	});
});
