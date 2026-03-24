import { describe, expect, test } from "bun:test";
import { Bash, InMemoryFs } from "just-bash";
import { createGit } from "../../src/index.ts";
import { createServer } from "../../src/server/handler.ts";
import { MemoryStorage } from "../../src/server/memory-storage.ts";
import type { GitServer } from "../../src/server/types.ts";
import { writeBlob, writeTree, createCommit } from "../../src/repo/writing.ts";
import { resolveRef, readFileAtCommit } from "../../src/repo/reading.ts";
import type { Identity } from "../../src/lib/types.ts";
import { envAt } from "./util.ts";

const ID: Identity = {
	name: "Test",
	email: "test@test.com",
	timestamp: 1000000000,
	timezone: "+0000",
};

function idAt(ts: number): Identity {
	return { ...ID, timestamp: ts };
}

const BASE = "http://git";

function setup() {
	const driver = new MemoryStorage();
	const server = createServer({ storage: driver });
	return { driver, server };
}

function client(server: GitServer, cwd = "/") {
	const fs = new InMemoryFs();
	const git = createGit({ network: server.asNetwork(BASE) });
	const bash = new Bash({ fs, cwd, customCommands: [git] });
	return bash;
}

async function seedRepo(server: GitServer, repoId: string) {
	const repo = await server.createRepo(repoId);
	const blob = await writeBlob(repo, "hello");
	const tree = await writeTree(repo, [{ name: "README.md", hash: blob }]);
	const hash = await createCommit(repo, {
		tree,
		parents: [],
		message: "init",
		author: ID,
		committer: ID,
		branch: "main",
	});
	return { repo, hash };
}

