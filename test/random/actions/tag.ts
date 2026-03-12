import { inConflict, newTagName, pickCommitHash, pickTag } from "../pickers";
import type { Action } from "../types";

const createTag: Action = {
	name: "createTag",
	category: "tag",
	canRun: (state) => state.hasCommits,
	precondition: (state) => !inConflict(state),
	weight: () => 3,
	async execute(harness, rng) {
		const name = newTagName(rng);
		const annotated = rng.bool(0.4);
		let cmd: string;
		if (annotated) {
			const msg = `tag-msg-${rng.alphanumeric(4)}`;
			cmd = `tag -m "${msg}" ${name}`;
		} else {
			cmd = `tag ${name}`;
		}
		const result = await harness.git(cmd);
		return { description: `git ${cmd}`, result };
	},
};

const createTagAtCommit: Action = {
	name: "createTagAtCommit",
	category: "tag",
	canRun: (state) => state.hasCommits,
	precondition: (state) => !inConflict(state),
	weight: () => 1,
	async execute(harness, rng, _state, fuzz?) {
		const hash = await pickCommitHash(harness, rng, {
			fuzzRate: fuzz?.commitRate,
		});
		if (!hash) return { description: "createTagAtCommit: no commits", result: null };
		const name = newTagName(rng);
		const result = await harness.git(`tag ${name} ${hash}`);
		return { description: `git tag ${name} ${hash.slice(0, 8)}`, result };
	},
};

const deleteTag: Action = {
	name: "deleteTag",
	category: "tag",
	canRun: (state) => state.hasCommits,
	precondition: () => true,
	weight: () => 1,
	async execute(harness, rng, _state, fuzz?) {
		const tag = await pickTag(harness, rng, { fuzzRate: fuzz?.tagRate });
		if (!tag) return { description: "deleteTag: no tags", result: null };
		const result = await harness.git(`tag -d ${tag}`);
		return { description: `git tag -d ${tag}`, result };
	},
};

const listTags: Action = {
	name: "listTags",
	category: "diagnostic",
	canRun: (state) => state.hasCommits,
	precondition: () => true,
	weight: () => 1,
	async execute(harness, rng) {
		const usePattern = rng.bool(0.4);
		const pattern = rng.pick(["v*", "release-*", "*"]);
		const cmd = usePattern ? `tag -l "${pattern}"` : "tag";
		const result = await harness.git(cmd);
		return { description: `git ${cmd}`, result };
	},
};

export const TAG_ACTIONS: readonly Action[] = [createTag, createTagAtCommit, deleteTag, listTags];
