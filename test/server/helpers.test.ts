import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { Bash, InMemoryFs } from "just-bash";
import { createGit } from "../../src/index.ts";
import { findGitDir } from "../../src/lib/repo.ts";
import type { GitRepo, Identity } from "../../src/lib/types.ts";
import {
	checkoutTo,
	createCommit,
	findMergeBases,
	mergeTrees,
	mergeTreesFromTreeHashes,
	readCommit,
	readFileAtCommit,
	writeBlob,
	writeTree,
} from "../../src/repo/helpers.ts";
import { SqliteStorage } from "../../src/server/sqlite-storage.ts";

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

const TEST_IDENTITY: Identity = {
	name: "Test",
	email: "test@test.com",
	timestamp: 1000000000,
	timezone: "+0000",
};

async function getRefHash(repo: GitRepo, refName: string): Promise<string> {
	const ref = await repo.refStore.readRef(refName);
	if (!ref) throw new Error(`ref ${refName} not found`);
	if (ref.type === "symbolic") {
		return getRefHash(repo, ref.target);
	}
	return ref.hash;
}

async function setupWithCommits(): Promise<{
	bash: Bash;
	repo: GitRepo;
	initialHash: string;
}> {
	const fs = new InMemoryFs();
	const git = createGit();
	const bash = new Bash({ fs, cwd: "/repo", customCommands: [git] });

	await bash.writeFile("/repo/file.txt", "initial content\n");
	await bash.exec("git init");
	await bash.exec("git add .");
	await bash.exec('git commit -m "initial"', { env: envAt(1000000000) });

	const ctx = await findGitDir(fs, "/repo");
	if (!ctx) throw new Error("failed to find git dir");

	const initialHash = await getRefHash(ctx, "HEAD");

	return { bash, repo: ctx, initialHash };
}

// ── mergeTrees ──────────────────────────────────────────────────────

describe("mergeTrees", () => {
	test("clean merge — non-overlapping changes", async () => {
		const { bash, repo } = await setupWithCommits();

		await bash.exec("git checkout -b feature", { env: TEST_ENV });
		await bash.writeFile("/repo/feature.txt", "feature work\n");
		await bash.exec("git add .");
		await bash.exec('git commit -m "add feature"', { env: envAt(1000000100) });

		await bash.exec("git checkout main", { env: TEST_ENV });
		await bash.writeFile("/repo/main-fix.txt", "main fix\n");
		await bash.exec("git add .");
		await bash.exec('git commit -m "main fix"', { env: envAt(1000000200) });

		const mainHash = await getRefHash(repo, "refs/heads/main");
		const featureHash = await getRefHash(repo, "refs/heads/feature");

		const result = await mergeTrees(repo, mainHash, featureHash);

		expect(result.clean).toBe(true);
		expect(result.conflicts).toHaveLength(0);
		expect(result.treeHash).toBeTruthy();
	});

	test("conflicting merge — overlapping changes", async () => {
		const { bash, repo } = await setupWithCommits();

		await bash.exec("git checkout -b feature", { env: TEST_ENV });
		await bash.writeFile("/repo/file.txt", "feature version\n");
		await bash.exec("git add .");
		await bash.exec('git commit -m "feature change"', { env: envAt(1000000100) });

		await bash.exec("git checkout main", { env: TEST_ENV });
		await bash.writeFile("/repo/file.txt", "main version\n");
		await bash.exec("git add .");
		await bash.exec('git commit -m "main change"', { env: envAt(1000000200) });

		const mainHash = await getRefHash(repo, "refs/heads/main");
		const featureHash = await getRefHash(repo, "refs/heads/feature");

		const result = await mergeTrees(repo, mainHash, featureHash);

		expect(result.clean).toBe(false);
		expect(result.conflicts.length).toBeGreaterThan(0);
		expect(result.conflicts[0]!.path).toBe("file.txt");
	});

	test("uses custom labels in conflict messages", async () => {
		const { bash, repo } = await setupWithCommits();

		await bash.exec("git checkout -b feature", { env: TEST_ENV });
		await bash.writeFile("/repo/file.txt", "feature version\n");
		await bash.exec("git add .");
		await bash.exec('git commit -m "feature change"', { env: envAt(1000000100) });

		await bash.exec("git checkout main", { env: TEST_ENV });
		await bash.writeFile("/repo/file.txt", "main version\n");
		await bash.exec("git add .");
		await bash.exec('git commit -m "main change"', { env: envAt(1000000200) });

		const mainHash = await getRefHash(repo, "refs/heads/main");
		const featureHash = await getRefHash(repo, "refs/heads/feature");

		const result = await mergeTrees(repo, mainHash, featureHash, {
			ours: "main",
			theirs: "feature",
		});

		expect(result.clean).toBe(false);
		expect(result.messages.length).toBeGreaterThan(0);
		const conflictMsg = result.messages.find((m) => m.includes("CONFLICT"));
		expect(conflictMsg).toBeDefined();
	});
});

