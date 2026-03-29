import { describe, expect, test } from "bun:test";
import { createCommit, writeBlob, writeTree } from "../../src/repo/writing.ts";
import { createServer } from "../../src/server/handler.ts";
import { MemoryStorage } from "../../src/server/memory-storage.ts";
import { createStorageAdapter } from "../../src/server/storage.ts";
import { encodePktLine, flushPkt, concatPktLines } from "../../src/lib/transport/pkt-line.ts";
import { createServerClient, envAt, startServer } from "./util.ts";

const TEST_IDENTITY = {
	name: "Test",
	email: "test@test.com",
	timestamp: 1000000000,
	timezone: "+0000",
};

async function setupRepo() {
	const driver = new MemoryStorage();
	const storage = createStorageAdapter(driver);
	const repo = await storage.createRepo("repo");
	const blob = await writeBlob(repo, "# test");
	const tree = await writeTree(repo, [{ name: "README.md", hash: blob }]);
	const commit = await createCommit(repo, {
		tree,
		parents: [],
		author: TEST_IDENTITY,
		committer: TEST_IDENTITY,
		message: "init\n",
	});
	await repo.refStore.writeRef("refs/heads/main", { type: "direct", hash: commit });
	return { repo, driver };
}

async function gzipBytes(data: Uint8Array): Promise<Uint8Array> {
	const cs = new CompressionStream("gzip");
	const writer = cs.writable.getWriter();
	const copy = new Uint8Array(data.byteLength);
	copy.set(data);
	await writer.write(copy);
	await writer.close();
	return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

// ── Issue 1: Upload-pack request size limits ────────────────────────

describe("bounded request size (upload-pack)", () => {
	test("oversized upload-pack body returns 413", async () => {
		const { driver } = await setupRepo();
		const server = createServer({
			storage: driver,
			fetchLimits: { maxRequestBytes: 64 },
			onError: false,
		});

		const enc = new TextEncoder();
		const fakeHash = "a".repeat(40);
		const wants: Uint8Array[] = [];
		for (let i = 0; i < 10; i++) {
			wants.push(encodePktLine(enc.encode(`want ${fakeHash}\n`)));
		}
		const body = concatPktLines(...wants, flushPkt(), encodePktLine(enc.encode("done\n")));

		const res = await server.fetch(
			new Request("http://localhost/repo/git-upload-pack", {
				method: "POST",
				body,
			}),
		);
		expect(res.status).toBe(413);
		expect(await res.text()).toContain("Request body too large");
	});

	test("oversized gzip-compressed upload-pack body returns 413", async () => {
		const { driver } = await setupRepo();
		const server = createServer({
			storage: driver,
			fetchLimits: { maxRequestBytes: 4096, maxInflatedBytes: 64 },
			onError: false,
		});

		const enc = new TextEncoder();
		const fakeHash = "b".repeat(40);
		const wants: Uint8Array[] = [];
		for (let i = 0; i < 10; i++) {
			wants.push(encodePktLine(enc.encode(`want ${fakeHash}\n`)));
		}
		const rawBody = concatPktLines(...wants, flushPkt(), encodePktLine(enc.encode("done\n")));
		const compressed = await gzipBytes(rawBody);

		const res = await server.fetch(
			new Request("http://localhost/repo/git-upload-pack", {
				method: "POST",
				headers: { "Content-Encoding": "gzip" },
				body: compressed,
			}),
		);
		expect(res.status).toBe(413);
		expect(await res.text()).toContain("Decompressed body too large");
	});

	test("normal-sized upload-pack body succeeds", async () => {
		const { driver } = await setupRepo();
		const server = createServer({
			storage: driver,
			fetchLimits: { maxRequestBytes: 4096 },
		});

		const emptyBody = concatPktLines(flushPkt(), encodePktLine(new TextEncoder().encode("done\n")));
		const res = await server.fetch(
			new Request("http://localhost/repo/git-upload-pack", {
				method: "POST",
				body: emptyBody,
			}),
		);
		expect(res.status).toBe(200);
	});

	test("fetchLimits does not affect receive-pack", async () => {
		const { driver } = await setupRepo();
		const server = createServer({
			storage: driver,
			fetchLimits: { maxRequestBytes: 4 },
			onError: false,
		});

		const res = await server.fetch(
			new Request("http://localhost/repo/git-receive-pack", {
				method: "POST",
				body: flushPkt(),
			}),
		);
		expect(res.status).toBe(200);
	});

	test("receiveLimits does not tighten upload-pack beyond fetchLimits", async () => {
		const { driver } = await setupRepo();
		const server = createServer({
			storage: driver,
			receiveLimits: { maxRequestBytes: 4 },
			fetchLimits: { maxRequestBytes: 4096 },
		});

		const emptyBody = concatPktLines(flushPkt(), encodePktLine(new TextEncoder().encode("done\n")));
		const res = await server.fetch(
			new Request("http://localhost/repo/git-upload-pack", {
				method: "POST",
				body: emptyBody,
			}),
		);
		expect(res.status).toBe(200);
	});
});

// ── Issue 2: Rejected push object rollback ──────────────────────────

describe("rejected push side effects", () => {
	test("preReceive rejection leaves zero new objects (memory/http)", async () => {
		const { driver } = await setupRepo();

		const objsBefore = driver.listObjectHashes("repo");
		const countBefore = objsBefore.length;

		const { srv, port } = startServer({
			storage: driver,
			hooks: {
				preReceive: async () => ({ reject: true, message: "blocked" }),
			},
		});

		try {
			const client = createServerClient();
			await client.exec(`git clone http://localhost:${port}/repo /local`, {
				env: envAt(1000000100),
			});

			await client.writeFile("/local/evil.txt", "should not persist");
			await client.exec("git add .", { cwd: "/local" });
			await client.exec('git commit -m "rejected"', {
				cwd: "/local",
				env: envAt(1000000200),
			});

			const pushResult = await client.exec("git push origin main", { cwd: "/local" });
			expect(pushResult.exitCode).not.toBe(0);

			const objsAfter = driver.listObjectHashes("repo");
			const delta = objsAfter.length - countBefore;
			expect(delta).toBeLessThanOrEqual(0);
		} finally {
			srv.stop();
		}
	});

	test("update rejection with no applied refs rolls back new objects", async () => {
		const { driver } = await setupRepo();
		const countBefore = driver.listObjectHashes("repo").length;

		const { server, srv, port } = startServer({
			storage: driver,
			hooks: {
				update: async () => ({ reject: true, message: "blocked" }),
			},
		});

		try {
			const client = createServerClient();
			await client.exec(`git clone http://localhost:${port}/repo /local`, {
				env: envAt(1000000150),
			});

			await client.writeFile("/local/update-blocked.txt", "should not persist");
			await client.exec("git add .", { cwd: "/local" });
			await client.exec('git commit -m "blocked update"', {
				cwd: "/local",
				env: envAt(1000000160),
			});

			const headResult = await client.exec("git rev-parse HEAD", { cwd: "/local" });
			const commitHash = headResult.stdout.trim();

			const pushResult = await client.exec("git push origin main", { cwd: "/local" });
			expect(pushResult.exitCode).not.toBe(0);

			const repo = await server.requireRepo("repo");
			expect(await repo.objectStore.exists(commitHash)).toBe(false);
			expect(driver.listObjectHashes("repo")).toHaveLength(countBefore);
		} finally {
			srv.stop();
		}
	});

	test("approved push persists objects correctly (regression)", async () => {
		const { driver } = await setupRepo();

		const objsBefore = driver.listObjectHashes("repo");
		const countBefore = objsBefore.length;

		const { srv, port } = startServer({ storage: driver });

		try {
			const client = createServerClient();
			await client.exec(`git clone http://localhost:${port}/repo /local`, {
				env: envAt(1000000100),
			});

			await client.writeFile("/local/new.txt", "new content");
			await client.exec("git add .", { cwd: "/local" });
			await client.exec('git commit -m "add new"', {
				cwd: "/local",
				env: envAt(1000000200),
			});

			const pushResult = await client.exec("git push origin main", { cwd: "/local" });
			expect(pushResult.exitCode).toBe(0);

			const objsAfter = driver.listObjectHashes("repo");
			expect(objsAfter.length).toBeGreaterThan(countBefore);
		} finally {
			srv.stop();
		}
	});

	test("preReceive rejection rolls back: object does not exist", async () => {
		const { driver } = await setupRepo();
		const { server, srv, port } = startServer({
			storage: driver,
			hooks: {
				preReceive: async () => ({ reject: true, message: "nope" }),
			},
		});

		try {
			const client = createServerClient();
			await client.exec(`git clone http://localhost:${port}/repo /local`, {
				env: envAt(1000000300),
			});

			await client.writeFile("/local/secret.txt", "secret data");
			await client.exec("git add .", { cwd: "/local" });
			await client.exec('git commit -m "secret"', {
				cwd: "/local",
				env: envAt(1000000400),
			});

			const headResult = await client.exec("git rev-parse HEAD", { cwd: "/local" });
			const commitHash = headResult.stdout.trim();

			const pushResult = await client.exec("git push origin main", { cwd: "/local" });
			expect(pushResult.exitCode).not.toBe(0);

			const repo = await server.requireRepo("repo");
			expect(await repo.objectStore.exists(commitHash)).toBe(false);

			const mainRef = await repo.refStore.readRef("refs/heads/main");
			const mainHash = mainRef?.type === "direct" ? mainRef.hash : null;
			expect(mainHash).not.toBe(commitHash);
		} finally {
			srv.stop();
		}
	});

	test("refs are stable after rejected push", async () => {
		const { repo, driver } = await setupRepo();

		const mainRef = await repo.refStore.readRef("refs/heads/main");
		const originalMain = mainRef?.type === "direct" ? mainRef.hash : null;

		const { srv, port } = startServer({
			storage: driver,
			hooks: {
				preReceive: async () => ({ reject: true }),
			},
		});

		try {
			const client = createServerClient();
			await client.exec(`git clone http://localhost:${port}/repo /local`, {
				env: envAt(1000000500),
			});

			await client.writeFile("/local/file.txt", "data");
			await client.exec("git add .", { cwd: "/local" });
			await client.exec('git commit -m "push"', {
				cwd: "/local",
				env: envAt(1000000600),
			});

			const pushResult = await client.exec("git push origin main", { cwd: "/local" });
			expect(pushResult.exitCode).not.toBe(0);

			const updatedRef = await repo.refStore.readRef("refs/heads/main");
			const updatedHash = updatedRef?.type === "direct" ? updatedRef.hash : null;
			expect(updatedHash).toBe(originalMain);
		} finally {
			srv.stop();
		}
	});
});
