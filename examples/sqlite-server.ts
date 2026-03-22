/**
 * SQLite-backed Git server example.
 *
 * Serves repos over Smart HTTP with all objects and refs stored in a
 * single SQLite database. Supports auto-creating repos on first push
 * and multi-repo routing via URL path.
 *
 * Run:   bun examples/sqlite-server.ts
 * Clone: git clone http://localhost:4200/my-repo
 * Push:  (just push normally after cloning)
 */

import { Database } from "bun:sqlite";
import { createGitServer, BunSqliteStorage } from "../src/server"; // "just-git/server"
import { getChangedFiles } from "../src/repo"; // "just-git/repo"

const DB_PATH = process.env.DB_PATH ?? ":memory:";
const PORT = Number(process.env.PORT ?? 4200);

const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode = WAL");
const storage = new BunSqliteStorage(db);

const server = createGitServer({
	resolveRepo: (repoPath) => {
		console.log(`  [resolve] ${repoPath}`);
		return storage.repo(repoPath) ?? storage.createRepo(repoPath);
	},

	hooks: {
		preReceive: async ({ updates }) => {
			for (const u of updates) {
				if (u.ref === "refs/heads/main" && !u.isFF && !u.isCreate) {
					return { reject: true, message: "no force-push to main" };
				}
			}
		},

		postReceive: async ({ repo, updates }) => {
			for (const u of updates) {
				const files = await getChangedFiles(repo, u.oldHash, u.newHash);
				console.log(
					`  [push] ${u.ref}: ${(u.oldHash ?? "0000000").slice(0, 7)}..${u.newHash.slice(0, 7)} (${files.length} files changed)`,
				);
			}
		},
	},
});

const srv = Bun.serve({ fetch: server.fetch, port: PORT });

console.log(`just-git sqlite server listening on http://localhost:${srv.port}`);
console.log(`database: ${DB_PATH === ":memory:" ? "(in-memory)" : DB_PATH}`);
console.log();
console.log("usage:");
console.log(`  git clone http://localhost:${srv.port}/<repo-name>`);
console.log(`  git push`);
