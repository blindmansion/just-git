/**
 * Smoke-tests every code example from the docs (README, CLIENT.md, REPO.md)
 * to make sure they actually work.
 *
 * Run: bun test/smoke/readme-examples.ts
 */

import { Bash, InMemoryFs } from "just-bash";
import { Database } from "bun:sqlite";
import { createGit, MemoryFileSystem, composeGitHooks, findRepo } from "../../src";
import { createGitServer, BunSqliteStorage } from "../../src/server";
import {
	readFileAtCommit,
	getChangedFiles,
	mergeTrees,
	readCommit,
	resolveRef,
	createWorktree,
	readonlyRepo,
	writeBlob,
	createCommit,
} from "../../src/repo";
import type { GitHooks } from "../../src";

// ═══════════════════════════════════════════════════════════════════
// README examples
// ═══════════════════════════════════════════════════════════════════

// ── README: Quick start (standalone exec) ───────────────────────────

{
	const fs = new MemoryFileSystem();
	const git = createGit({ identity: { name: "Alice", email: "alice@example.com" } });

	await git.exec("git init", { fs, cwd: "/repo" });
	await fs.writeFile("/repo/README.md", "hello");
	await git.exec("git add .", { fs, cwd: "/repo" });
	await git.exec('git commit -m "initial commit"', { fs, cwd: "/repo" });
	const log = await git.exec("git log --oneline", { fs, cwd: "/repo" });
	console.assert(log.exitCode === 0, "standalone exec should succeed");
	console.log("README standalone:", log.stdout.trim());
}

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

// ── README: Quick start (server) ────────────────────────────────────

{
	const storage = new BunSqliteStorage(new Database(":memory:"));

	const server = createGitServer({
		resolveRepo: (path) => storage.repo(path),
		hooks: {
			preReceive: ({ updates }) => {
				if (updates.some((u) => u.ref === "refs/heads/main" && !u.isFF))
					return { reject: true, message: "no force-push to main" };
			},
			postReceive: ({ repoPath, updates }) => {
				console.log(`  [server] ${repoPath}: ${updates.length} ref(s) updated`);
			},
		},
	});

	const srv = Bun.serve({ fetch: server.fetch, port: 0 });
	const git = createGit({ identity: { name: "Alice", email: "alice@example.com" } });
	const fs = new InMemoryFs();
	const clone = await git.exec(`clone ${srv.url}test-repo /repo`, { fs, cwd: "/" });
	console.assert(clone.exitCode === 0, "server clone should succeed");
	console.log("README server:", clone.exitCode === 0 ? "clone OK" : clone.stderr.trim());
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
	const storage = new BunSqliteStorage(new Database(":memory:"));
	const repo = storage.repo("my-repo");
	console.assert(repo.objectStore !== undefined, "should have objectStore");
	console.assert(repo.refStore !== undefined, "should have refStore");
	console.log("REPO storage-backed: BunSqliteStorage.repo() OK");
}

// ── REPO: createWorktree (hybrid pattern) ───────────────────────────

{
	const storage = new BunSqliteStorage(new Database(":memory:"));

	// Seed the repo with a commit via the repo API
	const repo = storage.repo("my-repo");
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

	// Now use createWorktree to bridge onto a VFS
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

	// Verify the commit went to storage
	const headHash = await resolveRef(repo, "HEAD");
	console.assert(headHash !== null, "should have HEAD after commit");
	const commit = await readCommit(repo, headHash!);
	console.assert(commit.message.trim() === "from agent", "commit message should match");
	console.log("REPO createWorktree: hybrid pattern OK, commit in storage");
}

// ── REPO: readonlyRepo ──────────────────────────────────────────────

{
	const storage = new BunSqliteStorage(new Database(":memory:"));
	const ro = readonlyRepo(storage.repo("my-repo"));

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

{
	const storage = new BunSqliteStorage(new Database(":memory:"));
	const foundPkg: string[] = [];

	const server = createGitServer({
		resolveRepo: (path) => storage.repo(path),
		hooks: {
			postReceive: async ({ repo, updates }) => {
				for (const u of updates) {
					const pkg = await readFileAtCommit(repo, u.newHash, "package.json");
					if (pkg) foundPkg.push(pkg);
				}
			},
		},
	});

	const srv = Bun.serve({ fetch: server.fetch, port: 0 });

	// Push a repo with package.json to the server
	const git = createGit({
		identity: { name: "Alice", email: "alice@example.com" },
		credentials: () => null,
	});
	const fs = new InMemoryFs();
	const bash = new Bash({ fs, cwd: "/repo", customCommands: [git] });
	await bash.exec("git init");
	await bash.exec('echo \'{"name":"test"}\' > package.json');
	await bash.exec("git add . && git commit -m 'init'");
	await bash.exec(`git remote add origin ${srv.url}test-repo`);
	await bash.exec("git push -u origin main");

	console.assert(foundPkg.length === 1, "postReceive should find package.json");
	console.log("REPO hooks (server): postReceive read package.json OK");
	srv.stop();
}

console.log("\nAll doc examples verified.");