// ── mergeTreesFromTreeHashes ────────────────────────────────────────

describe("mergeTreesFromTreeHashes", () => {
	test("merge with explicit base tree", async () => {
		const { bash, repo, initialHash } = await setupWithCommits();
		const initialCommit = await readCommit(repo, initialHash);

		await bash.exec("git checkout -b feature", { env: TEST_ENV });
		await bash.writeFile("/repo/feature.txt", "feature work\n");
		await bash.exec("git add .");
		await bash.exec('git commit -m "add feature"', { env: envAt(1000000100) });

		await bash.exec("git checkout main", { env: TEST_ENV });
		await bash.writeFile("/repo/main-fix.txt", "main fix\n");
		await bash.exec("git add .");
		await bash.exec('git commit -m "main fix"', { env: envAt(1000000200) });

		const mainHash = await getRefHash(repo, "refs/heads/main");
		const featureHash = await getRefHash(repo, "refs/heads/feature");

		const mainCommit = await readCommit(repo, mainHash);
		const featureCommit = await readCommit(repo, featureHash);

		const result = await mergeTreesFromTreeHashes(
			repo,
			initialCommit.tree,
			mainCommit.tree,
			featureCommit.tree,
		);

		expect(result.clean).toBe(true);
		expect(result.conflicts).toHaveLength(0);
	});

	test("merge with null base (disjoint histories)", async () => {
		const { bash, repo } = await setupWithCommits();

		await bash.exec("git checkout --orphan other", { env: TEST_ENV });
		await bash.writeFile("/repo/other.txt", "other content\n");
		await bash.exec("git add .");
		await bash.exec('git commit -m "other root"', { env: envAt(1000000100) });

		const mainHash = await getRefHash(repo, "refs/heads/main");
		const otherHash = await getRefHash(repo, "HEAD");

		const mainCommit = await readCommit(repo, mainHash);
		const otherCommit = await readCommit(repo, otherHash);

		const result = await mergeTreesFromTreeHashes(repo, null, mainCommit.tree, otherCommit.tree);

		expect(result.clean).toBe(true);
	});
});

// ── createCommit ────────────────────────────────────────────────────

describe("createCommit", () => {
	test("creates a commit readable by readCommit", async () => {
		const { repo, initialHash } = await setupWithCommits();
		const initial = await readCommit(repo, initialHash);

		const hash = await createCommit(repo, {
			tree: initial.tree,
			parents: [initialHash],
			author: TEST_IDENTITY,
			committer: TEST_IDENTITY,
			message: "programmatic commit\n",
		});

		expect(hash).toHaveLength(40);

		const commit = await readCommit(repo, hash);
		expect(commit.tree).toBe(initial.tree);
		expect(commit.parents).toEqual([initialHash]);
		expect(commit.message).toBe("programmatic commit\n");
		expect(commit.author.name).toBe("Test");
		expect(commit.committer.email).toBe("test@test.com");
	});

	test("creates a merge commit with two parents", async () => {
		const { bash, repo } = await setupWithCommits();

		await bash.exec("git checkout -b feature", { env: TEST_ENV });
		await bash.writeFile("/repo/feature.txt", "feature\n");
		await bash.exec("git add .");
		await bash.exec('git commit -m "feature"', { env: envAt(1000000100) });

		await bash.exec("git checkout main", { env: TEST_ENV });
		await bash.writeFile("/repo/main-fix.txt", "fix\n");
		await bash.exec("git add .");
		await bash.exec('git commit -m "fix"', { env: envAt(1000000200) });

		const mainHash = await getRefHash(repo, "refs/heads/main");
		const featureHash = await getRefHash(repo, "refs/heads/feature");

		const mergeResult = await mergeTrees(repo, mainHash, featureHash);
		expect(mergeResult.clean).toBe(true);

		const mergeCommitHash = await createCommit(repo, {
			tree: mergeResult.treeHash,
			parents: [mainHash, featureHash],
			author: TEST_IDENTITY,
			committer: TEST_IDENTITY,
			message: "Merge feature into main\n",
		});

		const mergeCommit = await readCommit(repo, mergeCommitHash);
		expect(mergeCommit.parents).toEqual([mainHash, featureHash]);
		expect(mergeCommit.message).toBe("Merge feature into main\n");
	});

	test("commit does not update any refs", async () => {
		const { repo, initialHash } = await setupWithCommits();
		const initial = await readCommit(repo, initialHash);

		const headBefore = await repo.refStore.readRef("HEAD");

		await createCommit(repo, {
			tree: initial.tree,
			parents: [initialHash],
			author: TEST_IDENTITY,
			committer: TEST_IDENTITY,
			message: "should not move HEAD\n",
		});

		const headAfter = await repo.refStore.readRef("HEAD");
		expect(headAfter).toEqual(headBefore);
	});
});

