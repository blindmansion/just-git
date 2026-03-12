import type { Action } from "../types";

const fileOps: Action = {
	name: "fileOps",
	category: "file-ops",
	canRun: () => true,
	precondition: () => true,
	weight: (state) => (state.files.length < 3 ? 14 : 10),
	async execute(harness, rng, state) {
		const seed = rng.int(0, 2 ** 31 - 1);
		await harness.applyFileOpBatch(seed, state.files);
		return { description: `fileOps seed=${seed}`, result: null };
	},
};

export const FILE_OPS_ACTIONS: readonly Action[] = [fileOps];
