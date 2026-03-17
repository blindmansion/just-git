import { envelope, PackedObjectStore } from "./object-store.ts";
import { parseCommit } from "./objects/commit.ts";
import { parseTag } from "./objects/tag.ts";
import { sha1 } from "./sha1.ts";
import type { Commit, GitContext, ObjectId, ObjectStore, ObjectType, RawObject, Tag } from "./types.ts";

// ── Store resolution ────────────────────────────────────────────────

function getStore(ctx: GitContext): ObjectStore {
	if (ctx.objectStore) return ctx.objectStore;
	const store = new PackedObjectStore(ctx.fs, ctx.gitDir, ctx.hooks);
	ctx.objectStore = store;
	return store;
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Compute the SHA-1 hash for an object without writing it to the store.
 */
export async function hashObject(type: ObjectType, content: Uint8Array): Promise<ObjectId> {
	return sha1(envelope(type, content));
}

/**
 * Write an object to the store.
 * Returns the object's SHA-1 hash.
 * If the object already exists, this is a no-op (content-addressable).
 */
export async function writeObject(
	ctx: GitContext,
	type: ObjectType,
	content: Uint8Array,
): Promise<ObjectId> {
	return getStore(ctx).write(type, content);
}

/**
 * Read a raw object from the store.
 * Parses the stored data and returns the type + content.
 */
export async function readObject(ctx: GitContext, hash: ObjectId): Promise<RawObject> {
	return getStore(ctx).read(hash);
}

/**
 * Check whether an object exists in the store.
 */
export async function objectExists(ctx: GitContext, hash: ObjectId): Promise<boolean> {
	return getStore(ctx).exists(hash);
}

/**
 * Import a raw packfile into the object store. The pack is retained
 * on disk with an index for efficient random-access reads.
 */
export async function ingestPackData(ctx: GitContext, packData: Uint8Array): Promise<number> {
	return getStore(ctx).ingestPack(packData);
}

/**
 * Find all object hashes matching a hex prefix.
 * Searches both loose objects and packfiles.
 */
export async function findObjectsByPrefix(
	ctx: GitContext,
	prefix: string,
): Promise<ObjectId[]> {
	return getStore(ctx).findByPrefix(prefix);
}

// ── Binary detection ────────────────────────────────────────────────

/** Check if a UTF-8 string contains NUL bytes (binary content). */
export function isBinaryStr(text: string): boolean {
	const limit = Math.min(text.length, 8000);
	for (let i = 0; i < limit; i++) {
		if (text.charCodeAt(i) === 0) return true;
	}
	return false;
}

/** Check if raw bytes contain NUL bytes (binary content). */
export function isBinaryBytes(data: Uint8Array): boolean {
	const limit = Math.min(data.byteLength, 8000);
	for (let i = 0; i < limit; i++) {
		if (data[i] === 0) return true;
	}
	return false;
}

// ── Blob read helpers ───────────────────────────────────────────────

const decoder = new TextDecoder();

/**
 * Read a blob object and return its content as a UTF-8 string.
 * Throws if the hash doesn't point to a blob.
 */
export async function readBlobContent(ctx: GitContext, hash: ObjectId): Promise<string> {
	const raw = await readObject(ctx, hash);
	if (raw.type !== "blob") {
		throw new Error(`Expected blob for ${hash}, got ${raw.type}`);
	}
	return decoder.decode(raw.content);
}

/**
 * Read a blob object and return its raw bytes.
 * Throws if the hash doesn't point to a blob.
 */
export async function readBlobBytes(ctx: GitContext, hash: ObjectId): Promise<Uint8Array> {
	const raw = await readObject(ctx, hash);
	if (raw.type !== "blob") {
		throw new Error(`Expected blob for ${hash}, got ${raw.type}`);
	}
	return raw.content;
}

// ── Typed read helpers ──────────────────────────────────────────────

/**
 * Read and parse a commit object. Throws if the hash doesn't
 * point to a commit.
 */
export async function readCommit(ctx: GitContext, hash: ObjectId): Promise<Commit> {
	const raw = await readObject(ctx, hash);
	if (raw.type !== "commit") {
		throw new Error(`Expected commit object for ${hash}, got ${raw.type}`);
	}
	return parseCommit(raw.content);
}

/**
 * Read and parse a tag object. Throws if the hash doesn't
 * point to a tag.
 */
export async function readTag(ctx: GitContext, hash: ObjectId): Promise<Tag> {
	const raw = await readObject(ctx, hash);
	if (raw.type !== "tag") {
		throw new Error(`Expected tag object for ${hash}, got ${raw.type}`);
	}
	return parseTag(raw.content);
}

/**
 * Peel an object hash through tag objects until reaching a commit.
 * If the hash already points to a commit, returns it unchanged.
 * Follows chains of annotated tags (tag → tag → commit).
 */
export async function peelToCommit(ctx: GitContext, hash: ObjectId): Promise<ObjectId> {
	let current = hash;
	for (let depth = 0; depth < 100; depth++) {
		const raw = await readObject(ctx, current);
		if (raw.type === "commit") return current;
		if (raw.type === "tag") {
			const tag = parseTag(raw.content);
			current = tag.object;
			continue;
		}
		throw new Error(`Cannot peel ${raw.type} object ${hash} to commit`);
	}
	throw new Error(`Tag chain too deep for ${hash}`);
}
