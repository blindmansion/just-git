import { replayAndCheck } from "../impl-harness";
import { runPostMortem } from "../post-mortem";
import { dbPath, ensureDbDir, parseArgs } from "./shared/args";
import { color, fmt, truncateCommand } from "./shared/format";
import { Database } from "bun:sqlite";
import { warnIfGitVersionMismatch } from "./shared/git-version";
import { generateTraces, parseSeeds, PRESETS } from "../generate";

export async function cmdValidate(args: string[]): Promise<void> {
	const { getOpt, hasFlag } = parseArgs(args);
	const seedsArg = getOpt("--seeds") ?? "1-5";
	const stepsArg = getOpt("--steps") ?? "300";
	const verbose = hasFlag("--verbose") || hasFlag("-v");

	if (hasFlag("--help") || hasFlag("-h")) {
		console.log(`Usage: bun oracle validate [options]

Generate and test a representative set of oracle traces in one step.
Runs the core and kitchen presets with a small seed count for quick validation.

Options:
  --seeds <spec>   Seed specification (default: "1-5")
  --steps <n>      Steps per seed (default: 300)
  -v, --verbose    Show per-step output during testing

Examples:
  validate                    # 5 seeds × 300 steps, core + kitchen
  validate --seeds 1-10       # more seeds for deeper coverage
  validate --seeds 1-3 -v     # fewer seeds, verbose output`);
		process.exit(0);
	}

	await warnIfGitVersionMismatch();

	const seeds = parseSeeds(seedsArg);
	const steps = parseInt(stepsArg, 10);
	const presetNames = ["core", "kitchen"] as const;

	console.log(
		`Validating: ${seeds.length} seeds × ${steps} steps × ${presetNames.length} presets\n`,
	);

	let anyFailed = false;

	for (const presetName of presetNames) {
		const preset = PRESETS[presetName];
		const db = dbPath(`validate/${presetName}`);
		ensureDbDir(db);

		console.log(`── ${presetName} ${"─".repeat(Math.max(0, 55 - presetName.length))}`);
		console.log("");

		const chaosRate = preset.chaosRate ?? 0;
		const chaosDesc = chaosRate > 0 ? `, chaos=${chaosRate}` : "";
		console.log(
			`  Generating ${seeds.length} traces × ${steps} steps (${presetName}${chaosDesc})...`,
		);

		await generateTraces({
			dbPath: db,
			seeds,
			steps,
			actions: preset.actions,
			chaosRate,
			worktreeRate: preset.worktreeRate,
			maxWorktrees: preset.maxWorktrees,
			worktreeStickiness: preset.worktreeStickiness,
			fuzz: preset.fuzz,
			fileGen: preset.fileGen,
			description: `validate: ${presetName}`,
			withRemote: preset.withRemote,
		});

		console.log("  Testing...\n");

		const conn = new Database(db, { readonly: true });
		const rows = conn.prepare("SELECT trace_id FROM traces ORDER BY trace_id").all() as {
			trace_id: number;
		}[];
		conn.close();
		const traceIds = rows.map((r) => r.trace_id);

		let passCount = 0;
		let warnCount = 0;
		let knownCount = 0;
		let failCount = 0;

		for (const traceId of traceIds) {
			const result = await replayAndCheck(db, traceId, { verbose });

			if (!result.firstDivergence && !result.firstWarning) {
				passCount++;
				if (verbose) {
					console.log(`  ${color.green("PASS")}   trace ${traceId}   ${result.totalSteps} steps`);
				}
			} else if (!result.firstDivergence && result.firstWarning) {
				warnCount++;
				const w = result.firstWarning;
				console.log(
					`  ${color.yellow("WARN")}   trace ${traceId}   ${result.totalSteps} steps  ${color.dim(`(step ${w.seq})`)}`,
				);
			} else if (result.firstDivergence) {
				const d = result.firstDivergence;
				let postMortemResult: Awaited<ReturnType<typeof runPostMortem>> | null = null;
				try {
					postMortemResult = await runPostMortem(db, traceId, d.seq, d.command, d.divergences);
				} catch {
					postMortemResult = null;
				}

				const isKnown = postMortemResult !== null && postMortemResult.pattern !== "unknown";
				if (isKnown && postMortemResult) {
					knownCount++;
					console.log(
						`  ${color.cyan("KNOWN")}  trace ${traceId}   step ${d.seq}/${result.totalSteps}  ${color.dim(postMortemResult.pattern)}`,
					);
				} else {
					failCount++;
					anyFailed = true;
					const cmd = truncateCommand(d.command, 50);
					const firstErr = d.divergences.find((x) => x.severity === "error");
					console.log(
						`  ${color.red("FAIL")}   trace ${traceId}   step ${d.seq}/${result.totalSteps}  ${cmd}`,
					);
					if (firstErr) {
						console.log(
							`         ${firstErr.field}: expected=${fmt(firstErr.expected)} actual=${fmt(firstErr.actual)}`,
						);
					}
				}
			}
		}

		const parts: string[] = [];
		parts.push(`${passCount} passed`);
		if (warnCount > 0) parts.push(color.yellow(`${warnCount} warned`));
		if (knownCount > 0) parts.push(color.cyan(`${knownCount} known`));
		if (failCount > 0) parts.push(color.red(`${failCount} failed`));
		console.log(`\n  ${parts.join(", ")}  (${traceIds.length} traces)\n`);
	}

	if (anyFailed) {
		console.log(color.red("Validation failed."));
		process.exit(1);
	} else {
		console.log(color.green("Validation passed."));
	}
}
