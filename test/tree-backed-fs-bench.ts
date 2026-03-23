#!/usr/bin/env bun
/**
 * Benchmark: TreeBackedFs vs MemoryFileSystem across a range of tree sizes.
 *
 * Measures construction, sequential readFile, random readFile, readdir,
 * stat, exists, and writeFile+readFile (overlay) performance.
 *
 * Usage:
 *   bun test/tree-backed-fs-bench.ts
 *   bun test/tree-backed-fs-bench.ts --sizes 100,1000,10000
 *   bun test/tree-backed-fs-bench.ts --ops 5000
 */

import { MemoryFileSystem } from "../src/memory-fs";
import { MemoryStorage } from "../src/server/memory-storage";
import { createStorageAdapter } from "../src/server/storage";
import { writeBlob, writeTree } from "../src/repo/helpers";
import { TreeBackedFs } from "../src/tree-backed-fs";
import type { TreeEntryInput } from "../src/repo/helpers";
import type { GitRepo } from "../src/lib/types";

// ── Config ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function argVal(flag: string): string | undefined {
	const i = args.indexOf(flag);
	return i !== -1 ? args[i + 1] : undefined;
}

const SIZES = (argVal("--sizes") ?? "10,100,500,1000,5000,10000").split(",").map(Number);
const OPS = Number(argVal("--ops") ?? "2000");
const WARMUP = 50;
const DIR_DEPTH = 3;

// ── Tree builder ────────────────────────────────────────────────────

interface TreeFixture {
	repo: GitRepo;
	rootTreeHash: string;
	paths: string[]; // absolute paths (e.g. "/src/a/file_42.ts")
	files: Record<string, string>;
}

function generateContent(i: number): string {
	const lines: string[] = [];
	const lineCount = 5 + (i % 20);
	for (let l = 0; l < lineCount; l++) {
		lines.push(`line ${l}: content for file ${i} — ${"x".repeat(20 + ((i * 7 + l) % 60))}`);
	}
	return lines.join("\n");
}

const DIR_PREFIXES = [
	"src",
	"lib",
	"test",
	"pkg",
	"internal",
	"cmd",
	"api",
	"util",
	"core",
	"common",
	"model",
	"service",
	"handler",
	"middleware",
	"config",
	"proto",
];

function filePath(i: number, totalFiles: number): string {
	if (totalFiles <= 20) return `file_${i}.ts`;
	const dirIdx = i % DIR_PREFIXES.length;
	const subDir = Math.floor(i / DIR_PREFIXES.length) % DIR_DEPTH;
	const parts = [DIR_PREFIXES[dirIdx]];
	for (let d = 0; d < subDir; d++) parts.push(`sub${d}`);
	parts.push(`file_${i}.ts`);
	return parts.join("/");
}

async function buildFixture(size: number): Promise<TreeFixture> {
	const storage = createStorageAdapter(new MemoryStorage());
	const repo = await storage.createRepo(`bench-${size}`);
	const files: Record<string, string> = {};
	const paths: string[] = [];

	// Group files by directory for nested tree construction
	const dirMap = new Map<string, TreeEntryInput[]>();
	dirMap.set("", []); // root always exists

	for (let i = 0; i < size; i++) {
		const relPath = filePath(i, size);
		const content = generateContent(i);
		const blobHash = await writeBlob(repo, content);
		const absPath = `/${relPath}`;
		files[absPath] = content;
		paths.push(absPath);

		const lastSlash = relPath.lastIndexOf("/");
		const dir = lastSlash === -1 ? "" : relPath.slice(0, lastSlash);
		const name = lastSlash === -1 ? relPath : relPath.slice(lastSlash + 1);

		if (!dirMap.has(dir)) dirMap.set(dir, []);
		dirMap.get(dir)!.push({ name, hash: blobHash, mode: "100644" });

		// Ensure all ancestor directories exist in the map
		const segments = dir.split("/");
		for (let d = 1; d < segments.length; d++) {
			const ancestor = segments.slice(0, d).join("/");
			if (!dirMap.has(ancestor)) dirMap.set(ancestor, []);
		}
	}

	// Build trees bottom-up: deepest directories first
	const dirs = [...dirMap.keys()].sort((a, b) => {
		const da = a === "" ? 0 : a.split("/").length;
		const db = b === "" ? 0 : b.split("/").length;
		return db - da; // deepest first
	});

	const treeHashes = new Map<string, string>();

	for (const dir of dirs) {
		const entries = dirMap.get(dir)!;

		// Add any child directory tree entries
		for (const [childDir, childHash] of treeHashes) {
			const parentOfChild =
				childDir.lastIndexOf("/") === -1 ? "" : childDir.slice(0, childDir.lastIndexOf("/"));
			if (parentOfChild === dir) {
				const childName = childDir.slice(childDir.lastIndexOf("/") + 1);
				if (!entries.some((e) => e.name === childName)) {
					entries.push({ name: childName, hash: childHash, mode: "040000" });
				}
			}
		}

		const treeHash = await writeTree(repo, entries);
		treeHashes.set(dir, treeHash);
	}

	const rootTreeHash = treeHashes.get("")!;
	return { repo, rootTreeHash, paths, files };
}

