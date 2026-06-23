import { describe, expect, test } from "bun:test";
import type { GitRepo, Identity } from "../../src/lib/types.ts";
import { cloneInto, merge, pull, rebase } from "../../src/repo/index.ts";
import { readFileAtCommit, resolveRef } from "../../src/repo/reading.ts";
import { commit } from "../../src/repo/writing.ts";
import { createServer } from "../../src/server/handler.ts";
import { createRepoStore, MemoryStorage } from "../../src/store/index.ts";

const BASE = "http://git";
const AUTHOR: Identity = {
	name: "Dev",
	email: "dev@x.dev",
	timestamp: 1000000000,
	timezone: "+0000",
};
const ENGINE: Identity = {
	name: "Engine",
	email: "engine@x.dev",
	timestamp: 1000001000,
	timezone: "+0000",
};

interface Harness {
	server: ReturnType<typeof createServer>;
	net: ReturnType<ReturnType<typeof createServer>["asNetwork"]>;
	local: GitRepo;
	url: string;
}

/** Server seeded on main + one local clone (which now has origin/* tracking). */
async function setup(): Promise<Harness> {
	const server = createServer({ autoCreate: true });
	await server.createRepo("repo");
	await server.commit("repo", {
		files: { "doc.md": "base\n" },
		message: "seed",
		author: AUTHOR,
		branch: "main",
	});
	const net = server.asNetwork(BASE);
	const local = await createRepoStore(new MemoryStorage()).createRepo("local");
	await cloneInto(local, `${BASE}/repo`, { networkPolicy: net });
	return { server, net, local, url: `${BASE}/repo` };
}

async function cloudCommit(
	h: Harness,
	files: Record<string, string>,
	message: string,
): Promise<string> {
	const { hash } = await h.server.commit("repo", {
		files,
		message,
		author: AUTHOR,
		branch: "main",
	});
	return hash;
}

const localMain = (repo: GitRepo) => resolveRef(repo, "refs/heads/main");
const fileAtMain = async (repo: GitRepo, path: string) =>
	readFileAtCommit(repo, (await localMain(repo)) as string, path);

describe("pull: merge strategy", () => {
	test("up-to-date when nothing changed on either side", async () => {
		const h = await setup();
		const { integration } = await pull(
			h.local,
			{ url: h.url, branch: "main" },
			{ networkPolicy: h.net },
		);
		expect(integration.status).toBe("up-to-date");
	});

	test("fast-forwards local when only the remote advanced", async () => {
		const h = await setup();
		const remoteTip = await cloudCommit(h, { "doc.md": "base\nv2\n" }, "remote v2");

		const { integration, fetched } = await pull(
			h.local,
			{ url: h.url, branch: "main" },
			{ networkPolicy: h.net },
		);

		expect(integration.status).toBe("fast-forward");
		expect(await localMain(h.local)).toBe(remoteTip);
		expect(fetched.updated.some((u) => u.ref === "refs/remotes/origin/main")).toBe(true);
	});

	test("auto-merges non-conflicting divergence and uses the supplied author", async () => {
		const h = await setup();
		await cloudCommit(h, { "remote.md": "r\n" }, "remote note");
		await commit(h.local, {
			files: { "local.md": "l\n" },
			message: "local note",
			author: AUTHOR,
			branch: "main",
		});

		const { integration } = await pull(
			h.local,
			{ url: h.url, branch: "main", author: ENGINE },
			{ networkPolicy: h.net },
		);

		expect(integration.status).toBe("merged");
		expect(await fileAtMain(h.local, "remote.md")).toBe("r\n");
		expect(await fileAtMain(h.local, "local.md")).toBe("l\n");
	});

	test("returns conflicts as data; resolve via merge() with the surfaced handles", async () => {
		const h = await setup();
		await cloudCommit(h, { "doc.md": "remote\n" }, "remote edit");
		await commit(h.local, {
			files: { "doc.md": "local\n" },
			message: "local edit",
			author: AUTHOR,
			branch: "main",
		});

		const { integration } = await pull(
			h.local,
			{ url: h.url, branch: "main", author: ENGINE },
			{ networkPolicy: h.net },
		);
		if (integration.status !== "conflicts" || !("ours" in integration)) {
			throw new Error("expected a merge conflict");
		}
		expect(integration.conflicts.map((c) => c.path)).toContain("doc.md");

		const resolved = await merge(h.local, {
			ours: integration.ours,
			theirs: integration.theirs,
			author: ENGINE,
			branch: "main",
			resolutions: { "doc.md": "theirs" },
		});
		expect(resolved.status).toBe("merged");
		expect(await fileAtMain(h.local, "doc.md")).toBe("remote\n");
	});

	test("defaults the branch to the current HEAD branch", async () => {
		const h = await setup();
		const remoteTip = await cloudCommit(h, { "doc.md": "base\nv2\n" }, "remote v2");
		const { integration } = await pull(h.local, { url: h.url }, { networkPolicy: h.net });
		expect(integration.status).toBe("fast-forward");
		expect(await localMain(h.local)).toBe(remoteTip);
	});
});

describe("pull: rebase strategy", () => {
	test("replays local commits onto the fetched tip (linear)", async () => {
		const h = await setup();
		await cloudCommit(h, { "remote.md": "r\n" }, "remote work");
		await commit(h.local, {
			files: { "a.md": "a\n" },
			message: "local a",
			author: AUTHOR,
			branch: "main",
		});

		const { integration } = await pull(
			h.local,
			{ url: h.url, branch: "main", strategy: "rebase", committer: ENGINE },
			{ networkPolicy: h.net },
		);

		expect(integration.status).toBe("ok");
		if (integration.status !== "ok") throw new Error("unreachable");
		expect(integration.rebased).toHaveLength(1);
		expect(await fileAtMain(h.local, "remote.md")).toBe("r\n");
		expect(await fileAtMain(h.local, "a.md")).toBe("a\n");
	});

	test("surfaces a continuation on conflict; resume via rebase()", async () => {
		const h = await setup();
		await cloudCommit(h, { "doc.md": "remote\n" }, "remote edit");
		await commit(h.local, {
			files: { "doc.md": "local\n" },
			message: "local edit",
			author: AUTHOR,
			branch: "main",
		});

		const { integration } = await pull(
			h.local,
			{ url: h.url, branch: "main", strategy: "rebase", committer: ENGINE },
			{ networkPolicy: h.net },
		);
		if (integration.status !== "conflicts" || !("continuation" in integration)) {
			throw new Error("expected a rebase conflict");
		}

		const done = await rebase(h.local, {
			continue: integration.continuation,
			resolutions: { "doc.md": "theirs" },
		});
		expect(done.status).toBe("ok");
		expect(await fileAtMain(h.local, "doc.md")).toBe("local\n");
	});
});
