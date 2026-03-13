#!/usr/bin/env bun
/**
 * Unified CLI for the oracle testing framework.
 *
 * Subcommands:
 *   generate   Create oracle traces from real git
 *   test       Replay traces against our implementation and compare
 *   inspect    Examine a specific step — shows oracle + impl diff
 *   rebuild    Materialize a real git repo at a specific step
 *   summary    Aggregate WARN/KNOWN/FAIL counts across all test result logs
 *
 * Examples:
 *   bun oracle generate basic --seeds 1-20 --steps 300
 *   bun oracle test basic
 *   bun oracle test basic 5 -v
 *   bun oracle inspect basic 5 42
 *   bun oracle rebuild basic 5 42
 */

import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readIndex } from "../../src/lib/index";
import { readObject } from "../../src/lib/object-db";
import { findGitDir } from "../../src/lib/repo";
import { captureIndex, captureWorkTree, type GitSnapshot, type WorkTreeFile } from "./capture";
import { compare, type OracleState } from "./compare";
import { generateTraces, PRESETS, parseSeeds } from "./generate";
import {
	type CommandTiming,
	captureVirtualWorkTree,
	replayAndCheck,
	replayToStateAndOutput,
	replayToVirtual,
	replayWithSize,
	replayWithTiming,
	type SizeSample,
} from "./impl-harness";
import { runPlannerInspect } from "./planner-inspect";
import { runPostMortem } from "./post-mortem";
import { replayTo } from "./runner";
import { applyDelta, EMPTY_SNAPSHOT, type SnapshotDelta } from "./snapshot-delta";

const DATA_DIR = join(dirname(import.meta.path), "data");

// ── Arg helpers ──────────────────────────────────────────────────

/** Known flags that consume the next arg as a value. */
const VALUE_FLAGS = new Set([
	"--seeds",
	"--steps",
	"--preset",
	"--description",
	"--db",
	"--trace",
	"--step",
	"--stop-at",
	"--before",
	"--limit",
	"--chaos",
	"--clone-url",
	"--top",
	"--every",
]);

/**
 * Parse args into positional args and flags/options.
 * Positional args are anything not starting with "-" and not consumed
 * as a value by a preceding flag.
 */
function parseArgs(args: string[]): {
	positional: string[];
	getOpt: (name: string) => string | undefined;
	hasFlag: (name: string) => boolean;
} {
	const positional: string[] = [];
	const flags = new Map<string, string | true>();
	let i = 0;
	while (i < args.length) {
		const arg = args[i];
		if (arg.startsWith("-")) {
			if (VALUE_FLAGS.has(arg) && i + 1 < args.length) {
				flags.set(arg, args[i + 1]);
				i += 2;
			} else {
				flags.set(arg, true);
				i++;
			}
		} else {
			positional.push(arg);
			i++;
		}
	}
	return {
		positional,
		getOpt: (name: string) => {
			const v = flags.get(name);
			return typeof v === "string" ? v : undefined;
		},
		hasFlag: (name: string) => flags.has(name),
	};
}

function dbPath(name: string): string {
	return join(DATA_DIR, name, "traces.sqlite");
}

function ensureDbDir(path: string): void {
	mkdirSync(dirname(path), { recursive: true });
}

// ── generate ─────────────────────────────────────────────────────

