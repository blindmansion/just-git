import type { GitRepo } from "../lib/types.ts";

/**
 * Advance `refs/heads/<branch>` to `hash`, optionally guarded by compare-and-swap.
 *
 * HEAD is initialized only for an otherwise-unborn repository. Existing HEAD
 * state is never redirected.
 */
export async function advanceBranchTo(
	repo: GitRepo,
	branch: string,
	hash: string,
	expectedOldHash?: string | null,
): Promise<void> {
	const branchRef = `refs/heads/${branch}`;
	if (expectedOldHash !== undefined) {
		const expectedOld =
			expectedOldHash === null ? null : { type: "direct" as const, hash: expectedOldHash };
		const ok = await repo.refStore.compareAndSwapRef(branchRef, expectedOld, {
			type: "direct",
			hash,
		});
		if (!ok) throw new Error(`branch '${branch}' moved during operation (CAS failed)`);
	} else {
		await repo.refStore.writeRef(branchRef, { type: "direct", hash });
	}

	const head = await repo.refStore.readRef("HEAD");
	if (!head) {
		await repo.refStore.writeRef("HEAD", { type: "symbolic", target: branchRef });
	}
}
