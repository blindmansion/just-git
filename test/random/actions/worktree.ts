import {
	claimedWorktreeBranches,
	inConflict,
	pickAnyBranch,
	pickClaimedWorktreeBranch,
} from "../pickers";
import type { Action } from "../types";

/**
 * Worktree paths are siblings of the repo (`../wt-<id>`) so the basename — and
 * thus the admin-dir id captured in the oracle snapshot — is identical between
 * the real-git temp dir and the in-memory VFS. The id is path-agnostic; the
 * sibling checkout itself lives outside the hashed worktree on both sides.
 */
const worktreeAddDetached: Action = {
	name: "worktreeAddDetached",
	category: "worktree",
	canRun: (state) => state.hasCommits,
	precondition: (state) => !inConflict(state),
	weight: () => 2,
	async execute(harness, rng) {
		const id = rng.alphanumeric(6);
		const cmd = `worktree add --detach ../wt-${id} HEAD`;
		const result = await harness.git(cmd);
		return { description: `git ${cmd}`, result };
	},
};

const worktreeAddNewBranch: Action = {
	name: "worktreeAddNewBranch",
	category: "worktree",
	canRun: (state) => state.hasCommits,
	precondition: (state) => !inConflict(state),
	weight: () => 2,
	async execute(harness, rng) {
		const id = rng.alphanumeric(6);
		const cmd = `worktree add -b wtb-${id} ../wt-${id}`;
		const result = await harness.git(cmd);
		return { description: `git ${cmd}`, result };
	},
};

const worktreeRemove: Action = {
	name: "worktreeRemove",
	category: "worktree",
	canRun: (state) => state.worktrees.length > 0,
	precondition: () => true,
	weight: () => 1,
	async execute(harness, rng, state) {
		const wt = state.worktrees[rng.int(0, state.worktrees.length - 1)]!;
		const cmd = `worktree remove ../${wt.id}`;
		const result = await harness.git(cmd);
		return { description: `git ${cmd}`, result };
	},
};

const worktreePrune: Action = {
	name: "worktreePrune",
	category: "worktree",
	canRun: () => true,
	precondition: () => true,
	weight: () => 1,
	async execute(harness) {
		const cmd = "worktree prune";
		const result = await harness.git(cmd);
		return { description: `git ${cmd}`, result };
	},
};

// ── Tier A: cross-worktree guards ────────────────────────────────────
// A branch checked out in a sibling worktree must be refused by the main
// worktree's checkout / switch / branch -d. A bug here surfaces as a HEAD or
// ref divergence (error severity), not just an output mismatch.

const switchClaimedBranch: Action = {
	name: "switchClaimedBranch",
	category: "worktree",
	canRun: (state) => claimedWorktreeBranches(state).length > 0,
	precondition: (state) => !inConflict(state),
	weight: () => 2,
	async execute(harness, rng, state) {
		const branch = pickClaimedWorktreeBranch(rng, state)!;
		const cmd = `switch ${branch}`;
		const result = await harness.git(cmd);
		return { description: `git ${cmd}`, result };
	},
};

const checkoutClaimedBranch: Action = {
	name: "checkoutClaimedBranch",
	category: "worktree",
	canRun: (state) => claimedWorktreeBranches(state).length > 0,
	precondition: (state) => !inConflict(state),
	weight: () => 2,
	async execute(harness, rng, state) {
		const branch = pickClaimedWorktreeBranch(rng, state)!;
		const cmd = `checkout ${branch}`;
		const result = await harness.git(cmd);
		return { description: `git ${cmd}`, result };
	},
};

const deleteClaimedBranch: Action = {
	name: "deleteClaimedBranch",
	category: "worktree",
	canRun: (state) => claimedWorktreeBranches(state).length > 0,
	precondition: (state) => !inConflict(state),
	weight: () => 2,
	async execute(harness, rng, state) {
		const branch = pickClaimedWorktreeBranch(rng, state)!;
		// Both -d and -D are refused while the branch is checked out elsewhere.
		const flag = rng.next() < 0.5 ? "-d" : "-D";
		const cmd = `branch ${flag} ${branch}`;
		const result = await harness.git(cmd);
		return { description: `git ${cmd}`, result };
	},
};

// ── Tier B: worktree add error paths ─────────────────────────────────

