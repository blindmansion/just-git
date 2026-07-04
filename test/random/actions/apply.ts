import { inConflict } from "../pickers";
import type { Action } from "../types";

// ── git apply oracle coverage ────────────────────────────────────────
//
// `apply` has no natural patch source in a random walk, so each action
// *composes* a diff with an apply. Both are wired as a `git diff … | git apply`
// pipe, which buys two properties the oracle needs:
//
//   1. The patch text never lands on a compared stdout — only the *resulting*
//      tree (worktree hash / index) is state-compared against real git. So a
//      cosmetic diff-formatting difference can't fail the step; a genuine
//      parse/apply bug can. (Plain `git diff` output is separately covered by
//      the diagnostic actions.)
//   2. No temp `.patch` file is written, so nothing pollutes the worktree hash
//      and there's no cleanup step to sequence.
//
// `apply` creates no commits and touches no refs, so — unlike `am` — it needs
// no deterministic-timestamp plumbing and slots into the oracle as-is.
//
// Both actions probe the diff first and only pipe a *plain* unified diff (see
// `isPlainAppliableDiff`). git's no-valid-patch message ("No valid patches in
// input") differs from just-git's ("unrecognized input"), so anything git
// apply treats as "no patch" — an empty diff, a combined/conflict diff
// (`diff --cc`, seen when chaos fires the action mid-merge), or a header-only
// mode/rename/binary diff — would diverge on stderr. We skip those and only
// feed diffs that carry a real `@@ ` hunk.

/**
 * Whether `git diff` output is a plain unified diff that `git apply` will
 * actually parse: non-empty, not a combined/conflict diff, and carrying at
 * least one standard `@@ …@@` hunk (combined diffs use `@@@`, and header-only
 * mode/rename/binary diffs carry none).
 */
function isPlainAppliableDiff(text: string): boolean {
	if (text.trim() === "") return false;
	if (/^diff --(cc|combined) /m.test(text)) return false;
	return /^@@ /m.test(text);
}

/**
 * Round-trip: reverse-apply the current diff so the tree returns to its prior
 * state (`git diff | git apply -R`, or the `--cached` variant against the
 * index). Exercises the diff parser, reverse hunk application, and the
 * worktree/index write path, then state-compares the reverted tree to real
 * git. Unstaged changes are preferred; staged changes are the fallback.
 */
const applyReverse: Action = {
	name: "applyReverse",
	category: "apply",
	canRun: (state) => state.hasCommits && state.files.length > 0,
	precondition: (state) => !inConflict(state),
	weight: () => 2,
	async execute(harness) {
		const unstaged = await harness.git("diff");
		if (isPlainAppliableDiff(unstaged.stdout)) {
			const result = await harness.git("diff | git apply -R");
			return { description: "git diff | git apply -R", result };
		}
		const staged = await harness.git("diff --cached");
		if (isPlainAppliableDiff(staged.stdout)) {
			const result = await harness.git("diff --cached | git apply -R --cached");
			return { description: "git diff --cached | git apply -R --cached", result };
		}
		return { description: "applyReverse: no plain diff", result: null };
	},
};

/**
 * Failure path: apply the unstaged diff *forward* onto the dirty worktree it
 * was generated from. The preimage (index content) is no longer present, so
 * git rejects the whole input all-or-nothing —
 *   error: patch failed: <file>:<line>
 *   error: <file>: patch does not apply
 * exit 1, no writes — which verifies just-git's rejection message and its
 * no-partial-write guarantee against real git. (A pure-insertion diff may
 * instead re-apply and duplicate lines; that outcome is identical on both
 * sides, so the state comparison still holds.)
 */
const applyForwardStale: Action = {
	name: "applyForwardStale",
	category: "apply",
	canRun: (state) => state.hasCommits && state.files.length > 0,
	precondition: (state) => !inConflict(state),
	weight: () => 1,
	async execute(harness) {
		const unstaged = await harness.git("diff");
		if (!isPlainAppliableDiff(unstaged.stdout)) {
			return { description: "applyForwardStale: no plain diff", result: null };
		}
		const result = await harness.git("diff | git apply");
		return { description: "git diff | git apply", result };
	},
};

export const APPLY_ACTIONS: readonly Action[] = [applyReverse, applyForwardStale];
