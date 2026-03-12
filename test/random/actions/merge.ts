import { inConflict, pickOtherBranch } from "../pickers";
import type { Action } from "../types";

const merge: Action = {
	name: "merge",
	category: "merge",
	canRun: (state) => state.branches.length >= 2 && state.hasCommits,
	precondition: (state) => !inConflict(state),
	weight: (state) => {
		if (state.branches.length >= 3) return 6;
		return 3;
	},
	async execute(harness, rng, state, fuzz?) {
		const target = pickOtherBranch(rng, state, { fuzzRate: fuzz?.branchRate });
		if (!target) return { description: "merge: no other branch", result: null };
		const mergeStyle = rng.pickWeighted([
			{ value: "", weight: 5 },
			{ value: " --no-ff", weight: 3 },
			{ value: " --ff-only", weight: 2 },
			{ value: " --squash", weight: 2 },
		]);
		const customMsg = rng.bool(0.2) ? ` -m "merge-${rng.alphanumeric(4)}"` : "";
		const result = await harness.git(`merge${mergeStyle}${customMsg} ${target}`);
		return {
			description: `git merge${mergeStyle}${customMsg} ${target}`,
			result,
		};
	},
};

const mergeAbort: Action = {
	name: "mergeAbort",
	category: "merge",
	canRun: () => true,
	precondition: (state) => state.inMergeConflict,
	weight: () => 8,
	async execute(harness) {
		const result = await harness.git("merge --abort");
		return { description: "git merge --abort", result };
	},
};

const mergeContinue: Action = {
	name: "mergeContinue",
	category: "merge",
	canRun: (state) => state.inMergeConflict && state.files.length > 0,
	precondition: () => true,
	weight: () => 8,
	async execute(harness, rng) {
		const seed = rng.int(0, 2 ** 31 - 1);
		await harness.resolveFiles(seed);
		await harness.git("add .");
		const result = await harness.git("merge --continue");
		return {
			description: `mergeContinue: resolve (seed=${seed}), git merge --continue`,
			result,
		};
	},
};

export const MERGE_ACTIONS: readonly Action[] = [merge, mergeAbort, mergeContinue];
