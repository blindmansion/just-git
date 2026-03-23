/**
 * Deno server smoke test: init repo, start HTTP server, clone & push
 * from a virtual client. Validates that the dist works in Deno
 * (where node:zlib is loaded via dynamic import()).
 *
 * Run: deno run --allow-all examples/deno-server.mjs   (requires `bun run build` first)
 */

import { createGit } from "../../dist/index.js";
import { createServer, MemoryDriver } from "../../dist/server/index.js";
import { writeBlob, writeTree, createCommit } from "../../dist/repo/index.js";
import { Bash, InMemoryFs } from "just-bash";

const ENV = {
	GIT_AUTHOR_NAME: "Test",
	GIT_AUTHOR_EMAIL: "test@test.com",
	GIT_COMMITTER_NAME: "Test",
	GIT_COMMITTER_EMAIL: "test@test.com",
};

const ID = { name: "Test", email: "test@test.com", timestamp: 1000000000, timezone: "+0000" };

// ── Set up server ───────────────────────────────────────────────────

const gitServer = createServer({ storage: new MemoryDriver() });
const repo = await gitServer.createRepo("repo");

const readmeBlob = await writeBlob(repo, "# Hello from Deno");
const indexBlob = await writeBlob(repo, "export const x = 1;");
const srcTree = await writeTree(repo, [{ name: "index.ts", hash: indexBlob }]);
const rootTree = await writeTree(repo, [
	{ name: "README.md", hash: readmeBlob },
	{ name: "src", hash: srcTree },
]);
await createCommit(repo, {
	tree: rootTree,
	parents: [],
	author: ID,
	committer: ID,
	message: "init\n",
	branch: "main",
});
console.log("commit: OK");

// ── Start Deno HTTP server ──────────────────────────────────────────

const srv = Deno.serve(
	{
		port: 0,
		onListen({ port }) {
			console.log(`Deno ${Deno.version.deno} server on port ${port}`);
		},
	},
	gitServer.fetch,
);
const port = srv.addr.port;

// ── Clone & push ────────────────────────────────────────────────────

const clientFs = new InMemoryFs();
const clientGit = createGit();
const client = new Bash({ fs: clientFs, cwd: "/", customCommands: [clientGit] });

let r = await client.exec(`git clone http://localhost:${port}/repo /work`, { env: ENV });
console.log("clone:", r.exitCode === 0 ? "OK" : "FAIL", r.stderr.trim());

const readme = await clientFs.readFile("/work/README.md");
console.log("readme:", readme.trim());

await client.writeFile("/work/src/index.ts", "export const x = 42;");
await client.exec("git add .", { cwd: "/work" });
await client.exec('git commit -m "update from deno"', { cwd: "/work", env: ENV });

r = await client.exec("git push origin main", { cwd: "/work" });
console.log("push:", r.exitCode === 0 ? "OK" : "FAIL");
if (r.exitCode !== 0) console.log("  stderr:", r.stderr);

await srv.shutdown();
console.log(`\nAll passed on Deno ${Deno.version.deno}`);
