import type { ExecResult, QueryState, WalkHarness } from "./harness";
import type { SeededRNG } from "./rng";

// ── Action categories ────────────────────────────────────────────────

export type ActionCategory =
	| "file-ops"
	| "staging"
	| "commit"
	| "branch"
	| "merge"
	| "rebase"
	| "cherry-pick"
	| "revert"
	| "stash"
	| "tag"
	| "remote"
	| "reset"
	| "clean"
	| "config"
	| "conflict-resolution"
	| "diagnostic"
	| "maintenance"
	| "worktree"
	| "apply"
	| "am";

// ── Fuzz config ──────────────────────────────────────────────────────

/** Per-picker-type probability of injecting a wrong value. */
export interface FuzzConfig {
	branchRate: number;
	fileRate: number;
	commitRate: number;
	tagRate: number;
	remoteRate: number;
}

// ── Action interface ─────────────────────────────────────────────────

/** An action the random walk can take. */
export interface Action {
	/** Human-readable name for logging. */
	name: string;
	/** Category for preset filtering/boosting. */
	category: ActionCategory;
	/**
	 * Whether a successful run of this action adds a linked worktree. The walk
	 * suppresses these once the live-worktree count reaches `maxWorktrees`, so
	 * the budget stays on depth (work *inside* a few worktrees) rather than
	 * breadth (many shallow checkouts). Error-path "add" actions that are
	 * expected to fail (duplicate branch / existing path / claimed branch) do
	 * not set this — they never grow the count.
	 */
	createsWorktree?: boolean;
	/**
	 * Hard precondition: the action's execute code won't crash.
	 * Checks structural requirements (e.g., needs files to pick from,
	 * needs at least 2 branches). Always checked.
	 */
	canRun(state: QueryState): boolean;
	/**
	 * Soft precondition: the action is expected to succeed.
	 * Typically guards against running during conflict states.
	 * Chaos mode bypasses this check to exercise error handling.
	 */
	precondition(state: QueryState): boolean;
	/** How likely this action should be picked (higher = more likely). */
	weight(state: QueryState): number;
	/**
	 * Execute the action. Returns a description string for the log
	 * and the ExecResult (or null if the action is purely a file operation).
	 */
	execute(
		harness: WalkHarness,
		rng: SeededRNG,
		state: QueryState,
		fuzz?: FuzzConfig,
	): Promise<{ description: string; result: ExecResult | null }>;
}
