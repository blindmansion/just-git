import type { Database } from "bun:sqlite";
import type { TraceConfig } from "./generate";
import type { SnapshotDelta } from "./snapshot-delta";

interface StepResult {
	command: string;
	exitCode: number;
	stdout: string;
	stderr: string;
}

export class OracleStore {
	private db: Database;
	private insertTrace;
	private insertStep;

	constructor(db: Database) {
		this.db = db;
		this.insertTrace = db.prepare(
			`INSERT INTO traces (seed, description, config) VALUES ($seed, $description, $config)`,
		);
		this.insertStep = db.prepare(
			`INSERT INTO steps (trace_id, seq, command, exit_code, stdout, stderr, snapshot)
       VALUES ($traceId, $seq, $command, $exitCode, $stdout, $stderr, $snapshot)`,
		);
	}

	createTrace(seed: number, description?: string, config?: TraceConfig): number {
		const result = this.insertTrace.run({
			$seed: seed,
			$description: description ?? null,
			$config: config ? JSON.stringify(config) : null,
		});
		return Number(result.lastInsertRowid);
	}

	/** Get the trace config (returns null for legacy traces without config). */
	getTraceConfig(traceId: number): TraceConfig | null {
		const row = this.db
			.prepare(`SELECT config FROM traces WHERE trace_id = $traceId`)
			.get({ $traceId: traceId }) as { config: string | null } | null;
		if (!row?.config) return null;
		return JSON.parse(row.config) as TraceConfig;
	}

	recordStep(
		traceId: number,
		seq: number,
		stepResult: StepResult,
		snapshot: SnapshotDelta,
	): number {
		const result = this.insertStep.run({
			$traceId: traceId,
			$seq: seq,
			$command: stepResult.command,
			$exitCode: stepResult.exitCode,
			$stdout: stepResult.stdout,
			$stderr: stepResult.stderr,
			$snapshot: JSON.stringify(snapshot),
		});
		return Number(result.lastInsertRowid);
	}

	getTraceSteps(
		traceId: number,
	): { step_id: number; seq: number; command: string; exit_code: number }[] {
		return this.db
			.prepare(
				`SELECT step_id, seq, command, exit_code
         FROM steps WHERE trace_id = $traceId ORDER BY seq`,
			)
			.all({ $traceId: traceId }) as {
			step_id: number;
			seq: number;
			command: string;
			exit_code: number;
		}[];
	}

	/** List all traces in the database. */
	listTraces(): {
		trace_id: number;
		seed: number;
		description: string | null;
	}[] {
		return this.db
			.prepare(`SELECT trace_id, seed, description FROM traces ORDER BY trace_id`)
			.all() as {
			trace_id: number;
			seed: number;
			description: string | null;
		}[];
	}

	/** Get all snapshot deltas for a trace up to (and including) a given seq. */
	getSnapshotsUpTo(traceId: number, seq: number): { seq: number; snapshot: string }[] {
		return this.db
			.prepare(
				`SELECT seq, snapshot FROM steps
         WHERE trace_id = $traceId AND seq <= $seq ORDER BY seq`,
			)
			.all({ $traceId: traceId, $seq: seq }) as {
			seq: number;
			snapshot: string;
		}[];
	}

	/** Get full step data including stdout, stderr, and snapshot. */
	getFullStep(
		traceId: number,
		seq: number,
	): {
		step_id: number;
		seq: number;
		command: string;
		exit_code: number;
		stdout: string;
		stderr: string;
		snapshot: string;
	} | null {
		return (
			(this.db
				.prepare(
					`SELECT step_id, seq, command, exit_code, stdout, stderr, snapshot
         FROM steps WHERE trace_id = $traceId AND seq = $seq`,
				)
				.get({ $traceId: traceId, $seq: seq }) as {
				step_id: number;
				seq: number;
				command: string;
				exit_code: number;
				stdout: string;
				stderr: string;
				snapshot: string;
			} | null) ?? null
		);
	}
}
