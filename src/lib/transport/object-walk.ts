import { readCommit, readObject } from "../object-db.ts";
import { parseCommit } from "../objects/commit.ts";
import { parseTag } from "../objects/tag.ts";
import { parseTree } from "../objects/tree.ts";
import type { GitRepo, ObjectId, ObjectType } from "../types.ts";

// ── Types ────────────────────────────────────────────────────────────

interface WalkObject {
	hash: ObjectId;
	type: ObjectType;
}

export interface WalkObjectWithContent {
	hash: ObjectId;
	type: ObjectType;
	content: Uint8Array;
}

/**
 * Result of an object enumeration. Contains the count of discovered
 * objects and a lazily-evaluated async iterable that yields them.
 *
 * `objects` can be consumed exactly once. Callers that need multiple
 * passes should collect into an array first.
 */
interface EnumerationResult<T> {
	count: number;
	objects: AsyncIterable<T>;
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Collect all objects reachable from `want` hashes but NOT reachable
 * from `have` hashes. Returns the set of object IDs (with types) that
 * need to be transferred.
 *
 * The full set is discovered before yielding so that `count` is exact.
 * Each `WalkObject` is lightweight (hash + type only), so the internal
 * array is small even for large repos.
 */
export async function enumerateObjects(
	ctx: GitRepo,
	wants: ObjectId[],
	haves: ObjectId[],
	shallowBoundary?: Set<ObjectId>,
	clientShallowBoundary?: Set<ObjectId>,
): Promise<EnumerationResult<WalkObject>> {
	const haveBoundary = clientShallowBoundary ?? shallowBoundary;
	const haveSet = new Set<ObjectId>();
	for (const hash of haves) {
		await walkReachable(ctx, hash, haveSet, haveBoundary);
	}

	// When deepening/unshallowing, the client already has commits at
	// its shallow boundary but is missing their parents. Add those
	// parents as extra starting points so the want-walk can reach them.
	// Only augment when shallowBoundary is also set (actual deepening);
	// plain fetches from shallow clients just need bounded have-walks.
	const effectiveWants = [...wants];
	if (clientShallowBoundary && shallowBoundary) {
		for (const shallowHash of clientShallowBoundary) {
			try {
				const commit = await readCommit(ctx, shallowHash);
				for (const parent of commit.parents) {
					if (!haveSet.has(parent)) effectiveWants.push(parent);
				}
			} catch {
				// Object may not exist on the server
			}
		}
	}

	const result: WalkObject[] = [];
	const visited = new Set<ObjectId>();
	for (const hash of effectiveWants) {
		await collectMissing(ctx, hash, haveSet, visited, result, shallowBoundary);
	}

	return {
		count: result.length,
		objects: yieldArray(result),
	};
}

/**
 * Like `enumerateObjects`, but each yielded object includes its raw
 * content bytes. This avoids a second read pass during pack building.
 */
export async function enumerateObjectsWithContent(
	ctx: GitRepo,
	wants: ObjectId[],
	haves: ObjectId[],
	shallowBoundary?: Set<ObjectId>,
	clientShallowBoundary?: Set<ObjectId>,
): Promise<EnumerationResult<WalkObjectWithContent>> {
	const haveBoundary = clientShallowBoundary ?? shallowBoundary;
	const haveSet = new Set<ObjectId>();
	for (const hash of haves) {
		await walkReachable(ctx, hash, haveSet, haveBoundary);
	}

	const effectiveWants = [...wants];
	if (clientShallowBoundary && shallowBoundary) {
		for (const shallowHash of clientShallowBoundary) {
			try {
				const commit = await readCommit(ctx, shallowHash);
				for (const parent of commit.parents) {
					if (!haveSet.has(parent)) effectiveWants.push(parent);
				}
			} catch {
				// Object may not exist on the server
			}
		}
	}

	const result: WalkObjectWithContent[] = [];
	const visited = new Set<ObjectId>();
	for (const hash of effectiveWants) {
		await collectMissingWithContent(ctx, hash, haveSet, visited, result, shallowBoundary);
	}

	return {
		count: result.length,
		objects: yieldArray(result),
	};
}

// ── Helpers ──────────────────────────────────────────────────────────

async function* yieldArray<T>(items: T[]): AsyncIterable<T> {
	for (const item of items) yield item;
}

/**
 * Convenience: collect an `EnumerationResult` into a plain array.
 * Useful for callers that need the full list (e.g. delta computation).
 */
export async function collectEnumeration<T>(result: EnumerationResult<T>): Promise<T[]> {
	const items: T[] = [];
	for await (const item of result.objects) items.push(item);
	return items;
}

// ── Internal ─────────────────────────────────────────────────────────

/**
 * Walk all objects reachable from `hash`, adding them to `visited`.
 */
async function walkReachable(
	ctx: GitRepo,
	hash: ObjectId,
	visited: Set<ObjectId>,
	shallowBoundary?: Set<ObjectId>,
): Promise<void> {
	if (visited.has(hash)) return;
	visited.add(hash);

	const raw = await readObjectIfExists(ctx, hash);
	if (!raw) return;

	switch (raw.type) {
		case "commit": {
			const commit = parseCommit(raw.content);
			await walkReachable(ctx, commit.tree, visited, shallowBoundary);
			if (!shallowBoundary?.has(hash)) {
				for (const parent of commit.parents) {
					await walkReachable(ctx, parent, visited, shallowBoundary);
				}
			}
			break;
		}
		case "tree": {
			const tree = parseTree(raw.content);
			for (const entry of tree.entries) {
				await walkReachable(ctx, entry.hash, visited, shallowBoundary);
			}
			break;
		}
		case "tag": {
			const tag = parseTag(raw.content);
			await walkReachable(ctx, tag.object, visited, shallowBoundary);
			break;
		}
		case "blob":
			break;
	}
}

async function collectMissingWithContent(
	ctx: GitRepo,
	hash: ObjectId,
	haveSet: Set<ObjectId>,
	visited: Set<ObjectId>,
	result: WalkObjectWithContent[],
	shallowBoundary?: Set<ObjectId>,
): Promise<void> {
	if (visited.has(hash) || haveSet.has(hash)) return;
	visited.add(hash);

	const raw = await readObject(ctx, hash);
	result.push({ hash, type: raw.type, content: raw.content });

	switch (raw.type) {
		case "commit": {
			const commit = parseCommit(raw.content);
			await collectMissingWithContent(ctx, commit.tree, haveSet, visited, result, shallowBoundary);
			if (!shallowBoundary?.has(hash)) {
				for (const parent of commit.parents) {
					await collectMissingWithContent(ctx, parent, haveSet, visited, result, shallowBoundary);
				}
			}
			break;
		}
		case "tree": {
			const tree = parseTree(raw.content);
			for (const entry of tree.entries) {
				await collectMissingWithContent(ctx, entry.hash, haveSet, visited, result, shallowBoundary);
			}
			break;
		}
		case "tag": {
			const tag = parseTag(raw.content);
			await collectMissingWithContent(ctx, tag.object, haveSet, visited, result, shallowBoundary);
			break;
		}
		case "blob":
			break;
	}
}

async function readObjectIfExists(ctx: GitRepo, hash: ObjectId) {
	if (ctx.objectStore.readMany) {
		const objects = await ctx.objectStore.readMany([hash]);
		return objects.get(hash) ?? null;
	}

	try {
		return await readObject(ctx, hash);
	} catch (err) {
		if (err instanceof Error && err.message === `object ${hash} not found`) {
			return null;
		}
		throw err;
	}
}

/**
 * Walk from `hash`, collecting objects that are NOT in `haveSet`.
 * Stops traversal when hitting an object in haveSet (everything
 * below it is assumed to be already known).
 */
async function collectMissing(
	ctx: GitRepo,
	hash: ObjectId,
	haveSet: Set<ObjectId>,
	visited: Set<ObjectId>,
	result: WalkObject[],
	shallowBoundary?: Set<ObjectId>,
): Promise<void> {
	if (visited.has(hash) || haveSet.has(hash)) return;
	visited.add(hash);

	const raw = await readObject(ctx, hash);
	result.push({ hash, type: raw.type });

	switch (raw.type) {
		case "commit": {
			const commit = parseCommit(raw.content);
			await collectMissing(ctx, commit.tree, haveSet, visited, result, shallowBoundary);
			if (!shallowBoundary?.has(hash)) {
				for (const parent of commit.parents) {
					await collectMissing(ctx, parent, haveSet, visited, result, shallowBoundary);
				}
			}
			break;
		}
		case "tree": {
			const tree = parseTree(raw.content);
			for (const entry of tree.entries) {
				await collectMissing(ctx, entry.hash, haveSet, visited, result, shallowBoundary);
			}
			break;
		}
		case "tag": {
			const tag = parseTag(raw.content);
			await collectMissing(ctx, tag.object, haveSet, visited, result, shallowBoundary);
			break;
		}
		case "blob":
			break;
	}
}
