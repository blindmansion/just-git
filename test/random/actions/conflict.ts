import { randomContent } from "../file-gen";
import { inConflict, pickFile } from "../pickers";
import { SeededRNG } from "../rng";
import type { Action } from "../types";

const resolveAndCommit: Action = {
	name: "resolveAndCommit",
	category: "conflict-resolution",
	canRun: (state) => inConflict(state) && state.files.length > 0,
	precondition: () => true,
	weight: () => 8,
	async execute(harness, rng) {
		const seed = rng.int(0, 2 ** 31 - 1);
		await harness.resolveFiles(seed);
		await harness.git("add .");
		const msg = `merge-resolve-${rng.alphanumeric(4)}`;
		const commitResult = await harness.gitCommit(msg);
		return {
			description: `resolveAndCommit: resolve files (seed=${seed}), git commit -m "${msg}"`,
			result: commitResult,
		};
	},
};

const resolvePartial: Action = {
	name: "resolvePartial",
	category: "conflict-resolution",
	canRun: (state) => inConflict(state) && state.files.length >= 2,
	precondition: () => true,
	weight: () => 4,
	async execute(harness, rng, state) {
		const count = rng.int(1, Math.max(1, Math.floor(state.files.length / 2)));
		const shuffled = [...state.files].sort(() => rng.next() - 0.5);
		const toResolve = shuffled.slice(0, count);
		const resolveRng = new SeededRNG(rng.int(0, 2 ** 31 - 1));
		for (const file of toResolve.sort()) {
			await harness.writeFile(file, randomContent(resolveRng));
			await harness.git(`add "${file}"`);
		}
		return {
			description: `resolvePartial: resolved ${count}/${state.files.length} files`,
			result: null,
		};
	},
};

const checkoutOursTheirs: Action = {
	name: "checkoutOursTheirs",
	category: "conflict-resolution",
	canRun: (state) => inConflict(state) && state.files.length > 0,
	precondition: () => true,
	weight: () => 4,
	async execute(harness, rng, state, fuzz?) {
		const path = pickFile(rng, state, { fuzzRate: fuzz?.fileRate });
		if (!path) return { description: "checkoutOursTheirs: no file", result: null };
		const side = rng.bool(0.5) ? "--ours" : "--theirs";
		const result = await harness.git(`checkout ${side} -- "${path}"`);
		return { description: `git checkout ${side} -- ${path}`, result };
	},
};

export const CONFLICT_ACTIONS: readonly Action[] = [
	resolveAndCommit,
	resolvePartial,
	checkoutOursTheirs,
];
