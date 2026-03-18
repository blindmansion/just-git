#!/usr/bin/env bun
/**
 * Performance test against a real cloned repo.
 *
 * Clones a GitHub repo into the virtual FS via Smart HTTP, then
 * exercises hot paths: object walks, log, diff, rebase, blame,
 * status/add on large worktrees, and gc/repack.
 *
 * Usage:
 *   bun test/perf/large-repo.ts [repo-url]
 *   bun test/perf/large-repo.ts                          # default: cannoli
 *   bun test/perf/large-repo.ts https://github.com/user/repo.git
 */

import { Bash } from "just-bash";
import { createGit } from "../../src/index.ts";
import { findRepo } from "../../src/lib/repo.ts";
import {
	enumerateObjects,
	enumerateObjectsWithContent,
	collectEnumeration,
} from "../../src/lib/transport/object-walk.ts";
import { listRefs, resolveRef } from "../../src/lib/refs.ts";
import { PackedObjectStore } from "../../src/lib/object-store.ts";

const TEST_ENV: Record<string, string> = {
	GIT_AUTHOR_NAME: "Perf Test",
	GIT_AUTHOR_EMAIL: "perf@test.com",
	GIT_COMMITTER_NAME: "Perf Test",
	GIT_COMMITTER_EMAIL: "perf@test.com",
	GIT_AUTHOR_DATE: "1700000000",
	GIT_COMMITTER_DATE: "1700000000",
};

const repoUrl = process.argv[2] || "https://github.com/DeabLabs/cannoli.git";

