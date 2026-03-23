/**
 * CI script runner example: run bash scripts from the repo inside server hooks.
 *
 * Demonstrates that no new APIs are needed — the existing pieces compose:
 *   1. Server hook fires → has repo: GitRepo
 *   2. Read a CI script from the pushed commit via readFileAtCommit()
 *   3. Clone the repo into an isolated sandbox via resolveRemote
 *   4. Run the script in the sandbox with full git support
 *   5. Report pass/fail (or reject the push)
 *
 * Run: bun examples/ci-script-runner.ts
 */

import { Bash, InMemoryFs } from "just-bash";
import { createGit, type GitRepo } from "../src";
import { createServer, MemoryDriver } from "../src/server";
import { readFileAtCommit, writeBlob, writeTree, createCommit } from "../src/repo";

const ENV = {
	GIT_AUTHOR_NAME: "Dev",
	GIT_AUTHOR_EMAIL: "dev@test.com",
	GIT_COMMITTER_NAME: "Dev",
	GIT_COMMITTER_EMAIL: "dev@test.com",
};

/**
 * Clone a repo into an isolated Bash sandbox. This is the core pattern:
 * resolveRemote makes the repo available via cross-VFS local transport,
 * then `git clone` copies objects and sets up refs — full history, proper
 * .git directory, everything. Three lines, no special APIs.
 */
async function cloneIntoSandbox(repo: GitRepo) {
	const fs = new InMemoryFs();
	const bash = new Bash({
		fs,
		cwd: "/",
		customCommands: [createGit({ resolveRemote: () => repo })],
	});
	await bash.exec("git clone /repo /workspace", { env: ENV });
	return bash;
}

// ── 1. Set up the server repo ───────────────────────────────────────

console.log("═══ 1. Setting up server repo ═══\n");

const ciResults: { ref: string; passed: boolean; output: string }[] = [];
const driver = new MemoryDriver();

const server = createServer({
	storage: driver,

	hooks: {
		postReceive: async ({ repo, updates }) => {
			for (const update of updates) {
				if (update.isDelete) continue;

				console.log(`  [CI] Checking ${update.ref} @ ${update.newHash.slice(0, 7)}...`);

				const script = await readFileAtCommit(repo, update.newHash, ".ci/test.sh");
				if (!script) {
					console.log(`  [CI] No .ci/test.sh found — skipping`);
					continue;
				}

				const sandbox = await cloneIntoSandbox(repo);
				const result = await sandbox.exec("bash .ci/test.sh", {
					cwd: "/workspace",
					env: ENV,
				});

				const passed = result.exitCode === 0;
				const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
				ciResults.push({ ref: update.ref, passed, output });

				console.log(`  [CI] ${passed ? "PASSED" : "FAILED"} (exit ${result.exitCode})`);
				if (output) {
					for (const line of output.split("\n")) {
						console.log(`  [CI]   ${line}`);
					}
				}
			}
		},
	},
});

const serverRepo = await server.createRepo("repo");

const ID = { name: "Dev", email: "dev@test.com", timestamp: 1000000000, timezone: "+0000" };

const readmeBlob = await writeBlob(serverRepo, "# CI Runner Demo");
const ciScriptContent = [
	"#!/bin/bash",
	"set -e",
	"",
	"echo '=== Running CI checks ==='",
	"",
	"git log --oneline",
	"git status",
	"git diff --stat HEAD~1 HEAD 2>/dev/null || echo 'First commit'",
	"",
	"if [ ! -f README.md ]; then",
	'  echo "ERROR: README.md missing" >&2',
	"  exit 1",
	"fi",
	"",
	"echo '=== CI checks passed ==='",
].join("\n");
const ciBlob = await writeBlob(serverRepo, ciScriptContent);
const ciTree = await writeTree(serverRepo, [{ name: "test.sh", hash: ciBlob }]);
const rootTree = await writeTree(serverRepo, [
	{ name: ".ci", hash: ciTree },
	{ name: "README.md", hash: readmeBlob },
]);
await createCommit(serverRepo, {
	tree: rootTree,
	parents: [],
	author: ID,
	committer: ID,
	message: "initial: add CI script\n",
	branch: "main",
});

console.log("  Server repo ready with .ci/test.sh\n");

// ── 2. Start the HTTP server ────────────────────────────────────────

console.log("═══ 2. Starting server ═══\n");

