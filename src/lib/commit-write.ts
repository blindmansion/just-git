// The shared commit-write chokepoint: serialize a commit, store it, and
// advance the current branch ref. Pure data core (returns the new hash) with
// no CLI concept — used by merge / rebase / cherry-pick / revert / pull.

import { writeObject } from "./object-db.ts";
import { serializeCommit } from "./objects/commit.ts";
import { advanceBranchRef } from "./refs/refs.ts";
import { type Signer, commitSigningPayload } from "./signing.ts";
import type { Commit, GitRepo, Identity, ObjectId } from "./types.ts";

/**
 * Serialize a commit, write it to the object store, and advance the branch ref.
 * Returns the new commit hash.
 *
 * Shared chokepoint behind merge / rebase / cherry-pick / revert / pull. When
 * `sign` is provided, the commit is signed (the `gpgsig` header is filled from
 * {@link commitSigningPayload}); resolve it once per command via
 * `resolveCommandSigner`.
 */
export async function writeCommitAndAdvance(
	ctx: GitRepo,
	tree: ObjectId,
	parents: ObjectId[],
	author: Identity,
	committer: Identity,
	message: string,
	sign?: Signer,
): Promise<ObjectId> {
	const commit: Commit = {
		type: "commit",
		tree,
		parents,
		author,
		committer,
		message,
	};
	if (sign) commit.gpgsig = await sign(commitSigningPayload(commit));
	const content = serializeCommit(commit);
	const hash = await writeObject(ctx, "commit", content);
	await advanceBranchRef(ctx, hash);
	return hash;
}
