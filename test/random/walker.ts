import { ALL_ACTIONS } from "./actions/index";
import type { ExecResult, QueryState, WalkHarness } from "./harness";
import { WorktreeView } from "./harness";
import { SeededRNG } from "./rng";
import type { Action, ActionCategory, FuzzConfig } from "./types";

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
	/**
	 * Probability (0-1) that a step runs inside a randomly chosen linked
	 * worktree instead of the primary one. Default 0 (always primary).
	 */
	worktreeRate?: number;
	/**
	 * Cap on concurrent linked worktrees. Worktree-creating actions are
	 * suppressed at/above this count so the walk builds a few deep checkouts
	 * rather than many shallow ones. Default Infinity (uncapped).
	 */
	maxWorktrees?: number;
	/**
	 * `[min, max]` consecutive steps to stay in a worktree once entered, so
	 * multi-step workflows (start op → resolve → continue → commit) complete in
	 * the same checkout. Default `[1, 1]` (independent per-step reselection).
	 */
	worktreeStickiness?: [number, number];
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
		inAmConflict,
		stashCount,
		remotes,
		worktrees,
	] = await Promise.all([
		harness.listWorkTreeFiles(),
		harness.listBranches(),
		harness.getCurrentBranch(),
		harness.hasCommits(),
		harness.isInMergeConflict(),
		harness.isInCherryPickConflict(),
		harness.isInRevertConflict(),
		harness.isInRebaseConflict(),
		harness.isInAmConflict(),
		harness.getStashCount(),
		harness.listRemotes(),
		harness.listWorktrees(),
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
		inAmConflict,
		stashCount,
		remotes,
		worktrees,
	};
}

// ── Worktree targeting ───────────────────────────────────────────────

/**
 * Action categories that only make sense from the primary worktree: worktree
 * management (`worktree add/remove/...` resolves sibling paths and `remove .`
 * relative to the main repo) and remote/network transport (base-URL wiring).
 * Everything else — staging, commit, branch, merge, rebase, stash, reset,
 * conflict resolution, diagnostics — operates on the current checkout and runs
 * unchanged inside a linked worktree.
 */
const PRIMARY_ONLY_CATEGORIES: ReadonlySet<ActionCategory> = new Set<ActionCategory>([
	"worktree",
	"remote",
]);

/** Actions that can run inside a linked worktree (excludes primary-only ones). */
export function worktreeSafeActions(actions: readonly Action[]): readonly Action[] {
	return actions.filter((a) => !PRIMARY_ONLY_CATEGORIES.has(a.category));
}

/**
 * Drop worktree-creating actions once the live-worktree count reaches `max`.
 * Keeps the worktree-management catalog (remove/prune/lock/guards/error paths)
 * eligible so churn and cross-worktree assertions still happen; only *growth*
 * is gated. A no-op below the cap.
 */
export function applyWorktreeCap(
	actions: readonly Action[],
	state: QueryState,
	max: number,
): readonly Action[] {
	if (state.worktrees.length < max) return actions;
	return actions.filter((a) => !a.createsWorktree);
}

/**
 * Per-step execution-target selector for the walk. With probability `rate` a
 * fresh decision enters a randomly chosen linked worktree (returning a
 * {@link WorktreeView}); otherwise the primary worktree (null). Once entered, a
 * worktree is held for a sticky run of `stickiness` steps so multi-step
 * workflows complete in place. The rng is only consumed once linked worktrees
 * exist, so a rate of 0 leaves the walk stream untouched.
 */
export class WorktreeTargeter {
	private sticky: { id: string; remaining: number } | null = null;

	constructor(
		private readonly rng: SeededRNG,
		private readonly rate: number,
		private readonly stickiness: [number, number] = [1, 1],
	) {}

	async select(harness: WalkHarness): Promise<WorktreeView | null> {
		if (this.rate <= 0) return null;
		const worktrees = await harness.listWorktrees();
		if (worktrees.length === 0) {
			this.sticky = null;
			return null;
		}
		// Continue an active sticky run if its worktree still exists. Sticky is
		// keyed by the stable admin id, but addressed by the worktree's *current*
		// path (which `worktree move` can change).
		const active = this.sticky;
		if (active && active.remaining > 0) {
			const held = worktrees.find((w) => w.id === active.id);
			if (held) {
				active.remaining -= 1;
				return new WorktreeView(harness, held.path);
			}
		}
		// Otherwise decide afresh whether to enter a worktree this step.
		this.sticky = null;
		if (this.rng.next() >= this.rate) return null;
		const wt = worktrees[this.rng.int(0, worktrees.length - 1)]!;
		const [lo, hi] = this.stickiness;
		const run = hi > 1 ? this.rng.int(lo, hi) : 1;
		this.sticky = { id: wt.id, remaining: run - 1 };
		return new WorktreeView(harness, wt.path);
	}
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
	const worktreeRate = config.worktreeRate ?? 0;
	const maxWorktrees = config.maxWorktrees ?? Number.POSITIVE_INFINITY;
	const rng = new SeededRNG(seed);
	const targeter = new WorktreeTargeter(rng, worktreeRate, config.worktreeStickiness);
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
		const target = await targeter.select(harness);
		const view = target ?? harness;
		const state = await queryState(view);
		const base = target ? worktreeSafeActions(actionSet) : actionSet;
		const eligible = applyWorktreeCap(base, state, maxWorktrees);
		const action = pickAction(rng, state, eligible, chaosRate);

		if (!action) {
			log.push({
				step,
				action: "skip",
				description: "no eligible actions",
				result: null,
			});
			continue;
		}

		const outcome = await action.execute(view, rng, state, fuzz);
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
