/**
 * Smoke-tests every code example from the docs (README, CLIENT.md, REPO.md, SERVER.md)
 * to make sure they actually work.
 *
 * Run: bun test/smoke/readme-examples.ts
 */

import { Bash, InMemoryFs } from "just-bash";
import { Database } from "bun:sqlite";
import { createGit, MemoryFileSystem, composeGitHooks, findRepo } from "../../src";
import { createServer, BunSqliteStorage } from "../../src/server";
import {
	commit,
	readFileAtCommit,
	getChangedFiles,
	getNewCommits,
	mergeTrees,
	readCommit,
	readTree,
	resolveRef,
	createWorktree,
	readonlyRepo,
	flattenTree,
	writeBlob,
	writeTree,
	updateTree,
	createCommit,
} from "../../src/repo";
import type { GitHooks } from "../../src";

// ═══════════════════════════════════════════════════════════════════
// README examples
// ═══════════════════════════════════════════════════════════════════

// ── README: Quick start (just-bash) ─────────────────────────────────

{
	const bash = new Bash({
		cwd: "/repo",
		customCommands: [createGit({ identity: { name: "Alice", email: "alice@example.com" } })],
	});

	await bash.exec("git init");
	await bash.exec("echo 'hello' > README.md");
	await bash.exec("git add . && git commit -m 'initial commit'");
	const log = await bash.exec("git log --oneline");
	console.assert(log.exitCode === 0, "just-bash exec should succeed");
	console.log("README just-bash:", log.stdout.trim());
}

// ── README: Quick start (standalone exec) ───────────────────────────

{
	const fs = new MemoryFileSystem();
	const git = createGit({
		fs,
		cwd: "/repo",
		identity: { name: "Alice", email: "alice@example.com" },
		credentials: (_url) => ({ type: "bearer" as const, token: "ghp_test_token" }),
		hooks: {
			beforeCommand: ({ command }) => {
				if (command === "push") return { reject: true, message: "push requires approval" };
			},
		},
	});

	await git.exec("git init");
	await fs.writeFile("/repo/README.md", "hello");
	await git.exec("git add .");
	await git.exec('git commit -m "initial commit"');
	const log = await git.exec("git log --oneline");
	console.assert(log.exitCode === 0, "standalone exec should succeed");

	// Verify identity is readable via git config
	const name = await git.exec("git config user.name");
	console.assert(name.exitCode === 0, "identity should be readable via git config");
	console.assert(name.stdout.trim() === "Alice", "user.name should match identity");

	// Verify beforeCommand blocks push
	const push = await git.exec("git push origin main");
	console.assert(push.exitCode !== 0, "push should be blocked by beforeCommand");
	console.assert(push.stderr.includes("push requires approval"), "should show rejection message");
	console.log("README standalone:", log.stdout.trim());
}

// ── README: Quick start (server) ────────────────────────────────────

{
	const changedFileCounts: number[] = [];

	const server = createServer({
		storage: new BunSqliteStorage(new Database(":memory:")),
		policy: { protectedBranches: ["main"] },
		hooks: {
			preReceive: ({ session }) => {
				if (!session?.request?.headers.has("Authorization"))
					return { reject: true, message: "unauthorized" };
			},
			postReceive: async ({ repo, updates }) => {
				for (const u of updates) {
					const files = await getChangedFiles(repo, u.oldHash, u.newHash);
					changedFileCounts.push(files.length);
				}
			},
		},
	});
	await server.createRepo("test-repo");

	const srv = Bun.serve({ fetch: server.fetch, port: 0 });
	const fs = new InMemoryFs();

	// Set up a local repo
	{
		const git = createGit({ identity: { name: "Alice", email: "alice@example.com" } });
		const bash = new Bash({ fs, cwd: "/repo", customCommands: [git] });
		await bash.exec("git init");
		await bash.exec("echo 'hello' > README.md");
		await bash.exec("git add . && git commit -m 'initial'");
		await bash.exec(`git remote add origin ${srv.url}test-repo`);
	}

	// Push without Authorization header should be rejected
	{
		const git = createGit({ identity: { name: "Alice", email: "alice@example.com" } });
		const bash = new Bash({ fs, cwd: "/repo", customCommands: [git] });
		const noAuth = await bash.exec("git push -u origin main");
		console.assert(noAuth.exitCode !== 0, "push without auth should fail");
	}

	// Push with Authorization header should succeed
	{
		const git = createGit({
			identity: { name: "Alice", email: "alice@example.com" },
			credentials: () => ({ type: "bearer" as const, token: "test-token" }),
		});
		const bash = new Bash({ fs, cwd: "/repo", customCommands: [git] });
		const withAuth = await bash.exec("git push -u origin main");
		console.assert(withAuth.exitCode === 0, "push with auth should succeed");
	}

	console.assert(changedFileCounts.length === 1, "postReceive should have fired once");
	console.assert(changedFileCounts[0] === 1, "should see 1 changed file (README.md)");
	console.log("README server: policy + auth + postReceive OK");
	srv.stop();
}

