import { beforeAll, describe, expect, test } from "bun:test";
import { MemoryStorage } from "../../src/server/memory-storage.ts";
import type { GitServer } from "../../src/server/types.ts";
import { envAt, createServerClient, startServer, startServerWithSessionAuth } from "./util.ts";

describe("server policy", () => {
	let driver: MemoryStorage;
	let server: GitServer;

	beforeAll(async () => {
		driver = new MemoryStorage();
		const { server: s, srv: seedSrv, port: seedPort } = startServer({ storage: driver });
		server = s;

		await server.createRepo("repo");

		const seedClient = createServerClient();
		await seedClient.exec(`git clone http://localhost:${seedPort}/repo /local`, {
			env: envAt(1000000000),
		});
		await seedClient.writeFile("/local/README.md", "# Test");
		await seedClient.exec("git add .", { cwd: "/local", env: envAt(1000000000) });
		await seedClient.exec('git commit -m "initial"', {
			cwd: "/local",
			env: envAt(1000000000),
		});
		await seedClient.exec("git push origin main", { cwd: "/local" });

		seedSrv.stop();

		const repo = (await server.repo("repo"))!;
		const mainRef = await repo.refStore.readRef("refs/heads/main");
		const mainHash = mainRef!.type === "direct" ? mainRef!.hash : "";
		await repo.refStore.writeRef("refs/heads/protected-branch", mainHash);
	});

	describe("protectedBranches", () => {
		test("blocks force-push to protected branch", async () => {
			const { srv, port } = startServer({
				storage: driver,
				policy: { protectedBranches: ["main"] },
			});

			try {
				const client = createServerClient();
				await client.exec(`git clone http://localhost:${port}/repo /local`, {
					env: envAt(1000000100),
				});

				await client.writeFile("/local/diverge.txt", "diverge");
				await client.exec("git add .", { cwd: "/local" });
				await client.exec('git commit --amend -m "diverge"', {
					cwd: "/local",
					env: envAt(1000000200),
				});

				const push = await client.exec("git push --force origin main", { cwd: "/local" });
				expect(push.exitCode).not.toBe(0);
			} finally {
				srv.stop();
			}
		});

		test("allows fast-forward push to protected branch", async () => {
			const { srv, port } = startServer({
				storage: driver,
				policy: { protectedBranches: ["main"] },
			});

			try {
				const client = createServerClient();
				await client.exec(`git clone http://localhost:${port}/repo /local`, {
					env: envAt(1000000300),
				});

				await client.writeFile("/local/new.txt", "new");
				await client.exec("git add .", { cwd: "/local" });
				await client.exec('git commit -m "ff commit"', {
					cwd: "/local",
					env: envAt(1000000400),
				});

				const push = await client.exec("git push origin main", { cwd: "/local" });
				expect(push.exitCode).toBe(0);
			} finally {
				srv.stop();
			}
		});

		test("blocks deletion of protected branch", async () => {
			const { srv, port } = startServer({
				storage: driver,
				policy: { protectedBranches: ["protected-branch"] },
			});

			try {
				const client = createServerClient();
				await client.exec(`git clone http://localhost:${port}/repo /local`, {
					env: envAt(1000000500),
				});

				const del = await client.exec("git push origin --delete protected-branch", {
					cwd: "/local",
				});
				expect(del.exitCode).not.toBe(0);
			} finally {
				srv.stop();
			}
		});

		test("allows deletion of non-protected branch", async () => {
			const repo = (await server.repo("repo"))!;
			const mainRef = await repo.refStore.readRef("refs/heads/main");
			await repo.refStore.writeRef("refs/heads/temp-delete", mainRef!);

			const { srv, port } = startServer({
				storage: driver,
				policy: { protectedBranches: ["main"] },
			});

			try {
				const client = createServerClient();
				await client.exec(`git clone http://localhost:${port}/repo /local`, {
					env: envAt(1000000600),
				});

				const del = await client.exec("git push origin --delete temp-delete", {
					cwd: "/local",
				});
				expect(del.exitCode).toBe(0);
			} finally {
				srv.stop();
			}
		});

		test("accepts short branch names (without refs/heads/ prefix)", async () => {
			const { srv, port } = startServer({
				storage: driver,
				policy: { protectedBranches: ["main"] },
			});

			try {
				const client = createServerClient();
				await client.exec(`git clone http://localhost:${port}/repo /local`, {
					env: envAt(1000000700),
				});
				await client.writeFile("/local/amend.txt", "amend");
				await client.exec("git add .", { cwd: "/local" });
				await client.exec('git commit --amend -m "amend"', {
					cwd: "/local",
					env: envAt(1000000800),
				});
				const push = await client.exec("git push --force origin main", { cwd: "/local" });
				expect(push.exitCode).not.toBe(0);
			} finally {
				srv.stop();
			}
		});
	});

	describe("denyNonFastForward", () => {
		test("rejects non-fast-forward push to any branch", async () => {
			const repo = (await server.repo("repo"))!;
			const mainRef = await repo.refStore.readRef("refs/heads/main");
			await repo.refStore.writeRef("refs/heads/deny-ff-test", mainRef!);

			const { srv, port } = startServer({
				storage: driver,
				policy: { denyNonFastForward: true },
			});

			try {
				const client = createServerClient();
				await client.exec(`git clone http://localhost:${port}/repo /local`, {
					env: envAt(1000000900),
				});

				await client.exec("git checkout deny-ff-test", { cwd: "/local" });
				await client.writeFile("/local/diverge2.txt", "diverge");
				await client.exec("git add .", { cwd: "/local" });
				await client.exec('git commit --amend -m "diverge"', {
					cwd: "/local",
					env: envAt(1000001000),
				});

				const push = await client.exec("git push --force origin deny-ff-test", {
					cwd: "/local",
				});
				expect(push.exitCode).not.toBe(0);
			} finally {
				srv.stop();
			}
		});

		test("allows fast-forward push", async () => {
			const { srv, port } = startServer({
				storage: driver,
				policy: { denyNonFastForward: true },
			});

			try {
				const client = createServerClient();
				await client.exec(`git clone http://localhost:${port}/repo /local`, {
					env: envAt(1000001100),
				});

				await client.writeFile("/local/ff.txt", "ff");
				await client.exec("git add .", { cwd: "/local" });
				await client.exec('git commit -m "ff"', {
					cwd: "/local",
					env: envAt(1000001200),
				});

				const push = await client.exec("git push origin main", { cwd: "/local" });
				expect(push.exitCode).toBe(0);
			} finally {
				srv.stop();
			}
		});
	});

	describe("denyDeletes", () => {
		test("rejects ref deletion", async () => {
			const repo = (await server.repo("repo"))!;
			const mainRef = await repo.refStore.readRef("refs/heads/main");
			await repo.refStore.writeRef("refs/heads/deny-del-test", mainRef!);

			const { srv, port } = startServer({
				storage: driver,
				policy: { denyDeletes: true },
			});

			try {
				const client = createServerClient();
				await client.exec(`git clone http://localhost:${port}/repo /local`, {
					env: envAt(1000001300),
				});

				const del = await client.exec("git push origin --delete deny-del-test", {
					cwd: "/local",
				});
				expect(del.exitCode).not.toBe(0);
			} finally {
				srv.stop();
			}
		});

		test("allows non-delete pushes", async () => {
			const { srv, port } = startServer({
				storage: driver,
				policy: { denyDeletes: true },
			});

			try {
				const client = createServerClient();
				await client.exec(`git clone http://localhost:${port}/repo /local`, {
					env: envAt(1000001400),
				});

				await client.writeFile("/local/nodelete.txt", "ok");
				await client.exec("git add .", { cwd: "/local" });
				await client.exec('git commit -m "no delete"', {
					cwd: "/local",
					env: envAt(1000001500),
				});

				const push = await client.exec("git push origin main", { cwd: "/local" });
				expect(push.exitCode).toBe(0);
			} finally {
				srv.stop();
			}
		});
	});

	describe("policy + hooks composition", () => {
		test("policy runs before user hooks", async () => {
			const hookLog: string[] = [];
			const { srv, port } = startServer({
				storage: driver,
				policy: { protectedBranches: ["main"] },
				hooks: {
					preReceive: () => {
						hookLog.push("user-preReceive");
					},
					postReceive: () => {
						hookLog.push("user-postReceive");
					},
				},
			});

			try {
				const client = createServerClient();
				await client.exec(`git clone http://localhost:${port}/repo /local`, {
					env: envAt(1000002700),
				});

				await client.writeFile("/local/compose.txt", "compose");
				await client.exec("git add .", { cwd: "/local" });
				await client.exec('git commit -m "compose"', {
					cwd: "/local",
					env: envAt(1000002800),
				});
				const push = await client.exec("git push origin main", { cwd: "/local" });
				expect(push.exitCode).toBe(0);
				expect(hookLog).toContain("user-preReceive");
				expect(hookLog).toContain("user-postReceive");
			} finally {
				srv.stop();
			}
		});

		test("policy rejection prevents user hooks from running", async () => {
			const hookLog: string[] = [];
			const { srv, port } = startServer({
				storage: driver,
				policy: { protectedBranches: ["main"] },
				hooks: {
					preReceive: () => {
						hookLog.push("user-preReceive");
					},
				},
			});

			try {
				const client = createServerClient();
				await client.exec(`git clone http://localhost:${port}/repo /local`, {
					env: envAt(1000002900),
				});

				await client.writeFile("/local/diverge.txt", "diverge");
				await client.exec("git add .", { cwd: "/local" });
				await client.exec('git commit --amend -m "diverge"', {
					cwd: "/local",
					env: envAt(1000003000),
				});
				const push = await client.exec("git push --force origin main", { cwd: "/local" });
				expect(push.exitCode).not.toBe(0);
				expect(hookLog).not.toContain("user-preReceive");
			} finally {
				srv.stop();
			}
		});
	});

	describe("session auth via hooks", () => {
		test("rejects clone when session builder rejects", async () => {
			const { srv, port } = startServerWithSessionAuth(() => false, {
				storage: driver,
			});

			try {
				const client = createServerClient();
				const clone = await client.exec(`git clone http://localhost:${port}/repo /local`, {
					env: envAt(1000003000),
				});
				expect(clone.exitCode).not.toBe(0);
			} finally {
				srv.stop();
			}
		});

		test("allows clone when session builder allows", async () => {
			const { srv, port } = startServerWithSessionAuth(() => true, {
				storage: driver,
			});

			try {
				const client = createServerClient();
				const clone = await client.exec(`git clone http://localhost:${port}/repo /local`, {
					env: envAt(1000003100),
				});
				expect(clone.exitCode).toBe(0);
			} finally {
				srv.stop();
			}
		});

		test("returns custom Response from session builder", async () => {
			const { srv, port } = startServerWithSessionAuth(
				() =>
					new Response("Unauthorized", {
						status: 401,
						headers: { "WWW-Authenticate": 'Bearer realm="git"' },
					}),
				{ storage: driver },
			);

			try {
				const res = await fetch(`http://localhost:${port}/repo/info/refs?service=git-upload-pack`);
				expect(res.status).toBe(401);
				expect(res.headers.get("WWW-Authenticate")).toBe('Bearer realm="git"');
			} finally {
				srv.stop();
			}
		});

		test("gates push when session builder rejects", async () => {
			const { srv, port } = startServerWithSessionAuth(
				(req) => req.headers.get("Authorization") === "Bearer secret",
				{ storage: driver },
			);

			try {
				const client = createServerClient();
				await client.exec(`git clone http://localhost:${port}/repo /local`, {
					env: envAt(1000003200),
				});
				const clone = await client.exec(`git clone http://localhost:${port}/repo /local2`, {
					env: envAt(1000003200),
				});
				expect(clone.exitCode).not.toBe(0);
			} finally {
				srv.stop();
			}
		});

		test("composes session auth with policy", async () => {
			const { srv, port } = startServerWithSessionAuth(() => true, {
				storage: driver,
				policy: { protectedBranches: ["main"] },
			});

			try {
				const client = createServerClient();
				await client.exec(`git clone http://localhost:${port}/repo /local`, {
					env: envAt(1000003300),
				});

				await client.writeFile("/local/compose.txt", "compose");
				await client.exec("git add .", { cwd: "/local" });
				await client.exec('git commit --amend -m "diverge"', {
					cwd: "/local",
					env: envAt(1000003400),
				});

				const push = await client.exec("git push --force origin main", { cwd: "/local" });
				expect(push.exitCode).not.toBe(0);
			} finally {
				srv.stop();
			}
		});
	});

	describe("immutableTags", () => {
		test("blocks tag deletion", async () => {
			const repo = (await server.repo("repo"))!;
			const mainRef = await repo.refStore.readRef("refs/heads/main");
			const mainHash = mainRef!.type === "direct" ? mainRef!.hash : "";
			const tagContent = `object ${mainHash}\ntype commit\ntag v1.0\ntagger Test <test@test.com> 1000002000 +0000\n\nrelease\n`;
			const tagHash = await repo.objectStore.write("tag", new TextEncoder().encode(tagContent));
			await repo.refStore.writeRef("refs/tags/v1.0", tagHash);

			const { srv, port } = startServer({
				storage: driver,
				policy: { immutableTags: true },
			});

			try {
				const client = createServerClient();
				await client.exec(`git clone http://localhost:${port}/repo /local`, {
					env: envAt(1000002100),
				});

				const del = await client.exec("git push origin --delete v1.0", { cwd: "/local" });
				expect(del.exitCode).not.toBe(0);

				const tag = await repo.refStore.readRef("refs/tags/v1.0");
				expect(tag).not.toBeNull();
			} finally {
				srv.stop();
			}
		});

		test("blocks tag overwrite via force-push", async () => {
			const { srv, port } = startServer({
				storage: driver,
				policy: { immutableTags: true },
			});

			try {
				const client = createServerClient();
				await client.exec(`git clone http://localhost:${port}/repo /local`, {
					env: envAt(1000002200),
				});

				await client.writeFile("/local/tag-overwrite.txt", "overwrite");
				await client.exec("git add .", { cwd: "/local" });
				await client.exec('git commit -m "new commit"', {
					cwd: "/local",
					env: envAt(1000002300),
				});
				await client.exec("git tag -f v1.0", { cwd: "/local" });

				const push = await client.exec("git push --force origin refs/tags/v1.0:refs/tags/v1.0", {
					cwd: "/local",
				});
				expect(push.exitCode).not.toBe(0);
			} finally {
				srv.stop();
			}
		});

		test("allows creating new tags", async () => {
			const { srv, port } = startServer({
				storage: driver,
				policy: { immutableTags: true },
			});

			try {
				const client = createServerClient();
				await client.exec(`git clone http://localhost:${port}/repo /local`, {
					env: envAt(1000002400),
				});

				await client.exec("git tag v2.0", { cwd: "/local" });
				const push = await client.exec("git push origin refs/tags/v2.0:refs/tags/v2.0", {
					cwd: "/local",
				});
				expect(push.exitCode).toBe(0);

				const repo = (await server.repo("repo"))!;
				const tag = await repo.refStore.readRef("refs/tags/v2.0");
				expect(tag).not.toBeNull();
			} finally {
				srv.stop();
			}
		});

		test("allows branch operations when only tags are protected", async () => {
			const repo = (await server.repo("repo"))!;
			const mainRef = await repo.refStore.readRef("refs/heads/main");
			await repo.refStore.writeRef("refs/heads/deleteable-branch", mainRef!);

			const { srv, port } = startServer({
				storage: driver,
				policy: { immutableTags: true },
			});

			try {
				const client = createServerClient();
				await client.exec(`git clone http://localhost:${port}/repo /local`, {
					env: envAt(1000002500),
				});

				await client.writeFile("/local/branch-ok.txt", "ok");
				await client.exec("git add .", { cwd: "/local" });
				await client.exec('git commit -m "branch ok"', {
					cwd: "/local",
					env: envAt(1000002600),
				});
				const push = await client.exec("git push origin main", { cwd: "/local" });
				expect(push.exitCode).toBe(0);

				const del = await client.exec("git push origin --delete deleteable-branch", {
					cwd: "/local",
				});
				expect(del.exitCode).toBe(0);
			} finally {
				srv.stop();
			}
		});
	});
});
