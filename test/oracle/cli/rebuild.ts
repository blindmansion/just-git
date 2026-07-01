import { replayTo } from "../runner";
import { dbPath, parseArgs } from "./shared/args";
import { dirname } from "node:path";

export async function cmdRebuild(args: string[]): Promise<void> {
	const { positional, getOpt } = parseArgs(args);

	// Positional: <name> <trace> <step>
	const dbName = positional[0] ?? getOpt("--db");
	const traceArg = positional[1] ?? getOpt("--trace");
	const stepArg = positional[2] ?? getOpt("--step");

	if (!dbName || !traceArg || !stepArg) {
		console.log(`Usage: bun oracle rebuild <name> <trace> <step>

Replays a trace up to the given step using real git,
leaving a directory you can cd into and inspect.

Examples:
  rebuild basic 5 42
  rebuild rebase-heavy 1 86`);
		process.exit(1);
	}

	const db = dbPath(dbName);
	const traceId = parseInt(traceArg, 10);
	const step = parseInt(stepArg, 10);

	console.log(`Rebuilding trace ${traceId} at step ${step}...`);
	const repoDir = await replayTo(db, traceId, step);

	console.log(`\nReal git repo at: ${repoDir}\n`);
	console.log("Inspect with:");
	console.log(`  cd ${repoDir}`);
	console.log("  git log --oneline --all --graph");
	console.log("  git status");
	console.log("  git diff");
	console.log(`\nCleanup: rm -rf ${dirname(repoDir)}`);
}
