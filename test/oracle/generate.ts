#!/usr/bin/env bun
/**
 * Generate oracle traces by running the random walker against real git.
 *
 * Usage:
 *   bun oracle generate --db traces.sqlite --seeds 1-10 --steps 300
 *   bun oracle generate --db traces.sqlite --seeds 1,2,42 --steps 500
 *   bun oracle generate --db traces.sqlite --seeds 1-5 --steps 200 --preset rebase-heavy
 *
 * Presets control which actions are enabled and their weight multipliers.
 * Custom configurations can import generateTraces() directly.
 */

import { ALL_ACTIONS } from "../random/actions/index";
import {
	DEFAULT_FILE_GEN_CONFIG,
	DEFAULT_GITIGNORE_PATTERNS,
	type FileGenConfig,
	STRESS_FILE_GEN_CONFIG,
	WIDE_FILE_GEN_CONFIG,
} from "../random/file-gen";
import type { ExecResult, WalkHarness } from "../random/harness";
import { SeededRNG } from "../random/rng";
import type { Action, ActionCategory, FuzzConfig } from "../random/types";
import { pickAction, queryState } from "../random/walker";
import { captureSnapshot, type GitSnapshot } from "./capture";
import { del, isCommitCommand, serializeFileOpBatch, serializeFileResolve, write } from "./fileops";
import { RealGitHarness } from "./real-harness";
import { initDb } from "./schema";
import { diffSnapshot, EMPTY_SNAPSHOT } from "./snapshot-delta";
import { OracleStore } from "./store";

// ── Trace config (stored per-trace in DB) ────────────────────────

/** Configuration bundle serialized into the traces table. */
export interface TraceConfig {
	chaosRate: number;
	fileGen: FileGenConfig;
	/** Per-picker-type probability of injecting wrong values. */
	fuzz?: FuzzConfig;
	/** When set, traces start with `git clone <url> .` instead of `git init`. */
	cloneUrl?: string;
}

// ── Recording harness ────────────────────────────────────────────

/**
 * Wraps a WalkHarness and records every operation as an oracle command string.
 * After each git command, captures a snapshot of the real repo state.
 */
class RecordingHarness implements WalkHarness {
	/** Accumulated commands for the current walker step. */
	private buffer: { command: string; result: ExecResult | null }[] = [];
	/** Previous full snapshot for computing deltas. */
	private prevSnapshot: GitSnapshot = EMPTY_SNAPSHOT;

	constructor(
		private readonly inner: RealGitHarness,
		private readonly store: OracleStore,
		private readonly traceId: number,
		private seq: number = 0,
	) {}

	async git(command: string, envOverride?: Record<string, string>): Promise<ExecResult> {
		// Commit-creating commands need incrementing timestamps to match replay
		let env = envOverride;
		if (!env && isCommitCommand(command)) {
			this.inner.commitCounter++;
			const ts = `${1000000000 + this.inner.commitCounter} +0000`;
			env = { GIT_AUTHOR_DATE: ts, GIT_COMMITTER_DATE: ts };
		}
		const result = await this.inner.git(command, env);
		this.buffer.push({ command: `git ${command}`, result });
		return result;
	}

	async gitCommit(message: string): Promise<ExecResult> {
		const result = await this.inner.gitCommit(message);
		this.buffer.push({
			command: `git commit -m "${message}"`,
			result,
		});
		return result;
	}

	// ── Individual file ops (for conflict resolution writes) ─────

	async writeFile(relPath: string, content: string): Promise<void> {
		await this.inner.writeFile(relPath, content);
		this.buffer.push({ command: write(relPath, content), result: null });
	}

	async readFile(relPath: string): Promise<string> {
		return this.inner.readFile(relPath);
	}

	async spliceFile(
		relPath: string,
		content: string,
		offset: number,
		deleteCount: number,
	): Promise<void> {
		await this.inner.spliceFile(relPath, content, offset, deleteCount);
		this.buffer.push({
			command: write(relPath, content, offset, deleteCount),
			result: null,
		});
	}

