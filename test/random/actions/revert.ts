import { inConflict, pickCommitHash, pickMergeCommitHash } from "../pickers";
import type { Action } from "../types";

const revert: Action = {
	name: "revert",
	category: "revert",
	canRun: (state) => state.hasCommits,
	precondition: (state) => !inConflict(state),
	weight: (state) => {
		if (state.branches.length >= 3) return 3;
		return 2;
	},
	async execute(harness, rng, _state, fuzz?) {
		const hash = await pickCommitHash(harness, rng, {
			fuzzRate: fuzz?.commitRate,
		});
		if (hash === null) {
			return { description: "revert: no commits", result: null };
		}
		const short = hash.slice(0, 8);
		const result = await harness.git(`revert ${hash} --no-edit`);
		return {
			description: `git revert ${short} --no-edit`,
			result,
		};
	},
};

const revertNoCommit: Action = {
	name: "revertNoCommit",
	category: "revert",
	canRun: (state) => state.hasCommits,
	precondition: (state) => !inConflict(state),
	weight: () => 1,
	async execute(harness, rng, _state, fuzz?) {
		const hash = await pickCommitHash(harness, rng, {
			fuzzRate: fuzz?.commitRate,
		});
		if (hash === null) {
			return { description: "revertNoCommit: no commits", result: null };
		}
		const short = hash.slice(0, 8);
		const result = await harness.git(`revert -n ${hash}`);
		return { description: `git revert -n ${short}`, result };
	},
};

const revertMainline: Action = {
	name: "revertMainline",
	category: "revert",
	canRun: (state) => state.hasCommits,
	precondition: (state) => !inConflict(state),
	weight: () => 1,
	async execute(harness, rng, _state, fuzz?) {
		const hash = await pickMergeCommitHash(harness, rng, {
			fuzzRate: fuzz?.commitRate,
		});
		if (hash === null) {
			return { description: "revertMainline: no merge commits", result: null };
		}
		const short = hash.slice(0, 8);
		const parent = rng.bool(0.8) ? 1 : 2;
		const result = await harness.git(`revert -m ${parent} ${hash} --no-edit`);
		return { description: `git revert -m ${parent} ${short} --no-edit`, result };
	},
};

const revertAbort: Action = {
	name: "revertAbort",
	category: "revert",
	canRun: () => true,
	precondition: (state) => state.inRevertConflict,
	weight: () => 8,
	async execute(harness) {
		const result = await harness.git("revert --abort");
		return { description: "git revert --abort", result };
	},
};

const revertContinue: Action = {
	name: "revertContinue",
	category: "revert",
	canRun: (state) => state.inRevertConflict && state.files.length > 0,
	precondition: () => true,
	weight: () => 8,
	async execute(harness, rng) {
		const seed = rng.int(0, 2 ** 31 - 1);
		await harness.resolveFiles(seed);
		await harness.git("add .");
		const result = await harness.git("revert --continue");
		return {
			description: `revertContinue: resolve (seed=${seed}), git revert --continue`,
			result,
		};
	},
};

const revertSkip: Action = {
	name: "revertSkip",
	category: "revert",
	canRun: () => true,
	precondition: (state) => state.inRevertConflict,
	weight: () => 4,
	async execute(harness) {
		const result = await harness.git("revert --skip");
		return { description: "git revert --skip", result };
	},
};

export const REVERT_ACTIONS: readonly Action[] = [
	revert,
	revertNoCommit,
	revertMainline,
	revertAbort,
	revertContinue,
	revertSkip,
];
