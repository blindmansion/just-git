import http from "node:http";
import Database from "better-sqlite3";
import {
	createGitServer,
	createStandardHooks,
	SqliteStorage,
	toNodeHandler,
	withAuth,
	wrapBetterSqlite3,
} from "just-git/server";

const GIT_TOKEN = process.env.GIT_TOKEN;

const storage = new SqliteStorage(wrapBetterSqlite3(new Database("repos.sqlite")));

const server = createGitServer({
	resolveRepo: withAuth(
		(request) => {
			if (!GIT_TOKEN) return true;
			const header = request.headers.get("authorization");
			if (!header) {
				return new Response("Authentication required\n", {
					status: 401,
					headers: { "WWW-Authenticate": 'Basic realm="git"' },
				});
			}
			if (header.startsWith("Basic ")) {
				const password = atob(header.slice(6)).split(":")[1];
				return password === GIT_TOKEN;
			}
			if (header.startsWith("Bearer ")) {
				return header.slice(7) === GIT_TOKEN;
			}
			return false;
		},
		(repoPath) => storage.repo(repoPath),
	),

	hooks: createStandardHooks({
		protectedBranches: ["main", "master"],
		denyDeleteTags: true,
		onPush: ({ repoPath, updates }) => {
			for (const u of updates) {
				console.log(
					`[push] ${repoPath}: ${u.ref} ${u.oldHash?.slice(0, 7) ?? "(new)"} → ${u.newHash.slice(0, 7)}`,
				);
			}
		},
	}),
});

const PORT = parseInt(process.env.PORT || "4280", 10);

http.createServer(toNodeHandler(server)).listen(PORT, () => {
	console.log(`Git server listening on http://localhost:${PORT}`);
	console.log(`Auth: ${GIT_TOKEN ? "enabled (set GIT_TOKEN)" : "disabled (no GIT_TOKEN set)"}`);
	console.log(`Protected branches: main, master`);
	console.log(`Try: git clone http://localhost:${PORT}/my-repo`);
});
