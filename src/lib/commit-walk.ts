import { firstLine } from "./command-utils.ts";
import { peelToCommit, readCommit } from "./object-db.ts";
import { listRefs } from "./refs.ts";
import type { Commit, GitRepo, ObjectId } from "./types.ts";

// ── Types ───────────────────────────────────────────────────────────

interface CommitEntry {
	hash: ObjectId;
	commit: Commit;
}

// ── Max-heap by committer timestamp (FIFO for ties) ─────────────────
//
// Git's revision walker uses commit_list_insert_by_date — a sorted
// linked list that maintains FIFO insertion order for equal timestamps.
// A plain binary heap is unstable, so we add an epoch counter as a
// secondary key: lower epoch (inserted earlier) = higher priority.

interface HeapNode {
	entry: CommitEntry;
	epoch: number;
}

export class CommitHeap {
	private heap: HeapNode[] = [];
	private nextEpoch = 0;

	get size(): number {
		return this.heap.length;
	}

	push(entry: CommitEntry): void {
		this.heap.push({ entry, epoch: this.nextEpoch++ });
		this.siftUp(this.heap.length - 1);
	}

	pop(): CommitEntry | undefined {
		const { heap } = this;
		if (heap.length === 0) return undefined;
		const top = heap[0]!;
		const last = heap.pop()!;
		if (heap.length > 0) {
			heap[0] = last;
			this.siftDown(0);
		}
		return top.entry;
	}

	/** Is a higher-priority than b? (newer timestamp, or FIFO for ties) */
	private higher(a: HeapNode, b: HeapNode): boolean {
		const ta = a.entry.commit.committer.timestamp;
		const tb = b.entry.commit.committer.timestamp;
		return ta > tb || (ta === tb && a.epoch < b.epoch);
	}

	private siftUp(i: number): void {
		const { heap } = this;
		while (i > 0) {
			const parent = (i - 1) >> 1;
			if (!this.higher(heap[i]!, heap[parent]!)) break;
			[heap[parent], heap[i]] = [heap[i]!, heap[parent]!];
			i = parent;
		}
	}