function fmt(ms: number): string {
	if (ms < 1) return `${(ms * 1000).toFixed(0)}μs`;
	return ms < 1000 ? `${ms.toFixed(1)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

const results: { label: string; ms: number }[] = [];

async function time<T>(label: string, fn: () => Promise<T>): Promise<T> {
	const t0 = performance.now();
	const result = await fn();
	const ms = performance.now() - t0;
	results.push({ label, ms });
	console.log(`  ${label.padEnd(50)} ${fmt(ms).padStart(10)}`);
	return result;
}

// ── Clone ────────────────────────────────────────────────────────────

console.log(`\n  Cloning ${repoUrl} into virtual FS...\n`);

const git = createGit();
const bash = new Bash({ cwd: "/", customCommands: [git], env: TEST_ENV });

const cloneResult = await time("git clone", () => bash.exec(`git clone ${repoUrl} /repo`));

if (cloneResult.exitCode !== 0) {
	console.error("Clone failed:", cloneResult.stderr);
	process.exit(1);
}

const ctx = (await findRepo(bash.fs, "/repo"))!;
const store = ctx.objectStore as PackedObjectStore;

// ── Repo stats ───────────────────────────────────────────────────────

console.log("\n── Repo stats ──────────────────────────────────────────");

const refs = await listRefs(ctx);
const headHash = await resolveRef(ctx, "HEAD");
console.log(`  Refs: ${refs.length}, HEAD: ${headHash?.slice(0, 8)}`);

// ── Object enumeration ──────────────────────────────────────────────

console.log("\n── Object enumeration (full repo, haves=[]) ────────────");

const allWants = refs.map((r) => r.hash);

const enum1 = await time("enumerateObjects (hash+type)", async () => {
	const r = await enumerateObjects(ctx, allWants, []);
	await collectEnumeration(r);
	return { count: r.count };
});
console.log(`    → ${enum1.count} objects`);

(store as any).cache.clear();

const enum2 = await time("enumerateObjectsWithContent (cold)", async () => {
	const r = await enumerateObjectsWithContent(ctx, allWants, []);
	await collectEnumeration(r);
	return { count: r.count };
});
console.log(`    → ${enum2.count} objects`);

const cacheInfo = (store as any).cache;
console.log(`    cache: ${cacheInfo.size} entries, ${(cacheInfo.bytes / 1024).toFixed(0)} KB`);

// const enum3 = await time("enumerateObjectsWithContent (warm)", async () => {
// 	const r = await enumerateObjectsWithContent(ctx, allWants, []);
// 	await collectEnumeration(r);
// 	return { count: r.count };
// });

// ── Incremental enumeration ─────────────────────────────────────────

console.log("\n── Incremental enumeration (simulated fetch) ────────────");

const haveHash = (await bash.exec("git rev-parse HEAD~20", { cwd: "/repo" })).stdout.trim();
const wantHash = (await bash.exec("git rev-parse HEAD", { cwd: "/repo" })).stdout.trim();

const incResult = await time("enumerate 20-commit delta", async () => {
	const r = await enumerateObjectsWithContent(ctx, [wantHash], [haveHash]);
	// const objects = await collectEnumeration(r);
	return { count: r.count };
});
console.log(`    → ${incResult.count} objects in delta`);

// ── Log / diff / show ────────────────────────────────────────────────

console.log("\n── Log / diff ──────────────────────────────────────────");

await time("git log --oneline (all)", () => bash.exec("git log --oneline", { cwd: "/repo" }));

await time("git log --stat -5", () => bash.exec("git log --stat -5", { cwd: "/repo" }));

await time("git diff HEAD~1 HEAD", () => bash.exec("git diff HEAD~1 HEAD", { cwd: "/repo" }));

await time("git diff HEAD~5 HEAD", () => bash.exec("git diff HEAD~5 HEAD", { cwd: "/repo" }));

await time("git diff HEAD~20 HEAD", () => bash.exec("git diff HEAD~20 HEAD", { cwd: "/repo" }));

// ── Branch / commit / rebase ─────────────────────────────────────────

console.log("\n── Branch / commit / rebase ─────────────────────────────");

let ts = 1700000001;

await bash.exec("git checkout -b perf-branch HEAD~30", { cwd: "/repo" });

for (let i = 0; i < 20; i++) {
	ts++;
	const env = { ...TEST_ENV, GIT_AUTHOR_DATE: String(ts), GIT_COMMITTER_DATE: String(ts) };
	await bash.exec(`printf 'perf ${i}\\nline2\\nline3\\n' > perf-${i}.txt`, { cwd: "/repo", env });
	await bash.exec(`git add perf-${i}.txt`, { cwd: "/repo", env });
	await bash.exec(`git commit -m "perf ${i}"`, { cwd: "/repo", env });
}

const mainBranch = (await bash.exec("git branch -a", { cwd: "/repo" })).stdout.includes("main")
	? "main"
	: "master";

await time(`git rebase ${mainBranch} (20 commits)`, async () => {
	ts++;
	const env = { ...TEST_ENV, GIT_AUTHOR_DATE: String(ts), GIT_COMMITTER_DATE: String(ts) };
	return bash.exec(`git rebase ${mainBranch}`, { cwd: "/repo", env });
});

// ── Status / add ─────────────────────────────────────────────────────

console.log("\n── Status / add ────────────────────────────────────────");

await time("git status (clean)", () => bash.exec("git status", { cwd: "/repo" }));

for (let i = 0; i < 100; i++) {
	await bash.exec(`printf 'bulk ${i}\\n' > bulk-${i}.txt`, { cwd: "/repo" });
}

await time("git add . (100 new files)", () => bash.exec("git add .", { cwd: "/repo" }));

ts++;
await time("git commit (100 new files)", () =>
	bash.exec('git commit -m "add 100 files"', {
		cwd: "/repo",
		env: { ...TEST_ENV, GIT_AUTHOR_DATE: String(ts), GIT_COMMITTER_DATE: String(ts) },
	}),
);

// ── gc / repack ──────────────────────────────────────────────────────

console.log("\n── gc / repack ─────────────────────────────────────────");

await time("git repack -a -d", () => bash.exec("git repack -a -d", { cwd: "/repo" }));

// Verify reads work after repack (tests invalidatePacks)
await time("git log --oneline -5 (after repack)", () =>
	bash.exec("git log --oneline -5", { cwd: "/repo" }),
);

await time("git diff HEAD~5 HEAD (after repack)", () =>
	bash.exec("git diff HEAD~5 HEAD", { cwd: "/repo" }),
);

// ── Blame ────────────────────────────────────────────────────────────

console.log("\n── Blame ───────────────────────────────────────────────");

const lsResult = await bash.exec("git ls-files", { cwd: "/repo" });
const files = lsResult.stdout
	.trim()
	.split("\n")
	.filter((f) => !f.includes("node_modules"));
const blameTarget = files.find((f) => f.endsWith(".ts") || f.endsWith(".js")) || files[0];

await time(`git blame ${blameTarget}`, () =>
	bash.exec(`git blame "${blameTarget}"`, { cwd: "/repo" }),
);

// ── Summary ──────────────────────────────────────────────────────────

console.log("\n────────────────────────────────────────────────────────\n");
