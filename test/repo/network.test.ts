import { describe, expect, test } from "bun:test";
import { createServer } from "../../src/server/handler.ts";
import { createRepoStore, MemoryStorage } from "../../src/store/index.ts";
import { cloneInto, fetch, listRemoteRefs, push } from "../../src/repo/network.ts";
import { withCapabilities } from "../../src/lib/capabilities.ts";
import { httpTransport } from "../../src/transport.ts";
import { commit } from "../../src/repo/writing.ts";
import type { GitHooks } from "../../src/hooks.ts";
import type { GitRepo, ObjectId } from "../../src/lib/types.ts";

const BASE = "http://git";
const AUTHOR = { name: "Tester", email: "test@test.com" };

async function refHash(repo: GitRepo, name: string): Promise<ObjectId | null> {
	const ref = await repo.refStore.readRef(name);
	return ref?.type === "direct" ? ref.hash : null;
}

/** Server with one seeded remote repo "repo" on branch main, plus its network. */
async function setupRemote() {
	const server = createServer({ autoCreate: true });
	const remote = await server.createRepo("repo");
	const firstHash = await commit(remote, {
		files: { "README.md": "# Hello\n" },
		message: "init",
		author: AUTHOR,
		branch: "main",
	});
	return { server, remote, net: server.asTransport(BASE), firstHash };
}

/** A fresh storage-backed local repo (server-free client). */
async function localRepo(): Promise<GitRepo> {
	const repos = createRepoStore(new MemoryStorage());
	return repos.createRepo("local");
}

describe("network: listRemoteRefs", () => {
	test("enumerates remote refs without fetching objects", async () => {
		const { net } = await setupRemote();
		const refs = await listRemoteRefs(`${BASE}/repo`, { transport: net });
		expect(refs.some((r) => r.name === "refs/heads/main")).toBe(true);
	});
});

describe("network: cloneInto", () => {
	test("populates refs + HEAD from a remote (server-free)", async () => {
		const { net, remote } = await setupRemote();
		const local = await localRepo();

		const result = await cloneInto(withCapabilities(local, { transport: net }), `${BASE}/repo`);

		expect(result.defaultBranch).toBe("main");
		expect(result.objectCount).toBeGreaterThan(0);
		expect(await refHash(local, "refs/heads/main")).toBe(await refHash(remote, "refs/heads/main"));

		const head = await local.refStore.readRef("HEAD");
		expect(head).toEqual({ type: "symbolic", target: "refs/heads/main" });
	});

	test("empty remote yields no refs", async () => {
		const server = createServer({ autoCreate: true });
		await server.createRepo("empty");
		const local = await localRepo();

		const result = await cloneInto(
			withCapabilities(local, { transport: server.asTransport(BASE) }),
			`${BASE}/empty`,
		);
		expect(result.defaultBranch).toBeNull();
		expect(result.fetchedRefs).toHaveLength(0);
	});

	test("writes remote-tracking refs alongside local heads", async () => {
		const { net } = await setupRemote();
		const local = await localRepo();

		const result = await cloneInto(withCapabilities(local, { transport: net }), `${BASE}/repo`);

		// origin/main mirrors the local head right after clone — no fetch needed.
		expect(await refHash(local, "refs/remotes/origin/main")).toBe(
			await refHash(local, "refs/heads/main"),
		);
		expect(result.trackingRefs.map((r) => r.ref)).toContain("refs/remotes/origin/main");
		expect(result.fetchedRefs.map((r) => r.ref)).toContain("refs/heads/main");
	});

	test("honors a custom remote name for the tracking namespace", async () => {
		const { net } = await setupRemote();
		const local = await localRepo();

		await cloneInto(withCapabilities(local, { transport: net }), `${BASE}/repo`, {
			remote: "upstream",
		});

		expect(await refHash(local, "refs/remotes/upstream/main")).not.toBeNull();
		expect(await refHash(local, "refs/remotes/origin/main")).toBeNull();
	});

	test("branch narrows to a single branch", async () => {
		const { server, remote, net } = await setupRemote();
		await commit(remote, {
			files: { "feature.txt": "feat\n" },
			message: "feature root",
			author: AUTHOR,
			branch: "feature",
		});
		void server;

		const local = await localRepo();
		const result = await cloneInto(withCapabilities(local, { transport: net }), `${BASE}/repo`, {
			branch: "feature",
		});

		expect(result.defaultBranch).toBe("feature");
		expect(await refHash(local, "refs/heads/feature")).not.toBeNull();
		expect(await refHash(local, "refs/heads/main")).toBeNull();
	});

	test("fires preClone / postClone via repo.capabilities.hooks", async () => {
		const { net } = await setupRemote();
		const local = await localRepo();
		const events: string[] = [];
		const hooks: GitHooks = {
			preClone: () => {
				events.push("pre");
			},
			postClone: () => {
				events.push("post");
			},
		};

		await cloneInto(withCapabilities(local, { transport: net, hooks }), `${BASE}/repo`);
		expect(events).toEqual(["pre", "post"]);
	});

	test("preClone rejection aborts the clone", async () => {
		const { net } = await setupRemote();
		const local = await localRepo();
		const hooks: GitHooks = { preClone: () => ({ reject: true, message: "no clone" }) };

		expect(
			cloneInto(withCapabilities(local, { transport: net, hooks }), `${BASE}/repo`),
		).rejects.toThrow("no clone");
	});
});