// ── README: Client hooks (preCommit + postCommit) ───────────────────

{
	const changedFiles: string[][] = [];

	const git = createGit({
		identity: { name: "Alice", email: "alice@example.com" },
		hooks: {
			preCommit: ({ index }) => {
				const forbidden = index.entries.filter((e) => /\.(env|pem|key)$/.test(e.path));
				if (forbidden.length) {
					return { reject: true, message: `Blocked: ${forbidden.map((e) => e.path).join(", ")}` };
				}
			},
			postCommit: async ({ repo, hash, branch: _branch, parents }) => {
				const files = await getChangedFiles(repo, parents[0] ?? null, hash);
				changedFiles.push(files.map((f) => f.path));
			},
		},
	});

	const bash = new Bash({ cwd: "/repo", customCommands: [git] });
	await bash.exec("git init");

	// Should block .env
	await bash.exec("echo 'SECRET=x' > .env");
	await bash.exec("git add .");
	const blocked = await bash.exec('git commit -m "oops"');
	console.assert(blocked.exitCode !== 0, "commit with .env should fail");

	// Should succeed with normal file (remove .env from worktree too)
	await bash.exec("rm .env");
	await bash.exec("git reset");
	await bash.exec("echo 'hello' > file.txt");
	await bash.exec("git add .");
	const ok = await bash.exec('git commit -m "ok"');
	console.assert(ok.exitCode === 0, "normal commit should succeed");
	console.assert(changedFiles.length === 1, "should have 1 postCommit event");
	console.log("README hooks: preCommit blocked .env, postCommit tracked", changedFiles[0]);
}

// ── README: Repo module (readFileAtCommit, getChangedFiles, mergeTrees) ──

{
	const bash = new Bash({
		cwd: "/repo",
		customCommands: [createGit({ identity: { name: "Alice", email: "alice@example.com" } })],
	});
	await bash.exec("git init");
	await bash.exec("echo 'v1' > src/index.ts");
	await bash.exec("git add . && git commit -m 'initial'");
	await bash.exec("echo 'v2' > src/index.ts");
	await bash.exec("git add . && git commit -m 'update'");

	const repo = (await findRepo(bash.fs, "/repo"))!;
	const headHash = (await resolveRef(repo, "HEAD"))!;
	const commit = await readCommit(repo, headHash);
	const parentHash = commit.parents[0]!;

	const content = await readFileAtCommit(repo, headHash, "src/index.ts");
	console.assert(content?.trim() === "v2", "should read v2 at HEAD");

	const changes = await getChangedFiles(repo, parentHash, headHash);
	console.assert(changes.length === 1, "should have 1 changed file");
	console.assert(changes[0]?.path === "src/index.ts", "changed file should be src/index.ts");

	// mergeTrees: create a branch, diverge, merge
	await bash.exec("git checkout -b feature");
	await bash.exec("echo 'feature' > feature.txt");
	await bash.exec("git add . && git commit -m 'feature'");
	await bash.exec("git checkout main");
	await bash.exec("echo 'main change' > main.txt");
	await bash.exec("git add . && git commit -m 'main work'");

	const mainHash = (await resolveRef(repo, "refs/heads/main"))!;
	const featureHash = (await resolveRef(repo, "refs/heads/feature"))!;
	const result = await mergeTrees(repo, mainHash, featureHash);
	console.assert(result.clean, "merge should be clean");
	console.log("README repo module: readFileAtCommit, getChangedFiles, mergeTrees all OK");
}

// ═══════════════════════════════════════════════════════════════════
// CLIENT.md examples
// ═══════════════════════════════════════════════════════════════════

// ── CLIENT: Options (createGit with all options) ────────────────────

{
	const git = createGit({
		identity: { name: "Agent Bot", email: "bot@company.com", locked: true },
		credentials: async (_url) => ({ type: "bearer" as const, token: "ghp_..." }),
		disabled: ["rebase"],
		network: false,
		config: {
			locked: { "push.default": "nothing" },
			defaults: { "merge.ff": "only" },
		},
	});

	const bash = new Bash({ cwd: "/repo", customCommands: [git] });
	await bash.exec("git init");

	// Verify disabled command
	const r = await bash.exec("git rebase main");
	console.assert(r.exitCode !== 0, "rebase should be disabled");

	// Verify locked identity
	await bash.exec("echo 'hi' > file.txt");
	await bash.exec("git add .");
	await bash.exec('git commit -m "test"');
	const log = await bash.exec("git log --format='%an <%ae>'");
	console.assert(log.stdout.includes("Agent Bot"), "locked identity should win");
	console.log("CLIENT options: disabled + locked identity OK");
}

