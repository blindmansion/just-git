import { inConflict, pickFile } from "../pickers";
import type { Action } from "../types";

const resetMixed: Action = {
	name: "resetMixed",
	category: "reset",
	canRun: (state) => state.hasCommits,
	precondition: (state) => !inConflict(state),
	weight: () => 3,
	async execute(harness) {
		const result = await harness.git("reset");
		return { description: "git reset", result };
	},
};

const resetHard: Action = {
	name: "resetHard",
	category: "reset",
	canRun: (state) => state.hasCommits,
	precondition: () => true,
	weight: () => 2,
	async execute(harness) {
		const result = await harness.git("reset --hard");
		return { description: "git reset --hard", result };
	},
};

const resetSoft: Action = {
	name: "resetSoft",
	category: "reset",
	canRun: (state) => state.hasCommits,
	precondition: (state) => !inConflict(state),
	weight: () => 1,
	async execute(harness) {
		const result = await harness.git("reset --soft HEAD~1");
		return { description: "git reset --soft HEAD~1", result };
	},
};

const resetFile: Action = {
	name: "resetFile",
	category: "reset",
	canRun: (state) => state.files.length > 0 && state.hasCommits,
	precondition: (state) => !inConflict(state),
	weight: () => 2,
	async execute(harness, rng, state, fuzz?) {
		const path = pickFile(rng, state, { fuzzRate: fuzz?.fileRate });
		if (!path) return { description: "resetFile: no file", result: null };
		const result = await harness.git(`reset "${path}"`);
		return { description: `git reset ${path}`, result };
	},
};

export const RESET_ACTIONS: readonly Action[] = [resetMixed, resetHard, resetSoft, resetFile];
