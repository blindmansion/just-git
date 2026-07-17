// End-to-end "workspace sync" workflows built on the programmatic repo module
// (no CLI, no worktree). These exercise pull() — the fetch+integrate operation
// — together with the primitives around it (cloneInto / fetch / push, merge /
// rebase), the way a collaborative web-app sync engine would: a central cloud
// repo, several workspace clients each on their own in-memory storage, an
// app-owned loop that pulls + auto-integrates + publishes (with optimistic
// retry on a rejected push), and conflicts surfaced to the "UI" as data.

import { describe, expect, test } from "bun:test";
import { withCapabilities } from "../../src/lib/capabilities.ts";
import type { GitRepo, Identity } from "../../src/lib/types.ts";
import { createMemoryDiscoveryCache, httpTransport } from "../../src/transport.ts";
import {
	type ConflictedPath,
	cloneInto,
	commit,
	countAheadBehind,
	fetch,
	listRemoteRefs,
	merge,
	type MergeResult,
	pull,
	push,
	readBlobText,
	readCommit,
	readFileAtCommit,
	rebase,
	type RebaseResult,
	resolveRef,
	walkCommitHistory,
} from "../../src/repo/index.ts";
import { createServer } from "../../src/server/server.ts";
import { createRepoStore, MemoryStorage } from "../../src/store/index.ts";

const BASE = "http://git";
const BRANCH = "main";

/** A human collaborator's identity (drives author of their edits). */
function person(name: string): Identity {
	return {
		name,
		email: `${name.toLowerCase()}@workspace.app`,
		timestamp: 1000000000,
		timezone: "+0000",
	};
}

/** The sync engine's own identity — committer of merge/rebase commits it makes. */
const ENGINE: Identity = {
	name: "Sync Engine",
	email: "sync@workspace.app",
	timestamp: 1000000500,
	timezone: "+0000",
};

// ── The "cloud" (server-side canonical repo) ────────────────────────

interface Cloud {
	server: ReturnType<typeof createServer>;
	url: string;
	net: ReturnType<ReturnType<typeof createServer>["asTransport"]>;
	repoId: string;
}

/** Stand up a cloud repo seeded with an initial document on `main`. */
async function makeCloud(
	repoId = "workspace",
	seed: Record<string, string> = { "doc.md": "# Project\n" },
): Promise<Cloud> {
	const server = createServer({ autoCreate: true });
	await server.createRepo(repoId);
	await server.commit(repoId, {
		files: seed,
		message: "seed workspace",
		author: person("Founder"),
		branch: BRANCH,
	});
	return { server, url: `${BASE}/${repoId}`, net: server.asTransport(BASE), repoId };
}

/** Push a commit straight onto the cloud repo (simulates "another client"). */
async function cloudCommit(
	cloud: Cloud,
	files: Record<string, string>,
	message: string,
): Promise<string> {
	const { hash } = await cloud.server.commit(cloud.repoId, {
		files,
		message,
		author: person("Remote"),
		branch: BRANCH,
	});
	return hash;
}

// ── A workspace client ──────────────────────────────────────────────

interface Workspace {
	repo: GitRepo;
	id: string;
}

/** Clone the cloud into a fresh client — the app's "open workspace" step. */
async function openWorkspace(id: string, cloud: Cloud): Promise<Workspace> {
	const repo = await createRepoStore(new MemoryStorage()).createRepo(id);
	await cloneInto(withCapabilities(repo, { transport: cloud.net }), cloud.url);
	return { repo, id };
}

/** A local edit the user makes inside their workspace (commits to `main`). */
async function edit(
	ws: Workspace,
	author: Identity,
	files: Record<string, string | null>,
	message: string,
): Promise<string> {
	return commit(ws.repo, { files, message, author, branch: BRANCH });
}

const localTip = (ws: Workspace) => resolveRef(ws.repo, `refs/heads/${BRANCH}`);
const trackedRemoteTip = (ws: Workspace) => resolveRef(ws.repo, `refs/remotes/origin/${BRANCH}`);

/** Read a file's content at the workspace's current local tip. */
async function fileAt(ws: Workspace, path: string): Promise<string | null> {
	const tip = (await localTip(ws)) as string;
	return readFileAtCommit(ws.repo, tip, path);
}

/** The cloud's current main tip (canonical published state). */
async function cloudTip(cloud: Cloud): Promise<string> {
	const repo = await cloud.server.requireRepo(cloud.repoId);
	return (await resolveRef(repo, `refs/heads/${BRANCH}`)) as string;
}