describe("forkRepo", () => {
	test("fork copies refs but not objects", async () => {
		const { driver, server } = setup();
		await seedRepo(server, "upstream");

		const fork = await server.forkRepo("upstream", "user/fork");
		expect(fork).toBeTruthy();

		const forkMainHash = await resolveRef(fork, "refs/heads/main");
		const upstreamRepo = await server.requireRepo("upstream");
		const upstreamMainHash = await resolveRef(upstreamRepo, "refs/heads/main");
		expect(forkMainHash).toBe(upstreamMainHash);

		// No objects in fork's own partition
		const forkObjects = driver.listObjectHashes("user/fork");
		expect(forkObjects.length).toBe(0);

		// Upstream still has its objects
		const upstreamObjects = driver.listObjectHashes("upstream");
		expect(upstreamObjects.length).toBeGreaterThan(0);
	});

	test("fork can read parent objects via fallback", async () => {
		const { server } = setup();
		await seedRepo(server, "upstream");

		const fork = await server.forkRepo("upstream", "user/fork");
		const content = await readFileAtCommit(
			fork,
			(await resolveRef(fork, "refs/heads/main"))!,
			"README.md",
		);
		expect(content).toBe("hello");
	});

	test("fork HEAD is copied from source", async () => {
		const { driver, server } = setup();
		await seedRepo(server, "upstream");

		await server.forkRepo("upstream", "user/fork");

		const head = driver.getRef("user/fork", "HEAD");
		expect(head).toEqual({ type: "symbolic", target: "refs/heads/main" });
	});

	test("write to fork goes to fork partition only", async () => {
		const { driver, server } = setup();
		await seedRepo(server, "upstream");

		const fork = await server.forkRepo("upstream", "user/fork");

		const blob = await writeBlob(fork, "fork-only content");
		const tree = await writeTree(fork, [{ name: "README.md", hash: blob }]);
		await createCommit(fork, {
			tree,
			parents: [(await resolveRef(fork, "refs/heads/main"))!],
			message: "fork commit",
			author: idAt(1000000001),
			committer: idAt(1000000001),
			branch: "main",
		});

		// Fork has its own objects now
		const forkObjects = driver.listObjectHashes("user/fork");
		expect(forkObjects.length).toBeGreaterThan(0);

		// Fork objects should not be in upstream
		for (const hash of forkObjects) {
			expect(driver.hasObject("upstream", hash)).toBe(false);
		}
	});

	test("fork-of-fork flattens to root", async () => {
		const { driver, server } = setup();
		await seedRepo(server, "upstream");

		await server.forkRepo("upstream", "fork-a");
		await server.forkRepo("fork-a", "fork-b");

		// fork-b should be recorded as fork of upstream, not fork-a
		expect(driver.getForkParent("fork-b")).toBe("upstream");
		expect(driver.getForkParent("fork-a")).toBe("upstream");

		// fork-b can still read upstream objects
		const forkB = await server.requireRepo("fork-b");
		const content = await readFileAtCommit(
			forkB,
			(await resolveRef(forkB, "refs/heads/main"))!,
			"README.md",
		);
		expect(content).toBe("hello");
	});

	test("findByPrefix returns results from both partitions", async () => {
		const { server } = setup();
		await seedRepo(server, "upstream");

		const fork = await server.forkRepo("upstream", "user/fork");

		// Write a new blob to the fork
		const forkBlob = await writeBlob(fork, "fork-unique");

		// The fork should find both its own objects and parent objects
		const prefix = forkBlob.slice(0, 6);
		const results = await fork.objectStore.findByPrefix(prefix);
		expect(results).toContain(forkBlob);

		// Also verify upstream objects are visible via prefix
		const upstream = await server.requireRepo("upstream");
		const upstreamHashes = await upstream.objectStore.findByPrefix(prefix);
		for (const h of upstreamHashes) {
			const forkResults = await fork.objectStore.findByPrefix(h.slice(0, 6));
			expect(forkResults).toContain(h);
		}
	});

	test("exists checks both partitions", async () => {
		const { driver, server } = setup();
		await seedRepo(server, "upstream");

		const fork = await server.forkRepo("upstream", "user/fork");

		// Upstream objects are visible via exists
		const upstreamHashes = driver.listObjectHashes("upstream");
		for (const hash of upstreamHashes) {
			expect(await fork.objectStore.exists(hash)).toBe(true);
		}
	});

	test("delete fork is clean", async () => {
		const { driver, server } = setup();
		await seedRepo(server, "upstream");

		await server.forkRepo("upstream", "user/fork");
		await server.deleteRepo("user/fork");

		expect(await server.repo("user/fork")).toBeNull();

		// Upstream is unaffected
		const upstream = await server.requireRepo("upstream");
		const hash = await resolveRef(upstream, "refs/heads/main");
		expect(hash).toBeTruthy();

		// Fork record is cleaned up
		expect(driver.getForkParent("user/fork")).toBeNull();
		expect(driver.listForks("upstream").length).toBe(0);
	});

	test("delete root with active forks throws", async () => {
		const { server } = setup();
		await seedRepo(server, "upstream");

		await server.forkRepo("upstream", "user/fork");

		expect(server.deleteRepo("upstream")).rejects.toThrow(
			"cannot delete repo 'upstream': has 1 active fork(s)",
		);
	});

	test("delete root succeeds after all forks deleted", async () => {
		const { server } = setup();
		await seedRepo(server, "upstream");

		await server.forkRepo("upstream", "fork-a");
		await server.forkRepo("upstream", "fork-b");

		await server.deleteRepo("fork-a");
		await server.deleteRepo("fork-b");

		// Now deleting root should succeed
		await server.deleteRepo("upstream");
		expect(await server.repo("upstream")).toBeNull();
	});

	test("fork source must exist", async () => {
		const { server } = setup();

		expect(server.forkRepo("nonexistent", "fork")).rejects.toThrow(
			"source repo 'nonexistent' not found",
		);
	});

	test("fork target must not exist", async () => {
		const { server } = setup();
		await seedRepo(server, "upstream");
		await server.createRepo("already-exists");

		expect(server.forkRepo("upstream", "already-exists")).rejects.toThrow(
			"repo 'already-exists' already exists",
		);
	});

	test("forkRepo throws when server is shutting down", async () => {
		const { server } = setup();
		await seedRepo(server, "upstream");

		await server.close();
		expect(server.forkRepo("upstream", "fork")).rejects.toThrow("Server is shutting down");
	});

	test("clone and push through fork via asNetwork", async () => {
		const { server } = setup();

		// Seed upstream
		const seeder = client(server);
		await server.createRepo("upstream");
		await seeder.exec(`git clone ${BASE}/upstream /seed`, { env: envAt(1000000000) });
		await seeder.writeFile("/seed/README.md", "# Hello");
		await seeder.exec("git add .", { cwd: "/seed", env: envAt(1000000000) });
		await seeder.exec('git commit -m "init"', { cwd: "/seed", env: envAt(1000000000) });
		await seeder.exec("git push origin main", { cwd: "/seed" });

		// Fork
		await server.forkRepo("upstream", "user/fork");

		// Clone the fork
		const c = client(server);
		const cloneResult = await c.exec(`git clone ${BASE}/user/fork /work`, {
			env: envAt(1000000100),
		});
		expect(cloneResult.exitCode).toBe(0);

		const fs = c.fs as InMemoryFs;
		expect(await fs.readFile("/work/README.md")).toBe("# Hello");

		// Push to the fork
		await c.writeFile("/work/new.txt", "fork content");
		await c.exec("git add .", { cwd: "/work", env: envAt(1000000200) });
		await c.exec('git commit -m "fork commit"', { cwd: "/work", env: envAt(1000000200) });

		const pushResult = await c.exec("git push origin main", { cwd: "/work" });
		expect(pushResult.exitCode).toBe(0);

		// Verify fork advanced
		const fork = await server.requireRepo("user/fork");
		const forkHash = await resolveRef(fork, "refs/heads/main");

		// Verify upstream is unchanged
		const upstream = await server.requireRepo("upstream");
		const upstreamHash = await resolveRef(upstream, "refs/heads/main");
		expect(forkHash).not.toBe(upstreamHash);
	});

	test("fetch from fork after upstream push", async () => {
		const { server } = setup();

		// Seed upstream
		const seeder = client(server);
		await server.createRepo("upstream");
		await seeder.exec(`git clone ${BASE}/upstream /seed`, { env: envAt(1000000000) });
		await seeder.writeFile("/seed/README.md", "# Hello");
		await seeder.exec("git add .", { cwd: "/seed", env: envAt(1000000000) });
		await seeder.exec('git commit -m "init"', { cwd: "/seed", env: envAt(1000000000) });
		await seeder.exec("git push origin main", { cwd: "/seed" });

		// Fork and clone
		await server.forkRepo("upstream", "user/fork");
		const c = client(server);
		await c.exec(`git clone ${BASE}/user/fork /work`, { env: envAt(1000000100) });

		// Push new content to fork directly
		const fork = await server.requireRepo("user/fork");
		const blob = await writeBlob(fork, "new content");
		const tree = await writeTree(fork, [{ name: "README.md", hash: blob }]);
		const forkHead = await resolveRef(fork, "refs/heads/main");
		await createCommit(fork, {
			tree,
			parents: [forkHead!],
			message: "server-side commit",
			author: idAt(1000000300),
			committer: idAt(1000000300),
			branch: "main",
		});

		// Client fetches
		const fetchResult = await c.exec("git fetch origin", { cwd: "/work" });
		expect(fetchResult.exitCode).toBe(0);

		const pullResult = await c.exec("git pull origin main --ff-only", {
			cwd: "/work",
			env: envAt(1000000400),
		});
		expect(pullResult.exitCode).toBe(0);

		const fs = c.fs as InMemoryFs;
		expect(await fs.readFile("/work/README.md")).toBe("new content");
	});

	test("multiple forks of same repo are independent", async () => {
		const { server } = setup();
		const { repo: upstream } = await seedRepo(server, "upstream");

		const forkA = await server.forkRepo("upstream", "fork-a");
		const forkB = await server.forkRepo("upstream", "fork-b");

		// Advance fork-a
		const blobA = await writeBlob(forkA, "content-a");
		const treeA = await writeTree(forkA, [{ name: "a.txt", hash: blobA }]);
		const headA = await resolveRef(forkA, "refs/heads/main");
		await createCommit(forkA, {
			tree: treeA,
			parents: [headA!],
			message: "fork-a commit",
			author: idAt(1000000001),
			committer: idAt(1000000001),
			branch: "main",
		});

		// fork-b main should still point to the upstream main
		const forkBHash = await resolveRef(forkB, "refs/heads/main");
		const upstreamHash = await resolveRef(upstream, "refs/heads/main");
		expect(forkBHash).toBe(upstreamHash);

		const forkAHash = await resolveRef(forkA, "refs/heads/main");
		expect(forkAHash).not.toBe(upstreamHash);
	});
});