// ── Benchmark helpers ───────────────────────────────────────────────

function pickRandom<T>(arr: T[], seed: number): T {
	return arr[((seed * 2654435761) >>> 0) % arr.length];
}

async function timeIt(label: string, fn: () => Promise<void>): Promise<number> {
	// Warmup
	for (let i = 0; i < WARMUP; i++) await fn();

	const t0 = performance.now();
	await fn();
	return performance.now() - t0;
}

interface BenchResult {
	label: string;
	memMs: number;
	treeMs: number;
	ops: number;
}

// ── Benchmarks ──────────────────────────────────────────────────────

async function benchSequentialRead(
	memFs: MemoryFileSystem,
	treeFs: TreeBackedFs,
	paths: string[],
	ops: number,
): Promise<BenchResult> {
	const count = Math.min(ops, paths.length);
	const subset = paths.slice(0, count);

	const memMs = await timeIt("mem-seq-read", async () => {
		for (const p of subset) await memFs.readFile(p);
	});

	// Fresh TreeBackedFs each time to measure cold reads
	const treeMs = await timeIt("tree-seq-read", async () => {
		for (const p of subset) await treeFs.readFile(p);
	});

	return { label: "sequential readFile", memMs, treeMs, ops: count };
}

async function benchRandomRead(
	memFs: MemoryFileSystem,
	treeFs: TreeBackedFs,
	paths: string[],
	ops: number,
): Promise<BenchResult> {
	const picks = Array.from({ length: ops }, (_, i) => pickRandom(paths, i));

	const memMs = await timeIt("mem-rnd-read", async () => {
		for (const p of picks) await memFs.readFile(p);
	});

	const treeMs = await timeIt("tree-rnd-read", async () => {
		for (const p of picks) await treeFs.readFile(p);
	});

	return { label: "random readFile", memMs, treeMs, ops };
}

async function benchReaddir(
	memFs: MemoryFileSystem,
	treeFs: TreeBackedFs,
	_paths: string[],
	ops: number,
): Promise<BenchResult> {
	const dirs = ["/"];
	for (const prefix of DIR_PREFIXES) dirs.push(`/${prefix}`);
	const picks = Array.from({ length: ops }, (_, i) => pickRandom(dirs, i));

	const memMs = await timeIt("mem-readdir", async () => {
		for (const d of picks) {
			try {
				await memFs.readdir(d);
			} catch {}
		}
	});

	const treeMs = await timeIt("tree-readdir", async () => {
		for (const d of picks) {
			try {
				await treeFs.readdir(d);
			} catch {}
		}
	});

	return { label: "readdir", memMs, treeMs, ops };
}

async function benchStat(
	memFs: MemoryFileSystem,
	treeFs: TreeBackedFs,
	paths: string[],
	ops: number,
): Promise<BenchResult> {
	const picks = Array.from({ length: ops }, (_, i) => pickRandom(paths, i));

	const memMs = await timeIt("mem-stat", async () => {
		for (const p of picks) await memFs.stat(p);
	});

	const treeMs = await timeIt("tree-stat", async () => {
		for (const p of picks) await treeFs.stat(p);
	});

	return { label: "stat", memMs, treeMs, ops };
}

async function benchExists(
	memFs: MemoryFileSystem,
	treeFs: TreeBackedFs,
	paths: string[],
	ops: number,
): Promise<BenchResult> {
	// Mix of existing paths and non-existing paths
	const picks = Array.from({ length: ops }, (_, i) =>
		i % 3 === 0 ? `/nonexistent/file_${i}.ts` : pickRandom(paths, i),
	);

	const memMs = await timeIt("mem-exists", async () => {
		for (const p of picks) await memFs.exists(p);
	});

	const treeMs = await timeIt("tree-exists", async () => {
		for (const p of picks) await treeFs.exists(p);
	});

	return { label: "exists (mixed)", memMs, treeMs, ops };
}

