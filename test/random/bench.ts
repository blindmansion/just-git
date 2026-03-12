#!/usr/bin/env bun
/**
 * Benchmark: run randomly-generated command sequences against just
 * the virtual bash instance (no real git, no FS I/O, no comparisons).
 *
 * Usage:
 *   bun test/random/bench.ts [seed] [steps]
 *   bun test/random/bench.ts              # defaults: seed 777, 1000 steps
 *   bun test/random/bench.ts 42 500
 *   bun test/random/bench.ts --suite       # run the full oracle suite config
 */

import { VirtualHarness } from "./harness";
import { runWalk } from "./walker";

// ── Single walk benchmark ────────────────────────────────────────────

async function benchWalk(
	seed: number,
	steps: number,
): Promise<{ elapsed: number; gitOps: number }> {
	const harness = new VirtualHarness();
	let gitOps = 0;

	const t0 = performance.now();

	await runWalk(
		harness,
		{ seed, steps },
		{
			async onGitStep() {
				gitOps++;
			},
		},
	);

	const elapsed = performance.now() - t0;
	return { elapsed, gitOps };
}

// ── Main ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes("--suite")) {
	// Run the same configuration as the full oracle test suite
	console.log("Benchmarking the full oracle test suite configuration");
	console.log("(virtual bash only — no real git, no comparisons)\n");

	const configs: { label: string; seed: number; steps: number }[] = [
		// Core regression seeds
		...[1, 2, 3, 4, 5, 7, 37, 43, 99].map((s) => ({
			label: `core   seed ${String(s).padStart(4)}`,
			seed: s,
			steps: 200,
		})),
		{ label: "core   seed   42", seed: 42, steps: 500 },
		// Broad sweep
		...[
			10, 11, 13, 17, 19, 23, 29, 31, 47, 53, 59, 61, 67, 71, 73, 79, 83, 89, 97, 101, 103, 107,
			109, 113, 127, 131, 137, 139, 149, 151,
		].map((s) => ({
			label: `broad  seed ${String(s).padStart(4)}`,
			seed: s,
			steps: 300,
		})),
		// Deep walks
		...[200, 314, 500, 777, 1337, 9999].map((s) => ({
			label: `deep   seed ${String(s).padStart(4)}`,
			seed: s,
			steps: 1000,
		})),
	];

	let totalElapsed = 0;
	let totalGitOps = 0;
	let totalSteps = 0;

	for (const { label, seed, steps } of configs) {
		const { elapsed, gitOps } = await benchWalk(seed, steps);
		totalElapsed += elapsed;
		totalGitOps += gitOps;
		totalSteps += steps;
		const ms = elapsed.toFixed(0).padStart(6);
		const opsRate = ((gitOps / elapsed) * 1000).toFixed(0);
		console.log(
			`  ${label}  ${String(steps).padStart(4)} steps  ${ms}ms  (${gitOps} git ops, ${opsRate} ops/s)`,
		);
	}

	console.log(
		`\n  ${"TOTAL".padEnd(20)} ${String(totalSteps).padStart(4)} steps  ${totalElapsed.toFixed(0).padStart(6)}ms  (${totalGitOps} git ops, ${((totalGitOps / totalElapsed) * 1000).toFixed(0)} ops/s)`,
	);
} else {
	const seed = Number(args[0]) || 777;
	const steps = Number(args[1]) || 1000;

	console.log(`Benchmarking seed ${seed}, ${steps} steps (virtual bash only)\n`);

	const { elapsed, gitOps } = await benchWalk(seed, steps);

	const opsRate = ((gitOps / elapsed) * 1000).toFixed(0);
	const stepsRate = ((steps / elapsed) * 1000).toFixed(0);
	console.log(`  Time:       ${elapsed.toFixed(1)}ms`);
	console.log(`  Steps:      ${steps} (${stepsRate} steps/s)`);
	console.log(`  Git ops:    ${gitOps} (${opsRate} ops/s)`);
	console.log(`  Avg/step:   ${(elapsed / steps).toFixed(2)}ms`);
	console.log(`  Avg/git-op: ${(elapsed / gitOps).toFixed(2)}ms`);
}
