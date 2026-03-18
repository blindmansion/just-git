#!/usr/bin/env bun
/**
 * Stress test for the SQLite-backed Git server.
 *
 * Exercises the full server stack with real git clients:
 *   1. Start the SQLite server (in-memory or on-disk)
 *   2. Clone a real GitHub repo via real git
 *   3. Push the entire repo to the server
 *   4. Clone back from the server, verify integrity
 *   5. Multi-branch workflows: create branches, push, fetch
 *   6. Incremental pushes with many small commits
 *   7. Parallel clones from the server
 *   8. Large file stress (generate bulk content, push)
 *   9. Second repo (multi-repo routing)
 *
 * Usage:
 *   bun test/perf/server-stress.ts
 *   bun test/perf/server-stress.ts https://github.com/user/repo.git
 *   DB_PATH=repos.sqlite bun test/perf/server-stress.ts
 *
 * Environment:
 *   DB_PATH  — SQLite path (default: ":memory:")
 *   PORT     — server port (default: 0 for random)
 */

import { Database } from "bun:sqlite";
import {
	mkdtempSync,
	rmSync,
	readdirSync,
	statSync,
	readFileSync,
	writeFileSync,
	mkdirSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { SqliteStorage } from "../../src/server/sqlite-storage.ts";
import { createGitServer } from "../../src/server/handler.ts";

const SOURCE_REPO = process.argv[2] || "https://github.com/DeabLabs/cannoli.git";
const DB_PATH = process.env.DB_PATH ?? ":memory:";
const PORT = Number(process.env.PORT ?? 0);

function fmt(ms: number): string {
	if (ms < 1) return `${(ms * 1000).toFixed(0)}μs`;
	return ms < 1000 ? `${ms.toFixed(1)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

function dirSize(dir: string): { files: number; bytes: number } {
	let files = 0;
	let bytes = 0;
	const walk = (d: string) => {
		for (const entry of readdirSync(d, { withFileTypes: true })) {
			const full = join(d, entry.name);
			if (entry.isDirectory()) {
				walk(full);
			} else {
				files++;
				bytes += statSync(full).size;
			}
		}
	};
	walk(dir);
	return { files, bytes };
}

async function git(
	cmd: string,
	cwd: string,
	env?: Record<string, string>,
): Promise<{
	stdout: string;
	stderr: string;
	exitCode: number;
	ms: number;
}> {
	const t0 = performance.now();
	const proc = Bun.spawn(["sh", "-c", cmd], {
		cwd,
		env: { ...process.env, ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const exitCode = await proc.exited;
	return { stdout, stderr, exitCode, ms: performance.now() - t0 };
}

const results: { label: string; ms: number; detail?: string }[] = [];

function record(label: string, ms: number, detail?: string) {
	results.push({ label, ms, detail });
	const detailStr = detail ? ` (${detail})` : "";
	console.log(`  ${label.padEnd(55)} ${fmt(ms).padStart(10)}${detailStr}`);
}

const GIT_ENV = {
	GIT_AUTHOR_NAME: "Stress Test",
	GIT_AUTHOR_EMAIL: "stress@test.com",
	GIT_COMMITTER_NAME: "Stress Test",
	GIT_COMMITTER_EMAIL: "stress@test.com",
};

// ── Setup ────────────────────────────────────────────────────────────

console.log("\n╔══════════════════════════════════════════════════════════╗");
console.log("║          SQLite Git Server — Stress Test                ║");
console.log("╚══════════════════════════════════════════════════════════╝\n");

const tmpBase = mkdtempSync(join(tmpdir(), "git-stress-"));
console.log(`  tmp dir:    ${tmpBase}`);
console.log(`  source:     ${SOURCE_REPO}`);
console.log(`  database:   ${DB_PATH === ":memory:" ? "(in-memory)" : DB_PATH}\n`);

const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode = WAL");
const storage = new SqliteStorage(db);

let pushCount = 0;

const NO_DELTA = process.env.NO_DELTA === "1";
if (NO_DELTA) console.log("  mode:       no-delta (streaming)\n");

const server = createGitServer({
	resolveRepo: async (repoPath) => {
		const repo = storage.repo(repoPath);
		const head = await repo.refStore.readRef("HEAD");
		if (!head) {
			await repo.refStore.writeRef("HEAD", { type: "symbolic", target: "refs/heads/main" });
		}
		return repo;
	},
	packOptions: NO_DELTA ? { noDelta: true } : undefined,
	hooks: {
		postReceive: async (event) => {
			pushCount++;
			for (const u of event.updates) {
				console.log(
					`  [push #${pushCount}] ${u.ref}: ${(u.oldHash ?? "0000000").slice(0, 7)}..${u.newHash.slice(0, 7)}`,
				);
			}
		},
	},
});