// ── findMergeBases ──────────────────────────────────────────────────

describe("findMergeBases", () => {
	test("finds the common ancestor of diverged branches", async () => {
		const { bash, repo, initialHash } = await setupWithCommits();

		await bash.exec("git checkout -b feature", { env: TEST_ENV });
		await bash.writeFile("/repo/feature.txt", "feature\n");
		await bash.exec("git add .");
		await bash.exec('git commit -m "feature"', { env: envAt(1000000100) });

		await bash.exec("git checkout main", { env: TEST_ENV });
		await bash.writeFile("/repo/main-fix.txt", "fix\n");
		await bash.exec("git add .");
		await bash.exec('git commit -m "fix"', { env: envAt(1000000200) });

		const mainHash = await getRefHash(repo, "refs/heads/main");
		const featureHash = await getRefHash(repo, "refs/heads/feature");

		const bases = await findMergeBases(repo, mainHash, featureHash);
		expect(bases).toHaveLength(1);
		expect(bases[0]).toBe(initialHash);
	});

	test("returns empty array for disjoint histories", async () => {
		const { bash, repo } = await setupWithCommits();

		await bash.exec("git checkout --orphan other", { env: TEST_ENV });
		await bash.writeFile("/repo/other.txt", "other\n");
		await bash.exec("git add .");
		await bash.exec('git commit -m "other root"', { env: envAt(1000000100) });

		const mainHash = await getRefHash(repo, "refs/heads/main");
		const otherHash = await getRefHash(repo, "HEAD");

		const bases = await findMergeBases(repo, mainHash, otherHash);
		expect(bases).toHaveLength(0);
	});
});

// ── readFileAtCommit ────────────────────────────────────────────────

describe("readFileAtCommit", () => {
	test("reads a file that exists at the commit", async () => {
		const { repo, initialHash } = await setupWithCommits();

		const content = await readFileAtCommit(repo, initialHash, "file.txt");
		expect(content).toBe("initial content\n");
	});

	test("returns null for a file that does not exist", async () => {
		const { repo, initialHash } = await setupWithCommits();

		const content = await readFileAtCommit(repo, initialHash, "nonexistent.txt");
		expect(content).toBeNull();
	});

	test("reads file content at a specific historical commit", async () => {
		const { bash, repo, initialHash } = await setupWithCommits();

		await bash.writeFile("/repo/file.txt", "updated content\n");
		await bash.exec("git add .");
		await bash.exec('git commit -m "update"', { env: envAt(1000000100) });

		const oldContent = await readFileAtCommit(repo, initialHash, "file.txt");
		expect(oldContent).toBe("initial content\n");

		const newHash = await getRefHash(repo, "HEAD");
		const newContent = await readFileAtCommit(repo, newHash, "file.txt");
		expect(newContent).toBe("updated content\n");
	});
});

// ── End-to-end: mergeTrees + createCommit ───────────────────────────

