import { type BisectState, isBisectInProgress, readBisectState } from "./bisect.ts";
import { readStateFile } from "./operation-state.ts";
import { readRebaseState, type RebaseState } from "./rebase.ts";
import { resolveRef } from "./refs/refs.ts";
import type { GitContext, ObjectId } from "./types.ts";

// ── OperationState: the bounded value-state for in-progress operations ─

/**
 * The primary in-progress git operation, unified into one discriminated
 * value. This is the bounded value-state that lets operation-aware code
 * run on a plain {@link GitContext}: the shell {@link readOperationState
 * materializes} it from the scattered `.git/` state (pseudo-refs, plain
 * files, and the rebase dir), and pure code branches on `kind`.
 *
 * The union models the *primary* operation. Some on-disk situations are
 * genuinely composite (a conflicted rebase also leaves a `MERGE_HEAD`,
 * `git status` reports both) — those few consumers keep reading the
 * granular state directly. Precedence here matches that umbrella view:
 * rebase > cherry-pick > revert > merge > bisect.
 */
export type OperationState =
	| { kind: "none" }
	| { kind: "merge"; heads: ObjectId[]; message: string | null }
	| { kind: "cherry-pick"; head: ObjectId; message: string | null }
	| { kind: "revert"; head: ObjectId; message: string | null }
	| { kind: "rebase"; rebase: RebaseState }
	| { kind: "bisect"; bisect: BisectState };

// ── Filesystem boundary (materialize) ───────────────────────────────

/**
 * Materialize the primary {@link OperationState} from `.git/`. Returns
 * `{ kind: "none" }` when no operation is in progress. This is the
 * imperative-shell read boundary.
 *
 * Precedence follows real git's umbrella view: a rebase wins even when it
 * has paused on a conflicted pick (which also leaves a `MERGE_HEAD`).
 */
export async function readOperationState(ctx: GitContext): Promise<OperationState> {
	const rebase = await readRebaseState(ctx);
	if (rebase) return { kind: "rebase", rebase };

	const cherryPickHead = await resolveRef(ctx, "CHERRY_PICK_HEAD");
	if (cherryPickHead) {
		return {
			kind: "cherry-pick",
			head: cherryPickHead,
			message: await readStateFile(ctx, "MERGE_MSG"),
		};
	}

	const revertHead = await resolveRef(ctx, "REVERT_HEAD");
	if (revertHead) {
		return { kind: "revert", head: revertHead, message: await readStateFile(ctx, "MERGE_MSG") };
	}

	const mergeHead = await resolveRef(ctx, "MERGE_HEAD");
	if (mergeHead) {
		return { kind: "merge", heads: [mergeHead], message: await readStateFile(ctx, "MERGE_MSG") };
	}

	if (await isBisectInProgress(ctx)) {
		return { kind: "bisect", bisect: await readBisectState(ctx) };
	}

	return { kind: "none" };
}

// ── Pure helpers (value in, data out) ───────────────────────────────

/** Whether any operation is in progress. */
export function operationInProgress(state: OperationState): boolean {
	return state.kind !== "none";
}
