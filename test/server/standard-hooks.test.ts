import { beforeAll, describe, expect, test } from "bun:test";
import { InMemoryFs, Bash } from "just-bash";
import { createGit } from "../../src/index.ts";
import { findRepo } from "../../src/lib/repo.ts";
import type { GitContext } from "../../src/lib/types.ts";
import { createStandardHooks } from "../../src/server/presets.ts";
import { envAt, createServerClient, startServer } from "./util.ts";

describe("createStandardHooks", () => {
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

		await serverBash.exec("git branch protected-branch");

		const ctx = await findRepo(serverFs, "/repo");
		if (!ctx) throw new Error("repo not found");
		serverRepo = ctx;
	});

	describe("protectedBranches", () => {
		test("blocks force-push to protected branch", async () => {
			const hooks = createStandardHooks({ protectedBranches: ["main"] });
			const { srv, port } = startServer({ resolveRepo: async () => serverRepo, hooks });

			try {
				const client = createServerClient();
				await client.exec(`git clone http://localhost:${port}/repo /local`, {
					env: envAt(1000000100),
				});

				// Create a divergent history to force a non-FF push
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
			const hooks = createStandardHooks({ protectedBranches: ["main"] });
			const { srv, port } = startServer({ resolveRepo: async () => serverRepo, hooks });

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
			const hooks = createStandardHooks({ protectedBranches: ["protected-branch"] });
			const { srv, port } = startServer({ resolveRepo: async () => serverRepo, hooks });

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
			// Create a temporary branch to delete
			await serverBash.exec("git branch temp-delete");
			const hooks = createStandardHooks({ protectedBranches: ["main"] });
			const { srv, port } = startServer({ resolveRepo: async () => serverRepo, hooks });

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
			const hooks = createStandardHooks({ protectedBranches: ["main"] });
			// The preReceive handler should map "main" → "refs/heads/main" internally
			expect(hooks.preReceive).toBeDefined();

			const { srv, port } = startServer({ resolveRepo: async () => serverRepo, hooks });
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
			await serverBash.exec("git branch deny-ff-test");
			const hooks = createStandardHooks({ denyNonFastForward: true });
			const { srv, port } = startServer({ resolveRepo: async () => serverRepo, hooks });

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
			const hooks = createStandardHooks({ denyNonFastForward: true });
			const { srv, port } = startServer({ resolveRepo: async () => serverRepo, hooks });

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
			await serverBash.exec("git branch deny-del-test");
			const hooks = createStandardHooks({ denyDeletes: true });
			const { srv, port } = startServer({ resolveRepo: async () => serverRepo, hooks });

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
			const hooks = createStandardHooks({ denyDeletes: true });
			const { srv, port } = startServer({ resolveRepo: async () => serverRepo, hooks });

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

	describe("authorize", () => {
		test("rejects push without authorization header", async () => {
			const hooks = createStandardHooks({
				authorize: (req) => req.headers.has("Authorization"),
			});
			const { srv, port } = startServer({ resolveRepo: async () => serverRepo, hooks });

			try {
				const client = createServerClient();
				await client.exec(`git clone http://localhost:${port}/repo /local`, {
					env: envAt(1000001600),
				});

				await client.writeFile("/local/auth.txt", "auth");
				await client.exec("git add .", { cwd: "/local" });
				await client.exec('git commit -m "auth"', {
					cwd: "/local",
					env: envAt(1000001700),
				});

				const push = await client.exec("git push origin main", { cwd: "/local" });
				expect(push.exitCode).not.toBe(0);
			} finally {
				srv.stop();
			}
		});
	});

	describe("onPush", () => {
		test("fires after successful push", async () => {
			const pushLog: Array<{ repoPath: string; refCount: number }> = [];

			const hooks = createStandardHooks({
				onPush: async (event) => {
					pushLog.push({ repoPath: event.repoPath, refCount: event.updates.length });
				},
			});
			const { srv, port } = startServer({ resolveRepo: async () => serverRepo, hooks });

			try {
				const client = createServerClient();
				await client.exec(`git clone http://localhost:${port}/myrepo /local`, {
					env: envAt(1000001800),
				});

				await client.writeFile("/local/push-log.txt", "log");
				await client.exec("git add .", { cwd: "/local" });
				await client.exec('git commit -m "push log"', {
					cwd: "/local",
					env: envAt(1000001900),
				});

				const push = await client.exec("git push origin main", { cwd: "/local" });
				expect(push.exitCode).toBe(0);
				expect(pushLog.length).toBe(1);
				expect(pushLog[0]!.repoPath).toBe("myrepo");
				expect(pushLog[0]!.refCount).toBe(1);
			} finally {
				srv.stop();
			}
		});
	});

	describe("denyDeleteTags", () => {
		test("blocks tag deletion", async () => {
			// Create a tag on the server
			await serverBash.exec('git tag -a v1.0 -m "release"', { env: envAt(1000002000) });

			const hooks = createStandardHooks({ denyDeleteTags: true });
			const { srv, port } = startServer({ resolveRepo: async () => serverRepo, hooks });

			try {
				const client = createServerClient();
				await client.exec(`git clone http://localhost:${port}/repo /local`, {
					env: envAt(1000002100),
				});

				const del = await client.exec("git push origin --delete v1.0", { cwd: "/local" });
				expect(del.exitCode).not.toBe(0);

				// Tag should still exist on server
				const tag = await serverRepo.refStore.readRef("refs/tags/v1.0");
				expect(tag).not.toBeNull();
			} finally {
				srv.stop();
			}
		});

		test("blocks tag overwrite via force-push", async () => {
			const hooks = createStandardHooks({ denyDeleteTags: true });
			const { srv, port } = startServer({ resolveRepo: async () => serverRepo, hooks });

			try {
				const client = createServerClient();
				await client.exec(`git clone http://localhost:${port}/repo /local`, {
					env: envAt(1000002200),
				});

				// Make a new commit and try to move the tag
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
			const hooks = createStandardHooks({ denyDeleteTags: true });
			const { srv, port } = startServer({ resolveRepo: async () => serverRepo, hooks });

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

				const tag = await serverRepo.refStore.readRef("refs/tags/v2.0");
				expect(tag).not.toBeNull();
			} finally {
				srv.stop();
			}
		});

		test("allows branch operations when only tags are protected", async () => {
			await serverBash.exec("git branch deleteable-branch");
			const hooks = createStandardHooks({ denyDeleteTags: true });
			const { srv, port } = startServer({ resolveRepo: async () => serverRepo, hooks });

			try {
				const client = createServerClient();
				await client.exec(`git clone http://localhost:${port}/repo /local`, {
					env: envAt(1000002500),
				});

				// Branch push should work
				await client.writeFile("/local/branch-ok.txt", "ok");
				await client.exec("git add .", { cwd: "/local" });
				await client.exec('git commit -m "branch ok"', {
					cwd: "/local",
					env: envAt(1000002600),
				});
				const push = await client.exec("git push origin main", { cwd: "/local" });
				expect(push.exitCode).toBe(0);

				// Branch deletion should work
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
