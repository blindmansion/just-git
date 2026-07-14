import { generateTraces, parseSeeds, PRESETS } from "../generate";
import { dbPath, ensureDbDir, parseArgs } from "./shared/args";
import { warnIfGitVersionMismatch } from "./shared/git-version";

export async function cmdGenerate(args: string[]): Promise<void> {
	const { positional, getOpt } = parseArgs(args);

	const seedsArg = getOpt("--seeds");
	const stepsArg = getOpt("--steps");
	const chaosArg = getOpt("--chaos");
	const cloneUrl = getOpt("--clone-url");
	const description = getOpt("--description");
	// First positional = dataset path. If it matches a known preset, use it as
	// both the dataset path and preset (unless --preset explicitly overrides).
	const dbName = positional[0] ?? getOpt("--db") ?? "default";
	const presetName =
		getOpt("--preset") ?? (positional[0] && positional[0] in PRESETS ? positional[0] : "default");
	const db = dbPath(dbName);

	if (!seedsArg) {
		console.log(`Usage: bun oracle generate [path] --seeds <spec> [options]

  First argument is the dataset path (default: preset name).
  Stored at: data/<path>/traces.sqlite

Options:
  --seeds <spec>      Seed specification: "1-10" or "1,2,42" (required)
  --steps <n>         Steps per seed (default: 300)
  --preset <name>     Action preset (default: "default")
                      Available: ${Object.keys(PRESETS).join(", ")}
  --chaos <rate>      Probability (0-1) of bypassing soft preconditions per step
                      Overrides preset's chaosRate if set
  --clone-url <url>   Clone from this URL instead of git init (requires network)
  --description <s>   Metadata tag for traces

Examples:
  generate basic --seeds 1-20
  generate experiments/core --preset core --seeds 1-20
  generate --preset rebase-heavy --seeds 1-20 --steps 300
  generate chaos --seeds 1-10
  generate my-experiment --preset merge-heavy --seeds 1-5 --chaos 0.15
  generate clone-test --seeds 1-5 --steps 50 --clone-url https://github.com/DeabLabs/cannoli.git`);
		process.exit(1);
	}

	const seeds = parseSeeds(seedsArg);
	const steps = parseInt(stepsArg ?? "300", 10);
	const preset = PRESETS[presetName];

	if (!preset) {
		console.error(`Unknown preset "${presetName}". Available: ${Object.keys(PRESETS).join(", ")}`);
		process.exit(1);
	}

	const chaosRate = chaosArg ? parseFloat(chaosArg) : (preset.chaosRate ?? 0);
	const effectiveCloneUrl = cloneUrl ?? preset.cloneUrl;

	ensureDbDir(db);
	await warnIfGitVersionMismatch();

	const chaosDesc = chaosRate > 0 ? `, chaos=${chaosRate}` : "";
	const cloneDesc = effectiveCloneUrl ? `, clone=${effectiveCloneUrl}` : "";
	console.log(
		`Generating: ${seeds.length} seeds x ${steps} steps (${presetName}${chaosDesc}${cloneDesc})`,
	);
	console.log(`Output: ${db}\n`);

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
		description,
		cloneUrl: effectiveCloneUrl,
		withRemote: preset.withRemote,
	});
}
