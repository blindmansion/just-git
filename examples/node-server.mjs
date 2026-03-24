import http from "node:http";
import Database from "better-sqlite3";
import { createServer, BetterSqlite3Storage } from "just-git/server";

const GIT_TOKEN = process.env.GIT_TOKEN;

const server = createServer({
	storage: new BetterSqlite3Storage(new Database("repos.sqlite")),
	autoCreate: true,

	auth: {
		http: (request) => {
			if (!GIT_TOKEN) return { transport: "http", request };

			const header = request.headers.get("authorization");
			if (!header) {
				return new Response("Authentication required\n", {
					status: 401,
					headers: { "WWW-Authenticate": 'Basic realm="git"' },
				});
			}
			if (header.startsWith("Basic ")) {
				const password = atob(header.slice(6)).split(":")[1];
				if (password !== GIT_TOKEN) {
					return new Response("Forbidden", { status: 403 });
				}
			} else if (header.startsWith("Bearer ")) {
				if (header.slice(7) !== GIT_TOKEN) {
					return new Response("Forbidden", { status: 403 });
				}
			} else {
				return new Response("Forbidden", { status: 403 });
			}
			return { transport: "http", request };
		},
		ssh: (info) => ({ transport: "ssh", username: info.username }),
	},

	policy: {
		protectedBranches: ["main", "master"],
		immutableTags: true,
	},

	hooks: {
		postReceive: ({ repoId, updates }) => {
			for (const u of updates) {
				console.log(
					`[push] ${repoId}: ${u.ref} ${u.oldHash?.slice(0, 7) ?? "(new)"} → ${u.newHash.slice(0, 7)}`,
				);
			}
		},
	},
});

const PORT = parseInt(process.env.PORT || "4280", 10);

http.createServer(server.nodeHandler).listen(PORT, () => {
	console.log(`Git server listening on http://localhost:${PORT}`);
	console.log(`Auth: ${GIT_TOKEN ? "enabled (set GIT_TOKEN)" : "disabled (no GIT_TOKEN set)"}`);
	console.log(`Protected branches: main, master`);
	console.log(`Try: git clone http://localhost:${PORT}/my-repo`);
});
