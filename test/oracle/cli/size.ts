import { replayWithSize, type SizeSample } from "../impl-harness";
import { dbPath, parseArgs } from "./shared/args";
import { Database } from "bun:sqlite";
import { fmtBytes } from "./shared/format";

export async function cmdSize(args: string[]): Promise<void> {
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
	console.log(`Usage: bun oracle size [path] [trace] [options]

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
