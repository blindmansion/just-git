import { inConflict } from "../pickers";
import type { Action } from "../types";

const stashPush: Action = {
	name: "stashPush",
	category: "stash",
	canRun: (state) => state.hasCommits && state.files.length >= 1,
	precondition: (state) => !inConflict(state),
	weight: () => 2,
	async execute(harness, rng) {
		const id = rng.alphanumeric(6);
		const result = await harness.git(`stash push -m "stash-${id}"`);
		return { description: `git stash push -m "stash-${id}"`, result };
	},
};

const stashPushUntracked: Action = {
	name: "stashPushUntracked",
	category: "stash",
	canRun: (state) => state.hasCommits,
	precondition: (state) => !inConflict(state),
	weight: () => 1,
	async execute(harness, rng) {
		const id = rng.alphanumeric(6);
		const result = await harness.git(`stash push -u -m "stash-u-${id}"`);
		return { description: `git stash push -u -m "stash-u-${id}"`, result };
	},
};

const stashPop: Action = {
	name: "stashPop",
	category: "stash",
	canRun: (state) => state.stashCount > 0 && state.hasCommits,
	precondition: (state) => !inConflict(state),
	weight: () => 2,
	async execute(harness) {
		const result = await harness.git("stash pop");
		return { description: "git stash pop", result };
	},
};

const stashApply: Action = {
	name: "stashApply",
	category: "stash",
	canRun: (state) => state.stashCount > 0 && state.hasCommits,
	precondition: (state) => !inConflict(state),
	weight: () => 1,
	async execute(harness, rng, state) {
		const idx = state.stashCount > 1 ? rng.int(0, state.stashCount - 1) : 0;
		const arg = idx === 0 ? "" : ` stash@{${idx}}`;
		const result = await harness.git(`stash apply${arg}`);
		return { description: `git stash apply${arg}`, result };
	},
};

const stashDrop: Action = {
	name: "stashDrop",
	category: "stash",
	canRun: (state) => state.stashCount > 0,
	precondition: () => true,
	weight: () => 1,
	async execute(harness, rng, state) {
		const idx = state.stashCount > 1 ? rng.int(0, state.stashCount - 1) : 0;
		const arg = idx === 0 ? "" : ` stash@{${idx}}`;
		const result = await harness.git(`stash drop${arg}`);
		return { description: `git stash drop${arg}`, result };
	},
};

const stashClear: Action = {
	name: "stashClear",
	category: "stash",
	canRun: (state) => state.stashCount > 0,
	precondition: () => true,
	weight: () => 1,
	async execute(harness) {
		const result = await harness.git("stash clear");
		return { description: "git stash clear", result };
	},
};

export const STASH_ACTIONS: readonly Action[] = [
	stashPush,
	stashPushUntracked,
	stashPop,
	stashApply,
	stashDrop,
	stashClear,
];