describe("mergeTrees + createCommit (PR merge flow)", () => {
	test("simulates a PR merge: merge trees, create commit, advance ref", async () => {
		const { bash, repo } = await setupWithCommits();

		await bash.exec("git checkout -b feature", { env: TEST_ENV });
		await bash.writeFile("/repo/feature.txt", "new feature\n");
		await bash.exec("git add .");
		await bash.exec('git commit -m "add feature"', { env: envAt(1000000100) });

		await bash.exec("git checkout main", { env: TEST_ENV });

		const mainRef = await repo.refStore.readRef("refs/heads/main");
		const featureRef = await repo.refStore.readRef("refs/heads/feature");
		if (!mainRef || mainRef.type !== "direct") throw new Error("expected main ref");
		if (!featureRef || featureRef.type !== "direct") throw new Error("expected feature ref");
		const mainHash = mainRef.hash;
		const featureHash = featureRef.hash;

		const mergeResult = await mergeTrees(repo, mainHash, featureHash);
		expect(mergeResult.clean).toBe(true);

		const mergeCommitHash = await createCommit(repo, {
			tree: mergeResult.treeHash,
			parents: [mainHash, featureHash],
			author: TEST_IDENTITY,
			committer: TEST_IDENTITY,
			message: "Merge pull request #1 from feature\n\nadd feature\n",
		});

		await repo.refStore.writeRef("refs/heads/main", {
			type: "direct",
			hash: mergeCommitHash,
		});

		const updatedMainRef = await repo.refStore.readRef("refs/heads/main");
		expect(updatedMainRef).toEqual({ type: "direct", hash: mergeCommitHash });

		const mergeCommit = await readCommit(repo, mergeCommitHash);
		expect(mergeCommit.parents).toEqual([mainHash, featureHash]);

		const featureContent = await readFileAtCommit(repo, mergeCommitHash, "feature.txt");
		expect(featureContent).toBe("new feature\n");

		const originalContent = await readFileAtCommit(repo, mergeCommitHash, "file.txt");
		expect(originalContent).toBe("initial content\n");
	});
});

// ── checkoutTo ──────────────────────────────────────────────────────

