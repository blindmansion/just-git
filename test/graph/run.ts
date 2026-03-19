/**
 * Graph comparison runner — compares virtual git output against real git.
 *
 * Usage:
 *   bun test/graph/run.ts                     — run all scenarios
 *   bun test/graph/run.ts <name>              — run matching scenario(s)
 *   bun test/graph/run.ts --list              — list available scenarios
 *
 * With deterministic timestamps and TZ=UTC, output should be byte-identical.
 */

import { join } from "node:path";
import type { GraphScenario } from "./types";
import { buildVirtual, buildReal, printComparison } from "./harness";

const args = process.argv.slice(2);

async function loadScenarios(): Promise<{ name: string; scenario: GraphScenario }[]> {
	const glob = new Bun.Glob("*.ts");
	const dir = join(import.meta.dir, "scenarios");
	const entries: { name: string; scenario: GraphScenario }[] = [];
	for await (const file of glob.scan(dir)) {
		const name = file.replace(/\.ts$/, "");
		const mod = await import(join(dir, file));
		entries.push({ name, scenario: mod.default as GraphScenario });
	}
	entries.sort((a, b) => a.name.localeCompare(b.name));
	return entries;
}

if (args.includes("--list")) {
	const all = await loadScenarios();
	console.log("Available scenarios:");
	for (const { name, scenario } of all) {
		console.log(`  ${name} — ${scenario.description ?? "(no description)"}`);
	}
	process.exit(0);
}

const filter = args[0];
const all = await loadScenarios();
const scenarios = filter ? all.filter((s) => s.name === filter || s.name.startsWith(filter)) : all;

if (scenarios.length === 0) {
	console.error(`No scenario found matching: ${filter}`);
	console.error("Available:", all.map((s) => s.name).join(", "));
	process.exit(1);
}

let totalPass = 0;
let totalFail = 0;

for (const { name, scenario } of scenarios) {
	console.log(`\n${"═".repeat(60)}`);
	console.log(`  ${name}: ${scenario.description ?? ""}`);
	console.log(`${"═".repeat(60)}`);

	const virtualResults = await buildVirtual(scenario);
	const realResults = buildReal(scenario);

	const logCommands = scenario.logCommands ?? ["git log --graph --all --oneline"];

	for (const cmd of logCommands) {
		const vr = virtualResults.get(cmd);
		const rr = realResults.get(cmd);

		if (!vr || !rr) {
			console.log(`  SKIP ${cmd} (missing result)`);
			continue;
		}

		const vOut = vr.stdout;
		const rOut = rr.stdout;

		if (vr.exitCode === rr.exitCode && vOut === rOut) {
			console.log(`  PASS ${cmd}`);
			totalPass++;
		} else {
			console.log(`  FAIL ${cmd}`);
			totalFail++;

			if (vr.exitCode !== rr.exitCode) {
				console.log(`    exit: virtual=${vr.exitCode} real=${rr.exitCode}`);
			}
			if (vr.stderr !== rr.stderr && (vr.exitCode !== 0 || rr.exitCode !== 0)) {
				console.log(`    stderr virtual: ${vr.stderr.trimEnd()}`);
				console.log(`    stderr real:    ${rr.stderr.trimEnd()}`);
			}
			if (vOut !== rOut) {
				const vLines = vOut.replace(/\n$/, "").split("\n");
				const rLines = rOut.replace(/\n$/, "").split("\n");
				printComparison(vLines, rLines);
			}
		}
	}
}

console.log(`\n${"─".repeat(60)}`);
console.log(`Results: ${totalPass} pass, ${totalFail} fail`);
process.exit(totalFail > 0 ? 1 : 0);
