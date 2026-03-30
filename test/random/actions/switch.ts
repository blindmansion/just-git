import {
	inConflict,
	newBranchName,
	pickAnyBranch,
	pickCommitHash,
	pickOtherBranch,
	pickRemoteTrackingBranch,
} from "../pickers";
import type { Action } from "../types";

const hasOrigin = (remotes: string[]) => remotes.includes("origin");

const switchBranchViaSwitchCmd: Action = {
	name: "switchBranchViaSwitch",
	category: "branch",
	canRun: (state) => state.branches.length >= 2 && state.hasCommits,
	precondition: (state) => !inConflict(state),
	weight: () => 3,
	async execute(harness, rng, state, fuzz?) {
		const target = pickOtherBranch(rng, state, { fuzzRate: fuzz?.branchRate });
		if (!target)
			return {
				description: "switchBranchViaSwitch: no other branch",
				result: null,
			};
		const result = await harness.git(`switch ${target}`);
		return { description: `git switch ${target}`, result };
	},
};

const switchCreate: Action = {
	name: "switchCreate",
	category: "branch",
	canRun: (state) => state.hasCommits,
	precondition: (state) => !inConflict(state),
	weight: (state) => {
		if (state.branches.length < 7) return 4;
		return 1;
	},
	async execute(harness, rng, state) {
		const name = newBranchName(rng, state.branches);
		const result = await harness.git(`switch -c ${name}`);
		return { description: `git switch -c ${name}`, result };
	},
};

const switchCreateFromRef: Action = {
	name: "switchCreateFromRef",
	category: "branch",
	canRun: (state) => state.branches.length >= 2 && state.hasCommits,
	precondition: (state) => !inConflict(state),
	weight: () => 2,
	async execute(harness, rng, state, fuzz?) {
		const startPoint = pickAnyBranch(rng, state, {
			fuzzRate: fuzz?.branchRate,
		});
		if (!startPoint) return { description: "switchCreateFromRef: no branch", result: null };
		const name = newBranchName(rng, state.branches);
		const result = await harness.git(`switch -c ${name} ${startPoint}`);
		return { description: `git switch -c ${name} ${startPoint}`, result };
	},
};

const switchForceCreate: Action = {
	name: "switchForceCreate",
	category: "branch",
	canRun: (state) => state.branches.length >= 2 && state.hasCommits,
	precondition: (state) => !inConflict(state),
	weight: () => 1,
	async execute(harness, rng, state, fuzz?) {
		const existing = pickOtherBranch(rng, state, {
			fuzzRate: fuzz?.branchRate,
		});
		if (!existing)
			return {
				description: "switchForceCreate: no other branch",
				result: null,
			};
		const result = await harness.git(`switch -C ${existing}`);
		return { description: `git switch -C ${existing}`, result };
	},
};

const switchDetach: Action = {
	name: "switchDetach",
	category: "branch",
	canRun: (state) => state.hasCommits,
	precondition: (state) => !inConflict(state),
	weight: () => 1,
	async execute(harness, rng, _state, fuzz?) {
		const hash = await pickCommitHash(harness, rng, {
			fuzzRate: fuzz?.commitRate,
		});
		if (!hash) return { description: "switchDetach: no commits", result: null };
		const result = await harness.git(`switch --detach ${hash}`);
		return {
			description: `git switch --detach ${hash.slice(0, 8)}`,
			result,
		};
	},
};

const switchOrphan: Action = {
	name: "switchOrphan",
	category: "branch",
	canRun: (state) => state.hasCommits,
	precondition: (state) => !inConflict(state),
	weight: (state) => {
		if (state.branches.length < 5) return 1;
		return 0;
	},
	async execute(harness, rng, state) {
		const name = newBranchName(rng, state.branches);
		const result = await harness.git(`switch --orphan ${name}`);
		return { description: `git switch --orphan ${name}`, result };
	},
};

const switchPrevious: Action = {
	name: "switchPrevious",
	category: "branch",
	canRun: (state) => state.branches.length >= 2 && state.hasCommits,
	precondition: (state) => !inConflict(state),
	weight: () => 1,
	async execute(harness) {
		const result = await harness.git("switch -");
		return { description: "git switch -", result };
	},
};

const switchGuess: Action = {
	name: "switchGuess",
	category: "branch",
	canRun: (state) => hasOrigin(state.remotes) && state.hasCommits,
	precondition: (state) => !inConflict(state),
	weight: () => 1,
	async execute(harness, rng, state, fuzz?) {
		let remoteBranch = await pickRemoteTrackingBranch(harness, rng, {
			fuzzRate: fuzz?.branchRate,
			remote: "origin",
			excludeLocals: state.branches,
		});

		if (!remoteBranch && harness.serverCommit) {
			const branchName = newBranchName(rng, state.branches);
			await harness.serverCommit(rng.int(0, 1_000_000), branchName);
			await harness.git(
				`fetch origin refs/heads/${branchName}:refs/remotes/origin/${branchName}`,
			);
			remoteBranch = `origin/${branchName}`;
		}

		if (!remoteBranch) {
			return { description: "switchGuess: no remote-only branch", result: null };
		}

		const branchName = remoteBranch.slice("origin/".length);
		const result = await harness.git(`switch --guess ${branchName}`);
		return { description: `git switch --guess ${branchName}`, result };
	},
};

export const SWITCH_ACTIONS: readonly Action[] = [
	switchBranchViaSwitchCmd,
	switchCreate,
	switchCreateFromRef,
	switchForceCreate,
	switchDetach,
	switchOrphan,
	switchPrevious,
	switchGuess,
];
