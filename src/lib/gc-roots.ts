import { clockNow } from "./capabilities.ts";
import { readIndex } from "./index.ts";
import { objectExists } from "./object-db.ts";
import { join } from "./path.ts";
import { readReflog, writeReflog, ZERO_HASH } from "./reflog.ts";
import { listRefs, resolveHead, resolveRef } from "./refs.ts";
import type { GitContext, ObjectId } from "./types.ts";

const REFLOG_EXPIRE_SECONDS = 90 * 24 * 60 * 60; // 90 days

/** In-progress operation state refs whose objects must survive a prune. */
const OPERATION_STATE_REFS = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "ORIG_HEAD"];

/**
 * Collect all root object IDs that must be kept (reachable from HEAD,
 * refs, reflogs, the index, and in-progress operation state files).
 * Filters out hashes whose objects no longer exist in the store.
 */
export async function collectAllRoots(gitCtx: GitContext): Promise<ObjectId[]> {
	return collectRoots(gitCtx, null);
}

/**
 * Single-pass: expire old reflog entries, then collect all root object
 * IDs (HEAD, refs, surviving reflog entries, index, op-state).
 * Matches real git's ordering (expire before reachability walk).
 */
export async function collectRootsAndExpireReflogs(gitCtx: GitContext): Promise<ObjectId[]> {
	const cutoff = Math.floor(clockNow(gitCtx.capabilities).getTime() / 1000) - REFLOG_EXPIRE_SECONDS;
	return collectRoots(gitCtx, cutoff);
}

/**
 * Shared root collection. When `cutoff` is non-null, reflog entries older
 * than the cutoff are expired (rewritten) before collection; when null,
 * reflogs are read-only and every entry contributes a root.
 */
async function collectRoots(gitCtx: GitContext, cutoff: number | null): Promise<ObjectId[]> {
	const roots = new Set<ObjectId>();

	const head = await resolveHead(gitCtx);
	if (head) roots.add(head);

	const refs = await listRefs(gitCtx, "refs");
	for (const ref of refs) {
		roots.add(ref.hash);
	}

	const logsDir = join(gitCtx.gitDir, "logs");
	if (await gitCtx.fs.exists(logsDir)) {
		await walkLogsDir(gitCtx, logsDir, logsDir, cutoff, roots);
	}

	const index = await readIndex(gitCtx);
	for (const entry of index.entries) {
		roots.add(entry.hash);
	}

	for (const stateRef of OPERATION_STATE_REFS) {
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
	cutoff: number | null,
	roots: Set<ObjectId>,
): Promise<void> {
	const entries = await gitCtx.fs.readdir(dirPath);
	for (const entry of entries) {
		const fullPath = join(dirPath, entry);
		const stat = await gitCtx.fs.stat(fullPath);
		if (stat.isDirectory) {
			await walkLogsDir(gitCtx, fullPath, logsDir, cutoff, roots);
			if (cutoff !== null) {
				try {
					const remaining = await gitCtx.fs.readdir(fullPath);
					if (remaining.length === 0) {
						await gitCtx.fs.rm(fullPath, { recursive: true });
					}
				} catch {
					// ignore
				}
			}
		} else if (stat.isFile) {
			const refName = fullPath.slice(logsDir.length + 1);
			const reflogEntries = await readReflog(gitCtx, refName);

			// Read-only mode, or the stash reflog (entries are user data,
			// never expired): every entry contributes a root.
			if (cutoff === null || refName === "refs/stash") {
				for (const e of reflogEntries) {
					if (e.newHash !== ZERO_HASH) roots.add(e.newHash);
				}
				continue;
			}

			const kept = reflogEntries.filter((e) => e.timestamp >= cutoff);
			await writeReflog(gitCtx, refName, kept);

			for (const e of kept) {
				if (e.newHash !== ZERO_HASH) roots.add(e.newHash);
			}
		}
	}
}
