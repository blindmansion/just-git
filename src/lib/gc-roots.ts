import { readIndex } from "./index.ts";
import { objectExists } from "./object-db.ts";
import { join } from "./path.ts";
import { listRefs, resolveHead, resolveRef } from "./refs.ts";
import { readReflogAt, ZERO_HASH } from "./reflog.ts";
import type { GitContext, ObjectId } from "./types.ts";
import { enumerateWorktrees } from "./worktree-admin.ts";
import { FileSystemRefStore } from "./ref-store.ts";

/**
 * Collect all root object IDs that must be kept (reachable from HEAD, refs,
 * reflogs, the index, and in-progress operation state) across every worktree.
 * Filters out hashes whose objects no longer exist in the store.
 *
 * Every worktree contributes its own HEAD, index, reflogs, and operation
 * state; the shared refs are contributed by all of them and de-duplicated.
 * Collecting only the invoking worktree would let GC delete objects a sibling
 * worktree still needs.
 */
export async function collectAllRoots(gitCtx: GitContext): Promise<ObjectId[]> {
	const roots = new Set<ObjectId>();

	// The main worktree's private state lives in the common dir itself.
	await collectWorktreeRoots(worktreeContext(gitCtx, gitCtx.commonDir), roots);

	for (const wt of await enumerateWorktrees(gitCtx)) {
		await collectWorktreeRoots(worktreeContext(gitCtx, wt.privateDir), roots);
	}

	const existing: ObjectId[] = [];
	for (const hash of roots) {
		if (await objectExists(gitCtx, hash)) existing.push(hash);
	}
	return existing;
}

/**
 * A context viewing one worktree: its private dir, the shared common dir, and a
 * ref store bound to both. Reuses the caller's context (and its ref store) when
 * the private dir is already the one in view.
 */
function worktreeContext(base: GitContext, privateDir: string): GitContext {
	if (privateDir === base.gitDir) return base;

	return {
		...base,
		gitDir: privateDir,
		refStore: new FileSystemRefStore(base.fs, privateDir, base.commonDir),
	};
}

/** Collect the roots a single worktree contributes into the shared set. */
async function collectWorktreeRoots(ctx: GitContext, roots: Set<ObjectId>): Promise<void> {
	const head = await resolveHead(ctx);
	if (head) roots.add(head);

	// listRefs dual-walks: shared refs from the common dir, this worktree's
	// refs/bisect|worktree|rewritten from its private dir.
	for (const ref of await listRefs(ctx, "refs")) {
		roots.add(ref.hash);
	}

	await collectLogRoots(ctx, join(ctx.commonDir, "logs"), roots);
	if (ctx.gitDir !== ctx.commonDir) {
		await collectLogRoots(ctx, join(ctx.gitDir, "logs"), roots);
	}

	const index = await readIndex(ctx);
	for (const entry of index.entries) {
		roots.add(entry.hash);
	}

	for (const stateRef of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "ORIG_HEAD"]) {
		const hash = await resolveRef(ctx, stateRef);
		if (hash) roots.add(hash);
	}
}

async function collectLogRoots(
	ctx: GitContext,
	dirPath: string,
	roots: Set<ObjectId>,
): Promise<void> {
	if (!(await ctx.fs.exists(dirPath))) return;

	for (const entry of await ctx.fs.readdir(dirPath)) {
		const fullPath = join(dirPath, entry);
		const stat = await ctx.fs.stat(fullPath);
		if (stat.isDirectory) {
			await collectLogRoots(ctx, fullPath, roots);
			continue;
		}
		if (!stat.isFile) continue;

		// Read the file we found rather than re-deriving its path from the ref
		// name, which would re-route across the common/private split.
		for (const e of await readReflogAt(ctx.fs, fullPath)) {
			if (e.newHash !== ZERO_HASH) roots.add(e.newHash);
		}
	}
}