describe("checkoutTo", () => {
	test("materializes a commit's worktree onto a filesystem", async () => {
		const { repo, initialHash } = await setupWithCommits();

		const targetFs = new InMemoryFs();
		const result = await checkoutTo(repo, initialHash, targetFs);

		expect(result.commitHash).toBe(initialHash);
		expect(result.filesWritten).toBe(1);
		expect(result.treeHash).toHaveLength(40);

		const content = await targetFs.readFile("/file.txt");
		expect(content).toBe("initial content\n");
	});

	test("accepts a ref name", async () => {
		const { repo } = await setupWithCommits();

		const targetFs = new InMemoryFs();
		const result = await checkoutTo(repo, "HEAD", targetFs);

		expect(result.filesWritten).toBe(1);
		const content = await targetFs.readFile("/file.txt");
		expect(content).toBe("initial content\n");
	});

	test("accepts a full ref path", async () => {
		const { repo } = await setupWithCommits();

		const targetFs = new InMemoryFs();
		await checkoutTo(repo, "refs/heads/main", targetFs);

		const content = await targetFs.readFile("/file.txt");
		expect(content).toBe("initial content\n");
	});

	test("writes files under targetDir", async () => {
		const { repo } = await setupWithCommits();

		const targetFs = new InMemoryFs();
		await checkoutTo(repo, "HEAD", targetFs, "/workspace/code");

		const content = await targetFs.readFile("/workspace/code/file.txt");
		expect(content).toBe("initial content\n");
	});

	test("handles nested directories", async () => {
		const { bash, repo } = await setupWithCommits();

		await bash.exec("mkdir -p /repo/src/lib");
		await bash.writeFile("/repo/src/lib/utils.ts", "export const foo = 1;\n");
		await bash.writeFile("/repo/src/index.ts", "import { foo } from './lib/utils';\n");
		await bash.exec("git add .", { env: TEST_ENV });
		await bash.exec('git commit -m "add nested files"', { env: envAt(1000000100) });

		const targetFs = new InMemoryFs();
		const result = await checkoutTo(repo, "HEAD", targetFs);

		expect(result.filesWritten).toBe(3);
		expect(await targetFs.readFile("/file.txt")).toBe("initial content\n");
		expect(await targetFs.readFile("/src/index.ts")).toBe("import { foo } from './lib/utils';\n");
		expect(await targetFs.readFile("/src/lib/utils.ts")).toBe("export const foo = 1;\n");
	});

	test("checks out a specific historical commit, not latest", async () => {
		const { bash, repo, initialHash } = await setupWithCommits();

		await bash.writeFile("/repo/file.txt", "updated content\n");
		await bash.writeFile("/repo/extra.txt", "extra\n");
		await bash.exec("git add .", { env: TEST_ENV });
		await bash.exec('git commit -m "update"', { env: envAt(1000000100) });

		const targetFs = new InMemoryFs();
		const result = await checkoutTo(repo, initialHash, targetFs);

		expect(result.filesWritten).toBe(1);
		expect(await targetFs.readFile("/file.txt")).toBe("initial content\n");
		expect(await targetFs.exists("/extra.txt")).toBe(false);
	});

	test("throws for nonexistent ref", async () => {
		const { repo } = await setupWithCommits();
		const targetFs = new InMemoryFs();
		await expect(checkoutTo(repo, "refs/heads/nonexistent", targetFs)).rejects.toThrow("not found");
	});

	test("throws for nonexistent hash", async () => {
		const { repo } = await setupWithCommits();
		const targetFs = new InMemoryFs();
		await expect(
			checkoutTo(repo, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", targetFs),
		).rejects.toThrow("not found");
	});

	test("works with SqliteStorage-backed repos", async () => {
		const db = new Database(":memory:");
		const storage = new SqliteStorage(db);
		const repo = storage.repo("test-repo");

		await repo.refStore.writeRef("HEAD", {
			type: "symbolic",
			target: "refs/heads/main",
		});

		const readmeBlob = await writeBlob(repo, "# My Project\n");
		const configBlob = await writeBlob(repo, '{"name": "my-project"}\n');
		const srcBlob = await writeBlob(repo, "console.log('hello');\n");

		const srcTree = await writeTree(repo, [{ name: "index.ts", hash: srcBlob }]);
		const rootTree = await writeTree(repo, [
			{ name: "README.md", hash: readmeBlob },
			{ name: "package.json", hash: configBlob },
			{ name: "src", hash: srcTree, mode: "40000" },
		]);
		const commitHash = await createCommit(repo, {
			tree: rootTree,
			parents: [],
			author: TEST_IDENTITY,
			committer: TEST_IDENTITY,
			message: "initial\n",
		});
		await repo.refStore.writeRef("refs/heads/main", { type: "direct", hash: commitHash });

		const targetFs = new InMemoryFs();
		const result = await checkoutTo(repo, "refs/heads/main", targetFs, "/build");

		expect(result.filesWritten).toBe(3);
		expect(result.commitHash).toBe(commitHash);
		expect(await targetFs.readFile("/build/README.md")).toBe("# My Project\n");
		expect(await targetFs.readFile("/build/package.json")).toBe('{"name": "my-project"}\n');
		expect(await targetFs.readFile("/build/src/index.ts")).toBe("console.log('hello');\n");
	});

	test("use in beforeMerge hook — inspect PR files before allowing merge", async () => {
		const { createPlatform } = await import("../../src/platform/platform.ts");

		const db = new Database(":memory:");
		let inspectedFiles: string[] = [];

		const platform = createPlatform({
			database: db,
			on: {
				async beforeMerge(event) {
					const headSha = event.pr.headSha;
					if (!headSha) return;

					const fs = new InMemoryFs();
					await checkoutTo(event.repo, headSha, fs, "/review");

					const entries = await fs.readdir("/review");
					inspectedFiles = entries.sort();

					if (await fs.exists("/review/.env")) {
						return { reject: true, message: "cannot merge: .env file detected" };
					}
				},
			},
		});

		platform.createRepo("repo");
		const repo = platform.gitRepo("repo");

		const blob = await writeBlob(repo, "init\n");
		const tree = await writeTree(repo, [{ name: "README.md", hash: blob }]);
		const commit = await createCommit(repo, {
			tree,
			parents: [],
			author: TEST_IDENTITY,
			committer: TEST_IDENTITY,
			message: "init\n",
		});
		await repo.refStore.writeRef("refs/heads/main", { type: "direct", hash: commit });

		const featureBlob = await writeBlob(repo, "feature code\n");
		const featureTree = await writeTree(repo, [
			{ name: "README.md", hash: blob },
			{ name: "feature.ts", hash: featureBlob },
		]);
		const featureCommit = await createCommit(repo, {
			tree: featureTree,
			parents: [commit],
			author: { ...TEST_IDENTITY, timestamp: 1000000100 },
			committer: { ...TEST_IDENTITY, timestamp: 1000000100 },
			message: "add feature\n",
		});
		await repo.refStore.writeRef("refs/heads/feature", {
			type: "direct",
			hash: featureCommit,
		});

		const pr = await platform.createPullRequest("repo", {
			head: "feature",
			base: "main",
			title: "Add feature",
			author: { name: "Test", email: "test@test.com" },
		});

		const result = await platform.mergePullRequest("repo", pr.number, {
			strategy: "merge",
			committer: { ...TEST_IDENTITY, timestamp: 1000000200 },
		});

		expect(result.sha).toHaveLength(40);
		expect(inspectedFiles).toEqual(["README.md", "feature.ts"]);
	});

	test("use in beforeMerge hook — reject merge based on file content", async () => {
		const { createPlatform } = await import("../../src/platform/platform.ts");
		const { MergeError } = await import("../../src/platform/pull-requests.ts");

		const db = new Database(":memory:");

		const platform = createPlatform({
			database: db,
			on: {
				async beforeMerge(event) {
					const headSha = event.pr.headSha;
					if (!headSha) return;

					const fs = new InMemoryFs();
					await checkoutTo(event.repo, headSha, fs, "/review");

					if (await fs.exists("/review/.env")) {
						return { reject: true, message: ".env file not allowed" };
					}
				},
			},
		});

		platform.createRepo("repo");
		const repo = platform.gitRepo("repo");

		const blob = await writeBlob(repo, "init\n");
		const tree = await writeTree(repo, [{ name: "README.md", hash: blob }]);
		const commit = await createCommit(repo, {
			tree,
			parents: [],
			author: TEST_IDENTITY,
			committer: TEST_IDENTITY,
			message: "init\n",
		});
		await repo.refStore.writeRef("refs/heads/main", { type: "direct", hash: commit });

		const envBlob = await writeBlob(repo, "SECRET=hunter2\n");
		const badTree = await writeTree(repo, [
			{ name: ".env", hash: envBlob },
			{ name: "README.md", hash: blob },
		]);
		const badCommit = await createCommit(repo, {
			tree: badTree,
			parents: [commit],
			author: { ...TEST_IDENTITY, timestamp: 1000000100 },
			committer: { ...TEST_IDENTITY, timestamp: 1000000100 },
			message: "add secrets\n",
		});
		await repo.refStore.writeRef("refs/heads/bad-branch", {
			type: "direct",
			hash: badCommit,
		});

		const pr = await platform.createPullRequest("repo", {
			head: "bad-branch",
			base: "main",
			title: "Bad PR",
			author: { name: "Test", email: "test@test.com" },
		});

		try {
			await platform.mergePullRequest("repo", pr.number, {
				strategy: "merge",
				committer: { ...TEST_IDENTITY, timestamp: 1000000200 },
			});
			expect(true).toBe(false);
		} catch (e) {
			expect(e).toBeInstanceOf(MergeError);
			expect((e as InstanceType<typeof MergeError>).message).toBe(".env file not allowed");
		}

		expect(platform.getPullRequest("repo", pr.number)!.state).toBe("open");
	});

	test("use in onPush callback — inspect pushed code", async () => {
		const { createPlatform } = await import("../../src/platform/platform.ts");

		const db = new Database(":memory:");
		let pushedFiles: string[] = [];

		const platform = createPlatform({
			database: db,
			on: {
				async onPush(event) {
					const fs = new InMemoryFs();
					await checkoutTo(event.repo, event.newHash, fs, "/snapshot");
					const entries = await fs.readdir("/snapshot");
					pushedFiles = entries.sort();
				},
			},
		});

		platform.createRepo("repo");
		const repo = platform.gitRepo("repo");

		const blob = await writeBlob(repo, "init\n");
		const tree = await writeTree(repo, [{ name: "README.md", hash: blob }]);
		const commit = await createCommit(repo, {
			tree,
			parents: [],
			author: TEST_IDENTITY,
			committer: TEST_IDENTITY,
			message: "init\n",
		});
		await repo.refStore.writeRef("refs/heads/main", { type: "direct", hash: commit });

		const server = platform.gitServer();
		const port = 49152 + Math.floor(Math.random() * 16000);
		const bunServer = Bun.serve({ port, fetch: server.fetch });

		try {
			const clientFs = new InMemoryFs();
			const git = createGit();
			const bash = new Bash({ fs: clientFs, cwd: "/local", customCommands: [git] });

			const env = {
				GIT_AUTHOR_NAME: "Test",
				GIT_AUTHOR_EMAIL: "test@test.com",
				GIT_COMMITTER_NAME: "Test",
				GIT_COMMITTER_EMAIL: "test@test.com",
				GIT_AUTHOR_DATE: "1000000100",
				GIT_COMMITTER_DATE: "1000000100",
			};

			await bash.exec(`git clone http://localhost:${port}/repo /local`, { env });
			await bash.writeFile("/local/app.ts", "console.log('hello');\n");
			await bash.exec("git add .", { env });
			await bash.exec('git commit -m "add app"', { env });
			await bash.exec("git push origin main", { env });

			expect(pushedFiles).toEqual(["README.md", "app.ts"]);
		} finally {
			bunServer.stop(true);
		}
	});
});
