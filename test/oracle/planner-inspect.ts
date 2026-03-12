#!/usr/bin/env bun

/**
 * CLI tool for interactively comparing planner output against real git rev-list.
 *
 * Thin wrapper around the shared logic in post-mortem.ts — the core comparison
 * is done by comparePlannerOutput and classifyPlannerDivergence.
 */

import { Database } from "bun:sqlite";
import { dirname, join } from "node:path";
import {
	classifyPlannerDivergence,
	comparePlannerOutput,
	parseRebaseUpstream,
} from "./post-mortem";

interface StepRow {
	seq: number;
	command: string;
}

function dbPathFor(name: string): string {
	return join(dirname(import.meta.path), "data", name, "traces.sqlite");
}

export async function runPlannerInspect(
	dbName: string,
	traceId: number,
	step: number,
): Promise<void> {
	const db = new Database(dbPathFor(dbName), { readonly: true });
	const row = db
		.query("SELECT seq, command FROM steps WHERE trace_id = ? AND seq = ? LIMIT 1")
		.get(traceId, step) as StepRow | null;
	db.close();

	if (!row) {
		console.error(`No step found: trace=${traceId} step=${step}`);
		process.exit(1);
	}

	const upstream = parseRebaseUpstream(row.command);
	if (!upstream) {
		console.error(`Step is not a simple 'git rebase <upstream>': ${row.command}`);
		process.exit(1);
	}

	const comparison = await comparePlannerOutput(dbPathFor(dbName), traceId, step, upstream);

	const classification = classifyPlannerDivergence(comparison);

	console.log(`trace=${traceId} step=${step} upstream=${upstream}`);
	console.log(`pre-step=${step - 1}`);
	console.log(`classification: ${classification.pattern}`);
	console.log(`explanation: ${classification.explanation}`);

	const rightMatch =
		JSON.stringify(comparison.oracleRight) === JSON.stringify(comparison.oursRight);
	const leftMatch = JSON.stringify(comparison.oracleLeft) === JSON.stringify(comparison.oursLeft);

	console.log(`right match: ${rightMatch ? "yes" : "no"}`);
	console.log(`left  match: ${leftMatch ? "yes" : "no"}`);
	console.log("");
	console.log(`oracle right (${comparison.oracleRight.length})`);
	console.log(comparison.oracleRight.join("\n"));
	console.log("");
	console.log(`ours right (${comparison.oursRight.length})`);
	console.log(comparison.oursRight.join("\n"));
	console.log("");
	console.log(`oracle left (${comparison.oracleLeft.length})`);
	console.log(comparison.oracleLeft.join("\n"));
	console.log("");
	console.log(`ours left (${comparison.oursLeft.length})`);
	console.log(comparison.oursLeft.join("\n"));
}

if (import.meta.main) {
	const [, , dbName, traceArg, stepArg] = process.argv;
	if (!dbName || !traceArg || !stepArg) {
		console.log(`Usage: bun oracle planner-inspect <db-name> <trace> <step>

Compares planner output against real git rev-list at the state BEFORE <step>.
The specified step should be a rebase command.

Example:
  bun oracle planner-inspect rebase-2 74 424`);
		process.exit(1);
	}

	const traceId = Number.parseInt(traceArg, 10);
	const step = Number.parseInt(stepArg, 10);
	if (!Number.isFinite(traceId) || !Number.isFinite(step) || step <= 0) {
		console.log(`Usage: bun oracle planner-inspect <db-name> <trace> <step>

Compares planner output against real git rev-list at the state BEFORE <step>.
The specified step should be a rebase command.

Example:
  bun oracle planner-inspect rebase-2 74 424`);
		process.exit(1);
	}

	await runPlannerInspect(dbName, traceId, step);
}
