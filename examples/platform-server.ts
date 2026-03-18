/**
 * Platform server example: GitHub-like PR workflows over real git.
 *
 * Serves a git repo over Smart HTTP (clone/fetch/push with real `git`)
 * and REST endpoints for pull request management.
 *
 * Run:   bun examples/platform-server.ts
 * Clone: git clone http://localhost:4201/my-repo
 *
 * PR endpoints (under /api):
 *   GET    /api/my-repo/pulls           — list PRs
 *   POST   /api/my-repo/pulls           — create PR
 *   GET    /api/my-repo/pulls/1         — get PR
 *   PATCH  /api/my-repo/pulls/1         — update PR title/body
 *   POST   /api/my-repo/pulls/1/merge   — merge PR
 *   POST   /api/my-repo/pulls/1/close   — close PR
 */

import { Database } from "bun:sqlite";
import { createPlatform } from "../src/platform/platform.ts";

const PORT = Number(process.env.PORT ?? 4201);

const db = new Database(":memory:");
db.run("PRAGMA journal_mode = WAL");

const platform = createPlatform({
	database: db,
	on: {
		onPush(event) {
			console.log(
				`  [push] ${event.repoId} ${event.ref}: ${(event.oldHash ?? "0000000").slice(0, 7)}..${event.newHash.slice(0, 7)}`,
			);
		},
		onPullRequestCreated(event) {
			console.log(
				`  [pr] #${event.pr.number} created: "${event.pr.title}" (${event.pr.headRef} → ${event.pr.baseRef})`,
			);
		},
		onPullRequestMerged(event) {
			console.log(
				`  [pr] #${event.pr.number} merged via ${event.strategy} → ${event.mergeCommitSha.slice(0, 12)}`,
			);
		},
		onPullRequestClosed(event) {
			console.log(`  [pr] #${event.pr.number} closed`);
		},
	},
});

platform.createRepo("my-repo");
console.log(`  repo "my-repo" created`);

const server = platform.server();

const srv = Bun.serve({ port: PORT, fetch: server.fetch });

console.log(`
just-git platform server listening on http://localhost:${srv.port}

────────────────────────────────────────────────────────

  Quick start:

  1. Push an initial commit:

     mkdir /tmp/my-repo && cd /tmp/my-repo
     git init && git checkout -b main
     echo "# My Project" > README.md
     git add . && git commit -m "initial commit"
     git remote add origin http://localhost:${srv.port}/my-repo
     git push -u origin main

  2. Create a feature branch and push it:

     git checkout -b feature
     echo "new stuff" > feature.txt
     git add . && git commit -m "add feature"
     git push -u origin feature

  3. Create a PR via the API:

     curl -s http://localhost:${srv.port}/api/my-repo/pulls \\
       -H 'Content-Type: application/json' \\
       -d '{"head":"feature","base":"main","title":"Add feature","author":{"name":"Dev","email":"dev@example.com"}}' | jq

  4. Merge the PR:

     curl -s http://localhost:${srv.port}/api/my-repo/pulls/1/merge \\
       -H 'Content-Type: application/json' \\
       -d '{"strategy":"merge","committer":{"name":"Dev","email":"dev@example.com","timestamp":0,"timezoneOffset":0}}' | jq

  5. Pull the merged result:

     git checkout main && git pull

────────────────────────────────────────────────────────
`);
