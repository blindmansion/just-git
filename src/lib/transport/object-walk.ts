import { objectExists, readObject } from "../object-db.ts";
import { parseCommit } from "../objects/commit.ts";
import { parseTag } from "../objects/tag.ts";
import { parseTree } from "../objects/tree.ts";
import type { GitContext, ObjectId, ObjectType } from "../types.ts";

// ── Types ────────────────────────────────────────────────────────────

interface WalkObject {
	hash: ObjectId;
	type: ObjectType;
}

interface WalkObjectWithContent {
	hash: ObjectId;
	type: ObjectType;
	content: Uint8Array;
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Collect all objects reachable from `want` hashes but NOT reachable
 * from `have` hashes. Returns the set of object IDs that need to be
 * transferred.
 *
 * This is the core of pack negotiation: given what the receiver wants
 * and what it already has, determine the minimal set of objects to send.
 */
export async function enumerateObjects(
	ctx: GitContext,
	wants: ObjectId[],
	haves: ObjectId[],
): Promise<WalkObject[]> {
	return enumerateMissing(ctx, wants, haves, false) as Promise<WalkObject[]>;
}

/**
 * Like `enumerateObjects`, but retains each object's raw content in the
 * result so callers (e.g. repack) avoid a second read pass.
 */
export async function enumerateObjectsWithContent(
	ctx: GitContext,
	wants: ObjectId[],
	haves: ObjectId[],
): Promise<WalkObjectWithContent[]> {
	return enumerateMissing(ctx, wants, haves, true) as Promise<WalkObjectWithContent[]>;
}

async function enumerateMissing(
	ctx: GitContext,
	wants: ObjectId[],
	haves: ObjectId[],
	includeContent: boolean,
): Promise<(WalkObject | WalkObjectWithContent)[]> {
	const haveSet = new Set<ObjectId>();
	for (const hash of haves) {
		await walkReachable(ctx, hash, haveSet);
	}

	const result: (WalkObject | WalkObjectWithContent)[] = [];
	const visited = new Set<ObjectId>();

	for (const hash of wants) {
		await collectMissing(ctx, hash, haveSet, visited, result, includeContent);
	}

	return result;
}

// ── Internal ─────────────────────────────────────────────────────────

/**
 * Walk all objects reachable from `hash`, adding them to `visited`.
 */
async function walkReachable(
	ctx: GitContext,
	hash: ObjectId,
	visited: Set<ObjectId>,
): Promise<void> {
	if (visited.has(hash)) return;
	visited.add(hash);

	if (!(await objectExists(ctx, hash))) return;

	const raw = await readObject(ctx, hash);

	switch (raw.type) {
		case "commit": {
			const commit = parseCommit(raw.content);
			await walkReachable(ctx, commit.tree, visited);
			for (const parent of commit.parents) {
				await walkReachable(ctx, parent, visited);
			}
			break;
		}
		case "tree": {
			const tree = parseTree(raw.content);
			for (const entry of tree.entries) {
				await walkReachable(ctx, entry.hash, visited);
			}
			break;
		}
		case "tag": {
			const tag = parseTag(raw.content);
			await walkReachable(ctx, tag.object, visited);
			break;
		}
		case "blob":
			break;
	}
}

/**
 * Walk from `hash`, collecting objects that are NOT in `haveSet`.
 * Stops traversal when hitting an object in haveSet (everything
 * below it is assumed to be already known).
 *
 * When `includeContent` is true, each result entry retains the raw
 * object bytes so callers avoid a second read pass.
 */
async function collectMissing(
	ctx: GitContext,
	hash: ObjectId,
	haveSet: Set<ObjectId>,
	visited: Set<ObjectId>,
	result: (WalkObject | WalkObjectWithContent)[],
	includeContent: boolean,
): Promise<void> {
	if (visited.has(hash) || haveSet.has(hash)) return;
	visited.add(hash);

	const raw = await readObject(ctx, hash);
	result.push(
		includeContent ? { hash, type: raw.type, content: raw.content } : { hash, type: raw.type },
	);

	switch (raw.type) {
		case "commit": {
			const commit = parseCommit(raw.content);
			await collectMissing(ctx, commit.tree, haveSet, visited, result, includeContent);
			for (const parent of commit.parents) {
				await collectMissing(ctx, parent, haveSet, visited, result, includeContent);
			}
			break;
		}
		case "tree": {
			const tree = parseTree(raw.content);
			for (const entry of tree.entries) {
				await collectMissing(ctx, entry.hash, haveSet, visited, result, includeContent);
			}
			break;
		}
		case "tag": {
			const tag = parseTag(raw.content);
			await collectMissing(ctx, tag.object, haveSet, visited, result, includeContent);
			break;
		}
		case "blob":
			break;
	}
}
