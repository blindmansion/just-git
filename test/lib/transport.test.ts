import { describe, expect, test } from "bun:test";
import { objectExists, readObject } from "../../src/lib/object-db.ts";
import { resolveHead, resolveRef } from "../../src/lib/refs.ts";
import { findGitDir } from "../../src/lib/repo.ts";
import { LocalTransport } from "../../src/lib/transport/transport.ts";
import { TEST_ENV as ENV } from "../fixtures";
import { createTestBash } from "../util";

async function setupPair() {
	const bash = createTestBash({
		files: {
			"/remote/README.md": "# Remote",
			"/local/.gitkeep": "",
		},
		env: ENV,
		cwd: "/remote",
	});

	// Init remote with a commit
	await bash.exec("git init");
	await bash.exec("git add .");
	await bash.exec('git commit -m "initial"');

	// Init local as empty repo
	await bash.exec("cd /local && git init");

	const remoteCtx = (await findGitDir(bash.fs, "/remote"))!;
	const localCtx = (await findGitDir(bash.fs, "/local"))!;

	return { bash, remoteCtx, localCtx };
}

describe("LocalTransport", () => {
	describe("advertiseRefs", () => {
		test("lists remote refs including HEAD", async () => {
			const { remoteCtx, localCtx } = await setupPair();
			const transport = new LocalTransport(localCtx, remoteCtx);
			const refs = await transport.advertiseRefs();

			expect(refs.length).toBeGreaterThanOrEqual(2);
			const names = refs.map((r) => r.name);
			expect(names).toContain("HEAD");
			expect(names).toContain("refs/heads/main");

			// HEAD and refs/heads/main should point to the same hash
			const headRef = refs.find((r) => r.name === "HEAD")!;
			const mainRef = refs.find((r) => r.name === "refs/heads/main")!;
			expect(headRef.hash).toBe(mainRef.hash);
		});
	});

	describe("fetch", () => {
		test("transfers objects from remote to local", async () => {
			const { remoteCtx, localCtx } = await setupPair();
			const transport = new LocalTransport(localCtx, remoteCtx);

			const refs = await transport.advertiseRefs();
			const mainHash = refs.find((r) => r.name === "refs/heads/main")!.hash;

			const result = await transport.fetch([mainHash], []);
			expect(result.objectCount).toBeGreaterThan(0);

			// Verify the commit object now exists in local
			expect(await objectExists(localCtx, mainHash)).toBe(true);

			// Verify the tree and blob are also present
			const raw = await readObject(localCtx, mainHash);
			expect(raw.type).toBe("commit");
		});

		test("returns 0 objects when already up to date", async () => {
			const { remoteCtx, localCtx } = await setupPair();
			const transport = new LocalTransport(localCtx, remoteCtx);

			const refs = await transport.advertiseRefs();
			const mainHash = refs.find((r) => r.name === "refs/heads/main")!.hash;

			// First fetch
			await transport.fetch([mainHash], []);

			// Second fetch with same objects as haves
			const result = await transport.fetch([mainHash], [mainHash]);
			expect(result.objectCount).toBe(0);
		});

		test("incremental fetch only transfers new objects", async () => {
			const { bash, remoteCtx, localCtx } = await setupPair();
			const transport = new LocalTransport(localCtx, remoteCtx);

			const refs = await transport.advertiseRefs();
			const firstHash = refs.find((r) => r.name === "refs/heads/main")!.hash;

			// Initial fetch
			const first = await transport.fetch([firstHash], []);

			// Add another commit to remote
			await bash.exec(
				"cd /remote && echo 'new file' > new.txt && git add . && git commit -m 'second'",
			);

			const newHead = (await resolveHead(remoteCtx))!;

			// Incremental fetch
			const second = await transport.fetch([newHead], [firstHash]);
			expect(second.objectCount).toBeGreaterThan(0);
			expect(second.objectCount).toBeLessThan(first.objectCount + 3);

			// New commit should exist locally
			expect(await objectExists(localCtx, newHead)).toBe(true);
		});
	});

	describe("push", () => {
		test("transfers objects from local to remote", async () => {
			const { bash, remoteCtx, localCtx } = await setupPair();

			// Make a commit in the local repo
			await bash.exec(
				"cd /local && echo 'local file' > local.txt && git add . && git commit -m 'local commit'",
			);

			const localHead = (await resolveHead(localCtx))!;

			const transport = new LocalTransport(localCtx, remoteCtx);
			const result = await transport.push([
				{
					name: "refs/heads/feature",
					oldHash: null,
					newHash: localHead,
					ok: true,
				},
			]);

			expect(result.updates).toHaveLength(1);
			expect(result.updates[0]!.ok).toBe(true);

			// Verify the ref exists on remote
			const remoteFeature = await resolveRef(remoteCtx, "refs/heads/feature");
			expect(remoteFeature).toBe(localHead);

			// Verify the objects exist on remote
			expect(await objectExists(remoteCtx, localHead)).toBe(true);
		});
	});
});