	async deleteFile(relPath: string): Promise<void> {
		await this.inner.deleteFile(relPath);
		this.buffer.push({ command: del(relPath), result: null });
	}

	// ── Seed-based batch (the common path) ───────────────────────

	async applyFileOpBatch(seed: number, files: string[]): Promise<void> {
		// Apply ops on the real harness (bypasses recording of individual ops)
		await this.inner.applyFileOpBatch(seed, files);
		// Record just the seed
		this.buffer.push({
			command: serializeFileOpBatch(seed),
			result: null,
		});
	}

	// ── Seed-based resolve (conflict resolution) ─────────────────

	async resolveFiles(seed: number): Promise<void> {
		await this.inner.resolveFiles(seed);
		this.buffer.push({
			command: serializeFileResolve(seed),
			result: null,
		});
	}

	/**
	 * Flush the buffer: write all accumulated ops to the DB.
	 * Captures a snapshot after the last git command in the batch,
	 * or after the last op if there were no git commands.
	 */
	async flush(): Promise<void> {
		if (this.buffer.length === 0) return;

		// Find the last git command index for snapshot placement
		let snapshotIdx = -1;
		for (let i = this.buffer.length - 1; i >= 0; i--) {
			if (this.buffer[i].result !== null) {
				snapshotIdx = i;
				break;
			}
		}
		// If no git commands, snapshot after the last op
		if (snapshotIdx === -1) snapshotIdx = this.buffer.length - 1;

		let snapshot: GitSnapshot | null = null;

		for (let i = 0; i < this.buffer.length; i++) {
			const { command, result } = this.buffer[i];

			if (i === snapshotIdx) {
				snapshot = await captureSnapshot(this.inner.repoDir);
				const delta = diffSnapshot(this.prevSnapshot, snapshot);
				this.store.recordStep(
					this.traceId,
					this.seq,
					{
						command,
						exitCode: result?.exitCode ?? 0,
						stdout: result?.stdout ?? "",
						stderr: result?.stderr ?? "",
					},
					delta,
				);
				this.prevSnapshot = snapshot;
			} else {
				// Placeholder: stored as-is so isPlaceholder (workTreeHash === "") still works
				this.store.recordStep(
					this.traceId,
					this.seq,
					{
						command,
						exitCode: result?.exitCode ?? 0,
						stdout: result?.stdout ?? "",
						stderr: result?.stderr ?? "",
					},
					EMPTY_SNAPSHOT,
				);
			}
			this.seq++;
		}
		this.buffer = [];
	}

	// ── State queries delegate directly ──────────────────────────

	listWorkTreeFiles() {
		return this.inner.listWorkTreeFiles();
	}
	listBranches() {
		return this.inner.listBranches();
	}
	getCurrentBranch() {
		return this.inner.getCurrentBranch();
	}
	isInMergeConflict() {
		return this.inner.isInMergeConflict();
	}
	isInCherryPickConflict() {
		return this.inner.isInCherryPickConflict();
	}
	isInRevertConflict() {
		return this.inner.isInRevertConflict();
	}
	isInRebaseConflict() {
		return this.inner.isInRebaseConflict();
	}
	hasCommits() {
		return this.inner.hasCommits();
	}
	getStashCount() {
		return this.inner.getStashCount();
	}
}

// ── Generation engine ────────────────────────────────────────────

interface GenerateConfig {
	/** Path to the output SQLite database. */
	dbPath: string;
	/** Seeds to generate traces for. */
	seeds: number[];
	/** Number of walker steps per seed. */
	steps: number;
	/** Actions to use. Defaults to ALL_ACTIONS. */
	actions?: readonly Action[];
	/** Probability (0-1) of bypassing soft preconditions per step. Default 0. */
	chaosRate?: number;
	/** Per-picker-type probability of injecting wrong values. */
	fuzz?: FuzzConfig;
	/** File generation config. Defaults to DEFAULT_FILE_GEN_CONFIG. */
	fileGen?: FileGenConfig;
	/** Optional description stored in the trace metadata. */
	description?: string;
	/** When set, traces start with `git clone <url> .` instead of `git init`. */
	cloneUrl?: string;
}

