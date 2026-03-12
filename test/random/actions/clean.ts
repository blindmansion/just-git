import type { Action } from "../types";

const cleanWorkTree: Action = {
	name: "cleanWorkTree",
	category: "clean",
	canRun: (state) => state.hasCommits,
	precondition: () => true,
	weight: () => 1,
	async execute(harness, rng) {
		const cmd = rng.pickWeighted<string>([
			{ value: "clean -n", weight: 6 },
			{ value: "clean -nd", weight: 3 },
			{ value: "clean -f", weight: 3 },
			{ value: "clean -fd", weight: 2 },
			{ value: "clean -fx", weight: 1 },
			{ value: "clean -fX", weight: 1 },
		]);
		const result = await harness.git(cmd);
		return { description: `git ${cmd}`, result };
	},
};

const toggleCleanRequireForce: Action = {
	name: "toggleCleanRequireForce",
	category: "config",
	canRun: () => true,
	precondition: () => true,
	weight: () => 1,
	async execute(harness, rng) {
		const current = await harness.git("config clean.requireForce");
		const currentValue = current.stdout.trim().toLowerCase();
		let nextValue: "true" | "false";
		if (current.exitCode === 0) {
			nextValue = currentValue === "false" ? "true" : "false";
		} else {
			nextValue = rng.bool(0.7) ? "false" : "true";
		}
		const cmd = `config clean.requireForce ${nextValue}`;
		const result = await harness.git(cmd);
		return { description: `git ${cmd}`, result };
	},
};

export const CLEAN_ACTIONS: readonly Action[] = [cleanWorkTree, toggleCleanRequireForce];
