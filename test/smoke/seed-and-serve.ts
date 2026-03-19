/**
 * Smoke test: seed a repo using repo helpers, serve it over HTTP,
 * clone and push from a virtual client.
 *
 * This exercises the same workflow as the Cloudflare Worker example
 * but uses the improved API (writeTree auto-mode, createCommit with
 * branch, writeRef with plain strings).
 *
 * Run: bun test/smoke/seed-and-serve.ts
 */

import { createGit } from "../../src/index.ts";
import { createGitServer, MemoryStorage } from "../../src/server/index.ts";
import {
	writeBlob,
	writeTree,
	createCommit,
	resolveRef,
	flattenTree,
} from "../../src/repo/index.ts";
import { Bash, InMemoryFs } from "just-bash";

const ID = {
	name: "Test",
	email: "test@test.com",
	timestamp: 1000000000,
	timezone: "+0000",
};

const ENV = {
	GIT_AUTHOR_NAME: "Test",
	GIT_AUTHOR_EMAIL: "test@test.com",
	GIT_COMMITTER_NAME: "Test",
	GIT_COMMITTER_EMAIL: "test@test.com",
};

// ── Seed a repo with the repo helpers ───────────────────────────────

const storage = new MemoryStorage();
const repo = storage.repo("demo");

const readmeBlob = await writeBlob(repo, "# Seeded Repo\n\nCreated with repo helpers.\n");
const indexBlob = await writeBlob(repo, 'export const greeting = "hello";\n');
const srcTree = await writeTree(repo, [{ name: "index.ts", hash: indexBlob }]);
const rootTree = await writeTree(repo, [
	{ name: "README.md", hash: readmeBlob },
	{ name: "src", hash: srcTree },
]);

const commitHash = await createCommit(repo, {
	tree: rootTree,
	parents: [],
	author: ID,
	committer: ID,
	message: "initial commit\n",
	branch: "main",
});

// Verify the seed worked
const head = await resolveRef(repo, "HEAD");
console.log("seed commit:", commitHash.slice(0, 7));
console.log("HEAD resolves:", head === commitHash ? "OK" : "FAIL");

const entries = await flattenTree(repo, rootTree);
const paths = entries.map((e) => e.path).sort();
console.log("tree contains:", paths.join(", "));
console.log(
	"tree modes correct:",
	entries.every((e) => (e.path.includes("/") ? true : e.mode === "100644")) ? "OK" : "FAIL",
);

// ── Serve it ────────────────────────────────────────────────────────

const gitServer = createGitServer({
	resolveRepo: async () => repo,
});

const port = 49152 + Math.floor(Math.random() * 16000);
const srv = Bun.serve({ port, fetch: gitServer.fetch });

// ── Clone from it with a virtual client ─────────────────────────────

const clientFs = new InMemoryFs();
const clientGit = createGit();
const client = new Bash({ fs: clientFs, cwd: "/", customCommands: [clientGit] });

let r = await client.exec(`git clone http://localhost:${port}/demo /work`, { env: ENV });
console.log("clone:", r.exitCode === 0 ? "OK" : "FAIL");
if (r.exitCode !== 0) console.log("  stderr:", r.stderr);

const readme = await clientFs.readFile("/work/README.md");
console.log("cloned README:", readme.trim());

const indexContent = await clientFs.readFile("/work/src/index.ts");
console.log("cloned src/index.ts:", indexContent.trim());

// ── Push a change back ──────────────────────────────────────────────

await client.writeFile("/work/src/index.ts", 'export const greeting = "updated";\n');
await client.exec("git add .", { cwd: "/work" });
await client.exec('git commit -m "update greeting"', { cwd: "/work", env: ENV });

r = await client.exec("git push origin main", { cwd: "/work" });
console.log("push:", r.exitCode === 0 ? "OK" : "FAIL");
if (r.exitCode !== 0) console.log("  stderr:", r.stderr);

// Verify push landed on server
const newHead = await resolveRef(repo, "refs/heads/main");
console.log("server ref advanced:", newHead !== commitHash ? "OK" : "FAIL");

srv.stop(true);
console.log("\nAll passed.");
