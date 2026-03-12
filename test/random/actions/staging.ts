import { inConflict, pickFile } from "../pickers";
import type { Action } from "../types";

const addAll: Action = {
	name: "addAll",
	category: "staging",
	canRun: () => true,
	precondition: () => true,
	weight: () => 6,
	async execute(harness) {
		const result = await harness.git("add .");
		return { description: "git add .", result };
	},
};

const addAllFlag: Action = {
	name: "addAllFlag",
	category: "staging",
	canRun: () => true,
	precondition: () => true,
	weight: () => 3,
	async execute(harness) {
		const result = await harness.git("add -A");
		return { description: "git add -A", result };
	},
};

const addSpecific: Action = {
	name: "addSpecific",
	category: "staging",
	canRun: (state) => state.files.length > 0,
	precondition: () => true,
	weight: () => 3,
	async execute(harness, rng, state, fuzz?) {
		const path = pickFile(rng, state, { fuzzRate: fuzz?.fileRate });
		if (!path) return { description: "addSpecific: no file", result: null };
		const result = await harness.git(`add "${path}"`);
		return { description: `git add ${path}`, result };
	},
};

const addUpdate: Action = {
	name: "addUpdate",
	category: "staging",
	canRun: (state) => state.hasCommits,
	precondition: () => true,
	weight: () => 2,
	async execute(harness) {
		const result = await harness.git("add -u");
		return { description: "git add -u", result };
	},
};

const rmFile: Action = {
	name: "rmFile",
	category: "staging",
	canRun: (state) => state.files.length >= 2 && state.hasCommits,
	precondition: (state) => !inConflict(state),
	weight: () => 2,
	async execute(harness, rng, state, fuzz?) {
		const path = pickFile(rng, state, { fuzzRate: fuzz?.fileRate });
		if (!path) return { description: "rmFile: no file", result: null };
		const result = await harness.git(`rm "${path}"`);
		return { description: `git rm ${path}`, result };
	},
};

const rmCached: Action = {
	name: "rmCached",
	category: "staging",
	canRun: (state) => state.files.length >= 2 && state.hasCommits,
	precondition: (state) => !inConflict(state),
	weight: () => 1,
	async execute(harness, rng, state, fuzz?) {
		const path = pickFile(rng, state, { fuzzRate: fuzz?.fileRate });
		if (!path) return { description: "rmCached: no file", result: null };
		const result = await harness.git(`rm --cached "${path}"`);
		return { description: `git rm --cached ${path}`, result };
	},
};

const mvFile: Action = {
	name: "mvFile",
	category: "staging",
	canRun: (state) => state.files.length >= 2 && state.hasCommits,
	precondition: (state) => !inConflict(state),
	weight: () => 2,
	async execute(harness, rng, state, fuzz?) {
		const srcPath = pickFile(rng, state, { fuzzRate: fuzz?.fileRate });
		if (!srcPath) return { description: "mvFile: no file", result: null };

		const dirs = new Set<string>();
		dirs.add("");
		for (const f of state.files) {
			const lastSlash = f.lastIndexOf("/");
			if (lastSlash >= 0) {
				dirs.add(f.slice(0, lastSlash + 1));
			}
		}
		const dirList = [...dirs];

		let dstPath: string;
		if (rng.bool(0.5)) {
			const lastSlash = srcPath.lastIndexOf("/");
			const dir = lastSlash >= 0 ? srcPath.slice(0, lastSlash + 1) : "";
			const ext = srcPath.includes(".") ? srcPath.slice(srcPath.lastIndexOf(".")) : "";
			dstPath = `${dir}${rng.alphanumeric(rng.int(3, 8))}${ext}`;
		} else {
			const prefix = rng.pick(dirList);
			const basename =
				srcPath.lastIndexOf("/") >= 0 ? srcPath.slice(srcPath.lastIndexOf("/") + 1) : srcPath;
			dstPath = `${prefix}${basename}`;
		}

		if (dstPath === srcPath) {
			const lastSlash = srcPath.lastIndexOf("/");
			const dir = lastSlash >= 0 ? srcPath.slice(0, lastSlash + 1) : "";
			dstPath = `${dir}renamed-${rng.alphanumeric(4)}`;
		}

		const result = await harness.git(`mv "${srcPath}" "${dstPath}"`);
		return { description: `git mv ${srcPath} ${dstPath}`, result };
	},
};

export const STAGING_ACTIONS: readonly Action[] = [
	addAll,
	addAllFlag,
	addSpecific,
	addUpdate,
	rmFile,
	rmCached,
	mvFile,
];
