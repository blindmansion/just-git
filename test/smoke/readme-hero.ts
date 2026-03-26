/**
 * Smoke-tests the hero code block from the top of the README.
 *
 * Run: bun test/smoke/readme-hero.ts
 */

import { createServer, BunSqliteStorage } from "../../src/server";
import { createGit } from "../../src";
import { getChangedFiles, readFileAtCommit, resolveRef, readCommit } from "../../src/repo";
import { Bash } from "just-bash";
import { Database } from "bun:sqlite";

// ── Hero block (matches README) ─────────────────────────────────────

const changedFileLogs: { repoId: string; files: string[] }[] = [];

const server = createServer({
	storage: new BunSqliteStorage(new Database(":memory:")),
	autoCreate: true,
	hooks: {
		postReceive: async ({ repo, repoId, updates }) => {
			for (const u of updates) {
				const files = await getChangedFiles(repo, u.oldHash, u.newHash);
				changedFileLogs.push({ repoId, files: files.map((f) => f.path) });
			}
		},
	},
});

const network = server.asNetwork();

const bash = new Bash({
	customCommands: [
		createGit({
			network,
			identity: { name: "Alice", email: "alice@team.dev", locked: true },
		}),
	],
});

await server.createRepo("project");
await server.commit("project", {
	files: { "README.md": "# Hello\n" },
	message: "seed",
	author: { name: "System", email: "system@team.dev" },
	branch: "main",
});

await bash.exec("git clone http://git/project . && echo 'hello' >> README.md");
await bash.exec("git add -A && git commit -m 'update readme' && git push");

// ── Validation ──────────────────────────────────────────────────────

// Verify server-side seed commit landed
const repo = await server.requireRepo("project");
const mainHash = await resolveRef(repo, "refs/heads/main");
console.assert(mainHash !== null, "main branch should exist");

// Verify the clone + push round-tripped
const headCommit = await readCommit(repo, mainHash!);
console.assert(
	headCommit.message.trim() === "update readme",
	"head commit should be 'update readme'",
);
console.assert(headCommit.author.name === "Alice", "locked identity should be used");

// Verify README.md was appended to
const content = await readFileAtCommit(repo, mainHash!, "README.md");
console.assert(content === "# Hello\nhello\n", "README.md should have appended line");

// postReceive hook should have fired for the push
console.assert(changedFileLogs.length === 1, "postReceive should have fired once");
console.assert(changedFileLogs[0]!.repoId === "project", "repoId should be 'project'");
console.assert(
	changedFileLogs[0]!.files.includes("README.md"),
	"hook should see README.md changed",
);

console.log("README hero block: all validations passed");
