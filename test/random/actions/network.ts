/**
 * Network transport actions: push, fetch, pull against a remote.
 * Requires a working remote (typically origin) — actions gate on
 * `state.remotes.length > 0`.
 */

import { inConflict, pickAnyBranch, pickOtherBranch } from "../pickers";
import type { Action } from "../types";

const hasOrigin = (remotes: string[]) => remotes.includes("origin");

const pushOrigin: Action = {
	name: "pushOrigin",
	category: "remote",
	canRun: (state) => hasOrigin(state.remotes) && state.hasCommits,
	precondition: (state) => !inConflict(state),
	weight: () => 3,
	async execute(harness) {
		const result = await harness.git("push");
		return { description: "git push", result };
	},
};

const pushAll: Action = {
	name: "pushAll",
	category: "remote",
	canRun: (state) => hasOrigin(state.remotes) && state.hasCommits,
	precondition: (state) => !inConflict(state),
	weight: () => 1,
	async execute(harness) {
		const result = await harness.git("push --all");
		return { description: "git push --all", result };
	},
};

const pushForce: Action = {
	name: "pushForce",
	category: "remote",
	canRun: (state) => hasOrigin(state.remotes) && state.hasCommits,
	precondition: (state) => !inConflict(state),
	weight: () => 1,
	async execute(harness, rng, state, fuzz?) {
		const branch = pickAnyBranch(rng, state, { fuzzRate: fuzz?.branchRate }) ?? "HEAD";
		const result = await harness.git(`push --force origin ${branch}`);
		return { description: `git push --force origin ${branch}`, result };
	},
};

const pushUpstream: Action = {
	name: "pushUpstream",
	category: "remote",
	canRun: (state) => hasOrigin(state.remotes) && state.hasCommits,
	precondition: (state) => !inConflict(state) && state.currentBranch !== null,
	weight: () => 2,
	async execute(harness, _rng, state) {
		const branch = state.currentBranch ?? "HEAD";
		const result = await harness.git(`push -u origin ${branch}`);
		return { description: `git push -u origin ${branch}`, result };
	},
};

const pushDelete: Action = {
	name: "pushDelete",
	category: "remote",
	canRun: (state) => hasOrigin(state.remotes) && state.branches.length >= 2,
	precondition: (state) => !inConflict(state),
	weight: () => 1,
	async execute(harness, rng, state, fuzz?) {
		const branch = pickOtherBranch(rng, state, { fuzzRate: fuzz?.branchRate });
		if (!branch) return { description: "pushDelete: no other branch", result: null };
		const result = await harness.git(`push --delete origin ${branch}`);
		return { description: `git push --delete origin ${branch}`, result };
	},
};

const fetchOrigin: Action = {
	name: "fetchOrigin",
	category: "remote",
	canRun: (state) => hasOrigin(state.remotes),
	precondition: (state) => !inConflict(state),
	weight: () => 3,
	async execute(harness) {
		const result = await harness.git("fetch origin");
		return { description: "git fetch origin", result };
	},
};

const fetchPrune: Action = {
	name: "fetchPrune",
	category: "remote",
	canRun: (state) => hasOrigin(state.remotes),
	precondition: (state) => !inConflict(state),
	weight: () => 1,
	async execute(harness) {
		const result = await harness.git("fetch --prune");
		return { description: "git fetch --prune", result };
	},
};

const fetchTags: Action = {
	name: "fetchTags",
	category: "remote",
	canRun: (state) => hasOrigin(state.remotes),
	precondition: (state) => !inConflict(state),
	weight: () => 1,
	async execute(harness) {
		const result = await harness.git("fetch --tags");
		return { description: "git fetch --tags", result };
	},
};

const pullOrigin: Action = {
	name: "pullOrigin",
	category: "remote",
	canRun: (state) => hasOrigin(state.remotes) && state.hasCommits,
	precondition: (state) => !inConflict(state),
	weight: () => 3,
	async execute(harness) {
		const result = await harness.git("pull");
		return { description: "git pull", result };
	},
};

const pullFfOnly: Action = {
	name: "pullFfOnly",
	category: "remote",
	canRun: (state) => hasOrigin(state.remotes) && state.hasCommits,
	precondition: (state) => !inConflict(state),
	weight: () => 1,
	async execute(harness) {
		const result = await harness.git("pull --ff-only");
		return { description: "git pull --ff-only", result };
	},
};

const pullNoFf: Action = {
	name: "pullNoFf",
	category: "remote",
	canRun: (state) => hasOrigin(state.remotes) && state.hasCommits,
	precondition: (state) => !inConflict(state),
	weight: () => 1,
	async execute(harness) {
		const result = await harness.git("pull --no-ff");
		return { description: "git pull --no-ff", result };
	},
};

const serverCommitAction: Action = {
	name: "serverCommit",
	category: "remote",
	canRun: (state) => hasOrigin(state.remotes) && state.hasCommits,
	precondition: (state) => !inConflict(state),
	weight: () => 4,
	async execute(harness, rng) {
		if (!harness.serverCommit) return { description: "serverCommit: no server", result: null };
		const seed = rng.int(0, 1_000_000);
		await harness.serverCommit(seed);
		return { description: `server-commit seed=${seed}`, result: null };
	},
};

export const NETWORK_ACTIONS: readonly Action[] = [
	pushOrigin,
	pushAll,
	pushForce,
	pushUpstream,
	pushDelete,
	fetchOrigin,
	fetchPrune,
	fetchTags,
	pullOrigin,
	pullFfOnly,
	pullNoFf,
	serverCommitAction,
];