describe("network: fetch", () => {
	test("updates tracking refs and reports updates", async () => {
		const { net, remote } = await setupRemote();
		const local = await localRepo();
		await cloneInto(withCapabilities(local, { transport: net }), `${BASE}/repo`);

		const second = await commit(remote, {
			files: { "extra.txt": "more\n" },
			message: "more",
			author: AUTHOR,
			branch: "main",
		});

		const result = await fetch(withCapabilities(local, { transport: net }), {
			url: `${BASE}/repo`,
		});

		expect(result.objectCount).toBeGreaterThan(0);
		expect(await refHash(local, "refs/remotes/origin/main")).toBe(second);
		expect(result.updated.some((u) => u.ref === "refs/remotes/origin/main")).toBe(true);
	});

	test("honors a custom remote name for the tracking namespace and hook payload", async () => {
		const { net, remote } = await setupRemote();
		const local = await localRepo();
		await cloneInto(withCapabilities(local, { transport: net }), `${BASE}/repo`, {
			remote: "upstream",
		});

		const second = await commit(remote, {
			files: { "extra.txt": "more\n" },
			message: "more",
			author: AUTHOR,
			branch: "main",
		});

		let seenRemote: string | undefined;
		const hooks: GitHooks = {
			preFetch: (e) => {
				seenRemote = e.remote;
			},
		};

		const result = await fetch(withCapabilities(local, { transport: net, hooks }), {
			url: `${BASE}/repo`,
			name: "upstream",
		});

		expect(seenRemote).toBe("upstream");
		expect(await refHash(local, "refs/remotes/upstream/main")).toBe(second);
		expect(result.updated.some((u) => u.ref === "refs/remotes/upstream/main")).toBe(true);
	});

	test("fires postFetch and honors preFetch rejection", async () => {
		const { net } = await setupRemote();
		const local = await localRepo();
		await cloneInto(withCapabilities(local, { transport: net }), `${BASE}/repo`);

		let postCount = 0;
		const postHooks: GitHooks = { postFetch: () => void postCount++ };
		await fetch(withCapabilities(local, { transport: net, hooks: postHooks }), {
			url: `${BASE}/repo`,
		});
		expect(postCount).toBe(1);

		const rejectHooks: GitHooks = { preFetch: () => ({ reject: true, message: "no fetch" }) };
		await expect(
			fetch(withCapabilities(local, { transport: net, hooks: rejectHooks }), {
				url: `${BASE}/repo`,
			}),
		).rejects.toThrow("no fetch");
	});
});