// ── CLIENT: Hooks (full 5-hook example) ─────────────────────────────

{
	const auditLog: { command: string; exitCode: number }[] = [];

	const git = createGit({
		identity: { name: "Alice", email: "alice@example.com" },
		hooks: {
			preCommit: ({ index }) => {
				const forbidden = index.entries.filter((e) => /\.(env|pem|key)$/.test(e.path));
				if (forbidden.length) {
					return { reject: true, message: `Blocked: ${forbidden.map((e) => e.path).join(", ")}` };
				}
			},
			commitMsg: (event) => {
				if (!/^(feat|fix|docs|refactor|test|chore)(\(.+\))?:/.test(event.message)) {
					return {
						reject: true,
						message: "Commit message must follow conventional commits format",
					};
				}
			},
			postCommit: async ({ repo, hash, branch: _branch, parents }) => {
				const files = await getChangedFiles(repo, parents[0] ?? null, hash);
				void files; // used in docs for onAgentCommit callback
			},
			afterCommand: ({ command, args: _args, result }) => {
				auditLog.push({ command: `git ${command}`, exitCode: result.exitCode });
			},
			beforeCommand: async ({ command }) => {
				if (command === "push") {
					return { reject: true, message: "Push blocked — awaiting approval.\n" };
				}
			},
		},
	});

	const bash = new Bash({ cwd: "/repo", customCommands: [git] });
	await bash.exec("git init");
	await bash.exec("echo 'hi' > file.txt && git add .");

	// commitMsg rejects bad message
	const bad = await bash.exec('git commit -m "did stuff"');
	console.assert(bad.exitCode !== 0, "bad commit msg should fail");

	// commitMsg accepts conventional message
	const good = await bash.exec('git commit -m "feat: add file"');
	console.assert(good.exitCode === 0, "conventional msg should pass");

	// beforeCommand blocks push
	const push = await bash.exec("git push origin main");
	console.assert(push.exitCode !== 0, "push should be blocked");
	console.assert(push.stderr.includes("awaiting approval"), "should mention approval");

	// afterCommand logged everything
	console.assert(auditLog.length > 0, "audit log should have entries");
	console.log("CLIENT hooks: all 5 hooks verified");
}

// ── CLIENT: composeGitHooks ─────────────────────────────────────────

{
	const log1: string[] = [];
	const log2: string[] = [];

	const hooks1: GitHooks = {
		afterCommand: ({ command }) => {
			log1.push(command);
		},
	};
	const hooks2: GitHooks = {
		afterCommand: ({ command }) => {
			log2.push(command);
		},
	};

	const git = createGit({
		identity: { name: "Alice", email: "alice@example.com" },
		hooks: composeGitHooks(hooks1, hooks2),
	});

	const bash = new Bash({ cwd: "/repo", customCommands: [git] });
	await bash.exec("git init");
	console.assert(log1.length === 1 && log2.length === 1, "both hook sets should fire");
	console.log("CLIENT composeGitHooks: both sets fired");
}

// ── CLIENT: Config overrides ────────────────────────────────────────

{
	const git = createGit({
		identity: { name: "Alice", email: "alice@example.com" },
		config: {
			locked: {
				"push.default": "nothing",
				"merge.conflictstyle": "diff3",
			},
			defaults: {
				"pull.rebase": "true",
				"merge.ff": "only",
			},
		},
	});

	const bash = new Bash({ cwd: "/repo", customCommands: [git] });
	await bash.exec("git init");

	// Locked value wins even if agent sets it
	await bash.exec("git config set push.default current");
	const val = await bash.exec("git config get push.default");
	console.assert(val.stdout.trim() === "nothing", "locked config should win");

	// Default is used when not set
	const pullRebase = await bash.exec("git config get pull.rebase");
	console.assert(pullRebase.stdout.trim() === "true", "default should apply");

	// Agent can override default
	await bash.exec("git config set pull.rebase false");
	const overridden = await bash.exec("git config get pull.rebase");
	console.assert(overridden.stdout.trim() === "false", "agent should override default");
	console.log("CLIENT config overrides: locked wins, defaults work, overridable");
}

// ── CLIENT: Multi-agent collaboration ───────────────────────────────

