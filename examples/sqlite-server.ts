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
import { SqliteStorage } from "../src/server/sqlite-storage.ts";
import { createGitServer } from "../src/server/handler.ts";

const DB_PATH = process.env.DB_PATH ?? ":memory:";
const PORT = Number(process.env.PORT ?? 4200);

const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode = WAL");
const storage = new SqliteStorage(db);

const server = createGitServer({
	resolveRepo: async (repoPath) => {
		console.log(`  [resolve] ${repoPath}`);
		const repo = storage.repo(repoPath);

		const head = await repo.refStore.readRef("HEAD");
		if (!head) {
			console.log(`  [init] auto-creating repo "${repoPath}"`);
			await repo.refStore.writeRef("HEAD", { type: "symbolic", target: "refs/heads/main" });
		}

		return repo;
	},

	hooks: {
		postReceive: async (event) => {
			for (const u of event.updates) {
				console.log(
					`  [push] ${u.ref}: ${(u.oldHash ?? "0000000").slice(0, 7)}..${u.newHash.slice(0, 7)}`,
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