describe("network: push", () => {
	test("pushes a branch (sugar form) and advances the remote", async () => {
		const { net, remote } = await setupRemote();
		const local = await localRepo();
		await cloneInto(withCapabilities(local, { transport: net }), `${BASE}/repo`);

		const advanced = await commit(local, {
			files: { "local.txt": "from client\n" },
			message: "client edit",
			author: AUTHOR,
			branch: "main",
		});

		const result = await push(withCapabilities(local, { transport: net }), {
			url: `${BASE}/repo`,
			branch: "main",
		});

		expect(result.ok).toBe(true);
		expect(result.refs[0]!.status).toBe("ok");
		expect(result.refs[0]!.ref).toBe("refs/heads/main");
		expect(await refHash(remote, "refs/heads/main")).toBe(advanced);
	});

	test("no-op push reports up-to-date", async () => {
		const { net } = await setupRemote();
		const local = await localRepo();
		await cloneInto(withCapabilities(local, { transport: net }), `${BASE}/repo`);

		const result = await push(withCapabilities(local, { transport: net }), {
			url: `${BASE}/repo`,
			branch: "main",
		});
		expect(result.ok).toBe(true);
		expect(result.refs[0]!.status).toBe("up-to-date");
	});

	test("non-fast-forward is rejected with structured status", async () => {
		const { net, remote } = await setupRemote();
		const local = await localRepo();
		await cloneInto(withCapabilities(local, { transport: net }), `${BASE}/repo`);

		// Advance the remote out from under the client.
		await commit(remote, {
			files: { "server.txt": "server side\n" },
			message: "server edit",
			author: AUTHOR,
			branch: "main",
		});
		// Diverging local commit (same parent as the original clone).
		await commit(local, {
			files: { "client.txt": "client side\n" },
			message: "client edit",
			author: AUTHOR,
			branch: "main",
		});

		const result = await push(withCapabilities(local, { transport: net }), {
			url: `${BASE}/repo`,
			branch: "main",
		});
		expect(result.ok).toBe(false);
		expect(result.refs[0]!.status).toBe("rejected-fetch-first");
	});

	test("force push overrides and is flagged forced", async () => {
		const { net, remote } = await setupRemote();
		const local = await localRepo();
		await cloneInto(withCapabilities(local, { transport: net }), `${BASE}/repo`);

		await commit(remote, {
			files: { "server.txt": "server side\n" },
			message: "server edit",
			author: AUTHOR,
			branch: "main",
		});
		const clientHash = await commit(local, {
			files: { "client.txt": "client side\n" },
			message: "client edit",
			author: AUTHOR,
			branch: "main",
		});

		const result = await push(withCapabilities(local, { transport: net }), {
			url: `${BASE}/repo`,
			branch: "main",
			force: true,
		});
		expect(result.ok).toBe(true);
		expect(result.refs[0]!.forced).toBe(true);
		expect(await refHash(remote, "refs/heads/main")).toBe(clientHash);
	});

	test("deletes a remote ref via refspecs escape hatch", async () => {
		const { net, remote } = await setupRemote();
		await commit(remote, {
			files: { "f.txt": "x\n" },
			message: "feature",
			author: AUTHOR,
			branch: "feature",
		});
		expect(await refHash(remote, "refs/heads/feature")).not.toBeNull();

		const local = await localRepo();
		const result = await push(withCapabilities(local, { transport: net }), {
			url: `${BASE}/repo`,
			refspecs: [":refs/heads/feature"],
		});
		expect(result.ok).toBe(true);
		expect(result.refs[0]!.deleted).toBe(true);
		expect(await refHash(remote, "refs/heads/feature")).toBeNull();
	});

	test("rejects mixing refspecs and sugar fields", async () => {
		const { net } = await setupRemote();
		const local = await localRepo();
		expect(
			push(withCapabilities(local, { transport: net }), {
				url: `${BASE}/repo`,
				branch: "main",
				refspecs: ["refs/heads/main"],
			}),
		).rejects.toThrow("not both");
	});

	test("prePush rejection aborts the push", async () => {
		const { net } = await setupRemote();
		const local = await localRepo();
		await cloneInto(withCapabilities(local, { transport: net }), `${BASE}/repo`);
		await commit(local, {
			files: { "x.txt": "x\n" },
			message: "edit",
			author: AUTHOR,
			branch: "main",
		});

		const hooks: GitHooks = { prePush: () => ({ reject: true, message: "blocked" }) };

		expect(
			push(withCapabilities(local, { transport: net, hooks }), {
				url: `${BASE}/repo`,
				branch: "main",
			}),
		).rejects.toThrow("blocked");
	});

	test("pushes a new branch to the remote (ref creation)", async () => {
		const { net, remote } = await setupRemote();
		const local = await localRepo();
		await cloneInto(withCapabilities(local, { transport: net }), `${BASE}/repo`);

		const featureHash = await commit(local, {
			files: { "feature.txt": "feat\n" },
			message: "feature root",
			author: AUTHOR,
			branch: "feature",
		});
		expect(await refHash(remote, "refs/heads/feature")).toBeNull();

		const result = await push(withCapabilities(local, { transport: net }), {
			url: `${BASE}/repo`,
			branch: "feature",
		});
		expect(result.ok).toBe(true);
		expect(result.refs[0]!.oldHash).toBeNull();
		expect(result.refs[0]!.status).toBe("ok");
		expect(await refHash(remote, "refs/heads/feature")).toBe(featureHash);
	});

	test("rejected-non-fast-forward when the remote object is present locally", async () => {
		const { net, remote } = await setupRemote();
		const local = await localRepo();
		await cloneInto(withCapabilities(local, { transport: net }), `${BASE}/repo`);

		// Remote advances; the client fetches the new object but doesn't merge it.
		await commit(remote, {
			files: { "server.txt": "server side\n" },
			message: "server edit",
			author: AUTHOR,
			branch: "main",
		});
		await fetch(withCapabilities(local, { transport: net }), { url: `${BASE}/repo` });

		// Client commits on its own (stale) main, diverging from the remote tip.
		await commit(local, {
			files: { "client.txt": "client side\n" },
			message: "client edit",
			author: AUTHOR,
			branch: "main",
		});

		const result = await push(withCapabilities(local, { transport: net }), {
			url: `${BASE}/repo`,
			branch: "main",
		});
		expect(result.ok).toBe(false);
		// Distinct from "rejected-fetch-first": the client already has the remote
		// object, so the rejection is a plain non-fast-forward.
		expect(result.refs[0]!.status).toBe("rejected-non-fast-forward");
	});

	test("fires postPush on a successful push", async () => {
		const { net } = await setupRemote();
		const local = await localRepo();
		await cloneInto(withCapabilities(local, { transport: net }), `${BASE}/repo`);
		await commit(local, {
			files: { "p.txt": "p\n" },
			message: "edit",
			author: AUTHOR,
			branch: "main",
		});

		let postCount = 0;
		const hooks: GitHooks = { postPush: () => void postCount++ };

		const result = await push(withCapabilities(local, { transport: net, hooks }), {
			url: `${BASE}/repo`,
			branch: "main",
		});
		expect(result.ok).toBe(true);
		expect(postCount).toBe(1);
	});
});

