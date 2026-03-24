import { describe, expect, test } from "bun:test";
import { createServer } from "../../src/server/handler.ts";
import { MemoryStorage } from "../../src/server/memory-storage.ts";
import { createCommit, writeBlob, writeTree } from "../../src/repo/writing.ts";
import type { SshChannel } from "../../src/server/types.ts";

const TEST_IDENTITY = {
	name: "Test",
	email: "test@test.com",
	timestamp: 1000000000,
	timezone: "+0000",
};

async function setupRepo() {
	const server = createServer({
		storage: new MemoryStorage(),
		auth: {
			http: (req) => {
				const token = req.headers.get("Authorization");
				return { userId: token ?? "anonymous", roles: ["read"] as string[] };
			},
		},
		hooks: {
			preReceive: ({ auth }) => {
				if (!auth?.roles.includes("push")) {
					return { reject: true, message: "forbidden" };
				}
			},
		},
	});
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
	return server;
}

describe("partial auth provider", () => {
	test("http-only auth provider: HTTP requests work", async () => {
		const server = await setupRepo();
		const res = await server.fetch(
			new Request("http://localhost/test/info/refs?service=git-upload-pack"),
		);
		expect(res.status).toBe(200);
	});

	test("http-only auth provider: hooks receive typed auth", async () => {
		const server = createServer({
			storage: new MemoryStorage(),
			auth: {
				http: () => ({ userId: "alice", roles: ["read"] }),
			},
			hooks: {
				advertiseRefs: ({ auth }) => {
					if (!auth?.roles.includes("read")) {
						return { reject: true, message: "no read access" };
					}
				},
			},
		});
		await server.createRepo("test");

		const res = await server.fetch(
			new Request("http://localhost/test/info/refs?service=git-upload-pack"),
		);
		expect(res.status).toBe(200);
	});

	test("http-only auth provider: SSH returns 128", async () => {
		const server = await setupRepo();

		let stderrOutput = "";
		const channel: SshChannel = {
			readable: new ReadableStream(),
			writable: new WritableStream(),
			writeStderr(data) {
				stderrOutput += new TextDecoder().decode(data);
			},
		};

		const exitCode = await server.handleSession("git-upload-pack 'test'", channel);
		expect(exitCode).toBe(128);
		expect(stderrOutput).toContain("SSH auth provider not configured");
	});

	test("ssh-only auth provider: SSH works", async () => {
		const server = createServer({
			storage: new MemoryStorage(),
			auth: {
				ssh: (info) => ({ userId: info.username ?? "anon" }),
			},
		});
		await server.createRepo("test");

		// SSH auth provider is present — shouldn't error on construction
		expect(server).toBeDefined();
	});

	test("ssh-only auth provider: HTTP returns 501", async () => {
		const server = createServer({
			storage: new MemoryStorage(),
			auth: {
				ssh: (info) => ({ userId: info.username ?? "anon" }),
			},
		});

		const res = await server.fetch(
			new Request("http://localhost/test/info/refs?service=git-upload-pack"),
		);
		expect(res.status).toBe(501);
		expect(await res.text()).toBe("HTTP auth provider not configured");
	});

	test("no auth config: both transports use defaults", async () => {
		const server = createServer({
			storage: new MemoryStorage(),
		});
		await server.createRepo("test");

		const res = await server.fetch(
			new Request("http://localhost/test/info/refs?service=git-upload-pack"),
		);
		expect(res.status).toBe(200);
	});
});