async function benchOverlayWrite(
	memFs: MemoryFileSystem,
	treeFs: TreeBackedFs,
	_paths: string[],
	ops: number,
): Promise<BenchResult> {
	const content = "overlay write benchmark content\n".repeat(10);

	const memMs = await timeIt("mem-write", async () => {
		for (let i = 0; i < ops; i++) {
			const p = `/overlay/bench_${i}.txt`;
			await memFs.writeFile(p, content);
			await memFs.readFile(p);
		}
	});

	const treeMs = await timeIt("tree-write", async () => {
		for (let i = 0; i < ops; i++) {
			const p = `/overlay/bench_${i}.txt`;
			await treeFs.writeFile(p, content);
			await treeFs.readFile(p);
		}
	});

	return { label: "write + read (overlay)", memMs, treeMs, ops };
}

async function benchColdConstruction(
	fixture: TreeFixture,
	files: Record<string, string>,
	paths: string[],
): Promise<BenchResult> {
	const ops = 20;

	const memMs = await timeIt("mem-construct", async () => {
		for (let i = 0; i < ops; i++) {
			const fs = new MemoryFileSystem(files);
			await fs.readFile(paths[0]);
		}
	});

	const treeMs = await timeIt("tree-construct", async () => {
		for (let i = 0; i < ops; i++) {
			const fs = new TreeBackedFs(fixture.repo.objectStore, fixture.rootTreeHash, "/");
			await fs.readFile(paths[0]);
		}
	});

	return { label: "construct + 1 read", memMs, treeMs, ops };
}

// ── Runner ──────────────────────────────────────────────────────────

function fmt(ms: number): string {
	if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`.padStart(8);
	return `${ms.toFixed(2)}ms`.padStart(8);
}

function ratio(memMs: number, treeMs: number): string {
	if (memMs === 0 && treeMs === 0) return "   1.0x";
	if (memMs === 0) return "    ∞x";
	const r = treeMs / memMs;
	const s = r < 1 ? `${r.toFixed(2)}x` : `${r.toFixed(1)}x`;
	return s.padStart(7);
}

async function runForSize(size: number) {
	process.stdout.write(`\nBuilding fixture with ${size} files...`);
	const fixture = await buildFixture(size);
	console.log(" done.");

	const memFs = new MemoryFileSystem(fixture.files);
	const treeFs = new TreeBackedFs(fixture.repo.objectStore, fixture.rootTreeHash, "/");

	const ops = Math.min(OPS, size * 2);

	const results: BenchResult[] = [];
	results.push(await benchColdConstruction(fixture, fixture.files, fixture.paths));
	results.push(await benchSequentialRead(memFs, treeFs, fixture.paths, ops));
	results.push(await benchRandomRead(memFs, treeFs, fixture.paths, ops));
	results.push(await benchReaddir(memFs, treeFs, fixture.paths, ops));
	results.push(await benchStat(memFs, treeFs, fixture.paths, ops));
	results.push(await benchExists(memFs, treeFs, fixture.paths, ops));
	results.push(await benchOverlayWrite(memFs, treeFs, fixture.paths, Math.min(ops, 1000)));

	const header = `${"benchmark".padEnd(26)} ${"MemFS".padStart(8)} ${"TreeFS".padStart(8)} ${"ratio".padStart(7)} ${"ops".padStart(6)}`;
	console.log(`\n  ── ${size} files ──`);
	console.log(`  ${header}`);
	console.log(`  ${"─".repeat(header.length)}`);
	for (const r of results) {
		const opStr = String(r.ops).padStart(6);
		console.log(
			`  ${r.label.padEnd(26)} ${fmt(r.memMs)} ${fmt(r.treeMs)} ${ratio(r.memMs, r.treeMs)} ${opStr}`,
		);
	}
}

// ── Main ────────────────────────────────────────────────────────────

console.log("TreeBackedFs vs MemoryFileSystem benchmark");
console.log(`Ops per bench: ${OPS} (capped to 2× tree size), warmup: ${WARMUP} iterations\n`);

for (const size of SIZES) {
	await runForSize(size);
}

console.log("\nratio = TreeFS / MemFS (lower is better for TreeFS)");
