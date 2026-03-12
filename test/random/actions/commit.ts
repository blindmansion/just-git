import { inConflict } from "../pickers";
import type { Action } from "../types";

const commit: Action = {
	name: "commit",
	category: "commit",
	canRun: () => true,
	precondition: () => true,
	weight: (state) => {
		if (state.files.length > 0) return 6;
		return 2;
	},
	async execute(harness, rng) {
		const msg = `commit-${rng.alphanumeric(6)}`;
		const result = await harness.gitCommit(msg);
		return { description: `git commit -m "${msg}"`, result };
	},
};

const commitAll: Action = {
	name: "commitAll",
	category: "commit",
	canRun: (state) => state.hasCommits,
	precondition: (state) => !inConflict(state),
	weight: () => 3,
	async execute(harness, rng) {
		const msg = `commit-a-${rng.alphanumeric(6)}`;
		const result = await harness.git(`commit -a -m "${msg}"`);
		return { description: `git commit -a -m "${msg}"`, result };
	},
};

const commitAmend: Action = {
	name: "commitAmend",
	category: "commit",
	canRun: (state) => state.hasCommits,
	precondition: (state) => !inConflict(state),
	weight: () => 2,
	async execute(harness, rng) {
		const msg = `amend-${rng.alphanumeric(6)}`;
		const result = await harness.git(`commit --amend -m "${msg}"`);
		return { description: `git commit --amend -m "${msg}"`, result };
	},
};

const commitAmendNoEdit: Action = {
	name: "commitAmendNoEdit",
	category: "commit",
	canRun: (state) => state.hasCommits,
	precondition: (state) => !inConflict(state),
	weight: () => 1,
	async execute(harness) {
		const result = await harness.git("commit --amend --no-edit");
		return { description: "git commit --amend --no-edit", result };
	},
};

export const COMMIT_ACTIONS: readonly Action[] = [
	commit,
	commitAll,
	commitAmend,
	commitAmendNoEdit,
];
