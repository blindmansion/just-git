import { join } from "./path.ts";
import { deleteRef } from "./refs.ts";
import type { GitContext } from "./types.ts";

// ── Low-level state file helpers ─────────────────────────────────────

/**
 * Read a plain state file from .git/ (e.g. MERGE_MSG, MERGE_MODE).
 * Returns null if the file doesn't exist.
 */
export async function readStateFile(gitCtx: GitContext, name: string): Promise<string | null> {
	const p = join(gitCtx.gitDir, name);
	if (!(await gitCtx.fs.exists(p))) return null;
	return gitCtx.fs.readFile(p);
}

/**
 * Write a plain state file into .git/.
 */
export async function writeStateFile(
	gitCtx: GitContext,
	name: string,
	content: string,
): Promise<void> {
	await gitCtx.fs.writeFile(join(gitCtx.gitDir, name), content);
}

/**
 * Delete a plain state file from .git/ if it exists.
 */
export async function deleteStateFile(gitCtx: GitContext, name: string): Promise<void> {
	const p = join(gitCtx.gitDir, name);
	if (await gitCtx.fs.exists(p)) await gitCtx.fs.rm(p);
}

// ── Composite cleanup helpers ────────────────────────────────────────

/**
 * Clear merge operation state (MERGE_HEAD, ORIG_HEAD, MERGE_MSG, MERGE_MODE).
 */
export async function clearMergeState(gitCtx: GitContext): Promise<void> {
	await deleteRef(gitCtx, "MERGE_HEAD");
	await deleteRef(gitCtx, "ORIG_HEAD");
	await deleteStateFile(gitCtx, "MERGE_MSG");
	await deleteStateFile(gitCtx, "MERGE_MODE");
	await deleteStateFile(gitCtx, "SQUASH_MSG");
}

/**
 * Clear cherry-pick operation state (CHERRY_PICK_HEAD, ORIG_HEAD, MERGE_MSG, SQUASH_MSG).
 */
export async function clearCherryPickState(gitCtx: GitContext): Promise<void> {
	await deleteRef(gitCtx, "CHERRY_PICK_HEAD");
	await deleteRef(gitCtx, "ORIG_HEAD");
	await deleteStateFile(gitCtx, "MERGE_MSG");
	await deleteStateFile(gitCtx, "SQUASH_MSG");
}

/**
 * Clear revert operation state (REVERT_HEAD, ORIG_HEAD, MERGE_MSG, SQUASH_MSG).
 */
export async function clearRevertState(gitCtx: GitContext): Promise<void> {
	await deleteRef(gitCtx, "REVERT_HEAD");
	await deleteRef(gitCtx, "ORIG_HEAD");
	await deleteStateFile(gitCtx, "MERGE_MSG");
	await deleteStateFile(gitCtx, "SQUASH_MSG");
}

/**
 * Clear all operation state refs and files.
 * Used by reset and checkout to clean up any in-progress operation.
 */
export async function clearAllOperationState(gitCtx: GitContext): Promise<void> {
	for (const ref of ["CHERRY_PICK_HEAD", "REVERT_HEAD", "MERGE_HEAD", "ORIG_HEAD"]) {
		await deleteRef(gitCtx, ref);
	}
	await deleteStateFile(gitCtx, "MERGE_MSG");
	await deleteStateFile(gitCtx, "MERGE_MODE");
	await deleteStateFile(gitCtx, "SQUASH_MSG");
}

// ── Detach point tracking ────────────────────────────────────────────

const DETACH_POINT_FILE = "DETACH_POINT";

export async function writeDetachPoint(gitCtx: GitContext, hash: string): Promise<void> {
	await gitCtx.fs.writeFile(join(gitCtx.gitDir, DETACH_POINT_FILE), hash);
}

export async function clearDetachPoint(gitCtx: GitContext): Promise<void> {
	const p = join(gitCtx.gitDir, DETACH_POINT_FILE);
	if (await gitCtx.fs.exists(p)) await gitCtx.fs.rm(p);
}

/**
 * Read the original detach point hash, or null if not available.
 */
export async function readDetachPoint(gitCtx: GitContext): Promise<string | null> {
	const p = join(gitCtx.gitDir, DETACH_POINT_FILE);
	if (!(await gitCtx.fs.exists(p))) return null;
	const content = await gitCtx.fs.readFile(p);
	return content?.trim() ?? null;
}
