import type { CommandTiming } from "../impl-harness";
import { dbPath, parseArgs } from "./shared/args";
import { Database } from "bun:sqlite";
import { replayWithTiming } from "../impl-harness";
import { fmtMs, truncateCommand } from "./shared/format";

interface ProfileTiming extends CommandTiming {
	traceId: number;
}

export async function cmdProfile(args: string[]): Promise<void> {
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
	console.log(`Usage: bun oracle profile [path] [trace] [options]

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

function profileBaseCommand(command: string): string {
	if (command.startsWith("FILE_")) return command.split(":")[0];
	return command.split(/\s+/).slice(0, 2).join(" ");
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