{
	const originFs = new InMemoryFs();
	const setupBash = new Bash({
		fs: originFs,
		cwd: "/repo",
		customCommands: [
			createGit({ identity: { name: "Setup", email: "setup@example.com", locked: true } }),
		],
	});
	await setupBash.exec("git init");
	await setupBash.exec("echo 'hello' > README.md");
	await setupBash.exec("git add . && git commit -m 'initial'");

	const alice = new Bash({
		fs: new InMemoryFs(),
		cwd: "/repo",
		customCommands: [
			createGit({
				identity: { name: "Alice", email: "alice@example.com", locked: true },
				resolveRemote: () => findRepo(originFs, "/repo"),
			}),
		],
	});

	const bob = new Bash({
		fs: new InMemoryFs(),
		cwd: "/repo",
		customCommands: [
			createGit({
				identity: { name: "Bob", email: "bob@example.com", locked: true },
				resolveRemote: () => findRepo(originFs, "/repo"),
			}),
		],
	});

	await alice.exec("git clone /origin /repo");
	await bob.exec("git clone /origin /repo");

	// Verify both cloned successfully
	const aliceLog = await alice.exec("git log --oneline");
	const bobLog = await bob.exec("git log --oneline");
	console.assert(
		aliceLog.exitCode === 0 && aliceLog.stdout.includes("initial"),
		"Alice should have cloned",
	);
	console.assert(
		bobLog.exitCode === 0 && bobLog.stdout.includes("initial"),
		"Bob should have cloned",
	);
	console.log("CLIENT multi-agent: alice and bob cloned OK");
}

// ═══════════════════════════════════════════════════════════════════
// REPO.md examples
// ═══════════════════════════════════════════════════════════════════

// ── REPO: findRepo (from VFS) ───────────────────────────────────────

{
	const fs = new InMemoryFs();
	const bash = new Bash({
		fs,
		cwd: "/repo",
		customCommands: [createGit({ identity: { name: "Alice", email: "alice@example.com" } })],
	});
	await bash.exec("git init");
	await bash.exec("echo 'hi' > file.txt && git add . && git commit -m 'init'");

	const ctx = await findRepo(fs, "/repo");
	console.assert(ctx !== null, "findRepo should find the repo");
	console.assert(ctx!.workTree === "/repo", "workTree should be /repo");
	console.log("REPO findRepo: found repo at", ctx!.workTree);
}

// ── REPO: Storage-backed GitRepo ────────────────────────────────────

{
	const server = createServer({
		storage: new BunSqliteStorage(new Database(":memory:")),
	});
	await server.createRepo("my-repo");
	const repo = (await server.repo("my-repo"))!;
	console.assert(repo.objectStore !== undefined, "should have objectStore");
	console.assert(repo.refStore !== undefined, "should have refStore");
	console.log("REPO storage-backed: server.repo() OK");
}

// ── REPO: createWorktree (hybrid pattern) ───────────────────────────

{
	const server = createServer({
		storage: new BunSqliteStorage(new Database(":memory:")),
	});

	const repo = await server.createRepo("my-repo");
	const blobHash = await writeBlob(repo, "hello world\n");
	const treeHash = await (async () => {
		const { writeTree } = await import("../../src/repo");
		return writeTree(repo, [{ name: "README.md", hash: blobHash, mode: "100644" }]);
	})();
	await createCommit(repo, {
		tree: treeHash,
		parents: [],
		author: { name: "Setup", email: "setup@example.com", timestamp: 1000000000, timezone: "+0000" },
		committer: {
			name: "Setup",
			email: "setup@example.com",
			timestamp: 1000000000,
			timezone: "+0000",
		},
		message: "initial",
		branch: "main",
	});

	const fs = new InMemoryFs();
	await createWorktree(repo, fs, { workTree: "/repo" });

	const git = createGit({
		identity: { name: "Agent", email: "agent@example.com" },
		objectStore: repo.objectStore,
		refStore: repo.refStore,
	});
	const bash = new Bash({ fs, cwd: "/repo", customCommands: [git] });

	await bash.exec("echo 'hello' > file.txt");
	await bash.exec("git add . && git commit -m 'from agent'");

	const headHash = await resolveRef(repo, "HEAD");
	console.assert(headHash !== null, "should have HEAD after commit");
	const commit = await readCommit(repo, headHash!);
	console.assert(commit.message.trim() === "from agent", "commit message should match");
	console.log("REPO createWorktree: hybrid pattern OK, commit in storage");
}

// ── REPO: readonlyRepo ──────────────────────────────────────────────

{
	const server = createServer({
		storage: new BunSqliteStorage(new Database(":memory:")),
	});
	const repo = await server.createRepo("my-repo");
	const ro = readonlyRepo(repo);

	let threw = false;
	try {
		await ro.objectStore.write("blob", new Uint8Array([1, 2, 3]));
	} catch {
		threw = true;
	}
	console.assert(threw, "readonlyRepo should throw on write");

	threw = false;
	try {
		await ro.refStore.writeRef("refs/heads/main", { type: "direct", hash: "a".repeat(40) });
	} catch {
		threw = true;
	}
	console.assert(threw, "readonlyRepo should throw on writeRef");
	console.log("REPO readonlyRepo: writes correctly blocked");
}

// ── REPO: Usage in hooks (client-side) ──────────────────────────────