// ── The app's sync engine ───────────────────────────────────────────

type SyncOutcome =
	| {
			kind: "in-sync";
			head: string;
			/** Status of the integration this round (`fast-forward`, `merged`, `ok`, …). */
			integrated: (MergeResult | RebaseResult)["status"];
			/** Whether anything was actually published (false when already up to date). */
			published: boolean;
			/** Rounds taken (>1 means a push race was retried). */
			attempts: number;
	  }
	| { kind: "conflicts"; integration: MergeResult | RebaseResult };

/**
 * One pass of an app's background sync, composed from the repo primitives:
 * `pull` (fetch + integrate) then `push`, retrying on a rejected push (the
 * cloud moved under us). A conflict stops the loop and is returned as data —
 * the module deliberately does not bundle this publish/retry policy, so the app
 * owns it here.
 *
 * `beforePush` is a test seam standing in for the real-world async gap between
 * integrating and pushing, letting another client race in.
 */
async function syncWorkspace(
	ws: Workspace,
	cloud: Cloud,
	author: Identity,
	opts: {
		strategy?: "merge" | "rebase";
		maxAttempts?: number;
		beforePush?: (attempt: number) => Promise<void>;
	} = {},
): Promise<SyncOutcome> {
	const repo = withCapabilities(ws.repo, { transport: cloud.net });
	const maxAttempts = opts.maxAttempts ?? 4;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const { integration } = await pull(repo, {
			url: cloud.url,
			branch: BRANCH,
			author,
			committer: ENGINE,
			strategy: opts.strategy,
		});

		if (integration.status === "conflicts") {
			return { kind: "conflicts", integration };
		}

		await opts.beforePush?.(attempt);

		const pushed = await push(repo, { url: cloud.url, branch: BRANCH });
		if (pushed.ok) {
			return {
				kind: "in-sync",
				head: (await localTip(ws)) as string,
				integrated: integration.status,
				published: pushed.refs.some((r) => r.status === "ok"),
				attempts: attempt,
			};
		}
		// Push rejected — the cloud moved. Loop: re-pull (re-integrate) and re-push.
	}

	throw new Error(`sync did not converge after ${maxAttempts} attempts`);
}

// ── Scenarios ───────────────────────────────────────────────────────

describe("sync workflow: bootstrap", () => {
	test("opening a workspace clones heads + tracking refs + HEAD", async () => {
		const cloud = await makeCloud();
		const ws = await openWorkspace("alice", cloud);

		const head = await ws.repo.refStore.readRef("HEAD");
		expect(head).toEqual({ type: "symbolic", target: `refs/heads/${BRANCH}` });
		expect(await localTip(ws)).toBe(await cloudTip(cloud));
		expect(await fileAt(ws, "doc.md")).toBe("# Project\n");

		// cloneInto now writes refs/remotes/origin/* tracking refs too, so the
		// origin baseline is known immediately — ahead/behind is answerable with
		// no initial fetch.
		expect(await trackedRemoteTip(ws)).toBe(await localTip(ws));
	});
});

describe("sync workflow: automatic fast-forward", () => {
	test("remote-only changes fast-forward the local branch with no merge commit", async () => {
		const cloud = await makeCloud();
		const ws = await openWorkspace("alice", cloud);

		// Someone else publishes to the cloud; Alice made no local edits.
		const remoteHash = await cloudCommit(cloud, { "doc.md": "# Project\n\nv2\n" }, "remote v2");

		const out = await syncWorkspace(ws, cloud, person("Alice"));

		expect(out.kind).toBe("in-sync");
		if (out.kind !== "in-sync") throw new Error("unreachable");
		expect(out.integrated).toBe("fast-forward");
		expect(out.published).toBe(false); // nothing local to publish
		expect(await localTip(ws)).toBe(remoteHash);

		// Fast-forward => single-parent tip, no synthetic merge commit.
		expect((await readCommit(ws.repo, out.head)).parents).toHaveLength(1);
	});
});