async function cmdGenerate(args: string[]): Promise<void> {
	const { positional, getOpt } = parseArgs(args);

	const seedsArg = getOpt("--seeds");
	const stepsArg = getOpt("--steps");
	const chaosArg = getOpt("--chaos");
	const cloneUrl = getOpt("--clone-url");
	const description = getOpt("--description");
	// First positional = db name. If it matches a known preset, use it as
	// both the db name and preset (unless --preset explicitly overrides).
	const dbName = positional[0] ?? getOpt("--db") ?? "default";
	const presetName =
		getOpt("--preset") ?? (positional[0] && positional[0] in PRESETS ? positional[0] : "default");
	const db = dbPath(dbName);

	if (!seedsArg) {
		console.log(`Usage: bun oracle generate [name] --seeds <spec> [options]

  First argument is the database name (default: preset name).
  Stored at: data/<name>/traces.sqlite

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
		fuzz: preset.fuzz,
		fileGen: preset.fileGen,
		description,
		cloneUrl: effectiveCloneUrl,
	});
}

// ── test ─────────────────────────────────────────────────────────

// ANSI color helpers (no-op if not a TTY)
const isTTY = process.stderr.isTTY ?? false;
const color = {
	green: (s: string) => (isTTY ? `\x1b[32m${s}\x1b[0m` : s),
	yellow: (s: string) => (isTTY ? `\x1b[33m${s}\x1b[0m` : s),
	red: (s: string) => (isTTY ? `\x1b[31m${s}\x1b[0m` : s),
	cyan: (s: string) => (isTTY ? `\x1b[36m${s}\x1b[0m` : s),
	dim: (s: string) => (isTTY ? `\x1b[2m${s}\x1b[0m` : s),
};

async function cmdTest(args: string[]): Promise<void> {
	const { positional, getOpt, hasFlag } = parseArgs(args);

	// Positional: [name] [trace]
	const dbName = positional[0] ?? getOpt("--db") ?? "default";
	const db = dbPath(dbName);
	const traceArg = positional[1] ?? getOpt("--trace");
	const seedsArg = getOpt("--seeds");
	const verbose = hasFlag("--verbose") || hasFlag("-v");
	const stopAt = getOpt("--stop-at");
	const noPostMortem = hasFlag("--no-post-mortem");

	// Get trace IDs to run
	let traceIds: number[];
	if (traceArg) {
		traceIds = [parseInt(traceArg, 10)];
	} else {
		const conn = new Database(db, { readonly: true });
		let rows: { trace_id: number }[];
		if (seedsArg) {
			const seeds = parseSeeds(seedsArg);
			const placeholders = seeds.map(() => "?").join(",");
			rows = conn
				.prepare(`SELECT trace_id FROM traces WHERE seed IN (${placeholders}) ORDER BY trace_id`)
				.all(...seeds) as { trace_id: number }[];
		} else {
			rows = conn.prepare("SELECT trace_id FROM traces ORDER BY trace_id").all() as {
				trace_id: number;
			}[];
		}
		conn.close();
		traceIds = rows.map((r) => r.trace_id);
	}

	if (traceIds.length === 0) {
		console.log(`No traces found in ${db}`);
		process.exit(1);
	}

	// Set up log file (sibling to traces.sqlite)
	const logPath = db.replace(/traces\.sqlite$/, "test-results.log");
	mkdirSync(dirname(logPath), { recursive: true });
	const flagsDesc = [verbose ? "-v" : null, traceArg ? `trace=${traceArg}` : null]
		.filter(Boolean)
		.join(" ");
	writeFileSync(
		logPath,
		`oracle test ${dbName}${flagsDesc ? ` ${flagsDesc}` : ""}  (${new Date().toISOString()})\n${"─".repeat(60)}\n`,
	);

	/** Write a line to console and log file. */
	function emit(line: string): void {
		console.log(line);
		appendFileSync(logPath, `${stripAnsi(line)}\n`);
	}
	/** Write a line to the log file only. */
	function logOnly(line: string): void {
		appendFileSync(logPath, `${stripAnsi(line)}\n`);
	}

	let passCount = 0;
	let warnCount = 0;
	let knownCount = 0;
	let failCount = 0;

	for (const traceId of traceIds) {
		const result = await replayAndCheck(db, traceId, {
			stopAt: stopAt ? parseInt(stopAt, 10) : undefined,
			verbose,
		});

		if (!result.firstDivergence && !result.firstWarning) {
			// Clean pass — no divergences at all
			passCount++;
			const passLine = verbose
				? `\n  ${color.green("PASS")}   trace ${traceId}   ${result.passed}/${result.totalSteps} steps`
				: `  ${color.green("PASS")}   trace ${traceId}   ${result.totalSteps} steps`;
			if (verbose) {
				emit(passLine);
			} else {
				// Suppress PASS from console in non-verbose; log only
				logOnly(passLine);
			}
		} else if (!result.firstDivergence && result.firstWarning) {
			// Passed with warnings — no errors, but some warn-level divergences
			warnCount++;
			const w = result.firstWarning;
			const cmd = truncateCommand(w.command, 50);

			if (!verbose) {
				const warnFields = w.divergences.map((d) => d.field).join(", ");
				emit(
					`  ${color.yellow("WARN")}   trace ${traceId}   ${result.totalSteps} steps  ${color.dim(`(${result.warned} warn-steps, first: step ${w.seq} ${cmd})`)}`,
				);
				emit(`         ${color.yellow(warnFields)}`);
			} else {
				emit(
					`\n  ${color.yellow("WARN")}   trace ${traceId}   ${result.passed}/${result.totalSteps} steps, ${result.warned} warnings`,
				);
				emit(`         first warning at step ${w.seq}: ${cmd}`);
				for (const d of w.divergences) {
					emit(
						`         ${color.yellow(d.field)}: expected=${fmt(d.expected)} actual=${fmt(d.actual)}`,
					);
				}
			}
		} else if (result.firstDivergence) {
			// Hard failure — run post-mortem to classify
			const d = result.firstDivergence;
			const cmd = truncateCommand(d.command, 50);
			const firstErr = d.divergences.find((x) => x.severity === "error");

			// Run post-mortem analysis unless disabled
			let postMortemResult: Awaited<ReturnType<typeof runPostMortem>> | null = null;
			if (!noPostMortem) {
				try {
					postMortemResult = await runPostMortem(db, traceId, d.seq, d.command, d.divergences);
				} catch {
					// Post-mortem failed — treat as unknown
					postMortemResult = null;
				}
			}

			const isKnown = postMortemResult !== null && postMortemResult.pattern !== "unknown";

			if (isKnown && postMortemResult) {
				// Known divergence pattern — don't count as failure
				knownCount++;
				emit(
					`  ${color.cyan("KNOWN")}  trace ${traceId}   step ${d.seq}/${result.totalSteps}  ${cmd}`,
				);
				emit(`         ${color.dim(postMortemResult.pattern)}: ${postMortemResult.explanation}`);
			} else {
				// Genuine failure
				failCount++;
				if (!verbose) {
					emit(
						`  ${color.red("FAIL")}   trace ${traceId}   step ${d.seq}/${result.totalSteps}  ${cmd}`,
					);
					if (firstErr) {
						emit(
							`         ${firstErr.field}: expected=${fmt(firstErr.expected)} actual=${fmt(firstErr.actual)}`,
						);
					}
					// If there was an earlier warning, mention it as possible root cause
					if (result.firstWarning && result.firstWarning.seq < d.seq) {
						const w = result.firstWarning;
						emit(
							`         ${color.yellow(`(preceded by warning at step ${w.seq}: ${truncateCommand(w.command, 40)})`)}`,
						);
					}
				} else {
					emit(
						`\n  ${color.red("FAIL")}   trace ${traceId}   step ${d.seq}/${result.totalSteps}  ${cmd}`,
					);
					for (const div of d.divergences) {
						const tag = div.severity === "error" ? color.red("ERR") : color.yellow("WRN");
						emit(
							`         [${tag}] ${div.field}: expected=${fmt(div.expected)} actual=${fmt(div.actual)}`,
						);
					}
					if (result.firstWarning && result.firstWarning.seq < d.seq) {
						const w = result.firstWarning;
						emit(
							`         ${color.yellow(`root cause? first warning at step ${w.seq}: ${truncateCommand(w.command, 50)}`)}`,
						);
						for (const wd of w.divergences) {
							emit(
								`           ${color.yellow(wd.field)}: expected=${fmt(wd.expected)} actual=${fmt(wd.actual)}`,
							);
						}
					}
				}
			}
		}
	}

	// Summary line
	const parts: string[] = [];
	parts.push(`${passCount} passed`);
	if (warnCount > 0) parts.push(color.yellow(`${warnCount} warned`));
	if (knownCount > 0) parts.push(color.cyan(`${knownCount} known`));
	if (failCount > 0) parts.push(color.red(`${failCount} failed`));

	emit(`\n${parts.join(", ")}  (${traceIds.length} total)`);
	console.log(color.dim(`Log: ${logPath}`));

	if (failCount > 0) process.exit(1);
}

// ── inspect ──────────────────────────────────────────────────────

async function cmdInspect(args: string[]): Promise<void> {
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
		if (delta.workTreeHash !== "") {
			snap = applyDelta(snap, delta);
		}
	}
	// Check if the target step itself is a placeholder
	const targetDelta: SnapshotDelta = JSON.parse(deltaRows[deltaRows.length - 1].snapshot);
	if (targetDelta.workTreeHash === "") {
		console.log("\nSnapshot: (placeholder — intermediate step of multi-command action)");
		console.log("");
		return;
	}

	console.log("\nOracle state:");
	printState({
		headRef: snap.head.headRef,
		headSha: snap.head.headSha,
		operation: snap.operation.operation,
		operationHash: snap.operation.stateHash,
		refCount: snap.refs.length,
		indexCount: snap.index.filter((e) => e.stage === 0).length,
		conflictCount: snap.index.filter((e) => e.stage > 0).length,
		workTreeHash: snap.workTreeHash,
	});

	console.log("\nImpl state:");
	printState({
		headRef: implState.headRef,
		headSha: implState.headSha,
		operation: implState.activeOperation,
		operationHash: implState.operationStateHash,
		refCount: implState.refs.size,
		indexCount: [...implState.index.keys()].filter((k) => k.endsWith(":0")).length,
		conflictCount: [...implState.index.keys()].filter((k) => !k.endsWith(":0")).length,
		workTreeHash: implState.workTreeHash,
	});

	// ── State divergences ────────────────────────────────────────

	const oracleState: OracleState = {
		head: snap.head,
		refs: snap.refs,
		index: snap.index,
		operation: snap.operation,
		workTreeHash: snap.workTreeHash,
		stashHashes: snap.stashHashes ?? [],
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

/**
 * Print a comparison of oracle vs impl output for a single stream (stdout/stderr).
 * Shows MATCH/MISMATCH with character-level first-difference on mismatch.
 */
function printOutputComparison(label: string, oracle: string, impl: string): void {
	console.log(`\n=== ${label} ===`);
	if (oracle === impl) {
		console.log(color.green("MATCH"));
		if (oracle) {
			console.log(color.dim("Content:"));
			console.log(indent(oracle));
		} else {
			console.log(color.dim("(empty)"));
		}
	} else {
		console.log(color.red("MISMATCH"));
		console.log(`\n${color.yellow(`Oracle ${label.toLowerCase()}:`)}`);
		console.log(oracle || color.dim("(empty)"));
		console.log(`\n${color.yellow(`Impl ${label.toLowerCase()}:`)}`);
		console.log(impl || color.dim("(empty)"));

		// Character-level first difference
		const maxLen = Math.max(oracle.length, impl.length);
		for (let i = 0; i < maxLen; i++) {
			if (oracle[i] !== impl[i]) {
				console.log(
					`\nFirst diff at char ${i}: oracle=${JSON.stringify(oracle[i] ?? "(end)")} impl=${JSON.stringify(impl[i] ?? "(end)")}`,
				);
				const start = Math.max(0, i - 20);
				console.log(
					`  oracle[${start}..${i + 20}]: ${JSON.stringify(oracle.slice(start, i + 20))}`,
				);
				console.log(`  impl  [${start}..${i + 20}]: ${JSON.stringify(impl.slice(start, i + 20))}`);
				break;
			}
		}
	}
}

// ── trace-context ────────────────────────────────────────────────

async function cmdTraceContext(args: string[]): Promise<void> {
	const { positional, getOpt } = parseArgs(args);
	const dbName = positional[0] ?? getOpt("--db");
	const traceArg = positional[1] ?? getOpt("--trace");
	const stepArg = positional[2] ?? getOpt("--step");
	const beforeArg = getOpt("--before");

	if (!dbName || !traceArg || !stepArg) {
		console.log(`Usage: bun oracle trace-context <name> <trace> <step> [--before N]

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

// ── diff-worktree ────────────────────────────────────────────────

async function cmdDiffWorktree(args: string[]): Promise<void> {
	const { positional, getOpt } = parseArgs(args);
	const dbName = positional[0] ?? getOpt("--db");
	const traceArg = positional[1] ?? getOpt("--trace");
	const stepArg = positional[2] ?? getOpt("--step");
	const limitArg = getOpt("--limit");

	if (!dbName || !traceArg || !stepArg) {
		console.log(`Usage: bun oracle diff-worktree <name> <trace> <step> [--limit N]

Compare oracle(real git) and impl virtual worktree files at a step.

Examples:
  diff-worktree basic 5 42
  diff-worktree basic 5 42 --limit 100`);
		process.exit(1);
	}

	const db = dbPath(dbName);
	const traceId = parseInt(traceArg, 10);
	const step = parseInt(stepArg, 10);
	const limit = parseInt(limitArg ?? "50", 10);

	const repoDir = await replayTo(db, traceId, step);
	try {
		const virtual = await replayToVirtual(db, traceId, step);
		const [oracleFiles, implFiles] = await Promise.all([
			captureWorkTree(repoDir),
			captureVirtualWorkTree(virtual.bash.fs),
		]);
		const diff = diffWorkTrees(oracleFiles, implFiles);

		console.log(`\n--- Trace ${traceId}, Step ${step} Worktree Diff ---\n`);
		console.log(
			`Differing paths: ${diff.differing.length}${diff.differing.length > limit ? ` (showing first ${limit})` : ""}\n`,
		);

		for (const d of diff.differing.slice(0, limit)) {
			console.log(
				`  ${d.path}\n    oracle: len=${d.oracleLen} sha1=${d.oracleSha}\n    impl:   len=${d.implLen} sha1=${d.implSha}`,
			);
		}
		console.log("");
	} finally {
		await rm(repoDir, { recursive: true, force: true });
	}
}

// ── diff-file ────────────────────────────────────────────────────

async function cmdDiffFile(args: string[]): Promise<void> {
	const { positional, getOpt } = parseArgs(args);
	const dbName = positional[0] ?? getOpt("--db");
	const traceArg = positional[1] ?? getOpt("--trace");
	const stepArg = positional[2] ?? getOpt("--step");
	const path = positional[3];

	if (!dbName || !traceArg || !stepArg || !path) {
		console.log(`Usage: bun oracle diff-file <name> <trace> <step> <path>

Show first line-level mismatch for a specific file path.

Examples:
  diff-file basic 5 42 src/app.ts
  diff-file cherry-pick 149 281 initial.txt`);
		process.exit(1);
	}

	const db = dbPath(dbName);
	const traceId = parseInt(traceArg, 10);
	const step = parseInt(stepArg, 10);

	const repoDir = await replayTo(db, traceId, step);
	try {
		const virtual = await replayToVirtual(db, traceId, step);
		const [oracleFiles, implFiles] = await Promise.all([
			captureWorkTree(repoDir),
			captureVirtualWorkTree(virtual.bash.fs),
		]);
		const oracleMap = new Map(oracleFiles.map((f) => [f.path, f.content]));
		const implMap = new Map(implFiles.map((f) => [f.path, f.content]));

		const oracle = oracleMap.get(path);
		const impl = implMap.get(path);

		console.log(`\n--- Trace ${traceId}, Step ${step}, File ${path} ---\n`);
		if (oracle === undefined && impl === undefined) {
			console.log("File missing in both oracle and impl.\n");
			return;
		}
		if (oracle === undefined) {
			console.log("File missing in oracle, present in impl.\n");
			return;
		}
		if (impl === undefined) {
			console.log("File present in oracle, missing in impl.\n");
			return;
		}
		if (oracle === impl) {
			console.log("File contents match.\n");
			return;
		}

		printFirstMismatch(path, oracle, impl);
	} finally {
		await rm(repoDir, { recursive: true, force: true });
	}
}

// ── conflict-blobs ───────────────────────────────────────────────

async function cmdConflictBlobs(args: string[]): Promise<void> {
	const { positional, getOpt, hasFlag } = parseArgs(args);
	const dbName = positional[0] ?? getOpt("--db");
	const traceArg = positional[1] ?? getOpt("--trace");
	const stepArg = positional[2] ?? getOpt("--step");
	const path = positional[3];
	const full = hasFlag("--full");

	if (!dbName || !traceArg || !stepArg || !path) {
		console.log(`Usage: bun oracle conflict-blobs <name> <trace> <step> <path> [--full]

Print stage 1/2/3 index blob info for a conflicted path in oracle and impl.

Examples:
  conflict-blobs cherry-pick 149 281 initial.txt
  conflict-blobs cherry-pick 149 281 initial.txt --full`);
		process.exit(1);
	}

	const db = dbPath(dbName);
	const traceId = parseInt(traceArg, 10);
	const step = parseInt(stepArg, 10);
	const repoDir = await replayTo(db, traceId, step);

	try {
		const virtual = await replayToVirtual(db, traceId, step);
		const gitCtx = await findGitDir(virtual.bash.fs, "/repo");
		if (!gitCtx) {
			console.log("No git repository in virtual replay.\n");
			return;
		}

		const [oracleEntries, implIndex] = await Promise.all([
			captureIndex(repoDir),
			readIndex(gitCtx),
		]);

		const oracleStages = oracleEntries
			.filter((e) => e.path === path && e.stage > 0)
			.sort((a, b) => a.stage - b.stage);
		const implStages = implIndex.entries
			.filter((e) => e.path === path && e.stage > 0)
			.sort((a, b) => a.stage - b.stage);

		console.log(`\n--- Trace ${traceId}, Step ${step}, Conflict Blobs: ${path} ---\n`);

		console.log("Oracle:");
		if (oracleStages.length === 0) {
			console.log("  (no stage 1/2/3 entries)");
		}
		for (const entry of oracleStages) {
			const content = await readRealStageBlob(repoDir, path, entry.stage);
			printStageBlob("  ", entry.stage, entry.sha, entry.mode, content, full);
		}

		console.log("\nImpl:");
		if (implStages.length === 0) {
			console.log("  (no stage 1/2/3 entries)");
		}
		for (const entry of implStages) {
			const raw = await readObject(gitCtx, entry.hash);
			const content = new TextDecoder().decode(raw.content);
			printStageBlob("  ", entry.stage, entry.hash, entry.mode, content, full);
		}
		console.log("");
	} finally {
		await rm(repoDir, { recursive: true, force: true });
	}
}

interface StateSummary {
	headRef: string | null;
	headSha: string | null;
	operation: string | null;
	operationHash: string | null;
	refCount: number;
	indexCount: number;
	conflictCount: number;
	workTreeHash: string;
}

function printState(s: StateSummary): void {
	console.log(`  HEAD: ${s.headRef ?? "(detached)"} -> ${s.headSha ?? "(none)"}`);
	console.log(
		`  Operation: ${s.operation ?? "none"}${s.operationHash ? ` (${s.operationHash.slice(0, 12)}...)` : ""}`,
	);
	console.log(
		`  Refs: ${s.refCount}  Index: ${s.indexCount}${s.conflictCount > 0 ? ` + ${s.conflictCount} conflict` : ""}`,
	);
	console.log(`  Worktree: ${s.workTreeHash}`);
}

// ── rebuild ──────────────────────────────────────────────────────

async function cmdRebuild(args: string[]): Promise<void> {
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
	console.log(`\nCleanup: rm -rf ${repoDir}`);
}

// ── profile ──────────────────────────────────────────────────

interface ProfileTiming extends CommandTiming {
	traceId: number;
}

async function cmdProfile(args: string[]): Promise<void> {
	const { positional, getOpt, hasFlag } = parseArgs(args);

	const dbName = positional[0] ?? getOpt("--db") ?? "default";
	const db = dbPath(dbName);
	const traceArg = positional[1] ?? getOpt("--trace");
	const csv = hasFlag("--csv");
	const topN = parseInt(getOpt("--top") ?? "15", 10);

	if (hasFlag("--help") || hasFlag("-h")) {
		printProfileUsage();
		process.exit(0);
	}

	let traceIds: number[];
	if (traceArg) {
		traceIds = [parseInt(traceArg, 10)];
	} else {
		const conn = new Database(db, { readonly: true });
		const rows = conn.prepare("SELECT trace_id FROM traces ORDER BY trace_id").all() as {
			trace_id: number;
		}[];
		conn.close();
		traceIds = rows.map((r) => r.trace_id);
	}

	if (traceIds.length === 0) {
		console.log(`No traces found in ${db}`);
		process.exit(1);
	}

	const allTimings: ProfileTiming[] = [];

	for (let i = 0; i < traceIds.length; i++) {
		const traceId = traceIds[i];
		if (!csv) {
			process.stderr.write(`\r  Profiling trace ${traceId} [${i + 1}/${traceIds.length}]...`);
		}
		const timings = await replayWithTiming(db, traceId);
		for (const t of timings) {
			allTimings.push({ traceId, ...t });
		}
	}
	if (!csv && traceIds.length > 0) {
		process.stderr.write(`\r${" ".repeat(60)}\r`);
	}

	if (csv) {
		console.log("trace_id,seq,command,base_command,elapsed_ms");
		for (const t of allTimings) {
			const base = profileBaseCommand(t.command);
			console.log(
				`${t.traceId},${t.seq},${csvEscape(t.command)},${base},${t.elapsedMs.toFixed(3)}`,
			);
		}
		return;
	}

	const totalMs = allTimings.reduce((sum, t) => sum + t.elapsedMs, 0);
	const gitTimings = allTimings.filter((t) => t.command.startsWith("git "));

	console.log(
		`\n=== Profile: ${dbName} (${traceIds.length} trace${traceIds.length !== 1 ? "s" : ""}, ${allTimings.length} steps, ${fmtMs(totalMs)} wall) ===\n`,
	);

	profilePrintCommandTable(allTimings);
	if (gitTimings.length > 0) {
		profilePrintStepRangeTable(gitTimings);
	}
	profilePrintSlowest(gitTimings, topN, traceIds.length > 1);
}

function printProfileUsage(): void {
	console.log(`Usage: bun oracle profile [name] [trace] [options]

Profile command execution times across oracle trace replays.
Times only git command execution — no state capture or comparison.

Options:
  --csv         Output raw CSV to stdout (pipe to file)
  --top <n>     Number of slowest individual commands to show (default: 15)

Examples:
  profile basic              # all traces
  profile basic 5            # single trace
  profile basic --csv        # raw data for external analysis`);
}

// ── Profile helpers ──────────────────────────────────────────

function profileBaseCommand(command: string): string {
	if (command.startsWith("FILE_")) return command.split(":")[0];
	return command.split(/\s+/).slice(0, 2).join(" ");
}

function fmtMs(ms: number): string {
	if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
	if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`;
	if (ms >= 100) return `${ms.toFixed(0)}ms`;
	if (ms >= 10) return `${ms.toFixed(1)}ms`;
	return `${ms.toFixed(2)}ms`;
}

function medianOf(sorted: number[]): number {
	if (sorted.length === 0) return 0;
	const mid = Math.floor(sorted.length / 2);
	if (sorted.length % 2) return sorted[mid];
	return (sorted[mid - 1] + sorted[mid]) / 2;
}

function p95Of(sorted: number[]): number {
	if (sorted.length === 0) return 0;
	return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
}

function csvEscape(s: string): string {
	if (s.includes(",") || s.includes('"') || s.includes("\n")) {
		return `"${s.replace(/"/g, '""')}"`;
	}
	return s;
}

function profilePrintCommandTable(timings: ProfileTiming[]): void {
	const groups = new Map<string, number[]>();
	for (const t of timings) {
		const base = profileBaseCommand(t.command);
		let arr = groups.get(base);
		if (!arr) {
			arr = [];
			groups.set(base, arr);
		}
		arr.push(t.elapsedMs);
	}

	const stats = [...groups.entries()].map(([cmd, values]) => {
		const sorted = values.sort((a, b) => a - b);
		const total = sorted.reduce((s, v) => s + v, 0);
		return {
			command: cmd,
			count: values.length,
			total,
			mean: total / values.length,
			median: medianOf(sorted),
			p95: p95Of(sorted),
			max: sorted[sorted.length - 1],
		};
	});
	stats.sort((a, b) => b.total - a.total);

	const W = { cmd: 20, n: 7, t: 9, m: 9, md: 9, p: 9, mx: 9 };
	const hdr = [
		"Command".padEnd(W.cmd),
		"Count".padStart(W.n),
		"Total".padStart(W.t),
		"Mean".padStart(W.m),
		"Median".padStart(W.md),
		"P95".padStart(W.p),
		"Max".padStart(W.mx),
	].join(" ");

	console.log("By command type (sorted by total time):");
	console.log(`  ${hdr}`);
	console.log(`  ${"─".repeat(hdr.length)}`);
	for (const s of stats) {
		console.log(
			`  ${s.command.padEnd(W.cmd)} ${String(s.count).padStart(W.n)} ${fmtMs(s.total).padStart(W.t)} ${fmtMs(s.mean).padStart(W.m)} ${fmtMs(s.median).padStart(W.md)} ${fmtMs(s.p95).padStart(W.p)} ${fmtMs(s.max).padStart(W.mx)}`,
		);
	}
	console.log("");
}

function profilePrintStepRangeTable(gitTimings: ProfileTiming[]): void {
	const BUCKET = 200;
	const maxSeq = Math.max(...gitTimings.map((t) => t.seq));
	const bucketCount = Math.ceil((maxSeq + 1) / BUCKET);

	const buckets: Array<{ label: string; values: number[] }> = [];
	for (let i = 0; i < bucketCount; i++) {
		const lo = i * BUCKET;
		const hi = lo + BUCKET - 1;
		buckets.push({ label: `${lo}-${hi}`, values: [] });
	}
	for (const t of gitTimings) {
		const idx = Math.floor(t.seq / BUCKET);
		buckets[idx].values.push(t.elapsedMs);
	}

	const W = { rng: 12, n: 7, m: 9, md: 9, p: 9, mx: 9 };
	const hdr = [
		"Steps".padEnd(W.rng),
		"Count".padStart(W.n),
		"Mean".padStart(W.m),
		"Median".padStart(W.md),
		"P95".padStart(W.p),
		"Max".padStart(W.mx),
	].join(" ");

	console.log("Timing by step range (git commands only):");
	console.log(`  ${hdr}`);
	console.log(`  ${"─".repeat(hdr.length)}`);
	for (const b of buckets) {
		if (b.values.length === 0) continue;
		const sorted = b.values.sort((a, b) => a - b);
		const total = sorted.reduce((s, v) => s + v, 0);
		console.log(
			`  ${b.label.padEnd(W.rng)} ${String(sorted.length).padStart(W.n)} ${fmtMs(total / sorted.length).padStart(W.m)} ${fmtMs(medianOf(sorted)).padStart(W.md)} ${fmtMs(p95Of(sorted)).padStart(W.p)} ${fmtMs(sorted[sorted.length - 1]).padStart(W.mx)}`,
		);
	}
	console.log("");
}

function profilePrintSlowest(gitTimings: ProfileTiming[], topN: number, multiTrace: boolean): void {
	const sorted = [...gitTimings].sort((a, b) => b.elapsedMs - a.elapsedMs);
	const top = sorted.slice(0, topN);

	if (top.length === 0) return;

	console.log(`Top ${Math.min(topN, top.length)} slowest commands:`);
	for (const t of top) {
		const loc = multiTrace ? `[trace ${t.traceId}, step ${t.seq}]` : `[step ${t.seq}]`;
		console.log(
			`  ${fmtMs(t.elapsedMs).padStart(9)}  ${loc.padEnd(multiTrace ? 22 : 12)}  ${truncateCommand(t.command, 60)}`,
		);
	}
	console.log("");
}

// ── Formatting helpers ───────────────────────────────────────────

function truncateCommand(cmd: string, maxLen: number): string {
	if (cmd.length <= maxLen) return cmd;
	return `${cmd.slice(0, maxLen)}...`;
}

function fmt(value: unknown, maxLen = 120): string {
	if (typeof value === "string") {
		const s = JSON.stringify(value);
		if (s.length <= maxLen) return s;
		return `${s.slice(0, maxLen - 3)}..."`;
	}
	return String(value);
}

function indent(text: string, prefix = "  "): string {
	return text
		.split("\n")
		.map((line) => `${prefix}${line}`)
		.join("\n");
}

/** Strip ANSI escape codes for clean log file output. */
function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

interface WorkTreeDiffEntry {
	path: string;
	oracleLen: number;
	implLen: number;
	oracleSha: string;
	implSha: string;
}

function diffWorkTrees(
	oracleFiles: WorkTreeFile[],
	implFiles: { path: string; content: string }[],
): { differing: WorkTreeDiffEntry[] } {
	const oracle = new Map(oracleFiles.map((f) => [f.path, f.content]));
	const impl = new Map(implFiles.map((f) => [f.path, f.content]));
	const allPaths = new Set<string>([...oracle.keys(), ...impl.keys()]);
	const differing: WorkTreeDiffEntry[] = [];

	for (const path of [...allPaths].sort()) {
		const a = oracle.get(path);
		const b = impl.get(path);
		if (a === b) continue;
		differing.push({
			path,
			oracleLen: a?.length ?? -1,
			implLen: b?.length ?? -1,
			oracleSha: a == null ? "(missing)" : sha1Hex(a),
			implSha: b == null ? "(missing)" : sha1Hex(b),
		});
	}

	return { differing };
}

function sha1Hex(text: string): string {
	const h = new Bun.CryptoHasher("sha1");
	h.update(text);
	return h.digest("hex");
}

function printFirstMismatch(path: string, oracle: string, impl: string): void {
	const oracleLines = oracle.split("\n");
	const implLines = impl.split("\n");
	let oi = 0;
	let ii = 0;
	while (oi < oracleLines.length || ii < implLines.length) {
		if (oracleLines[oi] === implLines[ii]) {
			oi++;
			ii++;
			continue;
		}

		console.log(`First mismatch in ${path}: oracle line ${oi + 1}, impl line ${ii + 1}\n`);
		for (let k = Math.max(0, oi - 4); k < Math.min(oracleLines.length, oi + 12); k++) {
			console.log(`  O ${String(k + 1).padStart(4)} ${oracleLines[k]}`);
		}
		console.log("");
		for (let k = Math.max(0, ii - 4); k < Math.min(implLines.length, ii + 12); k++) {
			console.log(`  I ${String(k + 1).padStart(4)} ${implLines[k]}`);
		}
		console.log("");
		return;
	}
}

async function readRealStageBlob(repoDir: string, path: string, stage: number): Promise<string> {
	const expr = `:${stage}:${path}`;
	const proc = Bun.spawn(["git", "show", expr], {
		cwd: repoDir,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	return stdout;
}

function printStageBlob(
	prefix: string,
	stage: number,
	sha: string,
	mode: number,
	content: string,
	full: boolean,
): void {
	console.log(
		`${prefix}stage ${stage}: sha=${sha} mode=${mode.toString(8)} len=${content.length} contentSha=${sha1Hex(content)}`,
	);
	if (full) {
		console.log(`${prefix}${indent(content, "")}`);
	} else {
		const preview = content.slice(0, 300);
		if (preview.length > 0) {
			console.log(`${prefix}preview: ${JSON.stringify(preview)}`);
		}
	}
}

// ── size ─────────────────────────────────────────────────────────

async function cmdSize(args: string[]): Promise<void> {
	const { positional, getOpt, hasFlag } = parseArgs(args);

	const dbName = positional[0] ?? getOpt("--db") ?? "default";
	const db = dbPath(dbName);
	const traceArg = positional[1] ?? getOpt("--trace");
	const csv = hasFlag("--csv");
	const sampleEvery = parseInt(getOpt("--every") ?? "200", 10);

	if (hasFlag("--help") || hasFlag("-h")) {
		printSizeUsage();
		process.exit(0);
	}

	let traceIds: number[];
	if (traceArg) {
		traceIds = [parseInt(traceArg, 10)];
	} else {
		const conn = new Database(db, { readonly: true });
		const rows = conn.prepare("SELECT trace_id FROM traces ORDER BY trace_id").all() as {
			trace_id: number;
		}[];
		conn.close();
		traceIds = rows.map((r) => r.trace_id);
	}

	if (traceIds.length === 0) {
		console.log(`No traces found in ${db}`);
		process.exit(1);
	}

	const allSamples: Array<SizeSample & { traceId: number }> = [];

	for (let i = 0; i < traceIds.length; i++) {
		const traceId = traceIds[i];
		if (!csv) {
			process.stderr.write(`\r  Replaying trace ${traceId} [${i + 1}/${traceIds.length}]...`);
		}
		const samples = await replayWithSize(db, traceId, sampleEvery);
		for (const s of samples) {
			allSamples.push({ traceId, ...s });
		}
	}
	if (!csv && traceIds.length > 0) {
		process.stderr.write(`\r${" ".repeat(60)}\r`);
	}

	if (csv) {
		console.log(
			"trace_id,seq,worktree_files,worktree_kb,index_entries,conflicts,objects,objects_kb",
		);
		for (const s of allSamples) {
			console.log(
				`${s.traceId},${s.seq},${s.workTreeFiles},${(s.workTreeBytes / 1024).toFixed(1)},${s.indexEntries},${s.conflictEntries},${s.objectCount},${(s.objectBytes / 1024).toFixed(1)}`,
			);
		}
		return;
	}

	console.log(
		`\n=== Repo Size: ${dbName} (${traceIds.length} trace${traceIds.length !== 1 ? "s" : ""}, sampled every ${sampleEvery} steps) ===\n`,
	);

	if (traceIds.length === 1) {
		sizePrintGrowthTable(allSamples);
	} else {
		sizePrintSummaryTable(allSamples, traceIds);
	}

	sizePrintPeaks(allSamples, traceIds.length > 1);
}

function printSizeUsage(): void {
	console.log(`Usage: bun oracle size [name] [trace] [options]

Replay traces and measure repo size at regular intervals.
Shows worktree file count/bytes, index entries, object store stats.

Options:
  --every <n>   Sample every N steps (default: 200)
  --csv         Output raw CSV to stdout (pipe to file)

Examples:
  size stress              # all traces, sample every 200 steps
  size stress 1            # single trace
  size stress --every 500  # coarser sampling for faster runs
  size stress --csv        # raw data for external analysis`);
}

function sizePrintGrowthTable(samples: Array<SizeSample & { traceId: number }>): void {
	const W = {
		step: 8,
		files: 7,
		wt: 9,
		idx: 7,
		conf: 9,
		obj: 9,
		ob: 10,
	};
	const hdr = [
		"Step".padStart(W.step),
		"Files".padStart(W.files),
		"WT Size".padStart(W.wt),
		"Index".padStart(W.idx),
		"Conflicts".padStart(W.conf),
		"Objects".padStart(W.obj),
		"Obj Store".padStart(W.ob),
	].join(" ");

	console.log("Repo growth over time:");
	console.log(`  ${hdr}`);
	console.log(`  ${"─".repeat(hdr.length)}`);
	for (const s of samples) {
		console.log(
			`  ${String(s.seq).padStart(W.step)} ${String(s.workTreeFiles).padStart(W.files)} ${fmtBytes(s.workTreeBytes).padStart(W.wt)} ${String(s.indexEntries).padStart(W.idx)} ${String(s.conflictEntries).padStart(W.conf)} ${String(s.objectCount).padStart(W.obj)} ${fmtBytes(s.objectBytes).padStart(W.ob)}`,
		);
	}
	console.log("");
}

function sizePrintSummaryTable(
	samples: Array<SizeSample & { traceId: number }>,
	traceIds: number[],
): void {
	console.log("Per-trace peak stats:");
	const W = {
		tr: 8,
		files: 7,
		wt: 9,
		idx: 7,
		conf: 9,
		obj: 9,
		ob: 10,
	};
	const hdr = [
		"Trace".padStart(W.tr),
		"Files".padStart(W.files),
		"WT Size".padStart(W.wt),
		"Index".padStart(W.idx),
		"Conflicts".padStart(W.conf),
		"Objects".padStart(W.obj),
		"Obj Store".padStart(W.ob),
	].join(" ");
	console.log(`  ${hdr}`);
	console.log(`  ${"─".repeat(hdr.length)}`);

	for (const tid of traceIds) {
		const ts = samples.filter((s) => s.traceId === tid);
		if (ts.length === 0) continue;
		console.log(
			`  ${String(tid).padStart(W.tr)} ${String(Math.max(...ts.map((s) => s.workTreeFiles))).padStart(W.files)} ${fmtBytes(Math.max(...ts.map((s) => s.workTreeBytes))).padStart(W.wt)} ${String(Math.max(...ts.map((s) => s.indexEntries))).padStart(W.idx)} ${String(Math.max(...ts.map((s) => s.conflictEntries))).padStart(W.conf)} ${String(Math.max(...ts.map((s) => s.objectCount))).padStart(W.obj)} ${fmtBytes(Math.max(...ts.map((s) => s.objectBytes))).padStart(W.ob)}`,
		);
	}
	console.log("");
}

function sizePrintPeaks(
	samples: Array<SizeSample & { traceId: number }>,
	multiTrace: boolean,
): void {
	const peakFiles = samples.reduce((max, s) => (s.workTreeFiles > max.workTreeFiles ? s : max));
	const peakBytes = samples.reduce((max, s) => (s.workTreeBytes > max.workTreeBytes ? s : max));
	const peakIndex = samples.reduce((max, s) => (s.indexEntries > max.indexEntries ? s : max));
	const peakConflicts = samples.reduce((max, s) =>
		s.conflictEntries > max.conflictEntries ? s : max,
	);
	const peakObjects = samples.reduce((max, s) => (s.objectCount > max.objectCount ? s : max));
	const peakObjBytes = samples.reduce((max, s) => (s.objectBytes > max.objectBytes ? s : max));
	const final = samples[samples.length - 1];

	const loc = (s: SizeSample & { traceId: number }) =>
		multiTrace ? `trace ${s.traceId} step ${s.seq}` : `step ${s.seq}`;

	console.log("Peak values:");
	console.log(`  Worktree files:    ${peakFiles.workTreeFiles} (${loc(peakFiles)})`);
	console.log(`  Worktree size:     ${fmtBytes(peakBytes.workTreeBytes)} (${loc(peakBytes)})`);
	console.log(`  Index entries:     ${peakIndex.indexEntries} (${loc(peakIndex)})`);
	console.log(`  Conflict entries:  ${peakConflicts.conflictEntries} (${loc(peakConflicts)})`);
	console.log(`  Object count:      ${peakObjects.objectCount} (${loc(peakObjects)})`);
	console.log(`  Object store size: ${fmtBytes(peakObjBytes.objectBytes)} (${loc(peakObjBytes)})`);
	if (final) {
		console.log(`\nFinal state (${loc(final)}):`);
		console.log(`  ${final.workTreeFiles} files, ${fmtBytes(final.workTreeBytes)} worktree`);
		console.log(`  ${final.indexEntries} index + ${final.conflictEntries} conflicts`);
		console.log(`  ${final.objectCount} objects, ${fmtBytes(final.objectBytes)} store`);
	}
	console.log("");
}

function fmtBytes(bytes: number): string {
	if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
	if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
	if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${bytes}B`;
}

// ── planner-inspect ──────────────────────────────────────────────

async function cmdPlannerInspect(args: string[]): Promise<void> {
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

// ── clean ────────────────────────────────────────────────────────

const TEMP_PREFIXES = ["oracle-git-", "oracle-home-", "replay-git-", "replay-home-"];

async function cmdClean(_args: string[]): Promise<void> {
	const tmp = tmpdir();
	const entries = await readdir(tmp);
	const stale = entries.filter((name) => TEMP_PREFIXES.some((p) => name.startsWith(p)));

	if (stale.length === 0) {
		console.log("No leftover oracle temp directories found.");
		return;
	}

	console.log(
		`Removing ${stale.length} temp director${stale.length === 1 ? "y" : "ies"} from ${tmp}:\n`,
	);
	for (const name of stale.sort()) {
		const full = join(tmp, name);
		await rm(full, { recursive: true, force: true });
		console.log(`  ${name}`);
	}
	console.log("\nDone.");
}

// ── summary ──────────────────────────────────────────────────────

interface SummaryEntry {
	set: string;
	trace: number;
	type: "WARN" | "KNOWN" | "FAIL";
	command: string;
	detail: string;
	pattern: string | null;
}

function cmdSummary(_args: string[]): void {
	const entries: SummaryEntry[] = [];
	const setStats = new Map<string, { traces: number; steps: number }>();
	let dirs: string[];
	try {
		dirs = readdirSync(DATA_DIR, { withFileTypes: true })
			.filter((d) => d.isDirectory())
			.map((d) => d.name)
			.sort();
	} catch {
		console.log(`No data directory found at ${DATA_DIR}`);
		process.exit(1);
	}

	for (const dir of dirs) {
		const logPath = join(DATA_DIR, dir, "test-results.log");
		let content: string;
		try {
			content = readFileSync(logPath, "utf-8");
		} catch {
			continue;
		}

		let dirTraces = 0;
		let dirSteps = 0;

		const lines = content.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];

			const passMatch = line.match(/^\s+PASS\s+trace\s+\d+\s+(\d+)\s+steps/);
			if (passMatch) {
				dirTraces++;
				dirSteps += parseInt(passMatch[1], 10);
				continue;
			}

			const m = line.match(/^\s+(WARN|KNOWN|FAIL)\s+trace\s+(\d+)\s+(.+)$/);
			if (!m) continue;
			const type = m[1] as SummaryEntry["type"];
			const trace = parseInt(m[2], 10);
			const command = m[3].trim();

			dirTraces++;

			const stepsFullMatch = command.match(/^(\d+)\s+steps/);
			const stepsPartialMatch = command.match(/^step\s+(\d+)\/(\d+)/);
			if (stepsFullMatch) {
				dirSteps += parseInt(stepsFullMatch[1], 10);
			} else if (stepsPartialMatch) {
				dirSteps += parseInt(stepsPartialMatch[1], 10);
			}

			const detailLine = (lines[i + 1] ?? "").trim();
			const colonIdx = detailLine.indexOf(":");
			const pattern = colonIdx > 0 ? detailLine.slice(0, colonIdx).trim() : null;

			entries.push({ set: dir, trace, type, command, detail: detailLine, pattern });
		}

		if (dirTraces > 0) {
			setStats.set(dir, { traces: dirTraces, steps: dirSteps });
		}
	}

	const allSetNames = [...setStats.keys()].sort();

	if (allSetNames.length === 0) {
		console.log("No test-results.log files found.");
		return;
	}

	const byType = new Map<string, SummaryEntry[]>();
	const byPattern = new Map<string, SummaryEntry[]>();
	for (const e of entries) {
		let arr = byType.get(e.type);
		if (!arr) {
			arr = [];
			byType.set(e.type, arr);
		}
		arr.push(e);

		const key = e.pattern ?? e.detail;
		let parr = byPattern.get(key);
		if (!parr) {
			parr = [];
			byPattern.set(key, parr);
		}
		parr.push(e);
	}

	console.log("\n══ Oracle Test Results — Aggregate Summary ══\n");

	// Per-set table
	const setTable = allSetNames.map((name) => {
		const se = entries.filter((e) => e.set === name);
		const stats = setStats.get(name) ?? { traces: 0, steps: 0 };
		return {
			set: name,
			traces: stats.traces,
			steps: stats.steps,
			warn: se.filter((e) => e.type === "WARN").length,
			known: se.filter((e) => e.type === "KNOWN").length,
			fail: se.filter((e) => e.type === "FAIL").length,
		};
	});

	const maxName = Math.max(...setTable.map((r) => r.set.length), 3);
	console.log("Per-set overview:");
	console.log(`  ${"Set".padEnd(maxName)}  Traces   Steps  WARN  KNOWN  FAIL`);
	console.log(`  ${"─".repeat(maxName)}  ──────  ──────  ────  ─────  ────`);
	for (const r of setTable) {
		console.log(
			`  ${r.set.padEnd(maxName)}  ${String(r.traces).padStart(6)}  ${String(r.steps).padStart(6)}  ${String(r.warn).padStart(4)}  ${String(r.known).padStart(5)}  ${String(r.fail).padStart(4)}`,
		);
	}
	const totals = setTable.reduce(
		(acc, r) => ({
			traces: acc.traces + r.traces,
			steps: acc.steps + r.steps,
			warn: acc.warn + r.warn,
			known: acc.known + r.known,
			fail: acc.fail + r.fail,
		}),
		{ traces: 0, steps: 0, warn: 0, known: 0, fail: 0 },
	);
	console.log(`  ${"─".repeat(maxName)}  ──────  ──────  ────  ─────  ────`);
	console.log(
		`  ${"TOTAL".padEnd(maxName)}  ${String(totals.traces).padStart(6)}  ${String(totals.steps).padStart(6)}  ${String(totals.warn).padStart(4)}  ${String(totals.known).padStart(5)}  ${String(totals.fail).padStart(4)}`,
	);

	// By type
	console.log("\nBy type:");
	for (const type of ["FAIL", "WARN", "KNOWN"] as const) {
		console.log(`  ${type}: ${(byType.get(type) ?? []).length}`);
	}

	// By pattern
	console.log("\nBy pattern:");
	const sortedPatterns = [...byPattern.entries()].sort((a, b) => b[1].length - a[1].length);
	for (const [pattern, group] of sortedPatterns) {
		const types = {
			WARN: group.filter((e) => e.type === "WARN").length,
			KNOWN: group.filter((e) => e.type === "KNOWN").length,
			FAIL: group.filter((e) => e.type === "FAIL").length,
		};
		const parts: string[] = [];
		if (types.KNOWN) parts.push(`${types.KNOWN} known`);
		if (types.WARN) parts.push(`${types.WARN} warn`);
		if (types.FAIL) parts.push(`${types.FAIL} fail`);

		console.log(`  ${pattern}  (${group.length} total: ${parts.join(", ")})`);
		const perSet = new Map<string, number>();
		for (const e of group) perSet.set(e.set, (perSet.get(e.set) ?? 0) + 1);
		const setParts = [...perSet.entries()]
			.sort((a, b) => b[1] - a[1])
			.map(([s, n]) => `${s}: ${n}`);
		console.log(`    sets: ${setParts.join(", ")}`);
	}

	// FAIL details
	const fails = byType.get("FAIL") ?? [];
	if (fails.length > 0) {
		console.log("\nFAIL details:");
		for (const f of fails) {
			console.log(`  [${f.set}] trace ${f.trace}  ${f.command}`);
			console.log(`    ${f.detail}`);
		}
	}

	// WARN details
	const warns = byType.get("WARN") ?? [];
	if (warns.length > 0) {
		console.log("\nWARN details:");
		for (const w of warns) {
			console.log(`  [${w.set}] trace ${w.trace}  ${w.command}`);
			console.log(`    ${w.detail}`);
		}
	}

	console.log("");
}

// ── Main dispatch ────────────────────────────────────────────────

const USAGE = `Usage: bun oracle <command> [args]

Commands:
  generate [name] --seeds <spec>    Create oracle traces from real git
  test [name] [trace]               Replay and compare against oracle
  profile [name] [trace]            Profile command execution times
  size [name] [trace]               Measure repo size growth over time
  inspect <name> <trace> <step>     Examine a step with oracle + impl diff
  trace-context <name> <trace> <step> [--before N]
                                    Show prior commands around a step
  diff-worktree <name> <trace> <step> [--limit N]
                                    Diff oracle vs impl worktree paths
  diff-file <name> <trace> <step> <path>
                                    Show first mismatch for one file
  conflict-blobs <name> <trace> <step> <path> [--full]
                                    Show stage 1/2/3 blob details
  rebuild <name> <trace> <step>     Materialize a real git repo at a step
  planner-inspect <name> <trace> <step>
                                    Compare planner output vs real git rev-list
  summary                           Aggregate WARN/KNOWN/FAIL counts across all sets
  clean                             Remove leftover temp directories

The first argument after the subcommand is always the database name.
Databases are stored at data/<name>/traces.sqlite.

Run any command without arguments for detailed help.`;

if (import.meta.main) {
	const args = process.argv.slice(2);
	const command = args[0];
	const rest = args.slice(1);

	switch (command) {
		case "generate":
			await cmdGenerate(rest);
			break;
		case "test":
			await cmdTest(rest);
			break;
		case "inspect":
			await cmdInspect(rest);
			break;
		case "trace-context":
			await cmdTraceContext(rest);
			break;
		case "diff-worktree":
			await cmdDiffWorktree(rest);
			break;
		case "diff-file":
			await cmdDiffFile(rest);
			break;
		case "conflict-blobs":
			await cmdConflictBlobs(rest);
			break;
		case "rebuild":
			await cmdRebuild(rest);
			break;
		case "profile":
			await cmdProfile(rest);
			break;
		case "size":
			await cmdSize(rest);
			break;
		case "planner-inspect":
			await cmdPlannerInspect(rest);
			break;
		case "summary":
			cmdSummary(rest);
			break;
		case "clean":
			await cmdClean(rest);
			break;
		default:
			console.log(USAGE);
			process.exit(command ? 1 : 0);
	}
}
