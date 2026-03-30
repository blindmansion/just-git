import { inConflict, pickOtherBranch } from "../pickers";
import type { Action } from "../types";

const rebase: Action = {
	name: "rebase",
	category: "rebase",
	canRun: (state) => state.branches.length >= 2 && state.hasCommits,
	precondition: (state) => !inConflict(state),
	weight: (state) => {
		if (state.branches.length >= 3) return 4;
		return 2;
	},
	async execute(harness, rng, state, fuzz?) {
		const target = pickOtherBranch(rng, state, { fuzzRate: fuzz?.branchRate });
		if (target === null) {
			return { description: "rebase: no other branch", result: null };
		}
		const result = await harness.git(`rebase ${target}`);
		return { description: `git rebase ${target}`, result };
	},
};

const rebaseOnto: Action = {
	name: "rebaseOnto",
	category: "rebase",
	canRun: (state) => state.branches.length >= 3 && state.hasCommits,
	precondition: (state) => !inConflict(state) && state.currentBranch !== null,
	weight: () => 1,
	async execute(harness, rng, state, fuzz?) {
		const candidates = state.branches.filter((branch) => branch !== state.currentBranch);
		if (candidates.length < 2) {
			return { description: "rebaseOnto: not enough other branches", result: null };
		}
		const oldBase = rng.pick(candidates);
		const ontoCandidates = candidates.filter((branch) => branch !== oldBase);
		const newBase =
			ontoCandidates.length > 0
				? rng.pick(ontoCandidates)
				: pickOtherBranch(rng, state, { fuzzRate: fuzz?.branchRate });
		if (!newBase || newBase === oldBase) {
			return { description: "rebaseOnto: could not choose distinct bases", result: null };
		}
		const result = await harness.git(`rebase --onto ${newBase} ${oldBase}`);
		return { description: `git rebase --onto ${newBase} ${oldBase}`, result };
	},
};

const rebaseAbort: Action = {
	name: "rebaseAbort",
	category: "rebase",
	canRun: () => true,
	precondition: (state) => state.inRebaseConflict,
	weight: () => 8,
	async execute(harness) {
		const result = await harness.git("rebase --abort");
		return { description: "git rebase --abort", result };
	},
};

const rebaseContinue: Action = {
	name: "rebaseContinue",
	category: "rebase",
	canRun: (state) => state.inRebaseConflict && state.files.length > 0,
	precondition: () => true,
	weight: () => 8,
	async execute(harness, rng) {
		const seed = rng.int(0, 2 ** 31 - 1);
		await harness.resolveFiles(seed);
		await harness.git("add .");
		const result = await harness.git("rebase --continue");
		return {
			description: `rebaseContinue: resolve files (seed=${seed}), git rebase --continue`,
			result,
		};
	},
};

const rebaseSkip: Action = {
	name: "rebaseSkip",
	category: "rebase",
	canRun: () => true,
	precondition: (state) => state.inRebaseConflict,
	weight: () => 4,
	async execute(harness) {
		const result = await harness.git("rebase --skip");
		return { description: "git rebase --skip", result };
	},
};

export const REBASE_ACTIONS: readonly Action[] = [
	rebase,
	rebaseOnto,
	rebaseAbort,
	rebaseContinue,
	rebaseSkip,
];
