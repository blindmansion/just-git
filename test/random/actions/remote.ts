import { pickRemote } from "../pickers";
import type { Action } from "../types";

const remoteAdd: Action = {
	name: "remoteAdd",
	category: "remote",
	canRun: () => true,
	precondition: () => true,
	weight: () => 2,
	async execute(harness, rng) {
		const names = ["staging", "backup", "mirror", "fork", "alt"];
		const name = rng.pick(names);
		const url = `https://example.com/${name}.git`;
		const result = await harness.git(`remote add ${name} ${url}`);
		return { description: `git remote add ${name} ${url}`, result };
	},
};

const remoteRemove: Action = {
	name: "remoteRemove",
	category: "remote",
	canRun: () => true,
	precondition: () => true,
	weight: () => 1,
	async execute(harness, rng, _state, fuzz?) {
		const name = await pickRemote(harness, rng, {
			fuzzRate: fuzz?.remoteRate,
			excludeOrigin: true,
		});
		if (!name)
			return {
				description: "remoteRemove: no removable remotes",
				result: null,
			};
		const result = await harness.git(`remote remove ${name}`);
		return { description: `git remote remove ${name}`, result };
	},
};

const remoteRename: Action = {
	name: "remoteRename",
	category: "remote",
	canRun: () => true,
	precondition: () => true,
	weight: () => 1,
	async execute(harness, rng) {
		const listResult = await harness.git("remote");
		const remotes = listResult.stdout.trim().split("\n").filter(Boolean);
		const renamable = remotes.filter((r) => r !== "origin");
		if (renamable.length === 0)
			return {
				description: "remoteRename: no renamable remotes",
				result: null,
			};
		const old = rng.pick(renamable);
		const names = ["staging", "backup", "mirror", "fork", "alt", "secondary"];
		const available = names.filter((n) => !remotes.includes(n));
		if (available.length === 0)
			return { description: "remoteRename: no available names", result: null };
		const newName = rng.pick(available);
		const result = await harness.git(`remote rename ${old} ${newName}`);
		return { description: `git remote rename ${old} ${newName}`, result };
	},
};

const remoteSetUrl: Action = {
	name: "remoteSetUrl",
	category: "remote",
	canRun: () => true,
	precondition: () => true,
	weight: () => 1,
	async execute(harness, rng, _state, fuzz?) {
		const name = await pickRemote(harness, rng, { fuzzRate: fuzz?.remoteRate });
		if (!name) return { description: "remoteSetUrl: no remotes", result: null };
		const url = `https://example.com/${rng.alphanumeric(6)}.git`;
		const result = await harness.git(`remote set-url ${name} ${url}`);
		return { description: `git remote set-url ${name} ${url}`, result };
	},
};

const remoteGetUrl: Action = {
	name: "remoteGetUrl",
	category: "diagnostic",
	canRun: () => true,
	precondition: () => true,
	weight: () => 1,
	async execute(harness, rng, _state, fuzz?) {
		const name = await pickRemote(harness, rng, { fuzzRate: fuzz?.remoteRate });
		if (!name) return { description: "remoteGetUrl: no remotes", result: null };
		const result = await harness.git(`remote get-url ${name}`);
		return { description: `git remote get-url ${name}`, result };
	},
};

const remoteList: Action = {
	name: "remoteList",
	category: "diagnostic",
	canRun: () => true,
	precondition: () => true,
	weight: () => 1,
	async execute(harness, rng) {
		const verbose = rng.bool(0.5);
		const cmd = verbose ? "remote -v" : "remote";
		const result = await harness.git(cmd);
		return { description: `git ${cmd}`, result };
	},
};

export const REMOTE_ACTIONS: readonly Action[] = [
	remoteAdd,
	remoteRemove,
	remoteRename,
	remoteSetUrl,
	remoteGetUrl,
	remoteList,
];
