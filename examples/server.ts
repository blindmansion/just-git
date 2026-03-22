/**
 * Git server example: serve repos over Smart HTTP, clone & push
 * from a virtual client. Works with real `git` clients too.
 *
 * Run: bun examples/server.ts
 */

import { Bash, InMemoryFs } from "just-bash";
import { createGit } from "../src"; // "just-git"
import { createGitServer, MemoryDriver } from "../src/server"; // "just-git/server"
import { writeBlob, writeTree, createCommit } from "../src/repo"; // "just-git/repo"

const ENV = {
	GIT_AUTHOR_NAME: "Test",
	GIT_AUTHOR_EMAIL: "test@test.com",
	GIT_COMMITTER_NAME: "Test",
	GIT_COMMITTER_EMAIL: "test@test.com",
};

const ID = {
	name: "Test",
	email: "test@test.com",
	timestamp: 1000000000,
	timezone: "+0000",
};

// ── 1. Create server and seed a repo ────────────────────────────────

console.log("═══ 1. Setting up server-side repo ═══\n");

const pushLog: string[] = [];

const server = createGitServer({
	storage: new MemoryDriver(),

	hooks: {
		preReceive: async (event) => {
			console.log(`  [pre-receive] ${event.updates.length} ref(s)`);
		},

		postReceive: async (event) => {
			for (const u of event.updates) {
				const line = `${u.ref}: ${(u.oldHash ?? "0000000").slice(0, 7)}..${u.newHash.slice(0, 7)}`;
				pushLog.push(line);
				console.log(`  [push] ${line}`);
			}
		},
	},
});

const repo = await server.createRepo("my-project");

const readmeBlob = await writeBlob(repo, "# My Project\n\nA repo served by just-git.");
const indexBlob = await writeBlob(repo, 'export const greeting = "hello";');
const srcTree = await writeTree(repo, [{ name: "index.ts", hash: indexBlob }]);
const rootTree = await writeTree(repo, [
	{ name: "README.md", hash: readmeBlob },
	{ name: "src", hash: srcTree },
]);

const seedHash = await createCommit(repo, {
	tree: rootTree,
	parents: [],
	author: ID,
	committer: ID,
	message: "initial commit\n",
	branch: "main",
});

// Tag via ref
await repo.refStore.writeRef("refs/tags/v0.1.0", { type: "direct", hash: seedHash });

console.log("  Server repo initialized with 1 commit and tag v0.1.0\n");

// ── 2. Start the server ─────────────────────────────────────────────

console.log("═══ 2. Starting Git server ═══\n");

const srv = Bun.serve({ fetch: server.fetch, port: 0 });
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

const updatedRepo = (await server.repo("my-project"))!;
const mainRef = await updatedRepo.refStore.readRef("refs/heads/main");
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

const repoAfterPush = (await server.repo("my-project"))!;
const featureRef = await repoAfterPush.refStore.readRef("refs/heads/feature/awesome");
console.log(`  Server has feature/awesome: ${featureRef !== null}`);

const allRefs = await repoAfterPush.refStore.listRefs("refs/heads");
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