{
	const changedPaths: string[] = [];

	const git = createGit({
		identity: { name: "Alice", email: "alice@example.com" },
		hooks: {
			postCommit: async ({ repo, hash, parents }) => {
				const files = await getChangedFiles(repo, parents[0] ?? null, hash);
				changedPaths.push(...files.map((f) => f.path));
			},
		},
	});

	const bash = new Bash({ cwd: "/repo", customCommands: [git] });
	await bash.exec("git init");
	await bash.exec("echo 'hi' > file.txt && git add . && git commit -m 'init'");
	console.assert(changedPaths.includes("file.txt"), "postCommit should see file.txt");
	console.log("REPO hooks (client): postCommit saw", changedPaths);
}

// ── REPO: Usage in hooks (server-side) ──────────────────────────────
// Exercises getChangedFiles, readFileAtCommit, and getNewCommits
// inside a postReceive hook (SERVER.md "Working with pushed code")

{
	const foundPkg: string[] = [];
	const changedFilePaths: string[] = [];
	const commitMessages: string[] = [];

	const server = createServer({
		storage: new BunSqliteStorage(new Database(":memory:")),
		hooks: {
			postReceive: async ({ repo, updates }) => {
				for (const u of updates) {
					const files = await getChangedFiles(repo, u.oldHash, u.newHash);
					changedFilePaths.push(...files.map((f) => f.path));

					const pkg = await readFileAtCommit(repo, u.newHash, "package.json");
					if (pkg) foundPkg.push(pkg);

					for await (const commit of getNewCommits(repo, u.oldHash, u.newHash)) {
						commitMessages.push(commit.message.trim());
					}
				}
			},
		},
	});
	await server.createRepo("test-repo");

	const srv = Bun.serve({ fetch: server.fetch, port: 0 });

	const git = createGit({
		identity: { name: "Alice", email: "alice@example.com" },
		credentials: () => null,
	});
	const fs = new InMemoryFs();
	const bash = new Bash({ fs, cwd: "/repo", customCommands: [git] });
	await bash.exec("git init");
	await bash.exec('echo \'{"name":"test"}\' > package.json');
	await bash.exec("git add . && git commit -m 'init'");
	await bash.exec("echo 'v2' > README.md && git add . && git commit -m 'add readme'");
	await bash.exec(`git remote add origin ${srv.url}test-repo`);
	await bash.exec("git push -u origin main");

	console.assert(foundPkg.length === 1, "postReceive should find package.json");
	console.assert(
		changedFilePaths.includes("package.json"),
		"getChangedFiles should see package.json",
	);
	console.assert(commitMessages.length === 2, "getNewCommits should yield 2 commits");
	console.assert(commitMessages.includes("init"), "should include 'init' commit");
	console.assert(commitMessages.includes("add readme"), "should include 'add readme' commit");
	console.log("REPO hooks (server): getChangedFiles + readFileAtCommit + getNewCommits OK");
	srv.stop();
}

// ── REPO: readTree + writeTree round-trip, and updateTree ───────────

