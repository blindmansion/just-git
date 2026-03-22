import { describe, expect, test } from "bun:test";
import { InMemoryFs, Bash } from "just-bash";
import { createGit } from "../../src/index.ts";
import { findRepo } from "../../src/lib/repo.ts";
import { createGitServer } from "../../src/server/handler.ts";
import { envAt, defaultHttpSession, defaultSshSession } from "./util.ts";

async function setupServerRepo() {
	const fs = new InMemoryFs();
	const git = createGit();
	const bash = new Bash({ fs, cwd: "/repo", customCommands: [git] });
	await bash.writeFile("/repo/README.md", "hello");
	await bash.exec("git init");
	await bash.exec("git add .");
	await bash.exec('git commit -m "init"', { env: envAt(1000000000) });
	const ctx = await findRepo(fs, "/repo");
	if (!ctx) throw new Error("repo not found");
	return ctx;
}

describe("resolveRepo and session auth", () => {
	test("returns 404 when resolveRepo returns null", async () => {
		const server = createGitServer({
			resolveRepo: () => null,
		});

		const res = await server.fetch(
			new Request("http://localhost/test/info/refs?service=git-upload-pack"),
		);
		expect(res.status).toBe(404);
	});

	test("session builder returns custom Response for auth failure", async () => {
		const server = createGitServer({
			resolveRepo: () => null,
			session: {
				http: (req) => {
					if (req.headers.get("Authorization") !== "Bearer secret") {
						return new Response("Unauthorized", {
							status: 401,
							headers: { "WWW-Authenticate": 'Bearer realm="git"' },
						});
					}
					return defaultHttpSession(req);
				},
				ssh: defaultSshSession,
			},
		});

		const res = await server.fetch(
			new Request("http://localhost/test/info/refs?service=git-upload-pack"),
		);
		expect(res.status).toBe(401);
		expect(res.headers.get("WWW-Authenticate")).toBe('Bearer realm="git"');
		expect(await res.text()).toBe("Unauthorized");
	});

	test("session builder rejects → 403 for upload-pack", async () => {
		const server = createGitServer({
			resolveRepo: () => null,
			session: {
				http: () => new Response("Forbidden", { status: 403 }),
				ssh: defaultSshSession,
			},
		});

		const res = await server.fetch(
			new Request("http://localhost/test/git-upload-pack", {
				method: "POST",
				body: new Uint8Array(0),
			}),
		);
		expect(res.status).toBe(403);
	});

	test("session builder rejects → 403 for receive-pack", async () => {
		const server = createGitServer({
			resolveRepo: () => null,
			session: {
				http: () => new Response("Forbidden", { status: 403 }),
				ssh: defaultSshSession,
			},
		});

		const res = await server.fetch(
			new Request("http://localhost/test/git-receive-pack", {
				method: "POST",
				body: new Uint8Array(0),
			}),
		);
		expect(res.status).toBe(403);
	});

	test("proceeds normally when resolveRepo returns a GitRepo", async () => {
		const repo = await setupServerRepo();

		const server = createGitServer({
			resolveRepo: () => repo,
		});

		const res = await server.fetch(
			new Request("http://localhost/test/info/refs?service=git-upload-pack"),
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("application/x-git-upload-pack-advertisement");
	});

	test("auth gate: rejects without token, allows with token", async () => {
		const repo = await setupServerRepo();

		const server = createGitServer({
			resolveRepo: () => repo,
			session: {
				http: (req) => {
					if (req.headers.get("Authorization") !== "Bearer valid-token") {
						return new Response("", { status: 401 });
					}
					return defaultHttpSession(req);
				},
				ssh: defaultSshSession,
			},
		});

		const rejected = await server.fetch(
			new Request("http://localhost/test/info/refs?service=git-upload-pack"),
		);
		expect(rejected.status).toBe(401);

		const allowed = await server.fetch(
			new Request("http://localhost/test/info/refs?service=git-upload-pack", {
				headers: { Authorization: "Bearer valid-token" },
			}),
		);
		expect(allowed.status).toBe(200);
	});
});
