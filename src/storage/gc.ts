import { findBestDeltas, type DeltaObject } from "../lib/pack/delta.ts";
import { deflate } from "../lib/pack/zlib.ts";
import { enumerateObjects } from "../lib/transport/object-walk.ts";
import type { GitRepo, RawObject, RefEntry } from "../lib/types.ts";
import type { DeltaObjectRow, Storage } from "./repo-store.ts";

// ── Defaults ────────────────────────────────────────────────────────

/** Default delta search window (matches the filesystem CLI's `git gc`). */
const DEFAULT_WINDOW = 10;
/** Default max delta chain depth (matches the filesystem CLI's `git gc`). */
const DEFAULT_DEPTH = 50;

// ── Options / results ───────────────────────────────────────────────

/** Options for {@link gcRepo}. */
export interface GcOptions {
	/** Report what would be deleted without actually deleting. Default: false. */
	dryRun?: boolean;
	/**
	 * Also delta-compress reachable history (in addition to pruning
	 * unreachable objects). Reuses the same delta engine as the filesystem
	 * `git repack`. This is the lever that shrinks live, near-duplicate
	 * history; reachability pruning alone cannot. Default: false.
	 *
	 * Ignored when {@link dryRun} is set.
	 */
	compact?: boolean;
	/** Delta search window when compacting (default {@link DEFAULT_WINDOW}). */
	window?: number;
	/** Max delta chain depth when compacting (default {@link DEFAULT_DEPTH}). */
	depth?: number;
}

/** Result of a {@link gcRepo} call. */
export interface GcResult {
	/** Number of unreachable objects deleted (or that would be deleted in dry-run mode). */
	deleted: number;
	/** Number of reachable objects retained. */
	retained: number;
	/** True if GC was aborted because refs changed during the walk (concurrent modification detected). */
	aborted?: boolean;
	/** Number of objects stored as deltas after compaction (only when `compact`). */
	deltified?: number;
	/** Object-partition byte size before compaction (only when `compact` and the backend reports size). */
	bytesBefore?: number;
	/** Object-partition byte size after compaction (only when `compact` and the backend reports size). */
	bytesAfter?: number;
}

/** Options for {@link repackRepo}. */
export interface RepackOptions {
	/** Delta search window (default {@link DEFAULT_WINDOW}). */
	window?: number;
	/** Max delta chain depth (default {@link DEFAULT_DEPTH}). */
	depth?: number;
	/** Report projected work without writing anything. Default: false. */
	dryRun?: boolean;
}

/** Result of a {@link repackRepo} call. */
export interface RepackResult {
	/** Number of reachable objects considered for compaction. */
	repacked: number;
	/** Number of objects stored as deltas. */
	deltified: number;
	/** Object-partition byte size before (when the backend reports size). */
	bytesBefore?: number;
	/** Object-partition byte size after (when the backend reports size). */
	bytesAfter?: number;
}

// ── gcRepo ──────────────────────────────────────────────────────────

/**
 * Remove unreachable objects from a repo's storage, optionally
 * delta-compressing the reachable history in the same pass.
 *
 * Walks all objects reachable from the repo's refs, compares against
 * the full set of stored objects, and deletes the difference. When
 * `compact` is set, reachable objects are first rewritten as deltas /
 * zlib (rewriting never changes a hash, so it is safe even if the
 * deletion phase later aborts).
 *
 * Includes a safety check: if any ref changes between the start of
 * the reachability walk and the deletion step, the deletion is aborted
 * and `{ aborted: true }` is returned. This prevents data loss from
 * concurrent pushes that complete during the walk. Callers can retry.
 *
 * @param repo - The GitRepo handle (objectStore + refStore).
 * @param driver - The raw Storage backend (for listObjectHashes / deleteObjects / putDeltaObjects).
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
	const compact = (options?.compact ?? false) && !dryRun;
	const window = options?.window ?? DEFAULT_WINDOW;
	const depth = options?.depth ?? DEFAULT_DEPTH;

	const beforeRefs = await snapshotRefs(repo);
	const tips = refTips(beforeRefs);

	if (extraTips) {
		for (const tip of extraTips) tips.push(tip);
	}

	if (tips.length === 0) {
		return { deleted: 0, retained: 0 };
	}

	const reachable = await computeReachable(repo, tips);

	const allHashes = await driver.listObjectHashes(repoId);
	const unreachable: string[] = [];
	for (const hash of allHashes) {
		if (!reachable.has(hash)) unreachable.push(hash);
	}

	// Compaction (rewrite) happens before the deletion guard: rewriting an
	// object's encoding never changes its hash/content, so it is safe even
	// if the deletion phase aborts on a concurrent ref change.
	let deltified: number | undefined;
	let bytesBefore: number | undefined;
	let bytesAfter: number | undefined;
	if (compact) {
		bytesBefore = await maybeByteSize(driver, repoId);
		const stats = await compactReachable(repo, driver, repoId, allHashes, reachable, window, depth);
		deltified = stats.deltified;
		bytesAfter = await maybeByteSize(driver, repoId);
	}

	const afterRefs = await snapshotRefs(repo);
	if (!refsMatch(beforeRefs, afterRefs)) {
		return {
			deleted: 0,
			retained: reachable.size,
			aborted: true,
			deltified,
			bytesBefore,
			bytesAfter,
		};
	}

	if (dryRun || unreachable.length === 0) {
		return {
			deleted: unreachable.length,
			retained: reachable.size,
			deltified,
			bytesBefore,
			bytesAfter,
		};
	}

	const deleted = await driver.deleteObjects(repoId, unreachable);
	if (compact) bytesAfter = await maybeByteSize(driver, repoId);
	return { deleted, retained: reachable.size, deltified, bytesBefore, bytesAfter };
}

// ── repackRepo ──────────────────────────────────────────────────────

/**
 * Delta-compress a repo's reachable history without pruning unreachable
 * objects — the "compress only" counterpart to {@link gcRepo}.
 *
 * Equivalent to the compaction phase of `gcRepo({ compact: true })` with
 * the reachability-deletion phase skipped. Use this when you want to bound
 * disk usage of live history but keep recently-orphaned objects around
 * (e.g. before deciding to prune separately).
 *
 * @param extraTips - Additional reachable tips (e.g. fork ref tips) so a
 *   root repo also compacts objects reachable only from its forks.
 */