/**
 * Generate oracle traces for the given seeds.
 * Runs the random walker against real git, recording every operation
 * and capturing snapshots into the oracle database.
 */
export async function generateTraces(config: GenerateConfig): Promise<void> {
	const { dbPath, seeds, steps, description, cloneUrl, fuzz } = config;
	const actions = config.actions ?? ALL_ACTIONS;
	const chaosRate = config.chaosRate ?? 0;
	const fileGen = config.fileGen ?? DEFAULT_FILE_GEN_CONFIG;
	const traceConfig: TraceConfig = { chaosRate, fileGen, fuzz, cloneUrl };

	const db = initDb(dbPath);
	const store = new OracleStore(db);

	const total = seeds.length;
	let completed = 0;

	let activeHarness: RealGitHarness | null = null;

	const cleanup = async () => {
		if (activeHarness) {
			await activeHarness.cleanup();
			activeHarness = null;
		}
		db.close();
	};

	const onSignal = () => {
		cleanup().finally(() => process.exit(1));
	};
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);

	try {
		for (const seed of seeds) {
			const t0 = performance.now();
			const harness = await RealGitHarness.create(fileGen);
			activeHarness = harness;

			const traceId = store.createTrace(
				seed,
				description ?? `seed=${seed} steps=${steps} actions=${actions.length}`,
				traceConfig,
			);
			const recorder = new RecordingHarness(harness, store, traceId);

			try {
				await runRecordedWalk(recorder, seed, steps, actions, chaosRate, cloneUrl, fuzz);
			} finally {
				await harness.cleanup();
				activeHarness = null;
			}

			completed++;
			const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
			console.log(`  [${completed}/${total}] seed ${seed}: ${steps} steps in ${elapsed}s`);
		}
	} finally {
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
		db.close();
	}

	console.log(`\nWrote ${total} traces to ${dbPath}`);
}

/**
 * Run the walker loop with recording.
 */
async function runRecordedWalk(
	recorder: RecordingHarness,
	seed: number,
	steps: number,
	actions: readonly Action[],
	chaosRate: number,
	cloneUrl?: string,
	fuzz?: FuzzConfig,
): Promise<void> {
	const rng = new SeededRNG(seed);

	if (cloneUrl) {
		await recorder.git(`clone ${cloneUrl} .`);
		await recorder.flush();
	} else {
		await recorder.git("init");
		await recorder.flush();

		await recorder.writeFile("initial.txt", `seed-${seed}\n`);
		await recorder.flush();
	}

	for (let step = 1; step <= steps; step++) {
		const state = await queryState(recorder);
		const action = pickAction(rng, state, actions, chaosRate);
		if (!action) continue;

		await action.execute(recorder, rng, state, fuzz);
		await recorder.flush();
	}
}

// ── Action presets ───────────────────────────────────────────────

interface Preset {
	actions: readonly Action[];
	chaosRate?: number;
	fuzz?: FuzzConfig;
	fileGen?: FileGenConfig;
	cloneUrl?: string;
}

/** Multiply weights for all actions in a category. */
function boostCategory(
	actions: readonly Action[],
	category: ActionCategory,
	multiplier: number,
): readonly Action[] {
	return actions.map((a) => {
		if (a.category === category) {
			return {
				...a,
				weight: (s: Parameters<Action["weight"]>[0]) => a.weight(s) * multiplier,
			};
		}
		return a;
	});
}

/** Remove actions by name. */
function excludeNames(actions: readonly Action[], ...names: string[]): readonly Action[] {
	return actions.filter((a) => !names.includes(a.name));
}

/** Keep only actions matching the given names. */
function includeNames(actions: readonly Action[], ...names: string[]): readonly Action[] {
	return actions.filter((a) => names.includes(a.name));
}