const srv = Bun.serve({ fetch: server.fetch, port: PORT });
const BASE_URL = `http://localhost:${srv.port}`;
console.log(`  server:     ${BASE_URL}\n`);

try {
	// ── 1. Clone source repo ─────────────────────────────────────────

	console.log("── 1. Clone source repo from GitHub ─────────────────────\n");

	const sourceDir = join(tmpBase, "source");
	const r1 = await git(`git clone ${SOURCE_REPO} ${sourceDir}`, tmpBase);
	const sourceStats = dirSize(sourceDir);
	record(
		"git clone (from GitHub)",
		r1.ms,
		`${sourceStats.files} files, ${(sourceStats.bytes / 1024 / 1024).toFixed(1)} MB`,
	);

	const sourceLog = await git("git log --oneline", sourceDir);
	const commitCount = sourceLog.stdout.trim().split("\n").length;
	const branchList = await git("git branch -a", sourceDir);
	const branches = branchList.stdout.trim().split("\n").length;
	console.log(`    ${commitCount} commits, ${branches} branches\n`);

	const mainBranch = (await git("git symbolic-ref --short HEAD", sourceDir)).stdout.trim();

	// ── 2. Push to server ────────────────────────────────────────────

	console.log("── 2. Push entire repo to SQLite server ─────────────────\n");

	await git(`git remote add sqlite ${BASE_URL}/stress-repo`, sourceDir);
	const r2 = await git(`git push sqlite ${mainBranch}`, sourceDir, GIT_ENV);
	record("git push (initial, single branch)", r2.ms);

	const r2all = await git("git push sqlite --all", sourceDir, GIT_ENV);
	record("git push --all (all branches)", r2all.ms);

	const r2tags = await git("git push sqlite --tags", sourceDir, GIT_ENV);
	record("git push --tags", r2tags.ms);

	// ── 3. Clone from server ─────────────────────────────────────────

	console.log("\n── 3. Clone from SQLite server ───────────────────────────\n");

	const cloneDir = join(tmpBase, "clone1");
	const r3 = await git(`git clone ${BASE_URL}/stress-repo ${cloneDir}`, tmpBase);
	if (r3.exitCode !== 0) {
		console.log(`  clone FAILED (exit ${r3.exitCode}):`);
		console.log(`    stdout: ${r3.stdout.slice(0, 500)}`);
		console.log(`    stderr: ${r3.stderr.slice(0, 500)}`);
	}
	const cloneStats = r3.exitCode === 0 ? dirSize(cloneDir) : { files: 0, bytes: 0 };
	record(
		"git clone (from server)",
		r3.ms,
		`${cloneStats.files} files, ${(cloneStats.bytes / 1024 / 1024).toFixed(1)} MB`,
	);

	// ── 4. Verify integrity ──────────────────────────────────────────

	console.log("\n── 4. Verify integrity ──────────────────────────────────\n");

	const sourceHead = (await git(`git rev-parse ${mainBranch}`, sourceDir)).stdout.trim();
	const cloneHead = (await git(`git rev-parse ${mainBranch}`, cloneDir)).stdout.trim();
	const headsMatch = sourceHead === cloneHead;
	console.log(`  HEAD match: ${headsMatch ? "✓" : "✗"} (${sourceHead.slice(0, 12)})`);

	const sourceTree = (
		await git(`git ls-tree -r --name-only ${mainBranch}`, sourceDir)
	).stdout.trim();
	const cloneTree = (await git(`git ls-tree -r --name-only ${mainBranch}`, cloneDir)).stdout.trim();
	const treesMatch = sourceTree === cloneTree;
	console.log(`  Tree match: ${treesMatch ? "✓" : "✗"} (${sourceTree.split("\n").length} files)`);

	const srcLocalBranches = (await git("git branch", sourceDir)).stdout
		.trim()
		.split("\n")
		.map((b) => b.replace(/^\*?\s+/, "").trim())
		.filter(Boolean)
		.sort();
	const clnRemoteBranches = (await git("git branch -r", cloneDir)).stdout
		.trim()
		.split("\n")
		.map((b) => b.trim())
		.filter((b) => !b.includes("->"))
		.map((b) => b.replace(/^[^/]+\//, ""))
		.sort();
	const branchesMatch = JSON.stringify(srcLocalBranches) === JSON.stringify(clnRemoteBranches);
	console.log(
		`  Branches:   ${branchesMatch ? "✓" : "✗"} (${srcLocalBranches.length} local → ${clnRemoteBranches.length} remote)`,
	);

	if (!headsMatch || !treesMatch) {
		console.log("\n  ⚠ INTEGRITY CHECK FAILED");
	}

	// ── 5. Multi-branch workflow ─────────────────────────────────────

	console.log("\n── 5. Multi-branch workflow ─────────────────────────────\n");

	const workDir = join(tmpBase, "work");
	await git(`git clone ${BASE_URL}/stress-repo ${workDir}`, tmpBase);

	let ts = 2000000000;
	const tsEnv = () => {
		ts++;
		return { ...GIT_ENV, GIT_AUTHOR_DATE: String(ts), GIT_COMMITTER_DATE: String(ts) };
	};

	const branchOps = 10;
	const t5_0 = performance.now();
	for (let i = 0; i < branchOps; i++) {
		await git(`git checkout -b stress-branch-${i}`, workDir, tsEnv());
		for (let j = 0; j < 5; j++) {
			writeFileSync(join(workDir, `stress-b${i}-f${j}.txt`), `branch ${i} commit ${j}\n`);
			await git("git add .", workDir, tsEnv());
			await git(`git commit -m "branch ${i} commit ${j}"`, workDir, tsEnv());
		}
		await git(`git push -u origin stress-branch-${i}`, workDir, tsEnv());
		await git(`git checkout ${mainBranch}`, workDir, tsEnv());
	}
	record(`create+push ${branchOps} branches (${branchOps * 5} commits)`, performance.now() - t5_0);

	// ── 6. Incremental push — many small commits ─────────────────────

	console.log("\n── 6. Incremental push — many small commits ─────────────\n");

	const rapidDir = join(tmpBase, "rapid");
	await git(`git clone ${BASE_URL}/stress-repo ${rapidDir}`, tmpBase);
	await git(`git checkout -b rapid-fire`, rapidDir, tsEnv());

	const rapidCount = 50;
	const t6_0 = performance.now();
	for (let i = 0; i < rapidCount; i++) {
		writeFileSync(join(rapidDir, `rapid-${i}.txt`), `rapid commit ${i} - ${ts}\n`);
		await git("git add .", rapidDir, tsEnv());
		await git(`git commit -m "rapid ${i}"`, rapidDir, tsEnv());
	}
	const t6_commit = performance.now();
	record(`create ${rapidCount} commits locally`, t6_commit - t6_0);

	const r6push = await git("git push -u origin rapid-fire", rapidDir, tsEnv());
	record(`push ${rapidCount} commits to server`, r6push.ms);

	// ── 7. Parallel clones from server ───────────────────────────────

	console.log("\n── 7. Parallel clones from server ──────────────────────\n");

	const parallelCount = 5;
	const t7_0 = performance.now();
	const clonePromises = Array.from({ length: parallelCount }, (_, i) => {
		const dir = join(tmpBase, `parallel-${i}`);
		return git(`git clone ${BASE_URL}/stress-repo ${dir}`, tmpBase).then((r) => r.ms);
	});
	const cloneTimes = await Promise.all(clonePromises);
	const t7_1 = performance.now();

	const avgClone = cloneTimes.reduce((s, t) => s + t, 0) / cloneTimes.length;
	record(
		`${parallelCount} parallel clones`,
		t7_1 - t7_0,
		`avg ${fmt(avgClone)} each, wall ${fmt(t7_1 - t7_0)}`,
	);

	const parallelHeadResults = await Promise.all(
		Array.from({ length: parallelCount }, (_, i) => {
			const dir = join(tmpBase, `parallel-${i}`);
			return git(`git rev-parse ${mainBranch}`, dir);
		}),
	);
	const parallelHeads = parallelHeadResults.map((r) => r.stdout.trim());
	const allSameHead = parallelHeads.every((h) => h === parallelHeads[0]);
	console.log(`    All heads match: ${allSameHead ? "✓" : "✗"}`);

	// ── 8. Large file stress ─────────────────────────────────────────

	console.log("\n── 8. Large file stress ─────────────────────────────────\n");

	const bigDir = join(tmpBase, "bigfiles");
	await git(`git clone ${BASE_URL}/stress-repo ${bigDir}`, tmpBase);
	await git(`git checkout -b big-files`, bigDir, tsEnv());

	const fileSizes = [
		{ name: "medium-1.bin", kb: 256 },
		{ name: "medium-2.bin", kb: 512 },
		{ name: "large-1.bin", kb: 1024 },
		{ name: "large-2.bin", kb: 2048 },
	];

	const t8_gen0 = performance.now();
	for (const { name, kb } of fileSizes) {
		const lines = Math.ceil((kb * 1024) / 80);
		const content = Array.from(
			{ length: lines },
			(_, i) => `line ${i.toString().padStart(8, "0")} ${"x".repeat(60)} ${name}\n`,
		).join("");
		await Bun.write(join(bigDir, name), content);
	}
	const t8_gen1 = performance.now();
	const totalKB = fileSizes.reduce((s, f) => s + f.kb, 0);
	record(`generate ${fileSizes.length} files (${totalKB} KB total)`, t8_gen1 - t8_gen0);

	await git("git add .", bigDir, tsEnv());
	await git(`git commit -m "add large files"`, bigDir, tsEnv());
	const r8push = await git("git push -u origin big-files", bigDir, tsEnv());
	record(`push ${totalKB} KB of content`, r8push.ms);

	const bigCloneDir = join(tmpBase, "bigfiles-clone");
	const r8clone = await git(
		`git clone -b big-files ${BASE_URL}/stress-repo ${bigCloneDir}`,
		tmpBase,
	);
	record(`clone back (with large files)`, r8clone.ms);

	for (const { name, kb } of fileSizes) {
		const original = readFileSync(join(bigDir, name), "utf-8");
		const cloned = readFileSync(join(bigCloneDir, name), "utf-8");
		const match = original === cloned;
		console.log(`    ${name} (${kb} KB): ${match ? "✓" : "✗"}`);
	}

	// ── 9. Second repo (multi-repo) ──────────────────────────────────

	console.log("\n── 9. Second repo (multi-repo routing) ──────────────────\n");

	const repo2Dir = join(tmpBase, "repo2");
	mkdirSync(repo2Dir, { recursive: true });
	await git("git init", repo2Dir, tsEnv());
	await git(`git checkout -b main`, repo2Dir, tsEnv());

	for (let i = 0; i < 20; i++) {
		writeFileSync(join(repo2Dir, `repo2-file-${i}.txt`), `repo2 file ${i}\n`);
		await git("git add .", repo2Dir, tsEnv());
		await git(`git commit -m "repo2 commit ${i}"`, repo2Dir, tsEnv());
	}

	await git(`git remote add sqlite ${BASE_URL}/second-repo`, repo2Dir);
	const r9push = await git("git push -u sqlite main", repo2Dir, tsEnv());
	record("push 20 commits to second repo", r9push.ms);

	const repo2CloneDir = join(tmpBase, "repo2-clone");
	const r9clone = await git(`git clone ${BASE_URL}/second-repo ${repo2CloneDir}`, tmpBase);
	record("clone second repo", r9clone.ms);

	const repo2Log = await git("git log --oneline", repo2CloneDir);
	const repo2Commits = repo2Log.stdout.trim().split("\n").length;
	console.log(`    Second repo: ${repo2Commits} commits cloned\n`);

	const repo1Check = join(tmpBase, "repo1-verify");
	await git(`git clone ${BASE_URL}/stress-repo ${repo1Check}`, tmpBase);
	const repo1Head = (await git(`git rev-parse ${mainBranch}`, repo1Check)).stdout.trim();
	console.log(
		`    First repo HEAD still: ${repo1Head.slice(0, 12)} (unchanged: ${repo1Head === sourceHead ? "✓" : "✗"})`,
	);

	// ── 10. Fetch after many pushes ──────────────────────────────────

	console.log("\n── 10. Fetch after many changes ─────────────────────────\n");

	const fetchDir = join(tmpBase, "fetch-test");
	await git(`git clone ${BASE_URL}/stress-repo ${fetchDir}`, tmpBase);

	const r10 = await git("git fetch --all", fetchDir, tsEnv());
	record("git fetch --all (catch up)", r10.ms);

	const fetchBranches = (await git("git branch -r", fetchDir)).stdout.trim().split("\n").length;
	console.log(`    Remote branches after fetch: ${fetchBranches}`);

	// ── DB stats ─────────────────────────────────────────────────────

	console.log("\n── Database stats ──────────────────────────────────────\n");

	const objCount = db.query("SELECT COUNT(*) as c FROM git_objects").get() as { c: number };
	const objSize = db.query("SELECT SUM(LENGTH(content)) as s FROM git_objects").get() as {
		s: number;
	};
	const refCount = db.query("SELECT COUNT(*) as c FROM git_refs").get() as { c: number };
	const repoCount = db.query("SELECT COUNT(DISTINCT repo_id) as c FROM git_objects").get() as {
		c: number;
	};

	console.log(`  Repos:           ${repoCount.c}`);
	console.log(`  Objects:         ${objCount.c}`);
	console.log(`  Object data:     ${(objSize.s / 1024 / 1024).toFixed(1)} MB`);
	console.log(`  Refs:            ${refCount.c}`);

	const perRepo = db
		.query(
			"SELECT repo_id, COUNT(*) as c, SUM(LENGTH(content)) as s FROM git_objects GROUP BY repo_id",
		)
		.all() as Array<{ repo_id: string; c: number; s: number }>;
	for (const r of perRepo) {
		console.log(`    ${r.repo_id}: ${r.c} objects, ${(r.s / 1024 / 1024).toFixed(1)} MB`);
	}

	const typeBreakdown = db
		.query(
			"SELECT type, COUNT(*) as c, SUM(LENGTH(content)) as s FROM git_objects WHERE repo_id = 'stress-repo' GROUP BY type ORDER BY s DESC",
		)
		.all() as Array<{ type: string; c: number; s: number }>;
	console.log(`\n  Object breakdown (stress-repo):`);
	for (const t of typeBreakdown) {
		console.log(
			`    ${t.type.padEnd(8)} ${String(t.c).padStart(6)} objects  ${(t.s / 1024 / 1024).toFixed(1).padStart(8)} MB`,
		);
	}

	if (DB_PATH !== ":memory:") {
		const dbStat = statSync(DB_PATH);
		console.log(`\n  DB file size:    ${(dbStat.size / 1024 / 1024).toFixed(1)} MB`);
	}

	// ── Summary ──────────────────────────────────────────────────────

	console.log("\n════════════════════════════════════════════════════════════");
	console.log("  SUMMARY");
	console.log("════════════════════════════════════════════════════════════\n");

	const maxLabel = Math.max(...results.map((r) => r.label.length));
	for (const r of results) {
		const detailStr = r.detail ? `  ${r.detail}` : "";
		console.log(`  ${r.label.padEnd(maxLabel + 2)} ${fmt(r.ms).padStart(10)}${detailStr}`);
	}

	const totalMs = results.reduce((s, r) => s + r.ms, 0);
	console.log(`\n  ${"TOTAL".padEnd(maxLabel + 2)} ${fmt(totalMs).padStart(10)}`);
	console.log();
} finally {
	srv.stop(true);
	try {
		rmSync(tmpBase, { recursive: true, force: true });
	} catch {
		console.log(`  (could not clean up ${tmpBase})`);
	}
}
