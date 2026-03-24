import type { GitRepo, RefEntry } from "../lib/types.ts";
import { enumerateObjects } from "../lib/transport/object-walk.ts";
import type { Storage } from "./storage.ts";

/** Options for {@link gcRepo}. */
export interface GcOptions {
	/** Report what would be deleted without actually deleting. Default: false. */
	dryRun?: boolean;
}

/** Result of a {@link gcRepo} call. */
export interface GcResult {
	/** Number of unreachable objects deleted (or that would be deleted in dry-run mode). */
	deleted: number;
	/** Number of reachable objects retained. */
	retained: number;
	/** True if GC was aborted because refs changed during the walk (concurrent modification detected). */
	aborted?: boolean;
}

/**
 * Remove unreachable objects from a repo's storage.
 *
 * Walks all objects reachable from the repo's refs, compares against
 * the full set of stored objects, and deletes the difference.
 *
 * Includes a safety check: if any ref changes between the start of
 * the reachability walk and the deletion step, GC aborts and returns
 * `{ aborted: true }`. This prevents data loss from concurrent pushes
 * that complete during the walk. Callers can retry.
 *
 * @param repo - The GitRepo handle (objectStore + refStore).
 * @param driver - The raw Storage backend (for listObjectHashes / deleteObjects).
 * @param repoId - The repo ID in the storage backend.
 * @param options - GC options.
 * @param extraTips - Additional object hashes to treat as reachable (e.g. fork ref tips).
 */
export async function gcRepo(
	repo: GitRepo,
	driver: Storage,
	repoId: string,
	options?: GcOptions,
	extraTips?: string[],
): Promise<GcResult> {
	const dryRun = options?.dryRun ?? false;

	const beforeRefs = await snapshotRefs(repo);
	const tips = refTips(beforeRefs);

	if (extraTips) {
		for (const tip of extraTips) tips.push(tip);
	}

	if (tips.length === 0) {
		return { deleted: 0, retained: 0 };
	}

	const enumResult = await enumerateObjects(repo, tips, []);
	const reachable = new Set<string>();
	for await (const obj of enumResult.objects) {
		reachable.add(obj.hash);
	}

	const allHashes = await driver.listObjectHashes(repoId);
	const unreachable: string[] = [];
	for (const hash of allHashes) {
		if (!reachable.has(hash)) unreachable.push(hash);
	}

	const afterRefs = await snapshotRefs(repo);
	if (!refsMatch(beforeRefs, afterRefs)) {
		return { deleted: 0, retained: reachable.size, aborted: true };
	}

	if (dryRun || unreachable.length === 0) {
		return { deleted: unreachable.length, retained: reachable.size };
	}

	const deleted = await driver.deleteObjects(repoId, unreachable);
	return { deleted, retained: reachable.size };
}

// ── Helpers ─────────────────────────────────────────────────────────

async function snapshotRefs(repo: GitRepo): Promise<RefEntry[]> {
	return repo.refStore.listRefs();
}

function refTips(refs: RefEntry[]): string[] {
	const tips = new Set<string>();
	for (const ref of refs) {
		tips.add(ref.hash);
	}
	return Array.from(tips);
}

function refsMatch(a: RefEntry[], b: RefEntry[]): boolean {
	if (a.length !== b.length) return false;
	const mapA = new Map<string, string>();
	for (const ref of a) mapA.set(ref.name, ref.hash);
	for (const ref of b) {
		if (mapA.get(ref.name) !== ref.hash) return false;
	}
	return true;
}