export async function repackRepo(
	repo: GitRepo,
	driver: Storage,
	repoId: string,
	options?: RepackOptions,
	extraTips?: string[],
): Promise<RepackResult> {
	const window = options?.window ?? DEFAULT_WINDOW;
	const depth = options?.depth ?? DEFAULT_DEPTH;
	const dryRun = options?.dryRun ?? false;

	const tips = refTips(await snapshotRefs(repo));
	if (extraTips) {
		for (const tip of extraTips) tips.push(tip);
	}
	if (tips.length === 0) return { repacked: 0, deltified: 0 };

	const reachable = await computeReachable(repo, tips);
	const allHashes = await driver.listObjectHashes(repoId);

	const candidates = allHashes.filter((h) => reachable.has(h));
	if (dryRun) {
		return { repacked: candidates.length, deltified: 0 };
	}

	const bytesBefore = await maybeByteSize(driver, repoId);
	const stats = await compactReachable(repo, driver, repoId, allHashes, reachable, window, depth);
	const bytesAfter = await maybeByteSize(driver, repoId);

	return { repacked: stats.repacked, deltified: stats.deltified, bytesBefore, bytesAfter };
}

// ── Compaction core ─────────────────────────────────────────────────

/**
 * Rewrite reachable, own-partition objects as delta/zlib rows.
 *
 * Restricting candidates to objects physically in this repo's partition
 * (via `listObjectHashes`, which never includes a parent/fork partition)
 * enforces the fork-safe rule that a delta's base lives in the same
 * partition as the object — `findBestDeltas` only ever deltas within the
 * candidate set.
 */
async function compactReachable(
	repo: GitRepo,
	driver: Storage,
	repoId: string,
	allHashes: ReadonlyArray<string>,
	reachable: ReadonlySet<string>,
	window: number,
	depth: number,
): Promise<{ repacked: number; deltified: number }> {
	const candidates: string[] = [];
	for (const hash of allHashes) {
		if (reachable.has(hash)) candidates.push(hash);
	}
	if (candidates.length === 0) return { repacked: 0, deltified: 0 };

	// Read reconstructed (raw) bodies. readMany decodes any existing delta/zlib
	// rows, so re-compaction always re-deltas from raw — no delta-of-delta
	// chain growth across passes.
	const contentMap = await readAll(repo, candidates);

	const objects: DeltaObject[] = [];
	for (const hash of candidates) {
		const raw = contentMap.get(hash);
		if (!raw) continue;
		objects.push({ hash, type: raw.type, content: raw.content });
	}

	const results = findBestDeltas(objects, { window, depth });

	const rows: DeltaObjectRow[] = [];
	let deltified = 0;
	for (const r of results) {
		if (r.delta && r.deltaBase) {
			rows.push({
				hash: r.hash,
				type: r.type,
				encoding: "delta-zlib",
				baseHash: r.deltaBase,
				content: await deflate(r.delta),
			});
			deltified++;
		} else {
			const deflated = await deflate(r.content);
			if (deflated.byteLength < r.content.byteLength) {
				rows.push({ hash: r.hash, type: r.type, encoding: "raw-zlib", content: deflated });
			} else {
				rows.push({ hash: r.hash, type: r.type, encoding: "raw", content: r.content });
			}
		}
	}

	await driver.putDeltaObjects(repoId, rows);
	return { repacked: rows.length, deltified };
}

// ── Helpers ─────────────────────────────────────────────────────────

async function computeReachable(repo: GitRepo, tips: string[]): Promise<Set<string>> {
	const enumResult = await enumerateObjects(repo, tips, []);
	const reachable = new Set<string>();
	for await (const obj of enumResult.objects) {
		reachable.add(obj.hash);
	}
	return reachable;
}

async function readAll(
	repo: GitRepo,
	hashes: ReadonlyArray<string>,
): Promise<Map<string, RawObject>> {
	if (repo.objectStore.readMany) {
		return repo.objectStore.readMany(hashes);
	}
	const result = new Map<string, RawObject>();
	for (const hash of hashes) {
		result.set(hash, await repo.objectStore.read(hash));
	}
	return result;
}

async function maybeByteSize(driver: Storage, repoId: string): Promise<number | undefined> {
	if (!driver.repoByteSize) return undefined;
	return driver.repoByteSize(repoId);
}

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