describe("sync workflow: automatic non-conflicting merge", () => {
	test("divergent edits to different files auto-merge and publish", async () => {
		const cloud = await makeCloud();
		const ws = await openWorkspace("alice", cloud);

		const remoteHash = await cloudCommit(cloud, { "remote.md": "remote\n" }, "remote note");
		const localHash = await edit(ws, person("Alice"), { "alice.md": "alice\n" }, "alice note");

		const out = await syncWorkspace(ws, cloud, person("Alice"));

		expect(out.kind).toBe("in-sync");
		if (out.kind !== "in-sync") throw new Error("unreachable");
		expect(out.integrated).toBe("merged");
		expect(out.published).toBe(true);

		// Local tip is a merge commit of [Alice's edit, remote edit].
		const tip = await readCommit(ws.repo, out.head);
		expect(tip.parents).toEqual([localHash, remoteHash]);
		expect(tip.committer.email).toBe(ENGINE.email);

		for (const path of ["doc.md", "remote.md", "alice.md"]) {
			expect(await fileAt(ws, path)).not.toBeNull();
		}
		expect(await cloudTip(cloud)).toBe(out.head);
	});
});

describe("sync workflow: conflict surfaced to the UI", () => {
	test("overlapping edits stop the sync and expose all three sides for resolution", async () => {
		const cloud = await makeCloud();
		const ws = await openWorkspace("alice", cloud);

		await cloudCommit(cloud, { "doc.md": "# Project\n\nremote wins?\n" }, "remote edit");
		await edit(ws, person("Alice"), { "doc.md": "# Project\n\nalice wins?\n" }, "alice edit");

		const out = await syncWorkspace(ws, cloud, person("Alice"));

		expect(out.kind).toBe("conflicts");
		if (
			out.kind !== "conflicts" ||
			out.integration.status !== "conflicts" ||
			!("ours" in out.integration)
		) {
			throw new Error("expected a merge conflict");
		}
		const conflicts: ConflictedPath[] = out.integration.conflicts;
		expect(conflicts.map((c) => c.path)).toEqual(["doc.md"]);

		// The UI renders a 3-way view from the conflict's blob refs.
		const c = conflicts[0]!;
		expect(c.reason).toBe("content");
		const read = (s: ConflictedPath["base"]) => (s ? readBlobText(ws.repo, s.hash) : null);
		expect(await read(c.base)).toBe("# Project\n");
		expect(await read(c.ours)).toBe("# Project\n\nalice wins?\n");
		expect(await read(c.theirs)).toBe("# Project\n\nremote wins?\n");

		// Nothing was published while the conflict is outstanding.
		expect(await cloudTip(cloud)).not.toBe(await localTip(ws));

		// The user hand-merges in the UI; we resolve with merge() using the
		// surfaced handles, then sync again to publish.
		await merge(ws.repo, {
			ours: out.integration.ours,
			theirs: out.integration.theirs,
			author: person("Alice"),
			branch: BRANCH,
			committer: ENGINE,
			resolutions: { "doc.md": { content: "# Project\n\nboth agree\n" } },
		});
		const published = await syncWorkspace(ws, cloud, person("Alice"));

		expect(published.kind).toBe("in-sync");
		expect(await localTip(ws)).toBe(await cloudTip(cloud));
		expect(await fileAt(ws, "doc.md")).toBe("# Project\n\nboth agree\n");
	});

	test("picking a side ('theirs') resolves a delete/modify conflict", async () => {
		const cloud = await makeCloud("dm", { "keep.md": "k\n", "victim.md": "v\n" });
		const ws = await openWorkspace("bob", cloud);

		await cloudCommit(cloud, { "victim.md": "v-edited\n" }, "remote edits victim");
		await edit(ws, person("Bob"), { "victim.md": null }, "bob deletes victim");

		const out = await syncWorkspace(ws, cloud, person("Bob"));
		expect(out.kind).toBe("conflicts");
		if (
			out.kind !== "conflicts" ||
			out.integration.status !== "conflicts" ||
			!("ours" in out.integration)
		) {
			throw new Error("expected a merge conflict");
		}
		const c = out.integration.conflicts.find((x) => x.path === "victim.md")!;
		expect(c.reason).toBe("delete-modify");
		expect(c.ours).toBeNull(); // Bob's side deleted it

		await merge(ws.repo, {
			ours: out.integration.ours,
			theirs: out.integration.theirs,
			author: person("Bob"),
			branch: BRANCH,
			committer: ENGINE,
			resolutions: { "victim.md": "theirs" },
		});
		await syncWorkspace(ws, cloud, person("Bob"));
		expect(await fileAt(ws, "victim.md")).toBe("v-edited\n");
	});
});