describe("fork GC", () => {
	test("GC of root with forks retains fork-referenced objects", async () => {
		const { server } = setup();
		const { repo: upstream, hash: initHash } = await seedRepo(server, "upstream");

		// Create a second commit on upstream
		const blob2 = await writeBlob(upstream, "second");
		const tree2 = await writeTree(upstream, [{ name: "file.txt", hash: blob2 }]);
		const secondHash = await createCommit(upstream, {
			tree: tree2,
			parents: [initHash],
			message: "second",
			author: idAt(1000000001),
			committer: idAt(1000000001),
			branch: "main",
		});

		// Fork from the second commit
		await server.forkRepo("upstream", "user/fork");

		// Force upstream main back to init, making secondHash orphaned from upstream's perspective
		const upstreamRepo = await server.requireRepo("upstream");
		await upstreamRepo.refStore.writeRef("refs/heads/main", initHash);

		// GC upstream — should NOT delete second commit objects because fork refs them
		const result = await server.gc("upstream");
		expect(result.deleted).toBe(0);

		// Fork should still be able to read
		const fork = await server.requireRepo("user/fork");
		const forkContent = await readFileAtCommit(fork, secondHash, "file.txt");
		expect(forkContent).toBe("second");
	});

	test("GC of root without forks deletes orphaned objects normally", async () => {
		const { server } = setup();
		const { repo: upstream, hash: initHash } = await seedRepo(server, "upstream");

		const blob2 = await writeBlob(upstream, "orphan");
		const tree2 = await writeTree(upstream, [{ name: "file.txt", hash: blob2 }]);
		await createCommit(upstream, {
			tree: tree2,
			parents: [initHash],
			message: "will be orphaned",
			author: idAt(1000000001),
			committer: idAt(1000000001),
			branch: "main",
		});

		// Force main back
		const repo = await server.requireRepo("upstream");
		await repo.refStore.writeRef("refs/heads/main", initHash);

		const result = await server.gc("upstream");
		expect(result.deleted).toBeGreaterThan(0);
	});

	test("GC of fork only touches fork partition", async () => {
		const { driver, server } = setup();
		await seedRepo(server, "upstream");
		const fork = await server.forkRepo("upstream", "user/fork");

		// Write a blob to fork, then make it orphaned
		await writeBlob(fork, "fork-orphan");
		expect(driver.listObjectHashes("user/fork").length).toBeGreaterThan(0);

		// GC fork — should delete the orphaned blob
		const result = await server.gc("user/fork");
		expect(result.deleted).toBeGreaterThan(0);

		// Upstream objects should be completely unaffected
		const upstreamBefore = driver.listObjectHashes("upstream");
		expect(upstreamBefore.length).toBeGreaterThan(0);
	});

	test("GC of fork doesn't delete objects referenced by fork refs", async () => {
		const { driver, server } = setup();
		await seedRepo(server, "upstream");
		const fork = await server.forkRepo("upstream", "user/fork");

		// Commit to the fork
		const forkHead = await resolveRef(fork, "refs/heads/main");
		const blob = await writeBlob(fork, "fork-content");
		const tree = await writeTree(fork, [{ name: "fork.txt", hash: blob }]);
		await createCommit(fork, {
			tree,
			parents: [forkHead!],
			message: "fork commit",
			author: idAt(1000000001),
			committer: idAt(1000000001),
			branch: "main",
		});

		const beforeCount = driver.listObjectHashes("user/fork").length;

		const result = await server.gc("user/fork");
		expect(result.deleted).toBe(0);

		const afterCount = driver.listObjectHashes("user/fork").length;
		expect(afterCount).toBe(beforeCount);
	});
});