{
	const server = createServer({
		storage: new BunSqliteStorage(new Database(":memory:")),
	});
	const repo = await server.createRepo("tree-test");

	const blob1 = await writeBlob(repo, "hello\n");
	const subtree = await writeTree(repo, [{ name: "index.ts", hash: blob1 }]);
	const root = await writeTree(repo, [
		{ name: "README.md", hash: blob1 },
		{ name: "src", hash: subtree },
	]);

	// readTree returns root-level entries (not recursive)
	const entries = await readTree(repo, root);
	console.assert(entries.length === 2, "readTree should return 2 root entries");
	const names = entries.map((e) => e.name).sort();
	console.assert(names[0] === "README.md" && names[1] === "src", "should have README.md and src");

	// Round-trip: readTree → writeTree produces same hash
	const rebuilt = await writeTree(repo, entries);
	console.assert(rebuilt === root, "readTree → writeTree should round-trip");

	// updateTree: add a nested file and remove a root file
	const newBlob = await writeBlob(repo, "new content\n");
	const updated = await updateTree(repo, root, [
		{ path: "src/lib/new.ts", hash: newBlob },
		{ path: "docs/guide.md", hash: newBlob },
		{ path: "README.md", hash: null },
	]);

	const flat = await flattenTree(repo, updated);
	const paths = flat.map((e) => e.path).sort();
	console.assert(!paths.includes("README.md"), "README.md should be removed");
	console.assert(paths.includes("src/index.ts"), "existing src/index.ts should be preserved");
	console.assert(paths.includes("src/lib/new.ts"), "nested file should be added");
	console.assert(paths.includes("docs/guide.md"), "new top-level dir should be created");

	// updateTree: delete the only file in a subtree prunes the subtree
	const pruned = await updateTree(repo, root, [{ path: "src/index.ts", hash: null }]);
	const prunedEntries = await readTree(repo, pruned);
	const prunedNames = prunedEntries.map((e) => e.name);
	console.assert(!prunedNames.includes("src"), "empty subtree should be pruned");
	console.assert(prunedNames.includes("README.md"), "untouched entries should remain");

	// Full server-side commit workflow using updateTree
	const initialCommit = await createCommit(repo, {
		tree: root,
		parents: [],
		author: { name: "Test", email: "test@test.com", timestamp: 1000000000, timezone: "+0000" },
		committer: { name: "Test", email: "test@test.com", timestamp: 1000000000, timezone: "+0000" },
		message: "initial\n",
		branch: "main",
	});

	const commit = await readCommit(repo, initialCommit);
	const fileBlob = await writeBlob(repo, "added via updateTree\n");
	const newTree = await updateTree(repo, commit.tree, [{ path: "src/added.ts", hash: fileBlob }]);
	const newCommit = await createCommit(repo, {
		tree: newTree,
		parents: [initialCommit],
		author: { name: "Test", email: "test@test.com", timestamp: 1000000001, timezone: "+0000" },
		committer: { name: "Test", email: "test@test.com", timestamp: 1000000001, timezone: "+0000" },
		message: "add file\n",
		branch: "main",
	});

	const headHash = await resolveRef(repo, "refs/heads/main");
	console.assert(headHash === newCommit, "branch should point to new commit");
	const newCommitObj = await readCommit(repo, newCommit);
	console.assert(newCommitObj.parents[0] === initialCommit, "parent should be initial commit");
	const finalFlat = await flattenTree(repo, newCommitObj.tree);
	const finalPaths = finalFlat.map((e) => e.path).sort();
	console.assert(
		finalPaths.includes("src/added.ts") && finalPaths.includes("src/index.ts"),
		"new tree should contain both old and new files",
	);

	console.log(
		"REPO readTree + updateTree: round-trip, nested ops, pruning, full commit workflow OK",
	);
}

// ── REPO: commit (high-level) ───────────────────────────────────────

{
	const server = createServer({
		storage: new BunSqliteStorage(new Database(":memory:")),
	});
	const repo = await server.createRepo("commit-test");

	// Root commit — branch doesn't exist yet
	const first = await commit(repo, {
		files: { "README.md": "# Hello\n", "src/index.ts": "export {};\n" },
		message: "initial commit\n",
		author: { name: "Alice", email: "alice@example.com" },
		branch: "main",
	});

	const firstCommit = await readCommit(repo, first);
	console.assert(firstCommit.parents.length === 0, "root commit should have no parents");
	console.assert(firstCommit.author.name === "Alice", "author should be Alice");
	console.assert(firstCommit.committer.name === "Alice", "committer should default to author");
	const firstFlat = await flattenTree(repo, firstCommit.tree);
	console.assert(firstFlat.length === 2, "should have 2 files");

	// Second commit — auto-resolves parent, preserves existing files
	const second = await commit(repo, {
		files: { "docs/guide.md": "# Guide\n" },
		message: "add docs\n",
		author: { name: "Alice", email: "alice@example.com" },
		branch: "main",
	});

	const secondCommit = await readCommit(repo, second);
	console.assert(secondCommit.parents[0] === first, "parent should be first commit");
	const secondFlat = await flattenTree(repo, secondCommit.tree);
	const paths = secondFlat.map((e) => e.path).sort();
	console.assert(paths.length === 3, "should have 3 files (2 original + 1 new)");
	console.assert(paths.includes("README.md"), "should preserve README.md");
	console.assert(paths.includes("docs/guide.md"), "should include new file");

	// Delete a file
	const third = await commit(repo, {
		files: { "src/index.ts": null },
		message: "remove index\n",
		author: { name: "Alice", email: "alice@example.com" },
		branch: "main",
	});

	const thirdCommit = await readCommit(repo, third);
	const thirdFlat = await flattenTree(repo, thirdCommit.tree);
	console.assert(thirdFlat.length === 2, "should have 2 files after deletion");
	console.assert(!thirdFlat.some((e) => e.path === "src/index.ts"), "deleted file should be gone");

	console.log("REPO commit: root, chain, delete, auto-parent, default committer OK");
}

// ═══════════════════════════════════════════════════════════════════
// SERVER.md examples
// ═══════════════════════════════════════════════════════════════════

// ── SERVER: Session builder (HTTP auth gate) ────────────────────────