describe("sync workflow: optimistic push race", () => {
	test("a cloud move between integrate and push triggers a retry that re-merges", async () => {
		const cloud = await makeCloud();
		const alice = await openWorkspace("alice", cloud);
		const bob = await openWorkspace("bob", cloud);

		await edit(bob, person("Bob"), { "bob.md": "bob\n" }, "bob note");

		// On Bob's first push attempt, Alice races a commit onto the cloud,
		// invalidating Bob's push and forcing the engine's retry path.
		let raced = false;
		const out = await syncWorkspace(bob, cloud, person("Bob"), {
			beforePush: async (attempt) => {
				if (attempt === 1 && !raced) {
					raced = true;
					await edit(alice, person("Alice"), { "alice.md": "alice\n" }, "alice note");
					const aliceSync = await syncWorkspace(alice, cloud, person("Alice"));
					expect(aliceSync.kind).toBe("in-sync");
				}
			},
		});

		expect(out.kind).toBe("in-sync");
		if (out.kind !== "in-sync") throw new Error("unreachable");
		expect(out.attempts).toBeGreaterThan(1); // first push was rejected
		expect(out.published).toBe(true);

		expect(await cloudTip(cloud)).toBe(out.head);
		expect(await fileAt(bob, "alice.md")).toBe("alice\n");
		expect(await fileAt(bob, "bob.md")).toBe("bob\n");
	});
});

describe("sync workflow: linear history via rebase", () => {
	test("rebase-strategy sync replays local commits onto the cloud tip", async () => {
		const cloud = await makeCloud();
		const ws = await openWorkspace("alice", cloud);

		const remoteHash = await cloudCommit(cloud, { "remote.md": "r\n" }, "remote work");
		await edit(ws, person("Alice"), { "a1.md": "1\n" }, "local 1");
		await edit(ws, person("Alice"), { "a2.md": "2\n" }, "local 2");

		const out = await syncWorkspace(ws, cloud, person("Alice"), { strategy: "rebase" });
		expect(out.kind).toBe("in-sync");
		if (out.kind !== "in-sync") throw new Error("unreachable");

		// Strictly linear: every commit has <=1 parent and the chain roots at the
		// cloud commit.
		const hashes: string[] = [];
		for await (const info of walkCommitHistory(ws.repo, out.head)) {
			expect(info.parents.length).toBeLessThanOrEqual(1);
			hashes.push(info.hash);
		}
		expect(hashes).toContain(remoteHash);
		expect(await cloudTip(cloud)).toBe(out.head);
	});

	test("a rebase conflict surfaces a serializable continuation the UI can resume", async () => {
		const cloud = await makeCloud();
		const ws = await openWorkspace("alice", cloud);

		await cloudCommit(cloud, { "doc.md": "# Project\n\nremote\n" }, "remote edit");
		await edit(ws, person("Alice"), { "doc.md": "# Project\n\nlocal\n" }, "local edit");

		// pull() with the rebase strategy stops on conflict and hands back the
		// continuation as part of the integration result.
		const { integration } = await pull(withCapabilities(ws.repo, { transport: cloud.net }), {
			url: cloud.url,
			branch: BRANCH,
			strategy: "rebase",
			committer: ENGINE,
		});
		if (integration.status !== "conflicts" || !("continuation" in integration)) {
			throw new Error("expected a rebase conflict");
		}

		// The continuation is plain JSON — a web-app can stash it between the
		// request that surfaced the conflict and the one that resolves it.
		const token = JSON.parse(JSON.stringify(integration.continuation));
		const done = await rebase(ws.repo, { continue: token, resolutions: { "doc.md": "theirs" } });
		expect(done.status).toBe("ok");

		const published = await syncWorkspace(ws, cloud, person("Alice"), { strategy: "rebase" });
		expect(published.kind).toBe("in-sync");
		expect(await fileAt(ws, "doc.md")).toBe("# Project\n\nlocal\n");
		expect(await localTip(ws)).toBe(await cloudTip(cloud));
	});
});

