import { findBestDeltas, type DeltaObject } from "../lib/pack/delta.ts";
import { deflate } from "../lib/pack/zlib.ts";
import { enumerateObjects } from "../lib/transport/object-walk.ts";
import type { GitRepo, RawObject, RefEntry } from "../lib/types.ts";
import type { RepoStorage } from "./repo-storage.ts";
import type { DeltaObjectRow } from "./repo-store.ts";

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
	/**
	 * Delete unreachable objects. Default: true.
	 *
	 * Set to `false` (with `compact: true`) to compact reachable history
	 * without pruning — the "compress only" mode — leaving recently-orphaned
	 * objects in place.
	 */
	prune?: boolean;
	/**
	 * zlib-compress stored object bytes during compaction. Default: true.
	 *
	 * Only relevant when {@link compact} is set. When `false`, objects are
	 * stored as `raw`/`delta` (delta-encoding still applies — it is the main
	 * spatial win for near-duplicate history); this skips the zlib CPU cost,
	 * an escape hatch for CPU-constrained (e.g. browser/`fflate`) clients or
	 * already-compressed payloads. Incompressible objects never grow even when
	 * `true` — the smaller of raw vs zlib is stored.
	 */
	compress?: boolean;
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
 * @param storage - Raw object and ref persistence scoped to this repo.
 * @param options - GC options.
 * @param forkRepos - Handles for any forks of this repo. Each fork's reachable
 *   closure (walked through its own handle, so fork-partition objects resolve)
 *   is unioned into the reachable set — this keeps shared bases the fork relies
 *   on (in this root's partition) from being pruned. Forks must be walked via
 *   their own handle because the root handle cannot read a fork's partition.
 */
export async function gcRepo(
	repo: GitRepo,
	storage: RepoStorage,
	options?: GcOptions,
	forkRepos?: ReadonlyArray<GitRepo>,
): Promise<GcResult> {
	const dryRun = options?.dryRun ?? false;
	const compact = (options?.compact ?? false) && !dryRun;
	const prune = options?.prune ?? true;
	const compress = options?.compress ?? true;
	const window = options?.window ?? DEFAULT_WINDOW;
	const depth = options?.depth ?? DEFAULT_DEPTH;

	const beforeRefs = await snapshotRefs(repo);
	const tips = refTips(beforeRefs);

	if (tips.length === 0) {
		return { deleted: 0, retained: 0 };
	}

	const reachable = await computeReachable(repo, tips);
	if (forkRepos) {
		for (const forkRepo of forkRepos) {
			const forkTips = refTips(await snapshotRefs(forkRepo));
			if (forkTips.length === 0) continue;
			const forkReachable = await computeReachable(forkRepo, forkTips);
			for (const hash of forkReachable) reachable.add(hash);
		}
	}

	const allHashes = await storage.listObjectHashes();
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
		bytesBefore = await maybeByteSize(storage);
		const stats = await compactReachable(
			repo,
			storage,
			allHashes,
			reachable,
			window,
			depth,
			compress,
		);
		deltified = stats.deltified;
		bytesAfter = await maybeByteSize(storage);
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

	if (dryRun || !prune || unreachable.length === 0) {
		// dryRun previews the would-be count; a no-prune or empty pass deletes nothing.
		return {
			deleted: dryRun ? unreachable.length : 0,
			retained: reachable.size,
			deltified,
			bytesBefore,
			bytesAfter,
		};
	}

	const deleted = await storage.deleteObjects(unreachable);
	if (compact) bytesAfter = await maybeByteSize(storage);
	return { deleted, retained: reachable.size, deltified, bytesBefore, bytesAfter };
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
	storage: RepoStorage,
	allHashes: ReadonlyArray<string>,
	reachable: ReadonlySet<string>,
	window: number,
	depth: number,
	compress: boolean,
): Promise<{ deltified: number }> {
	const candidates: string[] = [];
	for (const hash of allHashes) {
		if (reachable.has(hash)) candidates.push(hash);
	}
	if (candidates.length === 0) return { deltified: 0 };

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
				encoding: compress ? "delta-zlib" : "delta",
				baseHash: r.deltaBase,
				content: compress ? await deflate(r.delta) : r.delta,
			});
			deltified++;
		} else if (compress) {
			// Store whichever is smaller — incompressible objects stay raw.
			const deflated = await deflate(r.content);
			if (deflated.byteLength < r.content.byteLength) {
				rows.push({ hash: r.hash, type: r.type, encoding: "raw-zlib", content: deflated });
			} else {
				rows.push({ hash: r.hash, type: r.type, encoding: "raw", content: r.content });
			}
		} else {
			rows.push({ hash: r.hash, type: r.type, encoding: "raw", content: r.content });
		}
	}

	await storage.putDeltaObjects(rows);
	return { deltified };
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

async function maybeByteSize(storage: RepoStorage): Promise<number | undefined> {
	if (!storage.repoByteSize) return undefined;
	return storage.repoByteSize();
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
