import {
	claimedWorktreeBranches,
	inConflict,
	pickAnyBranch,
	pickClaimedWorktreeBranch,
} from "../pickers";
import type { SeededRNG } from "../rng";
import type { Action } from "../types";

/** Worktree-relative execution context (e.g. "../wt-abc") for a linked checkout. */
function worktreeCwd(id: string): string {
	return `../${id}`;
}

/** Pick a random linked worktree from state (caller guarantees non-empty). */
function pickWorktree(rng: SeededRNG, worktrees: { id: string; branch: string | null }[]) {
	return worktrees[rng.int(0, worktrees.length - 1)]!;
}

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

// ── Tier D: work *inside* a linked worktree ──────────────────────────
// These drive commands with a worktree-relative `cwd`, so the operation runs
// against the linked checkout's private HEAD / index / operation state over the
// shared object store. Tier 1 capture verifies the per-worktree contents, index,
// HEAD, and operation state these produce — invisible to the cross-worktree
// guards above, which only see the primary tree.

const worktreeRemoveDirty: Action = {
	name: "worktreeRemoveDirty",
	category: "worktree",
	canRun: (state) => state.worktrees.length > 0,
	precondition: () => true,
	weight: () => 1,
	async execute(harness, rng, state) {
		const wt = pickWorktree(rng, state.worktrees);
		const cwd = worktreeCwd(wt.id);
		// Dirty the linked checkout with an untracked file so plain `remove`
		// refuses; `-f` overrides the dirty guard.
		await harness.writeFile(
			`dirty-${rng.alphanumeric(6)}.txt`,
			`dirt-${rng.alphanumeric(8)}\n`,
			cwd,
		);
		const force = rng.bool() ? "-f " : "";
		const cmd = `worktree remove ${force}../${wt.id}`;
		const result = await harness.git(cmd);
		return { description: `git ${cmd}`, result };
	},
};

const worktreeCommit: Action = {
	name: "worktreeCommit",
	category: "worktree",
	canRun: (state) => state.worktrees.length > 0 && state.hasCommits,
	precondition: (state) => !inConflict(state),
	weight: () => 3,
	async execute(harness, rng, state) {
		const wt = pickWorktree(rng, state.worktrees);
		const cwd = worktreeCwd(wt.id);
		const seed = rng.int(0, 2 ** 31 - 1);
		// `files` is ignored for a worktree batch — the harness re-lists the
		// linked checkout's own files (record/replay determinism invariant).
		await harness.applyFileOpBatch(seed, [], cwd);
		await harness.git("add -A", undefined, cwd);
		const msg = `wt-${rng.alphanumeric(6)}`;
		const cmd = `commit -m "${msg}"`;
		const result = await harness.git(cmd, undefined, cwd);
		return { description: `(in ${wt.id}) git ${cmd}`, result };
	},
};

const worktreeMerge: Action = {
	name: "worktreeMerge",
	category: "worktree",
	canRun: (state) => state.worktrees.length > 0 && state.branches.length > 1,
	precondition: (state) => !inConflict(state),
	weight: () => 1,
	async execute(harness, rng, state) {
		const wt = pickWorktree(rng, state.worktrees);
		const cwd = worktreeCwd(wt.id);
		// Merge a branch other than the one checked out here (own branch merges
		// are a no-op "Already up to date").
		const others = state.branches.filter((b) => b !== wt.branch);
		const branch = others.length > 0 ? rng.pick(others) : rng.pick(state.branches);
		// Run the merge and stop. A clean merge produces a comparable commit; a
		// conflicting one *leaves the checkout mid-merge* — exactly the
		// per-worktree operation/conflicted-index state Tier 1 verifies and the
		// genuinely worktree-specific hazard this tier targets. The conflict is
		// concluded later by `worktreeCommit` (with an explicit message) or
		// cleared by `worktreeRemoveForce`.
		const result = await harness.git(`merge ${branch}`, undefined, cwd);
		return { description: `(in ${wt.id}) git merge ${branch}`, result };
	},
};

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
	worktreeRemoveDirty,
	worktreeCommit,
	worktreeMerge,
];
