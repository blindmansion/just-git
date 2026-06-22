import { describe, expect, test } from "bun:test";
import { createServer } from "../../src/server/handler.ts";
import { createRepoStore, MemoryStorage } from "../../src/storage/index.ts";
import { cloneInto, fetch, listRemoteRefs, push } from "../../src/repo/network.ts";
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
	return { server, remote, net: server.asNetwork(BASE), firstHash };
}

/** A fresh storage-backed local repo (server-free client). */
async function localRepo(): Promise<GitRepo> {
	const repos = createRepoStore(new MemoryStorage());
	return repos.createRepo("local");
}

describe("network: listRemoteRefs", () => {
	test("enumerates remote refs without fetching objects", async () => {
		const { net } = await setupRemote();
		const refs = await listRemoteRefs(`${BASE}/repo`, { networkPolicy: net });
		expect(refs.some((r) => r.name === "refs/heads/main")).toBe(true);
	});
});

describe("network: cloneInto", () => {
	test("populates refs + HEAD from a remote (server-free)", async () => {
		const { net, remote } = await setupRemote();
		const local = await localRepo();

		const result = await cloneInto(local, `${BASE}/repo`, { networkPolicy: net });

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

		const result = await cloneInto(local, `${BASE}/empty`, {
			networkPolicy: server.asNetwork(BASE),
		});
		expect(result.defaultBranch).toBeNull();
		expect(result.fetchedRefs).toHaveLength(0);
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
		const result = await cloneInto(local, `${BASE}/repo`, {
			networkPolicy: net,
			branch: "feature",
		});

		expect(result.defaultBranch).toBe("feature");
		expect(await refHash(local, "refs/heads/feature")).not.toBeNull();
		expect(await refHash(local, "refs/heads/main")).toBeNull();
	});

	test("fires preClone / postClone via repo.hooks", async () => {
		const { net } = await setupRemote();
		const local = await localRepo();
		const events: string[] = [];
		local.hooks = {
			preClone: () => {
				events.push("pre");
			},
			postClone: () => {
				events.push("post");
			},
		};

		await cloneInto(local, `${BASE}/repo`, { networkPolicy: net });
		expect(events).toEqual(["pre", "post"]);
	});

	test("preClone rejection aborts the clone", async () => {
		const { net } = await setupRemote();
		const local = await localRepo();
		local.hooks = { preClone: () => ({ reject: true, message: "no clone" }) };

		expect(cloneInto(local, `${BASE}/repo`, { networkPolicy: net })).rejects.toThrow(
			"no clone",
		);
	});
});

describe("network: fetch", () => {
	test("updates tracking refs and reports updates", async () => {
		const { net, remote } = await setupRemote();
		const local = await localRepo();
		await cloneInto(local, `${BASE}/repo`, { networkPolicy: net });

		const second = await commit(remote, {
			files: { "extra.txt": "more\n" },
			message: "more",
			author: AUTHOR,
			branch: "main",
		});

		const result = await fetch(local, { url: `${BASE}/repo` }, { networkPolicy: net });

		expect(result.objectCount).toBeGreaterThan(0);
		expect(await refHash(local, "refs/remotes/origin/main")).toBe(second);
		expect(result.updated.some((u) => u.ref === "refs/remotes/origin/main")).toBe(true);
	});

	test("fires postFetch and honors preFetch rejection", async () => {
		const { net } = await setupRemote();
		const local = await localRepo();
		await cloneInto(local, `${BASE}/repo`, { networkPolicy: net });

		let postCount = 0;
		local.hooks = { postFetch: () => void postCount++ };
		await fetch(local, { url: `${BASE}/repo` }, { networkPolicy: net });
		expect(postCount).toBe(1);

		local.hooks = { preFetch: () => ({ reject: true, message: "no fetch" }) };
		await expect(fetch(local, { url: `${BASE}/repo` }, { networkPolicy: net })).rejects.toThrow(
			"no fetch",
		);
	});
});

describe("network: push", () => {
	test("pushes a branch (sugar form) and advances the remote", async () => {
		const { net, remote } = await setupRemote();
		const local = await localRepo();
		await cloneInto(local, `${BASE}/repo`, { networkPolicy: net });

		const advanced = await commit(local, {
			files: { "local.txt": "from client\n" },
			message: "client edit",
			author: AUTHOR,
			branch: "main",
		});

		const result = await push(
			local,
			{ url: `${BASE}/repo`, branch: "main" },
			{ networkPolicy: net },
		);

		expect(result.ok).toBe(true);
		expect(result.refs[0]!.status).toBe("ok");
		expect(result.refs[0]!.ref).toBe("refs/heads/main");
		expect(await refHash(remote, "refs/heads/main")).toBe(advanced);
	});

	test("no-op push reports up-to-date", async () => {
		const { net } = await setupRemote();
		const local = await localRepo();
		await cloneInto(local, `${BASE}/repo`, { networkPolicy: net });

		const result = await push(
			local,
			{ url: `${BASE}/repo`, branch: "main" },
			{ networkPolicy: net },
		);
		expect(result.ok).toBe(true);
		expect(result.refs[0]!.status).toBe("up-to-date");
	});

	test("non-fast-forward is rejected with structured status", async () => {
		const { net, remote } = await setupRemote();
		const local = await localRepo();
		await cloneInto(local, `${BASE}/repo`, { networkPolicy: net });

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

		const result = await push(
			local,
			{ url: `${BASE}/repo`, branch: "main" },
			{ networkPolicy: net },
		);
		expect(result.ok).toBe(false);
		expect(result.refs[0]!.status).toBe("rejected-fetch-first");
	});

	test("force push overrides and is flagged forced", async () => {
		const { net, remote } = await setupRemote();
		const local = await localRepo();
		await cloneInto(local, `${BASE}/repo`, { networkPolicy: net });

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

		const result = await push(
			local,
			{ url: `${BASE}/repo`, branch: "main", force: true },
			{ networkPolicy: net },
		);
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
		const result = await push(
			local,
			{ url: `${BASE}/repo`, refspecs: [":refs/heads/feature"] },
			{ networkPolicy: net },
		);
		expect(result.ok).toBe(true);
		expect(result.refs[0]!.deleted).toBe(true);
		expect(await refHash(remote, "refs/heads/feature")).toBeNull();
	});

	test("rejects mixing refspecs and sugar fields", async () => {
		const { net } = await setupRemote();
		const local = await localRepo();
		expect(
			push(
				local,
				{ url: `${BASE}/repo`, branch: "main", refspecs: ["refs/heads/main"] },
				{ networkPolicy: net },
			),
		).rejects.toThrow("not both");
	});

	test("prePush rejection aborts the push", async () => {
		const { net } = await setupRemote();
		const local = await localRepo();
		await cloneInto(local, `${BASE}/repo`, { networkPolicy: net });
		await commit(local, {
			files: { "x.txt": "x\n" },
			message: "edit",
			author: AUTHOR,
			branch: "main",
		});

		const hooks: GitHooks = { prePush: () => ({ reject: true, message: "blocked" }) };
		local.hooks = hooks;

		expect(
			push(local, { url: `${BASE}/repo`, branch: "main" }, { networkPolicy: net }),
		).rejects.toThrow("blocked");
	});
});