const worktreeAddDuplicateBranch: Action = {
	name: "worktreeAddDuplicateBranch",
	category: "worktree",
	canRun: (state) => state.hasCommits && state.branches.length > 0,
	precondition: (state) => !inConflict(state),
	weight: () => 1,
	async execute(harness, rng, state) {
		const branch = pickAnyBranch(rng, state)!;
		const id = rng.alphanumeric(6);
		const cmd = `worktree add -b ${branch} ../wt-${id}`;
		const result = await harness.git(cmd);
		return { description: `git ${cmd}`, result };
	},
};

const worktreeAddExistingPath: Action = {
	name: "worktreeAddExistingPath",
	category: "worktree",
	canRun: (state) => state.hasCommits && state.worktrees.length > 0,
	precondition: (state) => !inConflict(state),
	weight: () => 1,
	async execute(harness, rng, state) {
		const wt = state.worktrees[rng.int(0, state.worktrees.length - 1)]!;
		const cmd = `worktree add ../${wt.id}`;
		const result = await harness.git(cmd);
		return { description: `git ${cmd}`, result };
	},
};

const worktreeAddClaimedBranch: Action = {
	name: "worktreeAddClaimedBranch",
	category: "worktree",
	canRun: (state) => state.hasCommits && claimedWorktreeBranches(state).length > 0,
	precondition: (state) => !inConflict(state),
	weight: () => 1,
	async execute(harness, rng, state) {
		const branch = pickClaimedWorktreeBranch(rng, state)!;
		const id = rng.alphanumeric(6);
		const cmd = `worktree add ../wt-${id} ${branch}`;
		const result = await harness.git(cmd);
		return { description: `git ${cmd}`, result };
	},
};

// ── Tier C: worktree remove edge cases ───────────────────────────────

const worktreeRemoveMain: Action = {
	name: "worktreeRemoveMain",
	category: "worktree",
	canRun: (state) => state.hasCommits,
	precondition: () => true,
	weight: () => 1,
	async execute(harness) {
		const cmd = "worktree remove .";
		const result = await harness.git(cmd);
		return { description: `git ${cmd}`, result };
	},
};

const worktreeRemoveLocked: Action = {
	name: "worktreeRemoveLocked",
	category: "worktree",
	canRun: (state) => state.worktrees.length > 0,
	precondition: () => true,
	weight: () => 1,
	async execute(harness, rng, state) {
		// Prefer an unlocked worktree so the setup lock succeeds cleanly; the
		// recorded refusal is the final `remove` (the lock is a placeholder step).
		const candidates = state.worktrees.filter((w) => !w.locked);
		const pool = candidates.length > 0 ? candidates : state.worktrees;
		const wt = pool[rng.int(0, pool.length - 1)]!;
		await harness.git(`worktree lock ../${wt.id}`);
		const cmd = `worktree remove ../${wt.id}`;
		const result = await harness.git(cmd);
		return { description: `git ${cmd}`, result };
	},
};

const worktreeRemoveForce: Action = {
	name: "worktreeRemoveForce",
	category: "worktree",
	canRun: (state) => state.worktrees.length > 0,
	precondition: () => true,
	weight: () => 1,
	async execute(harness, rng, state) {
		const wt = state.worktrees[rng.int(0, state.worktrees.length - 1)]!;
		// `-f -f` overrides both the dirty-tree and locked-tree guards.
		const cmd = `worktree remove -f -f ../${wt.id}`;
		const result = await harness.git(cmd);
		return { description: `git ${cmd}`, result };
	},
};

// Work *inside* a linked worktree is no longer driven by bespoke actions: the
// walk's worktree targeting (see `selectWorktreeTarget` / `WorktreeView` in
// walker.ts + harness.ts) binds the harness to a chosen checkout and runs the
// ordinary worktree-safe action catalog (commit/branch/merge/rebase/stash/...)
// against it, exercising per-worktree HEAD/index/operation state for free. The
// actions below are the ones that must run from the *primary* worktree: they
// manage worktrees (path/admin conventions) or assert cross-worktree guards.

export const WORKTREE_ACTIONS: readonly Action[] = [
	worktreeAddDetached,
	worktreeAddNewBranch,
	worktreeRemove,
	worktreePrune,
	switchClaimedBranch,
	checkoutClaimedBranch,
	deleteClaimedBranch,
	worktreeAddDuplicateBranch,
	worktreeAddExistingPath,
	worktreeAddClaimedBranch,
	worktreeRemoveMain,
	worktreeRemoveLocked,
	worktreeRemoveForce,
];