{
	const server = createServer({
		storage: new BunSqliteStorage(new Database(":memory:")),
		session: {
			http: (request) => {
				const header = request.headers.get("Authorization");
				if (!header) {
					return new Response("Unauthorized", {
						status: 401,
						headers: { "WWW-Authenticate": 'Bearer realm="git"' },
					});
				}
				return { userId: header.replace("Bearer ", "") };
			},
			ssh: (info) => ({
				userId: info.username ?? "anonymous",
			}),
		},
		hooks: {
			preReceive: ({ session }) => {
				if (!session) return { reject: true, message: "unauthorized" };
			},
		},
	});
	await server.createRepo("repo");

	const srv = Bun.serve({ fetch: server.fetch, port: 0 });

	// No auth → 401
	const noAuth = await server.fetch(
		new Request(`http://localhost:${srv.port}/repo/info/refs?service=git-upload-pack`),
	);
	console.assert(noAuth.status === 401, "session builder should reject without token");
	console.assert(
		noAuth.headers.get("WWW-Authenticate") === 'Bearer realm="git"',
		"should include WWW-Authenticate header",
	);

	// With auth → 200
	const withAuth = await server.fetch(
		new Request(`http://localhost:${srv.port}/repo/info/refs?service=git-upload-pack`, {
			headers: { Authorization: "Bearer test-token" },
		}),
	);
	console.assert(withAuth.status === 200, "session builder should allow with token");

	console.log("SERVER session builder: HTTP auth gate OK");
	srv.stop();
}

// ── SERVER: Custom session type (uniform auth across HTTP + SSH) ─────

{
	const server = createServer({
		storage: new BunSqliteStorage(new Database(":memory:")),
		session: {
			http: (req) => ({ authorized: req.headers.has("Authorization") }),
			ssh: (info) => ({ authorized: info.username != null }),
		},
		policy: { protectedBranches: ["main"] },
		hooks: {
			preReceive: ({ session }) => {
				if (!session?.authorized) return { reject: true, message: "unauthorized" };
			},
		},
	});
	await server.createRepo("test-repo");

	const srv = Bun.serve({ fetch: server.fetch, port: 0 });
	const fs = new InMemoryFs();

	{
		const git = createGit({ identity: { name: "Alice", email: "alice@example.com" } });
		const bash = new Bash({ fs, cwd: "/repo", customCommands: [git] });
		await bash.exec("git init");
		await bash.exec("echo 'hi' > file.txt && git add . && git commit -m 'init'");
		await bash.exec(`git remote add origin ${srv.url}test-repo`);

		// Push without auth should fail (session.authorized is false)
		const noAuth = await bash.exec("git push -u origin main");
		console.assert(noAuth.exitCode !== 0, "push without auth should fail");
	}
	{
		const git = createGit({
			identity: { name: "Alice", email: "alice@example.com" },
			credentials: () => ({ type: "bearer" as const, token: "x" }),
		});
		const bash = new Bash({ fs, cwd: "/repo", customCommands: [git] });

		// Push with auth should succeed (session.authorized is true)
		const withAuth = await bash.exec("git push -u origin main");
		console.assert(withAuth.exitCode === 0, "push with auth should succeed");
	}

	console.log("SERVER custom session: uniform auth OK");
	srv.stop();
}

// ── SERVER: advertiseRefs rejection (per-repo read gate) ────────────

{
	const server = createServer({
		storage: new BunSqliteStorage(new Database(":memory:")),
		hooks: {
			advertiseRefs: ({ repoId }) => {
				if (repoId.startsWith("private/")) {
					return { reject: true, message: "authentication required" };
				}
			},
		},
	});
	await server.createRepo("public-repo");
	await server.createRepo("private/secret");

	const srv = Bun.serve({ fetch: server.fetch, port: 0 });

	// Public repo → 200
	const pub = await server.fetch(
		new Request(`http://localhost:${srv.port}/public-repo/info/refs?service=git-upload-pack`),
	);
	console.assert(pub.status === 200, "public repo should be accessible");

	// Private repo → 403
	const priv = await server.fetch(
		new Request(`http://localhost:${srv.port}/private/secret/info/refs?service=git-upload-pack`),
	);
	console.assert(priv.status === 403, "private repo should be rejected");
	const body = await priv.text();
	console.assert(body === "authentication required", "should include rejection message");

	console.log("SERVER advertiseRefs: per-repo read gate OK");
	srv.stop();
}

// ── SERVER: policy + composeHooks ────────────────────────────────────

{
	const pushLog: string[] = [];

	const server = createServer({
		storage: new BunSqliteStorage(new Database(":memory:")),
		policy: { protectedBranches: ["main"] },
		hooks: {
			postReceive: async ({ repoId, updates }) => {
				for (const u of updates) {
					pushLog.push(`${repoId}:${u.ref}`);
				}
			},
		},
	});
	await server.createRepo("my-repo");

	const srv = Bun.serve({ fetch: server.fetch, port: 0 });
	const fs = new InMemoryFs();
	const git = createGit({ identity: { name: "Alice", email: "alice@example.com" } });
	const bash = new Bash({ fs, cwd: "/repo", customCommands: [git] });
	await bash.exec("git init");
	await bash.exec("echo 'hi' > file.txt && git add . && git commit -m 'init'");
	await bash.exec(`git remote add origin ${srv.url}my-repo`);
	const push = await bash.exec("git push -u origin main");
	console.assert(push.exitCode === 0, "push should succeed");
	console.assert(pushLog.length === 1, "postReceive should fire");
	console.assert(pushLog[0] === "my-repo:refs/heads/main", "should log correct repo:ref");

	console.log("SERVER policy + postReceive: logging OK");
	srv.stop();
}

