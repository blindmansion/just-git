import { readFileSync } from "fs";
import { DATA_DIR, discoverDatasets, parseArgs } from "./shared/args";
import { join } from "path";

interface SummaryEntry {
	set: string;
	trace: number;
	type: "WARN" | "KNOWN" | "FAIL";
	command: string;
	detail: string;
	pattern: string | null;
}

export function cmdSummary(args: string[]): void {
	const { positional } = parseArgs(args);
	const prefix = positional[0];
	const entries: SummaryEntry[] = [];
	const setStats = new Map<string, { traces: number; steps: number }>();
	const dirs = discoverDatasets("test-results.log", prefix);

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
		console.log(`No test-results.log files found${prefix ? ` under ${prefix}` : ""}.`);
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