const srv = Bun.serve({ fetch: server.fetch, port: 0 });
const url = `http://localhost:${srv.port}`;
console.log(`  Server listening on ${url}\n`);

// ── 3. Clone, modify, and push — triggers CI ───────────────────────

console.log("═══ 3. Push with passing CI script ═══\n");

const clientFs = new InMemoryFs();
const client = new Bash({
	fs: clientFs,
	cwd: "/",
	customCommands: [createGit()],
});

await client.exec(`git clone ${url}/repo /work`, { env: ENV });
await client.writeFile("/work/src/app.ts", 'export const app = "hello";');
await client.exec("git add .", { cwd: "/work" });
await client.exec('git commit -m "add app module"', { cwd: "/work", env: ENV });

const push1 = await client.exec("git push origin main", { cwd: "/work" });
console.log(`  Push exit: ${push1.exitCode}\n`);

// ── 4. Push a broken CI script — uses an unimplemented command ──────

console.log("═══ 4. Push with failing CI script ═══\n");

await client.writeFile(
	"/work/.ci/test.sh",
	[
		"#!/bin/bash",
		"set -e",
		"echo 'Running checks...'",
		"git submodule update --init --recursive",
		"echo 'Should not reach here'",
	].join("\n"),
);
await client.exec("git add .", { cwd: "/work" });
await client.exec('git commit -m "break CI with unsupported command"', {
	cwd: "/work",
	env: ENV,
});

const push2 = await client.exec("git push origin main", { cwd: "/work" });
console.log(`  Push exit: ${push2.exitCode}\n`);

// ── 5. Preemptive rejection: preReceive blocks the push ────────────

console.log("═══ 5. PreReceive rejection variant ═══\n");

const rejectResults: string[] = [];

const strictServer = createServer({
	storage: driver,

	hooks: {
		preReceive: async ({ repo, updates }) => {
			for (const update of updates) {
				if (update.isDelete) continue;

				const script = await readFileAtCommit(repo, update.newHash, ".ci/test.sh");
				if (!script) continue;

				const sandbox = await cloneIntoSandbox(repo);
				const result = await sandbox.exec("bash .ci/test.sh", {
					cwd: "/workspace",
					env: ENV,
				});

				if (result.exitCode !== 0) {
					const msg = `CI failed for ${update.ref}:\n${result.stderr || result.stdout}`;
					rejectResults.push(msg.trim());
					return { reject: true, message: msg };
				}
			}
		},
	},
});

const strictSrv = Bun.serve({ fetch: strictServer.fetch, port: 0 });
const strictUrl = `http://localhost:${strictSrv.port}`;

const client2Fs = new InMemoryFs();
const client2 = new Bash({
	fs: client2Fs,
	cwd: "/",
	customCommands: [createGit()],
});

await client2.exec(`git clone ${strictUrl}/repo /work`, { env: ENV });
await client2.writeFile(
	"/work/.ci/test.sh",
	["#!/bin/bash", "set -e", "git worktree add /tmp/test HEAD"].join("\n"),
);
await client2.exec("git add .", { cwd: "/work" });
await client2.exec('git commit -m "use unsupported git worktree"', {
	cwd: "/work",
	env: ENV,
});

const push3 = await client2.exec("git push origin main", { cwd: "/work" });
console.log(`  Push exit: ${push3.exitCode}`);
console.log(`  Push was rejected: ${push3.exitCode !== 0}`);
if (push3.stderr) {
	for (const line of push3.stderr.trim().split("\n").slice(0, 5)) {
		console.log(`  stderr: ${line}`);
	}
}
console.log();

// ── Summary ─────────────────────────────────────────────────────────

console.log("═══ Summary ═══\n");
console.log(`  CI runs: ${ciResults.length}`);
for (const r of ciResults) {
	console.log(`    ${r.ref}: ${r.passed ? "PASSED" : "FAILED"}`);
}
console.log(`  Rejection messages: ${rejectResults.length}`);
for (const r of rejectResults) {
	console.log(`    ${r.split("\n")[0]}`);
}

console.log(`
  The entire sandbox setup is three lines:

    const sandbox = new Bash({
      fs: new InMemoryFs(),
      cwd: "/",
      customCommands: [createGit({ resolveRemote: () => repo })],
    });
    await sandbox.exec("git clone /repo /workspace");

  No new APIs — just resolveRemote + git clone.
`);

srv.stop();
strictSrv.stop();