	private siftDown(i: number): void {
		const { heap } = this;
		const n = heap.length;
		while (true) {
			let best = i;
			const l = 2 * i + 1;
			const r = 2 * i + 2;
			if (l < n && this.higher(heap[l]!, heap[best]!)) best = l;
			if (r < n && this.higher(heap[r]!, heap[best]!)) best = r;
			if (best === i) break;
			[heap[i], heap[best]] = [heap[best]!, heap[i]!];
			i = best;
		}
	}
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Walk the commit graph starting from one or more hashes, yielding
 * commits in reverse chronological order (newest first).
 *
 * Uses a binary max-heap keyed on committer timestamp to handle
 * merge commits correctly — both parent chains are interleaved
 * by date rather than followed depth-first.
 */
export async function* walkCommits(
	ctx: GitRepo,
	startHash: ObjectId | ObjectId[],
	opts?: { exclude?: ObjectId[] },
): AsyncGenerator<CommitEntry> {
	const excluded = await buildExcludeSet(ctx, opts?.exclude);
	const visited = new Set<ObjectId>(excluded);
	const queue = new CommitHeap();

	const starts = Array.isArray(startHash) ? startHash : [startHash];
	for (const h of starts) {
		if (!visited.has(h)) {
			queue.push(await loadCommit(ctx, h));
		}
	}

	while (queue.size > 0) {
		const entry = queue.pop()!;
		if (visited.has(entry.hash)) continue;
		visited.add(entry.hash);

		yield entry;

		for (const parentHash of entry.commit.parents) {
			if (!visited.has(parentHash)) {
				queue.push(await loadCommit(ctx, parentHash));
			}
		}
	}
}

/**
 * Count how many commits are ahead/behind between two refs.
 * ahead = commits reachable from localHash but not upstreamHash.
 * behind = commits reachable from upstreamHash but not localHash.
 */
export async function countAheadBehind(
	ctx: GitRepo,
	localHash: ObjectId,
	upstreamHash: ObjectId,
): Promise<{ ahead: number; behind: number }> {
	if (localHash === upstreamHash) return { ahead: 0, behind: 0 };

	const localSet = new Set<ObjectId>();
	for await (const entry of walkCommits(ctx, localHash)) {
		localSet.add(entry.hash);
	}

	const upstreamSet = new Set<ObjectId>();
	for await (const entry of walkCommits(ctx, upstreamHash)) {
		upstreamSet.add(entry.hash);
	}

	let ahead = 0;
	for (const h of localSet) {
		if (!upstreamSet.has(h)) ahead++;
	}

	let behind = 0;
	for (const h of upstreamSet) {
		if (!localSet.has(h)) behind++;
	}

	return { ahead, behind };
}

// ── Orphaned commit detection ───────────────────────────────────────

/**
 * Find commits reachable from `startHash` that are not reachable from
 * any ref (or `targetHash`). Up to `maxCount` commits returned.
 *
 * Pre-computes the full set of commits reachable from ALL refs
 * (branches, tags, stash, etc.) and the target, then walks from
 * startHash counting commits not in that set.
 *
 * Note: this is slightly more accurate than Git's C implementation.
 * Git's `orphaned_commit_warning()` uses `mark_parents_uninteresting`
 * which skips recursion into already-marked parents. When multiple
 * refs share ancestry (e.g. stash overlapping with a branch), the
 * early-termination can cause Git to under-propagate and report a
 * higher orphan count. Our full reachability pre-computation avoids
 * this, so we may report fewer orphans than Git in these edge cases.
 */
export async function findOrphanedCommits(
	ctx: GitRepo,
	startHash: ObjectId,
	opts?: { targetHash?: ObjectId; maxCount?: number },
): Promise<{ hash: string; subject: string }[]> {
	const maxCount = opts?.maxCount ?? 25;

	const allRefs = await listRefs(ctx, "refs");
	const refTips: ObjectId[] = [];
	for (const r of allRefs) {
		try {
			refTips.push(await peelToCommit(ctx, r.hash));
		} catch {
			// Skip refs that don't resolve to commits
		}
	}
	if (opts?.targetHash) refTips.push(opts.targetHash);

	// Build the full set of commits reachable from any ref or target.
	const reachable = new Set<ObjectId>();
	if (refTips.length > 0) {
		for await (const entry of walkCommits(ctx, refTips)) {
			reachable.add(entry.hash);
		}
	}

	if (reachable.has(startHash)) return [];

	const orphans: { hash: string; subject: string }[] = [];
	const seen = new Set<ObjectId>();
	const queue = new CommitHeap();

	queue.push(await loadCommit(ctx, startHash));

	while (queue.size > 0 && orphans.length < maxCount) {
		const entry = queue.pop()!;
		if (seen.has(entry.hash)) continue;
		seen.add(entry.hash);

		if (reachable.has(entry.hash)) continue;

		orphans.push({
			hash: entry.hash,
			subject: firstLine(entry.commit.message),
		});

		for (const parentHash of entry.commit.parents) {
			if (!seen.has(parentHash)) {
				queue.push(await loadCommit(ctx, parentHash));
			}
		}
	}

	return orphans;
}

// ── Helpers ─────────────────────────────────────────────────────────

async function buildExcludeSet(
	ctx: GitRepo,
	exclude: ObjectId[] | undefined,
): Promise<Set<ObjectId>> {
	if (!exclude || exclude.length === 0) return new Set();
	const set = new Set<ObjectId>();
	for await (const entry of walkCommits(ctx, exclude)) {
		set.add(entry.hash);
	}
	return set;
}

async function loadCommit(ctx: GitRepo, hash: ObjectId): Promise<CommitEntry> {
	return { hash, commit: await readCommit(ctx, hash) };
}