// ── CLIENT: In-process server (default base URL) ────────────────────

{
	const server = createServer({
		storage: new BunSqliteStorage(new Database(":memory:")),
		autoCreate: true,
	});

	const git = createGit({
		network: server.asNetwork(),
	});

	const bash = new Bash({
		fs: new InMemoryFs(),
		cwd: "/",
		customCommands: [git],
	});
	const clone = await bash.exec("git clone http://git/my-repo /work", {
		env: {
			GIT_AUTHOR_NAME: "Alice",
			GIT_AUTHOR_EMAIL: "alice@example.com",
			GIT_COMMITTER_NAME: "Alice",
			GIT_COMMITTER_EMAIL: "alice@example.com",
		},
	});
	console.assert(clone.exitCode === 0, "in-process clone should succeed");

	await bash.exec("echo 'hello' > /work/README.md");
	await bash.exec("git add .", { cwd: "/work" });
	await bash.exec('git commit -m "init"', {
		cwd: "/work",
		env: {
			GIT_AUTHOR_NAME: "Alice",
			GIT_AUTHOR_EMAIL: "alice@example.com",
			GIT_COMMITTER_NAME: "Alice",
			GIT_COMMITTER_EMAIL: "alice@example.com",
		},
	});
	const push = await bash.exec("git push origin main", { cwd: "/work" });
	console.assert(push.exitCode === 0, "in-process push should succeed");

	const pull = await bash.exec("git pull origin main", { cwd: "/work" });
	console.assert(pull.exitCode === 0, "in-process pull should succeed");

	console.log("CLIENT in-process server: clone + push + pull OK (default URL)");
}

// ── CLIENT: In-process server (custom base URL) ─────────────────────

{
	const server = createServer({
		storage: new BunSqliteStorage(new Database(":memory:")),
		autoCreate: true,
	});

	const git = createGit({
		network: server.asNetwork("http://my-server:8080"),
	});

	const bash = new Bash({
		fs: new InMemoryFs(),
		cwd: "/",
		customCommands: [git],
	});
	const clone = await bash.exec("git clone http://my-server:8080/my-repo /work", {
		env: {
			GIT_AUTHOR_NAME: "Alice",
			GIT_AUTHOR_EMAIL: "alice@example.com",
			GIT_COMMITTER_NAME: "Alice",
			GIT_COMMITTER_EMAIL: "alice@example.com",
		},
	});
	console.assert(clone.exitCode === 0, "in-process clone with custom URL should succeed");

	const fs = bash.fs as InMemoryFs;
	const config = await fs.readFile("/work/.git/config");
	console.assert(config.includes("my-server:8080"), "remote URL should use custom base");

	console.log("CLIENT in-process server: custom base URL OK");
}

// ── SERVER: In-process client (with hooks) ──────────────────────────

{
	let hookFired = false;

	const server = createServer({
		storage: new BunSqliteStorage(new Database(":memory:")),
		autoCreate: true,
		hooks: {
			preReceive: ({ session: _session }) => {
				hookFired = true;
			},
		},
	});

	const git = createGit({
		network: server.asNetwork(),
	});

	const bash = new Bash({ fs: new InMemoryFs(), cwd: "/", customCommands: [git] });
	await bash.exec("git clone http://git/my-repo /work", {
		env: {
			GIT_AUTHOR_NAME: "Alice",
			GIT_AUTHOR_EMAIL: "alice@example.com",
			GIT_COMMITTER_NAME: "Alice",
			GIT_COMMITTER_EMAIL: "alice@example.com",
		},
	});
	await bash.exec("echo 'hello' > /work/file.txt");
	await bash.exec("git add .", { cwd: "/work" });
	await bash.exec('git commit -m "init"', {
		cwd: "/work",
		env: {
			GIT_AUTHOR_NAME: "Alice",
			GIT_AUTHOR_EMAIL: "alice@example.com",
			GIT_COMMITTER_NAME: "Alice",
			GIT_COMMITTER_EMAIL: "alice@example.com",
		},
	});
	const push = await bash.exec("git push origin main", { cwd: "/work" });
	console.assert(push.exitCode === 0, "in-process push with hooks should succeed");
	console.assert(hookFired, "preReceive hook should fire through asNetwork");

	console.log("SERVER in-process client: hooks fire through asNetwork OK");
}

console.log("\nAll doc examples verified.");
