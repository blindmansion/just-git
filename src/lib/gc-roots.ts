import { readIndex } from "./index.ts";
import { objectExists } from "./object-db.ts";
import { join } from "./path.ts";
import { readReflog, ZERO_HASH } from "./reflog.ts";
import { listRefs, resolveHead, resolveRef } from "./refs.ts";
import type { GitContext, ObjectId } from "./types.ts";

/**
 * Collect all root object IDs that must be kept (reachable from HEAD,
 * refs, reflogs, the index, and in-progress operation state files).
 * Filters out hashes whose objects no longer exist in the store.
 */
export async function collectAllRoots(gitCtx: GitContext): Promise<ObjectId[]> {
	const roots = new Set<ObjectId>();

	const head = await resolveHead(gitCtx);
	if (head) roots.add(head);

	const refs = await listRefs(gitCtx, "refs");
	for (const ref of refs) {
		roots.add(ref.hash);
	}

	const logsDir = join(gitCtx.gitDir, "logs");
	if (await gitCtx.fs.exists(logsDir)) {
		await walkLogsDir(gitCtx, logsDir, logsDir, roots);
	}

	const index = await readIndex(gitCtx);
	for (const entry of index.entries) {
		roots.add(entry.hash);
	}

	for (const stateRef of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "ORIG_HEAD"]) {
		const hash = await resolveRef(gitCtx, stateRef);
		if (hash) roots.add(hash);
	}

	const existing: ObjectId[] = [];
	for (const hash of roots) {
		if (await objectExists(gitCtx, hash)) {
			existing.push(hash);
		}
	}
	return existing;
}

async function walkLogsDir(
	gitCtx: GitContext,
	dirPath: string,
	logsDir: string,
	roots: Set<ObjectId>,
): Promise<void> {
	const entries = await gitCtx.fs.readdir(dirPath);
	for (const entry of entries) {
		const fullPath = join(dirPath, entry);
		const stat = await gitCtx.fs.stat(fullPath);
		if (stat.isDirectory) {
			await walkLogsDir(gitCtx, fullPath, logsDir, roots);
		} else if (stat.isFile) {
			const refName = fullPath.slice(logsDir.length + 1);
			const reflogEntries = await readReflog(gitCtx, refName);
			for (const e of reflogEntries) {
				if (e.newHash !== ZERO_HASH) roots.add(e.newHash);
			}
		}
	}
}
