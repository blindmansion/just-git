import { dbPath, parseArgs } from "./shared/args";
import { Database } from "bun:sqlite";
import { truncateCommand } from "./shared/format";

export async function cmdTraceContext(args: string[]): Promise<void> {
	const { positional, getOpt } = parseArgs(args);
	const dbName = positional[0] ?? getOpt("--db");
	const traceArg = positional[1] ?? getOpt("--trace");
	const stepArg = positional[2] ?? getOpt("--step");
	const beforeArg = getOpt("--before");

	if (!dbName || !traceArg || !stepArg) {
		console.log(`Usage: bun oracle trace-context <path> <trace> <step> [--before N]

Print preceding commands leading up to a step.

Examples:
  trace-context basic 5 42
  trace-context basic 5 42 --before 20`);
		process.exit(1);
	}

	const db = dbPath(dbName);
	const traceId = parseInt(traceArg, 10);
	const seq = parseInt(stepArg, 10);
	const before = parseInt(beforeArg ?? "10", 10);
	const conn = new Database(db, { readonly: true });

	const rows = conn
		.prepare(
			`SELECT seq, command, exit_code
       FROM steps
       WHERE trace_id = ? AND seq <= ?
       ORDER BY seq DESC
       LIMIT ?`,
		)
		.all(traceId, seq, before) as {
		seq: number;
		command: string;
		exit_code: number;
	}[];
	conn.close();

	console.log(`\n--- Trace ${traceId}, Context up to Step ${seq} ---\n`);
	for (const row of rows.reverse()) {
		const exitTag = row.exit_code !== 0 ? ` [exit=${row.exit_code}]` : "";
		console.log(`  [${row.seq}] ${truncateCommand(row.command, 100)}${exitTag}`);
	}
	console.log("");
}