describe("network: push (refspecs + src/dst sugar)", () => {
	test("pushes via an explicit src:dst refspec", async () => {
		const { net, remote } = await setupRemote();
		const local = await localRepo();
		await cloneInto(withCapabilities(local, { transport: net }), `${BASE}/repo`);
		const advanced = await commit(local, {
			files: { "a.txt": "a\n" },
			message: "edit",
			author: AUTHOR,
			branch: "main",
		});

		const result = await push(withCapabilities(local, { transport: net }), {
			url: `${BASE}/repo`,
			refspecs: ["main:main"],
		});
		expect(result.ok).toBe(true);
		expect(result.refs[0]!.ref).toBe("refs/heads/main");
		expect(await refHash(remote, "refs/heads/main")).toBe(advanced);
	});

	test("src/dst sugar pushes a source ref to a differently named remote ref", async () => {
		const { net, remote } = await setupRemote();
		const local = await localRepo();
		await cloneInto(withCapabilities(local, { transport: net }), `${BASE}/repo`);
		const hash = await commit(local, {
			files: { "x.txt": "x\n" },
			message: "edit",
			author: AUTHOR,
			branch: "main",
		});

		const result = await push(withCapabilities(local, { transport: net }), {
			url: `${BASE}/repo`,
			src: "main",
			dst: "released",
		});
		expect(result.ok).toBe(true);
		expect(result.refs[0]!.ref).toBe("refs/heads/released");
		expect(await refHash(remote, "refs/heads/released")).toBe(hash);
		// The source name is untouched on the remote.
		expect(await refHash(remote, "refs/heads/main")).not.toBe(hash);
	});

	test("force via the '+' refspec prefix overrides a non-fast-forward", async () => {
		const { net, remote } = await setupRemote();
		const local = await localRepo();
		await cloneInto(withCapabilities(local, { transport: net }), `${BASE}/repo`);

		await commit(remote, {
			files: { "server.txt": "server side\n" },
			message: "server edit",
			author: AUTHOR,
			branch: "main",
		});
		const clientHash = await commit(local, {
			files: { "client.txt": "client side\n" },
			message: "client edit",
			author: AUTHOR,
			branch: "main",
		});

		const result = await push(withCapabilities(local, { transport: net }), {
			url: `${BASE}/repo`,
			refspecs: ["+main:main"],
		});
		expect(result.ok).toBe(true);
		expect(result.refs[0]!.forced).toBe(true);
		expect(await refHash(remote, "refs/heads/main")).toBe(clientHash);
	});

	test("pushes a tag and rejects a non-fast-forward tag rewrite", async () => {
		const { net, remote } = await setupRemote();
		const local = await localRepo();
		await cloneInto(withCapabilities(local, { transport: net }), `${BASE}/repo`);
		const base = await refHash(local, "refs/heads/main");

		// Lightweight tag pointing at the cloned tip.
		await local.refStore.writeRef("refs/tags/v1", base!);
		const tagPush = await push(withCapabilities(local, { transport: net }), {
			url: `${BASE}/repo`,
			refspecs: ["refs/tags/v1:refs/tags/v1"],
		});
		expect(tagPush.ok).toBe(true);
		expect(await refHash(remote, "refs/tags/v1")).toBe(base);

		// Move the tag forward and try to push again without force — tags must
		// not move, even on a fast-forward.
		const moved = await commit(local, {
			files: { "t.txt": "t\n" },
			message: "tag move",
			author: AUTHOR,
			branch: "main",
		});
		await local.refStore.writeRef("refs/tags/v1", moved);
		const rewrite = await push(withCapabilities(local, { transport: net }), {
			url: `${BASE}/repo`,
			refspecs: ["refs/tags/v1:refs/tags/v1"],
		});
		expect(rewrite.ok).toBe(false);
		expect(rewrite.refs[0]!.status).toBe("rejected-already-exists");
		expect(await refHash(remote, "refs/tags/v1")).toBe(base);
	});
});

