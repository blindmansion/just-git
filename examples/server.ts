/**
 * Git server example: serve repos over Smart HTTP, clone & push
 * from a virtual client. Works with real `git` clients too.
 *
 * Run: bun examples/server.ts
 */

import { Bash, InMemoryFs } from "just-bash";
import { createGit } from "../src";
import { PackedObjectStore } from "../src/lib/object-store.ts";
import { FileSystemRefStore } from "../src/lib/refs.ts";
import { findGitDir } from "../src/lib/repo.ts";
import { createGitServer } from "../src/server/handler.ts";
import type { ServerRepoContext } from "../src/server/types.ts";

const ENV = {
	GIT_AUTHOR_NAME: "Test",
	GIT_AUTHOR_EMAIL: "test@test.com",
	GIT_COMMITTER_NAME: "Test",
	GIT_COMMITTER_EMAIL: "test@test.com",
};

// ── 1. Create a server-side repo ────────────────────────────────────

console.log("═══ 1. Setting up server-side repo ═══\n");

const serverFs = new InMemoryFs();
const serverGit = createGit();
const serverBash = new Bash({ fs: serverFs, cwd: "/repo", customCommands: [serverGit] });

await serverBash.writeFile("/repo/README.md", "# My Project\n\nA repo served by just-git.");
await serverBash.writeFile("/repo/src/index.ts", 'export const greeting = "hello";');
await serverBash.exec("git init");
await serverBash.exec("git add .");
await serverBash.exec('git commit -m "initial commit"', { env: ENV });
await serverBash.exec("git tag v0.1.0");

const ctx = await findGitDir(serverFs, "/repo");
if (!ctx) throw new Error("repo not found");

const repo: ServerRepoContext = {
	objects: new PackedObjectStore(ctx.fs, ctx.gitDir),
	refs: new FileSystemRefStore(ctx.fs, ctx.gitDir),
};

console.log("  Server repo initialized with 1 commit and tag v0.1.0\n");

// ── 2. Start the server ─────────────────────────────────────────────

console.log("═══ 2. Starting Git server ═══\n");

const pushLog: string[] = [];

const server = createGitServer({
	resolve: async (repoPath) => {
		console.log(`  [resolve] ${repoPath}`);
		return repo;
	},

	authorize: async (_req, repoPath, operation) => {
		console.log(`  [auth] ${operation} on ${repoPath}`);
		return { ok: true };
	},

	onPush: async (repoPath, refUpdates) => {
		for (const u of refUpdates) {
			const line = `${u.name}: ${u.oldHash.slice(0, 7)}..${u.newHash.slice(0, 7)}`;
			pushLog.push(line);
			console.log(`  [push] ${repoPath} — ${line}`);
		}
	},
});

const srv = Bun.serve({ fetch: (req) => server.handle(req), port: 0 });
const url = `http://localhost:${srv.port}`;
console.log(`  Listening on ${url}\n`);

// ── 3. Clone from the server ────────────────────────────────────────

console.log("═══ 3. Cloning from server ═══\n");

const clientFs = new InMemoryFs();
const clientGit = createGit();
const client = new Bash({ fs: clientFs, cwd: "/", customCommands: [clientGit] });

const cloneResult = await client.exec(`git clone ${url}/my-project /work`, { env: ENV });
console.log(`  Clone exit: ${cloneResult.exitCode}`);
console.log(`  ${cloneResult.stderr.trim()}`);

const readme = await clientFs.readFile("/work/README.md");
console.log(`  README.md: "${readme.split("\n")[0]}"`);

const branches = await client.exec("git branch -a", { cwd: "/work" });
console.log(`  Branches:\n${branches.stdout.replace(/^/gm, "    ").trimEnd()}\n`);

// ── 4. Push changes back ────────────────────────────────────────────

console.log("═══ 4. Pushing changes ═══\n");

await client.writeFile("/work/src/index.ts", 'export const greeting = "hello world";');
await client.exec("git add .", { cwd: "/work" });
await client.exec('git commit -m "update greeting"', { cwd: "/work", env: ENV });

const pushResult = await client.exec("git push origin main", { cwd: "/work" });
console.log(`  Push exit: ${pushResult.exitCode}`);

// Verify on the server side
const mainRef = await repo.refs.readRef("refs/heads/main");
console.log(`  Server main ref: ${mainRef?.type === "direct" ? mainRef.hash.slice(0, 12) : "?"}…`);
console.log(`  Push log: ${pushLog.join(", ")}\n`);

// ── 5. Push a new branch ────────────────────────────────────────────

console.log("═══ 5. Creating and pushing a feature branch ═══\n");

await client.exec("git checkout -b feature/awesome", { cwd: "/work" });
await client.writeFile("/work/feature.ts", "export const awesome = true;");
await client.exec("git add .", { cwd: "/work" });
await client.exec('git commit -m "feat: add awesome module"', { cwd: "/work", env: ENV });

const branchPush = await client.exec("git push origin feature/awesome", { cwd: "/work" });
console.log(`  Push exit: ${branchPush.exitCode}`);

const featureRef = await repo.refs.readRef("refs/heads/feature/awesome");
console.log(`  Server has feature/awesome: ${featureRef !== null}`);

const allRefs = await repo.refs.listRefs("refs/heads");
console.log(
	`  Server branches: ${allRefs.map((r) => r.name.replace("refs/heads/", "")).join(", ")}\n`,
);

// ── Cleanup ─────────────────────────────────────────────────────────

srv.stop();
console.log("═══ Done ═══\n");
console.log("  The server handled clone, push, and branch creation");
console.log("  using web-standard Request/Response — works with Bun,");
console.log("  Hono, Cloudflare Workers, or any fetch-compatible runtime.");
console.log("  Real `git` clients work too (try pointing git clone at the URL).\n");
