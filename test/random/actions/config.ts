import type { Action } from "../types";

const CONFIG_KEYS = [
	"advice.forceDeleteBranch",
	"pull.rebase",
	"merge.ff",
	"push.default",
] as const;

const CONFIG_VALUES: Record<(typeof CONFIG_KEYS)[number], readonly string[]> = {
	"advice.forceDeleteBranch": ["true", "false"],
	"pull.rebase": ["true", "false"],
	"merge.ff": ["true", "false", "only"],
	"push.default": ["simple", "current", "nothing"],
};

const configSet: Action = {
	name: "configSet",
	category: "config",
	canRun: () => true,
	precondition: () => true,
	weight: () => 1,
	async execute(harness, rng) {
		const key = rng.pick(CONFIG_KEYS);
		const value = rng.pick(CONFIG_VALUES[key]);
		const cmd = `config ${key} ${value}`;
		const result = await harness.git(cmd);
		return { description: `git ${cmd}`, result };
	},
};

const configUnset: Action = {
	name: "configUnset",
	category: "config",
	canRun: () => true,
	precondition: () => true,
	weight: () => 1,
	async execute(harness, rng) {
		const key = rng.pick(CONFIG_KEYS);
		const cmd = `config unset ${key}`;
		const result = await harness.git(cmd);
		return { description: `git ${cmd}`, result };
	},
};

export const CONFIG_ACTIONS: readonly Action[] = [configSet, configUnset];
