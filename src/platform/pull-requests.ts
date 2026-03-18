import type { GitRepo, Identity } from "../lib/types.ts";
import { createCommit, isAncestor, mergeTrees, resolveRef } from "../server/helpers.ts";
import type { MergeResult, MergeStrategy } from "./types.ts";

export class MergeError extends Error {
	constructor(
		message: string,
		public readonly code:
			| "not_open"
			| "head_mismatch"
			| "ref_missing"
			| "conflicts"
			| "not_fast_forward",
	) {
		super(message);
		this.name = "MergeError";
	}
}

export interface ExecuteMergeOptions {
	repo: GitRepo;
	strategy: MergeStrategy;
	baseRef: string;
	headRef: string;
	expectedHeadSha: string | null;
	committer: Identity;
	message?: string;
}

/**
 * Execute a PR merge against a GitRepo, returning the resulting commit
 * hash and strategy used. Throws MergeError on validation failures.
 *
 * Does NOT update platform DB state — the caller is responsible for
 * marking the PR as merged and advancing refs.
 */
export async function executeMerge(opts: ExecuteMergeOptions): Promise<MergeResult> {
	const { repo, strategy, baseRef, headRef, expectedHeadSha, committer, message } = opts;

	const baseSha = await resolveRef(repo, baseRef);
	if (!baseSha) {
		throw new MergeError(`base ref '${baseRef}' does not exist`, "ref_missing");
	}

	const headSha = await resolveRef(repo, headRef);
	if (!headSha) {
		throw new MergeError(`head ref '${headRef}' does not exist`, "ref_missing");
	}

	if (expectedHeadSha && headSha !== expectedHeadSha) {
		throw new MergeError(
			`head ref '${headRef}' has moved (expected ${expectedHeadSha.slice(0, 8)}, got ${headSha.slice(0, 8)})`,
			"head_mismatch",
		);
	}

	switch (strategy) {
		case "merge":
			return doMergeCommit(repo, baseSha, headSha, committer, message);
		case "squash":
			return doSquash(repo, baseSha, headSha, committer, message);
		case "fast-forward":
			return doFastForward(repo, baseSha, headSha);
	}
}

async function doMergeCommit(
	repo: GitRepo,
	baseSha: string,
	headSha: string,
	committer: Identity,
	message?: string,
): Promise<MergeResult> {
	const result = await mergeTrees(repo, baseSha, headSha);
	if (!result.clean) {
		throw new MergeError("merge has conflicts", "conflicts");
	}

	const sha = await createCommit(repo, {
		tree: result.treeHash,
		parents: [baseSha, headSha],
		author: committer,
		committer,
		message: message ?? `Merge branch into base\n`,
	});

	return { sha, strategy: "merge" };
}

async function doSquash(
	repo: GitRepo,
	baseSha: string,
	headSha: string,
	committer: Identity,
	message?: string,
): Promise<MergeResult> {
	const result = await mergeTrees(repo, baseSha, headSha);
	if (!result.clean) {
		throw new MergeError("merge has conflicts", "conflicts");
	}

	const sha = await createCommit(repo, {
		tree: result.treeHash,
		parents: [baseSha],
		author: committer,
		committer,
		message: message ?? `Squashed merge\n`,
	});

	return { sha, strategy: "squash" };
}

async function doFastForward(
	repo: GitRepo,
	baseSha: string,
	headSha: string,
): Promise<MergeResult> {
	const ancestor = await isAncestor(repo, baseSha, headSha);
	if (!ancestor) {
		throw new MergeError(
			"cannot fast-forward: base is not an ancestor of head",
			"not_fast_forward",
		);
	}

	return { sha: headSha, strategy: "fast-forward" };
}
