import { assertSchemaVersion } from "../schema";
import { dbPath, parseArgs } from "./shared/args";
import { Database } from "bun:sqlite";
import { color, fmt, truncateCommand } from "./shared/format";
import { replayToStateAndOutput } from "../impl-harness";
import { printOutputComparison, printState } from "./shared/worktree-diff";
import {
	applyDelta,
	EMPTY_SNAPSHOT,
	isPlaceholderDelta,
	type SnapshotDelta,
} from "../snapshot-delta";
import type { GitSnapshot } from "../capture";
import { compare, type OracleState } from "../compare";

export async function cmdInspect(args: string[]): Promise<void> {
	const { positional, getOpt } = parseArgs(args);

	// Positional: <name> <trace> <step>
	const dbName = positional[0] ?? getOpt("--db");
	const traceArg = positional[1] ?? getOpt("--trace");
	const stepArg = positional[2] ?? getOpt("--step");

	if (!dbName || !traceArg || !stepArg) {
		console.log(`Usage: bun oracle inspect <name> <trace> <step>

Replays the trace up to the given step, then shows oracle state,
impl state, divergences, and stdout/stderr comparison.

Examples:
  inspect basic 5 42
  inspect rebase-heavy 1 86`);
		process.exit(1);
	}

	const db = dbPath(dbName);
	const traceId = parseInt(traceArg, 10);
	const seq = parseInt(stepArg, 10);

	const conn = new Database(db, { readonly: true });
	assertSchemaVersion(conn);

	// Get the target step (without snapshot — we'll reconstruct it from deltas)
	const step = conn
		.prepare(
			"SELECT step_id, seq, command, exit_code, stdout, stderr FROM steps WHERE trace_id = ? AND seq = ?",
		)
		.get(traceId, seq) as {
		step_id: number;
		seq: number;
		command: string;
		exit_code: number;
		stdout: string;
		stderr: string;
	} | null;

	if (!step) {
		console.error(`No step found: trace ${traceId}, seq ${seq}`);
		conn.close();
		process.exit(1);
	}

	// Reconstruct full snapshot from deltas up to this step
	const deltaRows = conn
		.prepare("SELECT seq, snapshot FROM steps WHERE trace_id = ? AND seq <= ? ORDER BY seq")
		.all(traceId, seq) as { seq: number; snapshot: string }[];

	// Get context: 5 commands before this step
	const context = conn
		.prepare(
			"SELECT seq, command, exit_code FROM steps WHERE trace_id = ? AND seq < ? ORDER BY seq DESC LIMIT 5",
		)
		.all(traceId, seq) as {
		seq: number;
		command: string;
		exit_code: number;
	}[];

	conn.close();

	// ── Header + context ──────────────────────────────────────────

	console.log(`\n--- Trace ${traceId}, Step ${seq} ---\n`);

	if (context.length > 0) {
		console.log("Context (preceding steps):");
		for (const c of context.reverse()) {
			const exitTag = c.exit_code !== 0 ? ` [exit=${c.exit_code}]` : "";
			console.log(`  [${c.seq}] ${truncateCommand(c.command, 70)}${exitTag}`);
		}
		console.log("");
	}

	console.log(`Command: ${step.command}`);

	// ── Replay for impl state + output ───────────────────────────

	console.log("Replaying...\n");
	const { state: implState, output: implOutput } = await replayToStateAndOutput(db, traceId, seq);

	// ── Output comparison (exit code, stdout, stderr) ────────────

	const exitMatch = implOutput.exitCode === step.exit_code;
	console.log(
		`Exit code:  oracle=${step.exit_code}  impl=${implOutput.exitCode}  ${exitMatch ? color.green("MATCH") : color.red("MISMATCH")}`,
	);

	printOutputComparison("STDOUT", step.stdout, implOutput.stdout);
	printOutputComparison("STDERR", step.stderr, implOutput.stderr);

	// ── Oracle snapshot (reconstructed from deltas) ─────────────

	let snap: GitSnapshot = EMPTY_SNAPSHOT;
	for (const row of deltaRows) {
		const delta: SnapshotDelta = JSON.parse(row.snapshot);
		if (!isPlaceholderDelta(delta)) {
			snap = applyDelta(snap, delta);
		}
	}
	// Check if the target step itself is a placeholder
	const targetDelta: SnapshotDelta = JSON.parse(deltaRows[deltaRows.length - 1].snapshot);
	if (isPlaceholderDelta(targetDelta)) {
		console.log("\nSnapshot: (placeholder — intermediate step of multi-command action)");
		console.log("");
		return;
	}

	const oracleMain = snap.worktrees.find((w) => w.id === "main") ?? snap.worktrees[0];
	const implMain = implState.worktrees.find((w) => w.id === "main") ?? implState.worktrees[0];

	console.log("\nOracle state:");
	printState({
		headRef: oracleMain?.headRef ?? null,
		headSha: oracleMain?.headSha ?? null,
		operation: oracleMain?.operation ?? null,
		operationHash: oracleMain?.operationStateHash ?? null,
		refCount: snap.refs.length,
		indexCount: (oracleMain?.index ?? []).filter((e) => e.stage === 0).length,
		conflictCount: (oracleMain?.index ?? []).filter((e) => e.stage > 0).length,
		workTreeHash: oracleMain?.workTreeHash ?? "",
	});

	console.log("\nImpl state:");
	printState({
		headRef: implMain?.headRef ?? null,
		headSha: implMain?.headSha ?? null,
		operation: implMain?.operation ?? null,
		operationHash: implMain?.operationStateHash ?? null,
		refCount: implState.refs.size,
		indexCount: [...(implMain?.index.keys() ?? [])].filter((k) => k.endsWith(":0")).length,
		conflictCount: [...(implMain?.index.keys() ?? [])].filter((k) => !k.endsWith(":0")).length,
		workTreeHash: implMain?.workTreeHash ?? "",
	});

	// Note any linked worktrees so the `worktree:<path>:` divergence field
	// prefixes make sense (the path is the key; the admin id is shown alongside).
	const linked = snap.worktrees.filter((w) => w.id !== "main");
	if (linked.length > 0) {
		console.log(`\nLinked worktrees: ${linked.map((w) => `${w.path} (id ${w.id})`).join(", ")}`);
	}

	// ── State divergences ────────────────────────────────────────

	const oracleState: OracleState = {
		refs: snap.refs,
		stashHashes: snap.stashHashes ?? [],
		worktrees: snap.worktrees ?? [],
	};
	const divergences = compare(oracleState, implState);

	if (divergences.length === 0) {
		console.log("\nNo state divergences.");
	} else {
		const errors = divergences.filter((d) => d.severity === "error");
		const warnings = divergences.filter((d) => d.severity === "warn");
		const label =
			errors.length > 0
				? `${errors.length} error(s), ${warnings.length} warning(s)`
				: `${warnings.length} warning(s) only`;
		console.log(`\nState divergences (${divergences.length}: ${label}):`);
		for (const d of divergences) {
			const tag = d.severity === "error" ? "[ERR]" : "[WRN]";
			console.log(`  ${tag} ${d.field}:`);
			console.log(`    oracle: ${fmt(d.expected)}`);
			console.log(`    impl:   ${fmt(d.actual)}`);
		}
	}

	console.log("");
}
