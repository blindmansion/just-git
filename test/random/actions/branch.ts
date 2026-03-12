import {
	inConflict,
	newBranchName,
	pickAnyBranch,
	pickCommitHash,
	pickFile,
	pickOtherBranch,
} from "../pickers";
import type { Action } from "../types";

const createBranch: Action = {
	name: "createBranch",
	category: "branch",
	canRun: (state) => state.hasCommits,
	precondition: (state) => !inConflict(state),
	weight: (state) => {
		if (state.branches.length < 7) return 5;
		return 1;
	},
	async execute(harness, rng, state) {
		const useForce = rng.bool(0.2);
		if (useForce) {
			const useExisting = rng.bool(0.5) && state.branches.length >= 2;
			const name = useExisting
				? (pickOtherBranch(rng, state) ?? newBranchName(rng, state.branches))
				: newBranchName(rng, state.branches);
			const result = await harness.git(`checkout -B ${name}`);
			return { description: `git checkout -B ${name}`, result };
		}
		const name = newBranchName(rng, state.branches);
		const result = await harness.git(`checkout -b ${name}`);
		return { description: `git checkout -b ${name}`, result };
	},
};

const checkoutOrphan: Action = {
	name: "checkoutOrphan",
	category: "branch",
	canRun: (state) => state.hasCommits,
	precondition: (state) => !inConflict(state),
	weight: (state) => {
		if (state.branches.length < 5) return 2;
		return 1;
	},
	async execute(harness, rng, state) {
		const name = newBranchName(rng, state.branches);
		const result = await harness.git(`checkout --orphan ${name}`);
		return { description: `git checkout --orphan ${name}`, result };
	},
};

const switchBranch: Action = {
	name: "switchBranch",
	category: "branch",
	canRun: (state) => state.branches.length >= 2 && state.hasCommits,
	precondition: (state) => !inConflict(state),
	weight: () => 4,
	async execute(harness, rng, state, fuzz?) {
		const target = pickOtherBranch(rng, state, { fuzzRate: fuzz?.branchRate });
		if (!target) return { description: "switchBranch: no other branch", result: null };
		const result = await harness.git(`checkout ${target}`);
		return { description: `git checkout ${target}`, result };
	},
};

const deleteBranch: Action = {
	name: "deleteBranch",
	category: "branch",
	canRun: (state) => state.branches.length >= 2 && state.hasCommits,
	precondition: (state) => !inConflict(state),
	weight: () => 1,
	async execute(harness, rng, state, fuzz?) {
		const target = pickOtherBranch(rng, state, { fuzzRate: fuzz?.branchRate });
		if (!target) return { description: "deleteBranch: no other branch", result: null };
		const result = await harness.git(`branch -d ${target}`);
		return { description: `git branch -d ${target}`, result };
	},
};

const branchForceDelete: Action = {
	name: "branchForceDelete",
	category: "branch",
	canRun: (state) => state.branches.length >= 2 && state.hasCommits,
	precondition: (state) => !inConflict(state),
	weight: () => 1,
	async execute(harness, rng, state, fuzz?) {
		const target = pickOtherBranch(rng, state, { fuzzRate: fuzz?.branchRate });
		if (!target)
			return {
				description: "branchForceDelete: no other branch",
				result: null,
			};
		const result = await harness.git(`branch -D ${target}`);
		return { description: `git branch -D ${target}`, result };
	},
};

const branchRename: Action = {
	name: "branchRename",
	category: "branch",
	canRun: (state) => state.branches.length >= 2 && state.hasCommits,
	precondition: (state) => !inConflict(state),
	weight: () => 2,
	async execute(harness, rng, state, fuzz?) {
		const flag = rng.bool(0.25) ? "-M" : "-m";
		if (rng.bool(0.5) && state.currentBranch) {
			const newName = newBranchName(rng, state.branches);
			const result = await harness.git(`branch ${flag} ${newName}`);
			return { description: `git branch ${flag} ${newName}`, result };
		}
		const old = pickOtherBranch(rng, state, { fuzzRate: fuzz?.branchRate });
		if (!old) return { description: "branchRename: no other branch", result: null };
		const newName = newBranchName(rng, state.branches);
		const result = await harness.git(`branch ${flag} ${old} ${newName}`);
		return { description: `git branch ${flag} ${old} ${newName}`, result };
	},
};

const createBranchFromRef: Action = {
	name: "createBranchFromRef",
	category: "branch",
	canRun: (state) => state.branches.length >= 2 && state.hasCommits,
	precondition: (state) => !inConflict(state),
	weight: () => 2,
	async execute(harness, rng, state, fuzz?) {
		const startPoint = pickAnyBranch(rng, state, {
			fuzzRate: fuzz?.branchRate,
		});
		if (!startPoint) return { description: "createBranchFromRef: no branch", result: null };
		const name = newBranchName(rng, state.branches);
		const result = await harness.git(`branch ${name} ${startPoint}`);
		return { description: `git branch ${name} ${startPoint}`, result };
	},
};

const detachedCheckout: Action = {
	name: "detachedCheckout",
	category: "branch",
	canRun: (state) => state.hasCommits,
	precondition: (state) => !inConflict(state),
	weight: () => 1,
	async execute(harness, rng, _state, fuzz?) {
		const hash = await pickCommitHash(harness, rng, {
			fuzzRate: fuzz?.commitRate,
		});
		if (!hash) return { description: "detachedCheckout: no commits", result: null };
		const result = await harness.git(`checkout ${hash}`);
		return {
			description: `git checkout ${hash.slice(0, 8)} (detached)`,
			result,
		};
	},
};

const checkoutFile: Action = {
	name: "checkoutFile",
	category: "branch",
	canRun: (state) => state.files.length > 0 && state.hasCommits,
	precondition: () => true,
	weight: () => 1,
	async execute(harness, rng, state, fuzz?) {
		const path = pickFile(rng, state, { fuzzRate: fuzz?.fileRate });
		if (!path) return { description: "checkoutFile: no file", result: null };
		const result = await harness.git(`checkout -- "${path}"`);
		return { description: `git checkout -- ${path}`, result };
	},
};

const checkoutFileFromCommit: Action = {
	name: "checkoutFileFromCommit",
	category: "branch",
	canRun: (state) => state.files.length > 0 && state.hasCommits,
	precondition: () => true,
	weight: () => 1,
	async execute(harness, rng, state, fuzz?) {
		const path = pickFile(rng, state, { fuzzRate: fuzz?.fileRate });
		if (!path) return { description: "checkoutFileFromCommit: no file", result: null };
		const hash = await pickCommitHash(harness, rng, {
			fuzzRate: fuzz?.commitRate,
		});
		if (!hash)
			return {
				description: "checkoutFileFromCommit: no commits",
				result: null,
			};
		const result = await harness.git(`checkout ${hash} -- "${path}"`);
		return {
			description: `git checkout ${hash.slice(0, 8)} -- ${path}`,
			result,
		};
	},
};

export const BRANCH_ACTIONS: readonly Action[] = [
	createBranch,
	checkoutOrphan,
	switchBranch,
	deleteBranch,
	branchForceDelete,
	branchRename,
	createBranchFromRef,
	detachedCheckout,
	checkoutFile,
	checkoutFileFromCommit,
];
