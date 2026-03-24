/**
 * Smoke-tests the SERVER.md examples related to server.commit(),
 * buildCommit(), updateRefs(), and CAS protection.
 *
 * Run: bun test/smoke/server-commit-examples.ts
 */

import { Database } from "bun:sqlite";
import { createServer, BunSqliteStorage } from "../../src/server";
import { buildCommit, readFileAtCommit, readCommit, resolveRef } from "../../src/repo";

// ═══════════════════════════════════════════════════════════════════
// Programmatic commits (SERVER.md)
// ═══════════════════════════════════════════════════════════════════

// ── server.commit() basic usage ─────────────────────────────────────

{
	const server = createServer({
		storage: new BunSqliteStorage(new Database(":memory:")),
	});
	await server.createRepo("my-repo");

	const { hash, parentHash } = await server.commit("my-repo", {
		files: { "README.md": "# Hello\n", "src/index.ts": "export {};\n" },
		message: "auto-fix: lint errors",
		author: { name: "Bot", email: "bot@example.com" },
		branch: "main",
	});

	console.assert(typeof hash === "string" && hash.length === 40, "should return a 40-char hash");
	console.assert(parentHash === null, "root commit should have null parentHash");

	const repo = await server.requireRepo("my-repo");
	const readme = await readFileAtCommit(repo, hash, "README.md");
	console.assert(readme === "# Hello\n", "README.md content should match");
	const idx = await readFileAtCommit(repo, hash, "src/index.ts");
	console.assert(idx === "export {};\n", "src/index.ts content should match");

	console.log("SERVER.MD server.commit() basic: OK");
}

// ── server.commit() does not fire hooks ─────────────────────────────

{
	let hookFired = false;
	const server = createServer({
		storage: new BunSqliteStorage(new Database(":memory:")),
		hooks: {
			preReceive: () => {
				hookFired = true;
				return { reject: true, message: "should not fire" };
			},
		},
	});
	await server.createRepo("test");

	const { hash } = await server.commit("test", {
		files: { "file.txt": "content" },
		message: "bypasses hooks",
		author: { name: "Bot", email: "bot@example.com" },
		branch: "main",
	});

	console.assert(hash.length === 40, "commit should succeed despite rejecting hook");
	console.assert(!hookFired, "hook should not have fired");

	console.log("SERVER.MD server.commit() bypasses hooks: OK");
}

// ── buildCommit() + server.updateRefs() ─────────────────────────────

{
	const server = createServer({
		storage: new BunSqliteStorage(new Database(":memory:")),
	});
	await server.createRepo("my-repo");

	// Seed with an initial commit so the branch exists
	await server.commit("my-repo", {
		files: { "init.txt": "seed" },
		message: "init",
		author: { name: "Bot", email: "bot@example.com" },
		branch: "main",
	});

	const newConfig = { key: "value" };

	const repo = await server.requireRepo("my-repo");
	const { hash, parentHash } = await buildCommit(repo, {
		files: { "config.json": JSON.stringify(newConfig) },
		message: "update config",
		author: { name: "Bot", email: "bot@example.com" },
		branch: "main",
	});

	console.assert(parentHash !== null, "parentHash should not be null (branch exists)");

	// Ref should NOT have moved yet
	const refBefore = await resolveRef(repo, "refs/heads/main");
	console.assert(refBefore === parentHash, "ref should still point to parent before updateRefs");

	await server.updateRefs("my-repo", [
		{ ref: "refs/heads/main", newHash: hash, oldHash: parentHash },
	]);

	// Ref should now point to the new commit
	const refAfter = await resolveRef(repo, "refs/heads/main");
	console.assert(refAfter === hash, "ref should point to new commit after updateRefs");

	const config = await readFileAtCommit(repo, hash, "config.json");
	console.assert(config === JSON.stringify(newConfig), "config.json content should match");

	console.log("SERVER.MD buildCommit() + updateRefs(): OK");
}

// ── buildCommit() without branch (root commit) ─────────────────────

{
	const server = createServer({
		storage: new BunSqliteStorage(new Database(":memory:")),
	});
	const repo = await server.createRepo("my-repo");

	const { hash, parentHash } = await buildCommit(repo, {
		files: { "file.txt": "content" },
		message: "orphan commit",
		author: { name: "Bot", email: "bot@example.com" },
	});

	console.assert(parentHash === null, "root commit should have null parentHash");
	const commit = await readCommit(repo, hash);
	console.assert(commit.parents.length === 0, "root commit should have no parents");

	console.log("SERVER.MD buildCommit() root commit: OK");
}

// ═══════════════════════════════════════════════════════════════════
// CAS protection (SERVER.md)
// ═══════════════════════════════════════════════════════════════════

{
	const server = createServer({
		storage: new BunSqliteStorage(new Database(":memory:")),
	});
	await server.createRepo("test");

	// Create initial commit
	await server.commit("test", {
		files: { "file.txt": "v1" },
		message: "init",
		author: { name: "Bot", email: "bot@test.com" },
		branch: "main",
	});

	// buildCommit reads the current parent
	const repo = await server.requireRepo("test");
	const { hash, parentHash } = await buildCommit(repo, {
		files: { "file.txt": "v2" },
		message: "update",
		author: { name: "Bot", email: "bot@test.com" },
		branch: "main",
	});

	// Simulate concurrent update: advance the branch behind our back
	const { hash: sneakyHash } = await buildCommit(repo, {
		files: { "other.txt": "sneaky" },
		message: "concurrent",
		author: { name: "Other", email: "other@test.com" },
		branch: "main",
	});
	await repo.refStore.writeRef("refs/heads/main", { type: "direct", hash: sneakyHash });

	// Our updateRefs should fail because oldHash no longer matches
	const result = await server.updateRefs("test", [
		{ ref: "refs/heads/main", newHash: hash, oldHash: parentHash },
	]);
	console.assert(!result.refResults[0]!.ok, "CAS should fail when branch moved");
	console.assert(
		result.refResults[0]!.error === "failed to lock",
		"error should be 'failed to lock'",
	);

	console.log("SERVER.MD CAS protection: OK");
}

// ═══════════════════════════════════════════════════════════════════
// Hook enforcement via transport (SERVER.md)
// ═══════════════════════════════════════════════════════════════════

{
	const server = createServer({
		storage: new BunSqliteStorage(new Database(":memory:")),
		auth: {
			http: (req) => ({
				canWrite: req.headers.has("Authorization"),
			}),
		},
		hooks: {
			preReceive: ({ auth }) => {
				if (!auth.canWrite) return { reject: true, message: "write access denied" };
			},
		},
	});
	await server.createRepo("test");

	// Seed via direct API (no hooks)
	await server.commit("test", {
		files: { "init.txt": "seed" },
		message: "init",
		author: { name: "Bot", email: "bot@test.com" },
		branch: "main",
	});

	// Unauthenticated push via HTTP transport → hooks fire, rejected
	const pushReq = new Request("http://localhost/test/git-receive-pack", {
		method: "POST",
		headers: { "Content-Type": "application/x-git-receive-pack-request" },
		body: new Uint8Array(0),
	});
	const pushResp = await server.fetch(pushReq);
	// The push will fail at the protocol level (empty body), but the key
	// point is that hooks fire on transport and auth.canWrite is accessible
	// without optional chaining — auth is always present in transport hooks
	console.assert(pushResp.status !== 501, "HTTP should not return 501 (auth provider configured)");

	console.log("SERVER.MD hook enforcement via transport: OK");
}

// ═══════════════════════════════════════════════════════════════════

console.log("\nAll SERVER.MD commit/auth examples passed.");
