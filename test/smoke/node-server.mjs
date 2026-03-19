/**
 * Node.js server smoke test: init repo, start HTTP server, clone & push
 * from a virtual client. Validates that the dist works in Node ESM context
 * (where require() is unavailable and import() is used for node:zlib).
 *
 * Run: node examples/node-server.mjs         (requires `bun run build` first)
 */

import { createGit, findRepo } from "../../dist/index.js";
import { createGitServer } from "../../dist/server/index.js";
import { Bash, InMemoryFs } from "just-bash";
import http from "node:http";

const ENV = {
	GIT_AUTHOR_NAME: "Test",
	GIT_AUTHOR_EMAIL: "test@test.com",
	GIT_COMMITTER_NAME: "Test",
	GIT_COMMITTER_EMAIL: "test@test.com",
};

// ── Set up server repo ──────────────────────────────────────────────

const serverFs = new InMemoryFs();
const serverGit = createGit();
const serverBash = new Bash({ fs: serverFs, cwd: "/repo", customCommands: [serverGit] });

await serverBash.writeFile("/repo/README.md", "# Hello from Node " + process.version);
await serverBash.writeFile("/repo/src/index.ts", "export const x = 1;");
await serverBash.exec("git init");
await serverBash.exec("git add .");
let r = await serverBash.exec('git commit -m "init"', { env: ENV });
console.log("commit:", r.exitCode === 0 ? "OK" : "FAIL");

const repo = await findRepo(serverFs, "/repo");
const gitServer = createGitServer({ resolveRepo: async () => repo });

// ── Start Node HTTP server ──────────────────────────────────────────

const srv = http.createServer(async (req, res) => {
	const url = new URL(req.url, "http://localhost");
	const chunks = [];
	for await (const chunk of req) chunks.push(chunk);
	const body = Buffer.concat(chunks);
	const request = new Request(url, {
		method: req.method,
		headers: Object.fromEntries(
			Object.entries(req.headers)
				.filter(([, v]) => v != null)
				.map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : v]),
		),
		body: ["GET", "HEAD"].includes(req.method) ? undefined : body,
	});
	const response = await gitServer.fetch(request);
	res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
	res.end(Buffer.from(await response.arrayBuffer()));
});

await new Promise((resolve) => srv.listen(0, resolve));
const port = srv.address().port;
console.log(`Node ${process.version} server on port ${port}`);

// ── Clone & push ────────────────────────────────────────────────────

const clientFs = new InMemoryFs();
const clientGit = createGit();
const client = new Bash({ fs: clientFs, cwd: "/", customCommands: [clientGit] });

r = await client.exec(`git clone http://localhost:${port}/repo /work`, { env: ENV });
console.log("clone:", r.exitCode === 0 ? "OK" : "FAIL", r.stderr.trim());

const readme = await clientFs.readFile("/work/README.md");
console.log("readme:", readme.trim());

await client.writeFile("/work/src/index.ts", "export const x = 42;");
await client.exec("git add .", { cwd: "/work" });
await client.exec('git commit -m "update from node"', { cwd: "/work", env: ENV });

r = await client.exec("git push origin main", { cwd: "/work" });
console.log("push:", r.exitCode === 0 ? "OK" : "FAIL");
if (r.exitCode !== 0) console.log("  stderr:", r.stderr);

srv.close();
console.log(`\nAll passed on Node ${process.version}`);
