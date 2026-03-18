import { beforeAll, describe, expect, test } from "bun:test";
import { InMemoryFs, Bash } from "just-bash";
import { createGit } from "../../src/index.ts";
import { findRepo } from "../../src/lib/repo.ts";
import type { GitContext } from "../../src/lib/types.ts";
import { envAt, createServerClient, startServer } from "./util.ts";

describe("server hooks e2e", () => {
	let serverFs: InMemoryFs;
	let serverBash: Bash;
	let serverRepo: GitContext;

	beforeAll(async () => {
		serverFs = new InMemoryFs();
		const git = createGit();
		serverBash = new Bash({ fs: serverFs, cwd: "/repo", customCommands: [git] });

		await serverBash.writeFile("/repo/README.md", "# Test");
		await serverBash.exec("git init");
		await serverBash.exec("git add .");
		await serverBash.exec('git commit -m "initial"', { env: envAt(1000000000) });

		await serverBash.exec("git branch feature");
		await serverBash.exec("git branch internal-branch");

		const ctx = await findRepo(serverFs, "/repo");
		if (!ctx) throw new Error("repo not found");
		serverRepo = ctx;
	});

	describe("update hook", () => {
		test("rejects a specific ref while allowing others", async () => {
			const refResults: Array<{ ref: string; allowed: boolean }> = [];

			const { srv, port } = startServer({
				resolveRepo: async () => serverRepo,
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

				// Create and push a new branch that should be blocked
				await client.exec("git checkout -b blocked", { cwd: "/local" });
				await client.writeFile("/local/blocked.txt", "blocked");
				await client.exec("git add .", { cwd: "/local" });
				await client.exec('git commit -m "blocked"', {
					cwd: "/local",
					env: envAt(1000000200),
				});

				const push = await client.exec("git push origin blocked", { cwd: "/local" });
				expect(push.exitCode).not.toBe(0);

				// Verify the ref was not created on the server
				const ref = await serverRepo.refStore.readRef("refs/heads/blocked");
				expect(ref).toBeNull();

				// Push to a different branch that should succeed
				await client.exec("git checkout -b allowed", { cwd: "/local" });
				const pushOk = await client.exec("git push origin allowed", { cwd: "/local" });
				expect(pushOk.exitCode).toBe(0);

				const allowedRef = await serverRepo.refStore.readRef("refs/heads/allowed");
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
				resolveRepo: async () => serverRepo,
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

				// Push a new branch (isCreate = true)
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
			// Set up a server that hides branches starting with "internal"
			const { srv, port } = startServer({
				resolveRepo: async () => serverRepo,
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

				// Client should see main and feature, but not internal-branch
				const branches = await client.exec("git branch -r", { cwd: "/local" });
				expect(branches.stdout).toContain("origin/main");
				expect(branches.stdout).toContain("origin/feature");
				expect(branches.stdout).not.toContain("internal");
			} finally {
				srv.stop();
			}
		});

		test("filtered refs affect fetch", async () => {
			// Create a new internal branch after initial clone
			await serverBash.exec("git branch internal-new");

			const { srv, port } = startServer({
				resolveRepo: async () => serverRepo,
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

				const fetch = await client.exec("git fetch origin", { cwd: "/local" });
				expect(fetch.exitCode).toBe(0);

				const branches = await client.exec("git branch -r", { cwd: "/local" });
				expect(branches.stdout).not.toContain("internal");
			} finally {
				srv.stop();
			}
		});

		test("receives service type", async () => {
			const services: string[] = [];

			const { srv, port } = startServer({
				resolveRepo: async () => serverRepo,
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

				// Clone triggers git-upload-pack
				expect(services).toContain("git-upload-pack");

				// Push triggers git-receive-pack
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
	});
});
