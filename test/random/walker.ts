import { ALL_ACTIONS } from "./actions/index";
import type { ExecResult, QueryState, WalkHarness } from "./harness";
import { SeededRNG } from "./rng";
import type { Action, FuzzConfig } from "./types";

// ── Types ────────────────────────────────────────────────────────────

/** One step in the walk log. */
interface StepEvent {
	step: number;
	action: string;
	description: string;
	result: ExecResult | null;
}

/** Configuration for a random walk. */
interface WalkConfig {
	/** Seed for the PRNG. Same seed = same sequence. */
	seed: number;
	/** Number of actions to take in the walk. */
	steps: number;
	/** Actions to use. Defaults to ALL_ACTIONS. */
	actions?: readonly Action[];
	/** Probability (0-1) of bypassing soft preconditions per step. Default 0. */
	chaosRate?: number;
	/** Per-picker-type probability of injecting wrong values. */
	fuzz?: FuzzConfig;
}

/** Optional callbacks that let consumers inject behavior into the walk. */
interface WalkOptions {
	/**
	 * Called after each step that produced a git command result.
	 * Throw to abort the walk (e.g. on exit code mismatch).
	 */
	onGitStep?: (event: StepEvent, log: StepEvent[]) => Promise<void>;

	/**
	 * How often to call onCheckpoint (every N steps).
	 * Only used when onCheckpoint is also provided.
	 */
	assertEvery?: number;

	/**
	 * Called every `assertEvery` steps for periodic state comparison.
	 * Throw to abort the walk on divergence.
	 */
	onCheckpoint?: (step: number, log: StepEvent[]) => Promise<void>;
}

// ── Utilities ────────────────────────────────────────────────────────

/** Query the current repo state from the harness. */
export async function queryState(harness: WalkHarness): Promise<QueryState> {
	const [
		files,
		branches,
		currentBranch,
		hasCommits,
		inMergeConflict,
		inCherryPickConflict,
		inRevertConflict,
		inRebaseConflict,
		stashCount,
	] = await Promise.all([
		harness.listWorkTreeFiles(),
		harness.listBranches(),
		harness.getCurrentBranch(),
		harness.hasCommits(),
		harness.isInMergeConflict(),
		harness.isInCherryPickConflict(),
		harness.isInRevertConflict(),
		harness.isInRebaseConflict(),
		harness.getStashCount(),
	]);
	return {
		files,
		branches,
		currentBranch,
		hasCommits,
		inMergeConflict,
		inCherryPickConflict,
		inRevertConflict,
		inRebaseConflict,
		stashCount,
	};
}

/** Pick an eligible action using weighted random selection. */
export function pickAction(
	rng: SeededRNG,
	state: QueryState,
	actions: readonly Action[] = ALL_ACTIONS,
	chaosRate = 0,
): Action | null {
	const chaos = chaosRate > 0 && rng.next() < chaosRate;
	const eligible = chaos
		? actions.filter((a) => a.canRun(state))
		: actions.filter((a) => a.canRun(state) && a.precondition(state));
	if (eligible.length === 0) return null;
	const weighted = eligible.map((a) => ({
		value: a,
		weight: a.weight(state),
	}));
	return rng.pickWeighted(weighted);
}

// ── Walk engine ──────────────────────────────────────────────────────

/**
 * Run a random walk through git commands.
 *
 * Initializes a repo, seeds it with one file, then executes
 * `config.steps` randomly-selected actions. Returns the full step log.
 *
 * Optional callbacks allow consumers to inject behavior (e.g. oracle
 * comparison) without the walk engine knowing about it.
 */
export async function runWalk(
	harness: WalkHarness,
	config: WalkConfig,
	options?: WalkOptions,
): Promise<StepEvent[]> {
	const { seed, steps, chaosRate, fuzz } = config;
	const actionSet = config.actions ?? ALL_ACTIONS;
	const rng = new SeededRNG(seed);
	const log: StepEvent[] = [];

	// Initialize the repo
	const initResult = await harness.git("init");
	const initEvent: StepEvent = {
		step: 0,
		action: "init",
		description: "git init",
		result: initResult,
	};
	log.push(initEvent);
	if (options?.onGitStep) await options.onGitStep(initEvent, log);

	// Seed the repo with at least one file
	await harness.writeFile("initial.txt", `seed-${seed}\n`);
	log.push({
		step: 0,
		action: "writeFile",
		description: "writeFile initial.txt (seed file)",
		result: null,
	});

	for (let step = 1; step <= steps; step++) {
		const state = await queryState(harness);
		const action = pickAction(rng, state, actionSet, chaosRate);

		if (!action) {
			log.push({
				step,
				action: "skip",
				description: "no eligible actions",
				result: null,
			});
			continue;
		}

		const outcome = await action.execute(harness, rng, state, fuzz);
		const event: StepEvent = {
			step,
			action: action.name,
			description: outcome.description,
			result: outcome.result,
		};
		log.push(event);

		// Notify after git commands
		if (outcome.result && options?.onGitStep) {
			await options.onGitStep(event, log);
		}

		// Periodic checkpoint
		if (options?.assertEvery && step % options.assertEvery === 0 && options.onCheckpoint) {
			await options.onCheckpoint(step, log);
		}
	}

	return log;
}
