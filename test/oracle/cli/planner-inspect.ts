import { runPlannerInspect } from "../planner-inspect";
import { parseArgs } from "./shared/args";

export async function cmdPlannerInspect(args: string[]): Promise<void> {
	const { positional, getOpt } = parseArgs(args);
	const dbName = positional[0] ?? getOpt("--db");
	const traceArg = positional[1] ?? getOpt("--trace");
	const stepArg = positional[2] ?? getOpt("--step");

	if (!dbName || !traceArg || !stepArg) {
		console.log(`Usage: bun oracle planner-inspect <name> <trace> <step>

Compares planner output against real git rev-list at the state BEFORE <step>.
The specified step should be a rebase command.

Examples:
  planner-inspect rebase-heavy 5 42
  planner-inspect rebase-2 74 424`);
		process.exit(1);
	}

	const traceId = parseInt(traceArg, 10);
	const step = parseInt(stepArg, 10);

	await runPlannerInspect(dbName, traceId, step);
}