/** A bare storage-backed repo, server-free, seeded on main. */
async function bareRemoteRepo(): Promise<GitRepo> {
	const repos = createRepoStore(new MemoryStorage());
	const remote = await repos.createRepo("remote");
	await commit(remote, {
		files: { "README.md": "# Hello\n" },
		message: "init",
		author: AUTHOR,
		branch: "main",
	});
	return remote;
}

describe("network: resolveRemote (LocalTransport)", () => {
	test("clones a non-HTTP remote resolved to a GitRepo", async () => {
		const remote = await bareRemoteRepo();
		const local = await localRepo();
		const resolveRemote = (url: string) => (url === "repo://remote" ? remote : null);

		const result = await cloneInto(
			withCapabilities(local, { transport: httpTransport({ resolveInProcess: resolveRemote }) }),
			"repo://remote",
		);

		expect(result.defaultBranch).toBe("main");
		expect(result.objectCount).toBeGreaterThan(0);
		expect(await refHash(local, "refs/heads/main")).toBe(await refHash(remote, "refs/heads/main"));
		expect(await local.refStore.readRef("HEAD")).toEqual({
			type: "symbolic",
			target: "refs/heads/main",
		});
	});

	test("fetch and push round-trip over the local transport", async () => {
		const remote = await bareRemoteRepo();
		const resolveRemote = (url: string) => (url === "repo://remote" ? remote : null);
		const local = await localRepo();
		await cloneInto(
			withCapabilities(local, { transport: httpTransport({ resolveInProcess: resolveRemote }) }),
			"repo://remote",
		);

		// Local edit, pushed back over the local transport.
		const advanced = await commit(local, {
			files: { "local.txt": "from client\n" },
			message: "client edit",
			author: AUTHOR,
			branch: "main",
		});
		const pushResult = await push(
			withCapabilities(local, { transport: httpTransport({ resolveInProcess: resolveRemote }) }),
			{
				url: "repo://remote",
				branch: "main",
			},
		);
		expect(pushResult.ok).toBe(true);
		expect(await refHash(remote, "refs/heads/main")).toBe(advanced);

		// Remote advances; fetch it back over the local transport.
		const second = await commit(remote, {
			files: { "remote.txt": "from server\n" },
			message: "server edit",
			author: AUTHOR,
			branch: "main",
		});
		const fetchResult = await fetch(
			withCapabilities(local, { transport: httpTransport({ resolveInProcess: resolveRemote }) }),
			{
				url: "repo://remote",
			},
		);
		expect(fetchResult.objectCount).toBeGreaterThan(0);
		expect(await refHash(local, "refs/remotes/origin/main")).toBe(second);
		expect(fetchResult.updated.some((u) => u.ref === "refs/remotes/origin/main")).toBe(true);
	});
});
