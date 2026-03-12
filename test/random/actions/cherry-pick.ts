import { inConflict, pickCommitHash, pickOtherBranch } from "../pickers";
import type { Action } from "../types";

const cherryPick: Action = {
	name: "cherryPick",
	category: "cherry-pick",
	canRun: (state) => state.branches.length >= 2 && state.hasCommits,
	precondition: (state) => !inConflict(state),
	weight: (state) => {
		if (state.branches.length >= 3) return 4;
		return 2;
	},
	async execute(harness, rng, state, fuzz?) {
		const sourceBranch = pickOtherBranch(rng, state, {
			fuzzRate: fuzz?.branchRate,
		});
		if (sourceBranch === null) {
			return { description: "cherryPick: no other branch", result: null };
		}
		const hash = await pickCommitHash(harness, rng, {
			fuzzRate: fuzz?.commitRate,
			branch: sourceBranch,
		});
		if (hash === null) {
			return { description: "cherryPick: no commits on source", result: null };
		}
		const short = hash.slice(0, 8);
		const result = await harness.git(`cherry-pick ${hash}`);
		return {
			description: `git cherry-pick ${short} (from ${sourceBranch})`,
			result,
		};
	},
};

const cherryPickX: Action = {
	name: "cherryPickX",
	category: "cherry-pick",
	canRun: (state) => state.branches.length >= 2 && state.hasCommits,
	precondition: (state) => !inConflict(state),
	weight: (state) => {
		if (state.branches.length >= 3) return 2;
		return 1;
	},
	async execute(harness, rng, state, fuzz?) {
		const sourceBranch = pickOtherBranch(rng, state, {
			fuzzRate: fuzz?.branchRate,
		});
		if (sourceBranch === null) {
			return { description: "cherryPickX: no other branch", result: null };
		}
		const hash = await pickCommitHash(harness, rng, {
			fuzzRate: fuzz?.commitRate,
			branch: sourceBranch,
		});
		if (hash === null) {
			return { description: "cherryPickX: no commits on source", result: null };
		}
		const short = hash.slice(0, 8);
		const result = await harness.git(`cherry-pick -x ${hash}`);
		return {
			description: `git cherry-pick -x ${short} (from ${sourceBranch})`,
			result,
		};
	},
};

const cherryPickAbort: Action = {
	name: "cherryPickAbort",
	category: "cherry-pick",
	canRun: () => true,
	precondition: (state) => state.inCherryPickConflict,
	weight: () => 8,
	async execute(harness) {
		const result = await harness.git("cherry-pick --abort");
		return { description: "git cherry-pick --abort", result };
	},
};

const cherryPickContinue: Action = {
	name: "cherryPickContinue",
	category: "cherry-pick",
	canRun: (state) => state.inCherryPickConflict && state.files.length > 0,
	precondition: () => true,
	weight: () => 8,
	async execute(harness, rng) {
		const seed = rng.int(0, 2 ** 31 - 1);
		await harness.resolveFiles(seed);
		await harness.git("add .");
		const result = await harness.git("cherry-pick --continue");
		return {
			description: `cherryPickContinue: resolve (seed=${seed}), git cherry-pick --continue`,
			result,
		};
	},
};

const cherryPickSkip: Action = {
	name: "cherryPickSkip",
	category: "cherry-pick",
	canRun: () => true,
	precondition: (state) => state.inCherryPickConflict,
	weight: () => 4,
	async execute(harness) {
		const result = await harness.git("cherry-pick --skip");
		return { description: "git cherry-pick --skip", result };
	},
};

const cherryPickNoCommit: Action = {
	name: "cherryPickNoCommit",
	category: "cherry-pick",
	canRun: (state) => state.branches.length >= 2 && state.hasCommits,
	precondition: (state) => !inConflict(state),
	weight: () => 2,
	async execute(harness, rng, state, fuzz?) {
		const sourceBranch = pickOtherBranch(rng, state, {
			fuzzRate: fuzz?.branchRate,
		});
		if (sourceBranch === null) {
			return {
				description: "cherryPickNoCommit: no other branch",
				result: null,
			};
		}
		const hash = await pickCommitHash(harness, rng, {
			fuzzRate: fuzz?.commitRate,
			branch: sourceBranch,
		});
		if (hash === null) {
			return {
				description: "cherryPickNoCommit: no commits on source",
				result: null,
			};
		}
		const short = hash.slice(0, 8);
		const result = await harness.git(`cherry-pick -n ${hash}`);
		return {
			description: `git cherry-pick -n ${short} (from ${sourceBranch})`,
			result,
		};
	},
};

export const CHERRY_PICK_ACTIONS: readonly Action[] = [
	cherryPick,
	cherryPickX,
	cherryPickAbort,
	cherryPickContinue,
	cherryPickSkip,
	cherryPickNoCommit,
];
