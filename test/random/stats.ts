#!/usr/bin/env bun
/**
 * Gather statistics about the virtual filesystem state after random walks.
 * Shows file sizes, object counts, tree depth, etc.
 *
 * Usage:  bun test/random/stats.ts [seed] [steps]
 */

import { VirtualHarness } from "./harness";
import { runWalk } from "./walker";

// ── Stats gathering ──────────────────────────────────────────────────

async function gatherStats(harness: VirtualHarness) {
	const fs = harness.bash.fs;
	const root = "/repo";

	// Working tree files
	const workFiles = await harness.listWorkTreeFiles();
	const fileSizes: number[] = [];
	const lineCounts: number[] = [];
	for (const f of workFiles) {
		const content = await fs.readFile(`${root}/${f}`);
		fileSizes.push(content.length);
		lineCounts.push(content.split("\n").length);
	}

	// .git/objects — count loose objects and total size
	let objectCount = 0;
	let objectTotalBytes = 0;
	const objectsDir = `${root}/.git/objects`;
	if (await fs.exists(objectsDir)) {
		for (const fanout of await fs.readdir(objectsDir)) {
			if (fanout === "pack" || fanout === "info") continue;
			const fanoutDir = `${objectsDir}/${fanout}`;
			const stat = await fs.lstat(fanoutDir);
			if (!stat.isDirectory) continue;
			for (const obj of await fs.readdir(fanoutDir)) {
				objectCount++;
				const data = await fs.readFileBuffer(`${fanoutDir}/${obj}`);
				objectTotalBytes += data.byteLength;
			}
		}
	}

	// Index size
	let indexBytes = 0;
	const indexPath = `${root}/.git/index`;
	if (await fs.exists(indexPath)) {
		const data = await fs.readFileBuffer(indexPath);
		indexBytes = data.byteLength;
	}

	// Branches
	const branches = await harness.listBranches();

	return {
		workFiles: workFiles.length,
		fileSizes,
		lineCounts,
		objectCount,
		objectTotalBytes,
		indexBytes,
		branches: branches.length,
		branchNames: branches,
	};
}

// ── Run walk and report ──────────────────────────────────────────────

async function run(seed: number, steps: number) {
	const harness = new VirtualHarness();

	// Track action counts
	const actionCounts = new Map<string, number>();
	let gitOps = 0;
	let merges = 0;
	let conflicts = 0;
	let maxFiles = 0;
	let maxBranches = 0;

	const log = await runWalk(
		harness,
		{ seed, steps },
		{
			async onGitStep(event) {
				gitOps++;
				if (event.action === "merge" && event.result?.exitCode === 1) conflicts++;
				if (event.action === "merge") merges++;
			},
			assertEvery: 1,
			async onCheckpoint() {
				// Track peak file/branch counts at each step
				const files = await harness.listWorkTreeFiles();
				const branches = await harness.listBranches();
				maxFiles = Math.max(maxFiles, files.length);
				maxBranches = Math.max(maxBranches, branches.length);
			},
		},
	);

	// Count actions from the log
	for (const event of log) {
		actionCounts.set(event.action, (actionCounts.get(event.action) ?? 0) + 1);
	}

	// Gather final state
	const stats = await gatherStats(harness);

	console.log(`\n── Seed ${seed}, ${steps} steps ──\n`);

	console.log("Action distribution:");
	const sorted = [...actionCounts.entries()].sort((a, b) => b[1] - a[1]);
	for (const [name, count] of sorted) {
		console.log(`  ${name.padEnd(20)} ${String(count).padStart(4)}`);
	}

	console.log(`\nGit operations:      ${gitOps}`);
	console.log(`Merges attempted:    ${merges}`);
	console.log(`Merge conflicts:     ${conflicts}`);

	console.log(`\nWorking tree files:  ${stats.workFiles} (peak: ${maxFiles})`);
	console.log(`Branches:            ${stats.branches} (peak: ${maxBranches})`);
	console.log(`Branch names:        ${stats.branchNames.join(", ")}`);

	if (stats.fileSizes.length > 0) {
		const sizes = stats.fileSizes.sort((a, b) => a - b);
		const lines = stats.lineCounts.sort((a, b) => a - b);
		const sum = (a: number[]) => a.reduce((s, v) => s + v, 0);
		const median = (a: number[]) => a[Math.floor(a.length / 2)];
		console.log(
			`\nFile sizes (bytes):  min=${sizes[0]}, median=${median(sizes)}, max=${sizes[sizes.length - 1]}, total=${sum(sizes)}`,
		);
		console.log(
			`Line counts:         min=${lines[0]}, median=${median(lines)}, max=${lines[lines.length - 1]}, avg=${(sum(lines) / lines.length).toFixed(1)}`,
		);
	}

	console.log(
		`\nObject store:        ${stats.objectCount} objects, ${(stats.objectTotalBytes / 1024).toFixed(1)} KB`,
	);
	console.log(`Index size:          ${stats.indexBytes} bytes`);
	console.log(
		`Avg object size:     ${stats.objectCount > 0 ? (stats.objectTotalBytes / stats.objectCount).toFixed(0) : 0} bytes`,
	);
}

const seed = Number(process.argv[2]) || 777;
const steps = Number(process.argv[3]) || 1000;
await run(seed, steps);