describe("sync workflow: cheap divergence detection for the UI", () => {
	test("listRemoteRefs flags drift without fetching; ahead/behind needs objects", async () => {
		const cloud = await makeCloud();
		const ws = await openWorkspace("alice", cloud);

		// A pure ref-advertisement probe: enough to light up a "sync available"
		// badge without downloading anything.
		await cloudCommit(cloud, { "doc.md": "# Project\n\nnew\n" }, "remote change");
		const refs = await listRemoteRefs(cloud.url, { transport: cloud.net });
		const remoteMain = refs.find((r) => r.name === `refs/heads/${BRANCH}`)!;
		expect(remoteMain.hash).not.toBe(await localTip(ws));

		// To render "N behind" you must fetch the objects (no merge), then count
		// against the updated tracking ref.
		await fetch(withCapabilities(ws.repo, { transport: cloud.net }), { url: cloud.url });
		const counts = await countAheadBehind(
			ws.repo,
			(await localTip(ws)) as string,
			(await trackedRemoteTip(ws)) as string,
		);
		expect(counts).toEqual({ ahead: 0, behind: 1 });
	});

	test("by-name fetch resolves a single branch and updates only its tracking ref", async () => {
		const cloud = await makeCloud();
		const ws = await openWorkspace("alice", cloud);

		const remoteHash = await cloudCommit(
			cloud,
			{ "doc.md": "# Project\n\nnamed\n" },
			"remote named",
		);

		// Request the branch *by name*: on a `ref-in-want` server this is one
		// fetch round-trip with no separate advertisement; in-process it
		// degrades to advertise+fetch. Either way only the named ref comes back.
		const result = await fetch(withCapabilities(ws.repo, { transport: cloud.net }), {
			url: cloud.url,
			refs: [`refs/heads/${BRANCH}`],
		});

		expect(result.remoteRefs).toHaveLength(1);
		expect(result.remoteRefs[0]!.name).toBe(`refs/heads/${BRANCH}`);
		expect(result.remoteRefs[0]!.hash).toBe(remoteHash);
		expect(result.objectCount).toBeGreaterThan(0);
		expect(await trackedRemoteTip(ws)).toBe(remoteHash);
	});

	test("ahead/behind reflects unsynced local work and a simple timeline renders", async () => {
		const cloud = await makeCloud();
		const ws = await openWorkspace("alice", cloud);

		await cloudCommit(cloud, { "remote.md": "r\n" }, "remote work");
		await edit(ws, person("Alice"), { "a.md": "a\n" }, "local work");

		// Fetch-only to learn where the remote is, without integrating.
		await fetch(withCapabilities(ws.repo, { transport: cloud.net }), { url: cloud.url });
		const counts = await countAheadBehind(
			ws.repo,
			(await localTip(ws)) as string,
			(await trackedRemoteTip(ws)) as string,
		);
		expect(counts).toEqual({ ahead: 1, behind: 1 });

		// A minimal "git graph" for the UI: subject lines newest-first.
		const subjects: string[] = [];
		for await (const info of walkCommitHistory(ws.repo, [
			(await localTip(ws)) as string,
			(await trackedRemoteTip(ws)) as string,
		])) {
			subjects.push(info.message.split("\n")[0] as string);
		}
		expect(subjects).toContain("local work");
		expect(subjects).toContain("remote work");
		expect(subjects).toContain("seed workspace");
	});
});

// ── Round-trip accounting & partial-result handling ─────────────────

/**
 * Wrap a cloud's in-process network with a request counter so a test can assert
 * how many upload-pack POSTs an operation issues. `ls-refs` and the object
 * `fetch` both POST to `git-upload-pack`, so counting those POSTs distinguishes
 * the advertise+fetch path (two POSTs) from the by-name `want-ref` path (one).
 */
function instrumentedNet(cloud: Cloud): {
	net: ReturnType<ReturnType<typeof createServer>["asTransport"]>;
	counts: { uploadPack: number; receivePack: number; infoRefs: number };
} {
	const policy = cloud.server.asNetwork(BASE);
	const baseFetch = policy.fetch!; // in-process asNetwork always supplies fetch
	const counts = { uploadPack: 0, receivePack: 0, infoRefs: 0 };
	const countingFetch = (input: string | URL | Request, init?: RequestInit) => {
		const url = input instanceof Request ? input.url : String(input);
		// Discovery is a GET to `/info/refs?service=git-{upload,receive}-pack`;
		// match it first so its service query param isn't mistaken for a POST.
		if (url.includes("/info/refs")) counts.infoRefs++;
		else if (url.includes("git-upload-pack")) counts.uploadPack++;
		else if (url.includes("git-receive-pack")) counts.receivePack++;
		return baseFetch(input, init);
	};
	const net = httpTransport({ allowed: policy.allowed, fetch: countingFetch });
	return { net, counts };
}