const FUZZ_LIGHT: FuzzConfig = {
	branchRate: 0.03,
	fileRate: 0.03,
	commitRate: 0.03,
	tagRate: 0.03,
	remoteRate: 0.03,
};

const FUZZ_HEAVY: FuzzConfig = {
	branchRate: 0.08,
	fileRate: 0.1,
	commitRate: 0.08,
	tagRate: 0.08,
	remoteRate: 0.08,
};

/** ~60 daily-use actions for the core preset family. */
const CORE_ACTIONS = includeNames(
	ALL_ACTIONS,
	// file-ops
	"fileOps",
	// staging
	"addAll",
	"addAllFlag",
	"addSpecific",
	"addUpdate",
	"rmFile",
	// commit
	"commit",
	"commitAll",
	"commitAmend",
	"commitAmendNoEdit",
	// branch
	"createBranch",
	"switchBranch",
	"deleteBranch",
	"branchForceDelete",
	"branchRename",
	"createBranchFromRef",
	"detachedCheckout",
	"checkoutFile",
	// merge
	"merge",
	"mergeAbort",
	"mergeContinue",
	// rebase
	"rebase",
	"rebaseAbort",
	"rebaseContinue",
	"rebaseSkip",
	// cherry-pick
	"cherryPick",
	"cherryPickAbort",
	"cherryPickContinue",
	// revert
	"revert",
	"revertAbort",
	"revertContinue",
	// conflict resolution
	"resolveAndCommit",
	"resolvePartial",
	"checkoutOursTheirs",
	// stash
	"stashPush",
	"stashPop",
	"stashApply",
	"stashDrop",
	// tag
	"createTag",
	"deleteTag",
	// reset
	"resetMixed",
	"resetHard",
	"resetSoft",
	"resetFile",
	// clean
	"cleanWorkTree",
	// switch (modern branch switching)
	"switchBranchViaSwitch",
	"switchCreate",
	// restore
	"restoreWorktree",
	"restoreStaged",
	// diagnostics
	"statusVariant",
	"diffUnstaged",
	"diffCached",
	"logVariant",
	"logRef",
	"branchList",
	"branchListVerbose",
	"listTags",
	"reflogShow",
	"lsFiles",
);

