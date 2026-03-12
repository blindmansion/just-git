import { inConflict } from "../pickers";
import type { Action } from "../types";

const repack: Action = {
	name: "repack",
	category: "maintenance",
	canRun: (state) => state.hasCommits,
	precondition: (state) => !inConflict(state),
	weight: () => 0.5,
	async execute(harness, rng) {
		const cmd = rng.pickWeighted<string>([
			{ value: "repack", weight: 2 },
			{ value: "repack -a", weight: 2 },
			{ value: "repack -d", weight: 2 },
			{ value: "repack -a -d", weight: 4 },
		]);
		const result = await harness.git(cmd);
		return { description: `git ${cmd}`, result };
	},
};

const gc: Action = {
	name: "gc",
	category: "maintenance",
	canRun: (state) => state.hasCommits,
	precondition: (state) => !inConflict(state),
	weight: () => 0.5,
	async execute(harness, rng) {
		const aggressive = rng.bool(0.2);
		const cmd = aggressive ? "gc --aggressive" : "gc";
		const result = await harness.git(cmd);
		return { description: `git ${cmd}`, result };
	},
};

export const MAINTENANCE_ACTIONS: readonly Action[] = [repack, gc];
