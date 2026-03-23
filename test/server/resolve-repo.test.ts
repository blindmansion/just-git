import { describe, expect, test } from "bun:test";
import { createCommit, writeBlob, writeTree } from "../../src/repo/writing.ts";
import { createServer } from "../../src/server/handler.ts";
import { MemoryStorage } from "../../src/server/memory-storage.ts";
import type { GitServerConfig } from "../../src/server/types.ts";
import { defaultHttpSession } from "./util.ts";

const TEST_IDENTITY = {
	name: "Test",
	email: "test@test.com",
	timestamp: 1000000000,
	timezone: "+0000",
};

async function setupServerRepo(options?: Pick<GitServerConfig, "session">) {
	const driver = new MemoryStorage();
	const server = createServer({ storage: driver, ...options });
	const repo = await server.createRepo("test");
	const blobHash = await writeBlob(repo, "hello");
	const treeHash = await writeTree(repo, [{ name: "README.md", hash: blobHash }]);
	await createCommit(repo, {
		tree: treeHash,
		parents: [],
		message: "init",
		author: TEST_IDENTITY,
		committer: TEST_IDENTITY,
		branch: "main",
	});
	return { server, driver };
}

describe("resolveRepo and session auth", () => {
	test("returns 404 when resolveRepo returns null", async () => {
		const server = createServer({
			storage: new MemoryStorage(),
			resolve: () => null,
		});

		const res = await server.fetch(
			new Request("http://localhost/test/info/refs?service=git-upload-pack"),
		);
		expect(res.status).toBe(404);
	});

	test("session builder returns custom Response for auth failure", async () => {
		const server = createServer({
			storage: new MemoryStorage(),
			resolve: () => null,
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
		const server = createServer({
			storage: new MemoryStorage(),
			resolve: () => null,
			session: {
				http: () => new Response("Forbidden", { status: 403 }),
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
		const server = createServer({
			storage: new MemoryStorage(),
			resolve: () => null,
			session: {
				http: () => new Response("Forbidden", { status: 403 }),
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
		const server = (await setupServerRepo()).server;

		const res = await server.fetch(
			new Request("http://localhost/test/info/refs?service=git-upload-pack"),
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("application/x-git-upload-pack-advertisement");
	});

	test("auth gate: rejects without token, allows with token", async () => {
		const server = (
			await setupServerRepo({
				session: {
					http: (req) => {
						if (req.headers.get("Authorization") !== "Bearer valid-token") {
							return new Response("", { status: 401 });
						}
						return defaultHttpSession(req);
					},
				},
			})
		).server;

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
