import { inConflict, pickCommitHash, pickFile } from "../pickers";
import type { Action } from "../types";

/** Restore a single file's worktree content from index (default behavior). */
const restoreWorktree: Action = {
	name: "restoreWorktree",
	category: "branch",
	canRun: (state) => state.files.length > 0 && state.hasCommits,
	precondition: () => true,
	weight: () => 1,
	async execute(harness, rng, state, fuzz?) {
		const path = pickFile(rng, state, { fuzzRate: fuzz?.fileRate });
		if (!path) return { description: "restoreWorktree: no file", result: null };
		const result = await harness.git(`restore "${path}"`);
		return { description: `git restore ${path}`, result };
	},
};

/** Unstage a file (restore --staged, source defaults to HEAD). */
const restoreStaged: Action = {
	name: "restoreStaged",
	category: "reset",
	canRun: (state) => state.files.length > 0 && state.hasCommits,
	precondition: (state) => !inConflict(state),
	weight: () => 1,
	async execute(harness, rng, state, fuzz?) {
		const path = pickFile(rng, state, { fuzzRate: fuzz?.fileRate });
		if (!path) return { description: "restoreStaged: no file", result: null };
		const result = await harness.git(`restore --staged "${path}"`);
		return { description: `git restore --staged ${path}`, result };
	},
};

/** Restore worktree from a specific commit (--source). */
const restoreFromSource: Action = {
	name: "restoreFromSource",
	category: "branch",
	canRun: (state) => state.files.length > 0 && state.hasCommits,
	precondition: () => true,
	weight: () => 1,
	async execute(harness, rng, state, fuzz?) {
		const path = pickFile(rng, state, { fuzzRate: fuzz?.fileRate });
		if (!path) return { description: "restoreFromSource: no file", result: null };
		const hash = await pickCommitHash(harness, rng, {
			fuzzRate: fuzz?.commitRate,
		});
		if (!hash) return { description: "restoreFromSource: no commits", result: null };
		const result = await harness.git(`restore --source ${hash} "${path}"`);
		return {
			description: `git restore --source ${hash.slice(0, 8)} ${path}`,
			result,
		};
	},
};

/** Restore both staged and worktree from a commit. */
const restoreStagedAndWorktree: Action = {
	name: "restoreStagedAndWorktree",
	category: "branch",
	canRun: (state) => state.files.length > 0 && state.hasCommits,
	precondition: (state) => !inConflict(state),
	weight: () => 1,
	async execute(harness, rng, state, fuzz?) {
		const path = pickFile(rng, state, { fuzzRate: fuzz?.fileRate });
		if (!path)
			return {
				description: "restoreStagedAndWorktree: no file",
				result: null,
			};
		const hash = await pickCommitHash(harness, rng, {
			fuzzRate: fuzz?.commitRate,
		});
		if (!hash)
			return {
				description: "restoreStagedAndWorktree: no commits",
				result: null,
			};
		const result = await harness.git(`restore --source ${hash} --staged --worktree "${path}"`);
		return {
			description: `git restore -s ${hash.slice(0, 8)} -SW ${path}`,
			result,
		};
	},
};

/** During conflict, restore a file with --ours or --theirs. */
const restoreOursTheirs: Action = {
	name: "restoreOursTheirs",
	category: "conflict-resolution",
	canRun: (state) => inConflict(state) && state.files.length > 0,
	precondition: () => true,
	weight: () => 3,
	async execute(harness, rng, state, fuzz?) {
		const path = pickFile(rng, state, { fuzzRate: fuzz?.fileRate });
		if (!path) return { description: "restoreOursTheirs: no file", result: null };
		const side = rng.bool(0.5) ? "--ours" : "--theirs";
		const result = await harness.git(`restore ${side} "${path}"`);
		return { description: `git restore ${side} ${path}`, result };
	},
};

export const RESTORE_ACTIONS: readonly Action[] = [
	restoreWorktree,
	restoreStaged,
	restoreFromSource,
	restoreStagedAndWorktree,
	restoreOursTheirs,
];
