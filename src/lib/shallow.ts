import { objectExists, readCommit } from "./object-db.ts";
import { join } from "./path.ts";
import type { GitContext, GitRepo, ObjectId } from "./types.ts";

/** Depth value that represents "full history" (used by --unshallow). */
export const INFINITE_DEPTH = 0x7fffffff;

// ── Shared shallow types ────────────────────────────────────────────

/** Shallow boundary delta: what to add/remove from `.git/shallow`. */
export interface ShallowUpdate {
	/** Commits to add to the shallow boundary. */
	shallow: ObjectId[];
	/** Commits to remove from the shallow boundary (now have full parents). */
	unshallow: ObjectId[];
}

// ── .git/shallow file I/O ───────────────────────────────────────────

/**
 * Read the set of shallow boundary commit hashes from `.git/shallow`.
 * Returns an empty set if the file doesn't exist or is empty.
 */
export async function readShallowCommits(ctx: GitContext): Promise<Set<ObjectId>> {
	const path = join(ctx.gitDir, "shallow");
	try {
		const content = await ctx.fs.readFile(path);
		const hashes = new Set<ObjectId>();
		for (const line of content.split("\n")) {
			const trimmed = line.trim();
			if (trimmed.length === 40) hashes.add(trimmed);
		}
		return hashes;
	} catch {
		return new Set();
	}
}

/**
 * Write the shallow boundary set to `.git/shallow`.
 * Removes the file if the set is empty (repo is no longer shallow).
 */
export async function writeShallowCommits(ctx: GitContext, hashes: Set<ObjectId>): Promise<void> {
	const path = join(ctx.gitDir, "shallow");
	if (hashes.size === 0) {
		try {
			await ctx.fs.rm(path, { force: true });
		} catch {
			// Already absent
		}
		return;
	}
	const sorted = [...hashes].sort();
	await ctx.fs.writeFile(path, sorted.join("\n") + "\n");
}

/** Check whether a repo is shallow (has a non-empty `.git/shallow` file). */
export async function isShallowRepo(ctx: GitContext): Promise<boolean> {
	const shallows = await readShallowCommits(ctx);
	return shallows.size > 0;
}

/**
 * Merge a `ShallowUpdate` into the current `.git/shallow` file.
 * Adds new shallow commits, removes unshallowed ones, persists the result.
 */
export async function applyShallowUpdates(
	ctx: GitContext,
	updates: ShallowUpdate,
	existing?: Set<ObjectId>,
): Promise<void> {
	const shallows = existing ?? (await readShallowCommits(ctx));
	for (const hash of updates.shallow) {
		shallows.add(hash);
	}
	for (const hash of updates.unshallow) {
		shallows.delete(hash);
	}
	await writeShallowCommits(ctx, shallows);
}

// ── Shallow boundary computation ────────────────────────────────────

/**
 * Compute the shallow boundary for a depth-limited fetch.
 *
 * BFS from `wants` up to `depth` levels of commit parents. Commits
 * at exactly depth N (whose parents would exceed the limit) become
 * the new shallow boundary. Any commit in `clientShallows` that is
 * now within the traversal depth gets unshallowed.
 *
 * The returned `shallow` set is the new boundary — commits whose
 * parents the client should NOT expect to have. The `unshallow` set
 * is commits that were previously shallow but are now within depth.
 */
export async function computeShallowBoundary(
	repo: GitRepo,
	wants: ObjectId[],
	depth: number,
	clientShallows: Set<ObjectId>,
): Promise<ShallowUpdate> {
	if (depth >= INFINITE_DEPTH) {
		return { shallow: [], unshallow: [...clientShallows] };
	}

	const visited = new Map<ObjectId, number>();
	const queue: Array<{ hash: ObjectId; level: number }> = [];

	for (const hash of wants) {
		if (!visited.has(hash) && (await objectExists(repo, hash))) {
			visited.set(hash, 1);
			queue.push({ hash, level: 1 });
		}
	}

	const newShallows = new Set<ObjectId>();

	let qi = 0;
	while (qi < queue.length) {
		const { hash, level } = queue[qi++]!;

		if (level >= depth) {
			newShallows.add(hash);
			continue;
		}

		let commit;
		try {
			commit = await readCommit(repo, hash);
		} catch {
			continue;
		}

		for (const parentHash of commit.parents) {
			if (!visited.has(parentHash) && (await objectExists(repo, parentHash))) {
				visited.set(parentHash, level + 1);
				queue.push({ hash: parentHash, level: level + 1 });
			}
		}
	}

	const unshallow: ObjectId[] = [];
	for (const hash of clientShallows) {
		const reachedAt = visited.get(hash);
		if (reachedAt !== undefined && reachedAt < depth) {
			unshallow.push(hash);
		}
	}

	return { shallow: [...newShallows], unshallow };
}
