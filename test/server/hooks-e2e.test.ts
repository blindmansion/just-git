import { beforeAll, describe, expect, test } from "bun:test";
import { MemoryStorage } from "../../src/server/memory-storage.ts";
import type { GitServer } from "../../src/server/types.ts";
import { envAt, createServerClient, startServer } from "./util.ts";

describe("server hooks e2e", () => {
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

		const repo = await server.requireRepo("repo");
		const mainRef = await repo.refStore.readRef("refs/heads/main");
		const mainHash = mainRef!.type === "direct" ? mainRef!.hash : "";
		await repo.refStore.writeRef("refs/heads/feature", mainHash);
		await repo.refStore.writeRef("refs/heads/internal-branch", mainHash);
	});

	describe("update hook", () => {
		test("rejects a specific ref while allowing others", async () => {
			const refResults: Array<{ ref: string; allowed: boolean }> = [];

			const {
				server: testServer,
				srv,
				port,
			} = startServer({
				storage: driver,
				hooks: {
					update: async ({ update }) => {
						if (update.ref === "refs/heads/blocked") {
							refResults.push({ ref: update.ref, allowed: false });
							return { reject: true, message: "blocked branch" };
						}
						refResults.push({ ref: update.ref, allowed: true });
					},
				},
			});

			try {
				const client = createServerClient();
				await client.exec(`git clone http://localhost:${port}/repo /local`, {
					env: envAt(1000000100),
				});

				await client.exec("git checkout -b blocked", { cwd: "/local" });
				await client.writeFile("/local/blocked.txt", "blocked");
				await client.exec("git add .", { cwd: "/local" });
				await client.exec('git commit -m "blocked"', {
					cwd: "/local",
					env: envAt(1000000200),
				});

				const push = await client.exec("git push origin blocked", { cwd: "/local" });
				expect(push.exitCode).not.toBe(0);

				const repo = (await testServer.repo("repo"))!;
				const ref = await repo.refStore.readRef("refs/heads/blocked");
				expect(ref).toBeNull();

				await client.exec("git checkout -b allowed", { cwd: "/local" });
				const pushOk = await client.exec("git push origin allowed", { cwd: "/local" });
				expect(pushOk.exitCode).toBe(0);

				const allowedRef = await repo.refStore.readRef("refs/heads/allowed");
				expect(allowedRef).not.toBeNull();
			} finally {
				srv.stop();
			}
		});

		test("receives correct update fields", async () => {
			const captured: Array<{
				ref: string;
				isFF: boolean;
				isCreate: boolean;
				isDelete: boolean;
			}> = [];

			const { srv, port } = startServer({
				storage: driver,
				hooks: {
					update: async ({ update }) => {
						captured.push({
							ref: update.ref,
							isFF: update.isFF,
							isCreate: update.isCreate,
							isDelete: update.isDelete,
						});
					},
				},
			});

			try {
				const client = createServerClient();
				await client.exec(`git clone http://localhost:${port}/repo /local`, {
					env: envAt(1000000300),
				});

				await client.exec("git checkout -b new-branch", { cwd: "/local" });
				await client.writeFile("/local/new.txt", "new");
				await client.exec("git add .", { cwd: "/local" });
				await client.exec('git commit -m "new"', {
					cwd: "/local",
					env: envAt(1000000400),
				});
				await client.exec("git push origin new-branch", { cwd: "/local" });

				expect(captured.length).toBe(1);
				expect(captured[0]!.ref).toBe("refs/heads/new-branch");
				expect(captured[0]!.isCreate).toBe(true);
				expect(captured[0]!.isDelete).toBe(false);
			} finally {
				srv.stop();
			}
		});
	});

	describe("advertiseRefs hook", () => {
		test("filtered refs affect what client sees during clone", async () => {
			const { srv, port } = startServer({
				storage: driver,
				hooks: {
					advertiseRefs: async ({ refs }) => {
						return refs.filter((r) => !r.name.includes("internal"));
					},
				},
			});

			try {
				const client = createServerClient();

				await client.exec(`git clone http://localhost:${port}/repo /local`, {
					env: envAt(1000000500),
				});

				const branches = await client.exec("git branch -r", { cwd: "/local" });
				expect(branches.stdout).toContain("origin/main");
				expect(branches.stdout).toContain("origin/feature");
				expect(branches.stdout).not.toContain("internal");
			} finally {
				srv.stop();
			}
		});

		test("filtered refs affect fetch", async () => {
			const repo = await server.requireRepo("repo");
			const mainRef = await repo.refStore.readRef("refs/heads/main");
			await repo.refStore.writeRef("refs/heads/internal-new", mainRef!);

			const { srv, port } = startServer({
				storage: driver,
				hooks: {
					advertiseRefs: async ({ refs }) => {
						return refs.filter((r) => !r.name.includes("internal"));
					},
				},
			});

			try {
				const client = createServerClient();

				await client.exec(`git clone http://localhost:${port}/repo /local`, {
					env: envAt(1000000600),
				});

				const fetchRes = await client.exec("git fetch origin", { cwd: "/local" });
				expect(fetchRes.exitCode).toBe(0);

				const branches = await client.exec("git branch -r", { cwd: "/local" });
				expect(branches.stdout).not.toContain("internal");
			} finally {
				srv.stop();
			}
		});

		test("receives service type", async () => {
			const services: string[] = [];

			const { srv, port } = startServer({
				storage: driver,
				hooks: {
					advertiseRefs: async ({ service }) => {
						services.push(service);
					},
				},
			});

			try {
				const client = createServerClient();
				await client.exec(`git clone http://localhost:${port}/repo /local`, {
					env: envAt(1000000700),
				});

				expect(services).toContain("git-upload-pack");

				await client.writeFile("/local/svc.txt", "svc");
				await client.exec("git add .", { cwd: "/local" });
				await client.exec('git commit -m "svc"', {
					cwd: "/local",
					env: envAt(1000000800),
				});
				await client.exec("git push origin main", { cwd: "/local" });

				expect(services).toContain("git-receive-pack");
			} finally {
				srv.stop();
			}
		});

		test("rejection from advertiseRefs returns 403 over HTTP", async () => {
			const { srv, port } = startServer({
				storage: driver,
				hooks: {
					advertiseRefs: async () => {
						return { reject: true, message: "access denied" };
					},
				},
			});

			try {
				const res = await fetch(`http://localhost:${port}/repo/info/refs?service=git-upload-pack`);
				expect(res.status).toBe(403);
				expect(await res.text()).toBe("access denied");
			} finally {
				srv.stop();
			}
		});
	});
});