describe("sync workflow: round-trip accounting", () => {
	test("a steady pull folds ls-refs into fetch (one upload-pack POST via want-ref)", async () => {
		const cloud = await makeCloud();
		const ws = await openWorkspace("alice", cloud);
		const { net, counts } = instrumentedNet(cloud);

		// The remote advances by one commit; Alice has no local work, so the pull
		// fast-forwards.
		const remoteHash = await cloudCommit(cloud, { "doc.md": "# Project\n\nv2\n" }, "remote v2");

		const { integration } = await pull(withCapabilities(ws.repo, { transport: net }), {
			url: cloud.url,
			branch: BRANCH,
			committer: ENGINE,
		});

		expect(integration.status).toBe("fast-forward");
		expect(await localTip(ws)).toBe(remoteHash);

		// By-name (`want-ref`) resolves the tip *and* returns the pack in a single
		// upload-pack POST — no separate `ls-refs`. The advertise+fetch path would
		// have issued two POSTs here.
		expect(counts.uploadPack).toBe(1);
	});

	test("a push reuses the receive-pack advertisement (no upload-pack ls-refs)", async () => {
		const cloud = await makeCloud();
		const ws = await openWorkspace("alice", cloud);
		const { net, counts } = instrumentedNet(cloud);

		// Local work to publish.
		await edit(ws, person("Alice"), { "a.md": "a\n" }, "local work");

		const pushed = await push(withCapabilities(ws.repo, { transport: net }), {
			url: cloud.url,
			branch: BRANCH,
		});
		expect(pushed.ok).toBe(true);
		expect(await cloudTip(cloud)).toBe((await localTip(ws)) as string);

		// Remote `oldHash` values come from the receive-pack advertisement that
		// the push needs anyway, so the upload-pack side is never touched: no cap
		// GET, no `ls-refs`. Exactly one receive-pack GET (advert) + one POST.
		expect(counts.uploadPack).toBe(0);
		expect(counts.infoRefs).toBe(1);
		expect(counts.receivePack).toBe(1);
	});

	test("a shared discovery cache skips the capability GET on later cycles", async () => {
		const cloud = await makeCloud();
		const ws = await openWorkspace("alice", cloud);
		const { net, counts } = instrumentedNet(cloud);
		const discoveryCache = createMemoryDiscoveryCache();
		const repo = withCapabilities(ws.repo, { transport: net, discoveryCache });

		// Cycle 1: discovery from the wire — one cap GET + one want-ref POST.
		await cloudCommit(cloud, { "doc.md": "# Project\n\nv2\n" }, "remote v2");
		await pull(repo, { url: cloud.url, branch: BRANCH, committer: ENGINE });
		expect(counts.infoRefs).toBe(1);
		expect(counts.uploadPack).toBe(1);

		// Cycle 2: caps restored from the shared cache — the cap GET is skipped,
		// leaving just the want-ref fetch POST.
		await cloudCommit(cloud, { "doc.md": "# Project\n\nv3\n" }, "remote v3");
		await pull(repo, { url: cloud.url, branch: BRANCH, committer: ENGINE });
		expect(counts.infoRefs).toBe(1); // unchanged — GET suppressed
		expect(counts.uploadPack).toBe(2); // one more want-ref fetch
	});

	test("knownRefs from a probe lets a (advertise-path) fetch skip ls-refs", async () => {
		const cloud = await makeCloud();
		const ws = await openWorkspace("alice", cloud);
		const { net, counts } = instrumentedNet(cloud);
		await cloudCommit(cloud, { "doc.md": "# Project\n\nv2\n" }, "remote v2");

		// A drift probe runs its own discovery; hand its refs to the follow-up
		// fetch so it doesn't re-advertise.
		const refs = await listRemoteRefs(cloud.url, { transport: net });
		const before = counts.uploadPack;

		const result = await fetch(withCapabilities(ws.repo, { transport: net }), {
			url: cloud.url,
			knownRefs: refs,
		});
		expect(result.objectCount).toBeGreaterThan(0);

		// The advertise path normally costs ls-refs + the object fetch (two
		// POSTs); seeding the probe's refs drops the ls-refs, leaving just one.
		expect(counts.uploadPack - before).toBe(1);
	});

	test("pull of a non-existent remote branch errors clearly (named ref not returned)", async () => {
		const cloud = await makeCloud();
		const ws = await openWorkspace("alice", cloud);

		// The by-name path loses the advertisement's implicit "ref doesn't exist"
		// signal: a missing branch comes back as an absent ref, so `pull` must
		// surface it rather than failing opaquely later in `merge`.
		await expect(
			pull(withCapabilities(ws.repo, { transport: cloud.net }), {
				url: cloud.url,
				branch: BRANCH,
				remoteBranch: "does-not-exist",
				author: person("Alice"),
				committer: ENGINE,
			}),
		).rejects.toThrow(/couldn't find remote ref refs\/heads\/does-not-exist/);
	});
});