export const PRESETS: Record<string, Preset> = {
	/** All actions, default config. */
	default: { actions: ALL_ACTIONS },

	/** All actions including rebase — same as default. */
	basic: { actions: ALL_ACTIONS },

	/**
	 * Core daily-use commands (~60 actions). Covers add/commit/branch/merge/
	 * rebase plus revert, tags, rm, clean, restore, and detached checkout.
	 * Light chaos and fuzz for error-path coverage without full-set noise.
	 */
	core: {
		actions: CORE_ACTIONS,
		chaosRate: 0.05,
		fuzz: FUZZ_LIGHT,
	},

	/** Heavy on rebase operations. */
	"rebase-heavy": {
		actions: boostCategory(ALL_ACTIONS, "rebase", 3),
	},

	/** Heavy on merge operations. */
	"merge-heavy": {
		actions: boostCategory(ALL_ACTIONS, "merge", 3),
	},

	/** Cherry-pick focused. */
	"cherry-pick-heavy": {
		actions: boostCategory(ALL_ACTIONS, "cherry-pick", 3),
	},

	/** Excludes mv and show — avoids rename-detection ambiguity and combined-diff non-determinism. */
	"no-rename-show": {
		actions: excludeNames(ALL_ACTIONS, "mvFile", "showHead"),
	},

	/** Excludes show only — allows mv/rename, avoids combined-diff non-determinism. */
	"no-show": {
		actions: excludeNames(ALL_ACTIONS, "showHead"),
	},

	/** Wider file generation: deeper nesting, larger files, some empties. */
	"wide-files": { actions: ALL_ACTIONS, fileGen: WIDE_FILE_GEN_CONFIG },

	/** Chaos mode: ~12% chance of bypassing soft preconditions per step. */
	chaos: { actions: ALL_ACTIONS, chaosRate: 0.12 },

	/** Heavier chaos: ~20% chance of bypassing soft preconditions. */
	"chaos-heavy": { actions: ALL_ACTIONS, chaosRate: 0.2 },

	/** Clone from DeabLabs/cannoli on GitHub, then run random walks. */
	"clone-cannoli": {
		actions: excludeNames(ALL_ACTIONS, "showHead"),
		cloneUrl: "https://github.com/DeabLabs/cannoli.git",
	},

	/** Core actions against a cloned cannoli repo. Requires network. */
	"clone-core": {
		actions: CORE_ACTIONS,
		chaosRate: 0.05,
		fuzz: FUZZ_LIGHT,
		cloneUrl: "https://github.com/DeabLabs/cannoli.git",
	},

	/** Light fuzz: 3% wrong-value injection across all picker types. */
	"fuzz-light": { actions: ALL_ACTIONS, fuzz: FUZZ_LIGHT },

	/** Heavy fuzz: 8-10% wrong-value injection for stress-testing error paths. */
	"fuzz-heavy": { actions: ALL_ACTIONS, fuzz: FUZZ_HEAVY },

	/** Chaos + fuzz combined. */
	"chaos-fuzz": {
		actions: ALL_ACTIONS,
		chaosRate: 0.12,
		fuzz: FUZZ_LIGHT,
	},

	/** Gitignore generation: 5% chance per file-op batch. */
	gitignore: {
		actions: ALL_ACTIONS,
		fileGen: {
			...DEFAULT_FILE_GEN_CONFIG,
			gitignore: {
				rate: 0.05,
				subdirRate: 0.3,
				patterns: DEFAULT_GITIGNORE_PATTERNS,
			},
		},
	},

	/** Kitchen sink: chaos + light fuzz + gitignore. Good general-purpose validation.
	 *  Excludes cherryPickNoCommit — cherry-pick -n leaves merge results in the
	 *  index without committing, so rename-detection tie-breaking differences
	 *  cascade through every subsequent operation, poisoning ~90% of traces. */
	kitchen: {
		actions: excludeNames(ALL_ACTIONS, "cherryPickNoCommit"),
		chaosRate: 0.12,
		fuzz: FUZZ_LIGHT,
		fileGen: {
			...DEFAULT_FILE_GEN_CONFIG,
			gitignore: {
				rate: 0.05,
				subdirRate: 0.3,
				patterns: DEFAULT_GITIGNORE_PATTERNS,
			},
		},
	},

	/**
	 * Stress test: builds very large repos to surface performance degradation.
	 * Large file batches (8-25 per op), big files (40-250 lines), 16 directory
	 * prefixes, heavy create bias (60% create, 30% edit, 10% delete).
	 * Boosts file-ops/commit/staging 2x, reduces diagnostics/clean/reset to 0.3x.
	 * Best with high step counts (2000-5000).
	 */
	stress: {
		actions: boostCategory(
			boostCategory(
				boostCategory(
					boostCategory(
						boostCategory(
							boostCategory(excludeNames(ALL_ACTIONS, "showHead"), "file-ops", 2),
							"commit",
							2,
						),
						"staging",
						1.5,
					),
					"diagnostic",
					0.3,
				),
				"clean",
				0.3,
			),
			"reset",
			0.5,
		),
		fileGen: STRESS_FILE_GEN_CONFIG,
	},
};

// ── CLI ──────────────────────────────────────────────────────────

export function parseSeeds(input: string): number[] {
	const seeds: number[] = [];
	for (const part of input.split(",")) {
		const trimmed = part.trim();
		if (trimmed.includes("-")) {
			const [startStr, endStr] = trimmed.split("-");
			const start = parseInt(startStr, 10);
			const end = parseInt(endStr, 10);
			for (let i = start; i <= end; i++) seeds.push(i);
		} else {
			seeds.push(parseInt(trimmed, 10));
		}
	}
	return seeds;
}
