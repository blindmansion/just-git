import { inConflict } from "../pickers";
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
		const id = state.worktrees[rng.int(0, state.worktrees.length - 1)];
		const cmd = `worktree remove ../${id}`;
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

export const WORKTREE_ACTIONS: readonly Action[] = [
	worktreeAddDetached,
	worktreeAddNewBranch,
	worktreeRemove,
	worktreePrune,
];
