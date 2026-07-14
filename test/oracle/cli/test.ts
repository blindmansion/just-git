import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { parseSeeds } from "../generate";
import { dbPath } from "./shared/args";
import { parseArgs } from "./shared/args";
import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { color, fmt, stripAnsi, truncateCommand } from "./shared/format";
import { replayAndCheck } from "../impl-harness";
import { runPostMortem } from "../post-mortem";

export async function cmdTest(args: string[]): Promise<void> {
	const { positional, getOpt, hasFlag } = parseArgs(args);

	// Positional: [path] [trace]
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
