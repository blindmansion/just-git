import { readObject } from "./object-db.ts";
import { parseTag } from "./objects/tag.ts";
import { join } from "./path.ts";
import { deleteReflog } from "./reflog.ts";
import { ensureParentDir } from "./repo.ts";
import type { DirectRef, GitContext, ObjectId, Ref, SymbolicRef } from "./types.ts";

// ── Constants ───────────────────────────────────────────────────────

const SYMBOLIC_PREFIX = "ref: ";
const MAX_SYMREF_DEPTH = 10;

// ── Read ────────────────────────────────────────────────────────────

/**
 * Read a single ref and return it without following symbolic refs.
 * `name` can be a full path like "refs/heads/main" or just "HEAD".
 * Falls back to the `packed-refs` file when no loose ref file exists.
 */
async function readRef(ctx: GitContext, name: string): Promise<Ref | null> {
	const path = refPath(ctx, name);
	if (await ctx.fs.exists(path)) {
		const raw = (await ctx.fs.readFile(path)).trim();

		if (raw.startsWith(SYMBOLIC_PREFIX)) {
			return {
				type: "symbolic",
				target: raw.slice(SYMBOLIC_PREFIX.length),
			} satisfies SymbolicRef;
		}

		return { type: "direct", hash: raw } satisfies DirectRef;
	}

	// Fall back to packed-refs (only contains direct refs)
	const packed = await readPackedRefs(ctx);
	const hash = packed.get(name);
	if (hash) return { type: "direct", hash } satisfies DirectRef;

	return null;
}

/**
 * Resolve a ref name all the way to a concrete ObjectId,
 * following symbolic refs recursively.
 * Returns null if the ref doesn't exist or points to a nonexistent target
 * (e.g. HEAD on an empty repo pointing to refs/heads/main which doesn't exist yet).
 */
export async function resolveRef(ctx: GitContext, name: string): Promise<ObjectId | null> {
	let current = name;

	for (let depth = 0; depth < MAX_SYMREF_DEPTH; depth++) {
		const ref = await readRef(ctx, current);
		if (!ref) return null;

		if (ref.type === "direct") return ref.hash;

		// Follow the symbolic ref
		current = ref.target;
	}

	throw new Error(`Symbolic ref loop detected resolving "${name}"`);
}

/** Shorthand: read HEAD as a Ref. */
export async function readHead(ctx: GitContext): Promise<Ref | null> {
	return readRef(ctx, "HEAD");
}

/** Shorthand: resolve HEAD to a commit hash (null on empty repo). */
export async function resolveHead(ctx: GitContext): Promise<ObjectId | null> {
	return resolveRef(ctx, "HEAD");
}

// ── Write ───────────────────────────────────────────────────────────

/** Write a direct ref (a file containing just a hex hash). */
export async function updateRef(ctx: GitContext, name: string, hash: ObjectId): Promise<void> {
	const oldHash = ctx.hooks ? await resolveRef(ctx, name) : null;
	const path = refPath(ctx, name);
	await ensureParentDir(ctx.fs, path);
	await ctx.fs.writeFile(path, `${hash}\n`);
	ctx.hooks?.emit("ref:update", {
		ref: name,
		oldHash,
		newHash: hash,
	});
}

/** Write a symbolic ref (a file containing `ref: <target>`). */
export async function createSymbolicRef(
	ctx: GitContext,
	name: string,
	target: string,
): Promise<void> {
	const path = refPath(ctx, name);
	await ensureParentDir(ctx.fs, path);
	await ctx.fs.writeFile(path, `${SYMBOLIC_PREFIX}${target}\n`);
}

/** Delete a ref (removes loose file, packed-refs entry, and reflog). */
export async function deleteRef(ctx: GitContext, name: string): Promise<void> {
	const oldHash = ctx.hooks ? await resolveRef(ctx, name) : null;
	const path = refPath(ctx, name);
	if (await ctx.fs.exists(path)) {
		await ctx.fs.rm(path);
	}
	await removePackedRef(ctx, name);
	await deleteReflog(ctx, name);
	if (ctx.hooks && oldHash) {
		ctx.hooks.emit("ref:delete", { ref: name, oldHash });
	}
}

// ── Enumeration ─────────────────────────────────────────────────────

interface RefEntry {
	name: string;
	hash: ObjectId;
}

/**
 * List all refs under a prefix (e.g. "refs/heads", "refs/tags").
 * Returns resolved hashes (follows symbolic refs).
 * Merges loose refs with packed-refs; loose refs take precedence.
 */
export async function listRefs(ctx: GitContext, prefix: string = "refs"): Promise<RefEntry[]> {
	const results: RefEntry[] = [];
	const dir = join(ctx.gitDir, prefix);

	if (await ctx.fs.exists(dir)) {
		await walkRefs(ctx, dir, prefix, results);
	}

	const packed = await readPackedRefs(ctx);
	if (packed.size > 0) {
		const looseNames = new Set(results.map((r) => r.name));
		const prefixSlash = `${prefix}/`;
		for (const [name, hash] of packed) {
			if (name.startsWith(prefixSlash) && !looseNames.has(name)) {
				results.push({ name, hash });
			}
		}
	}

	return results.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// ── Branch helpers ──────────────────────────────────────────────────

/** Extract the short branch name from a full ref path like "refs/heads/main" → "main". */
export function branchNameFromRef(ref: string): string {
	return ref.replace("refs/heads/", "");
}

/** Advance the current branch (or detached HEAD) to point at `hash`. */
export async function advanceBranchRef(ctx: GitContext, hash: ObjectId): Promise<void> {
	const head = await readHead(ctx);
	if (head && head.type === "symbolic") {
		await updateRef(ctx, head.target, hash);
	} else {
		await updateRef(ctx, "HEAD", hash);
	}
}

// ── Pack refs ───────────────────────────────────────────────────────

/**
 * Remove a single ref entry from the `packed-refs` file.
 * Also removes the `^` peeled line that follows it (if any).
 */
async function removePackedRef(ctx: GitContext, name: string): Promise<void> {
	const packedPath = join(ctx.gitDir, "packed-refs");
	if (!(await ctx.fs.exists(packedPath))) return;

	const content = await ctx.fs.readFile(packedPath);
	const lines = content.split("\n");
	const filtered: string[] = [];
	let skipPeeled = false;

	for (const line of lines) {
		if (skipPeeled && line.startsWith("^")) {
			skipPeeled = false;
			continue;
		}
		skipPeeled = false;

		if (!line || line.startsWith("#")) {
			filtered.push(line);
			continue;
		}

		const spaceIdx = line.indexOf(" ");
		if (spaceIdx !== -1) {
			const refName = line.slice(spaceIdx + 1).trim();
			if (refName === name) {
				skipPeeled = true;
				continue;
			}
		}
		filtered.push(line);
	}

	const hasRefs = filtered.some((l) => l && !l.startsWith("#") && !l.startsWith("^"));
	if (!hasRefs) {
		await ctx.fs.rm(packedPath);
	} else {
		await ctx.fs.writeFile(packedPath, filtered.join("\n"));
	}
}

/**
 * Pack all loose refs under `refs/` into the `packed-refs` file.
 * Removes loose ref files after packing and cleans empty directories.
 * Symbolic refs (e.g. HEAD) are not packed.
 */
export async function writePackedRefs(ctx: GitContext): Promise<void> {
	const refs = await listRefs(ctx, "refs");
	if (refs.length === 0) return;

	const lines: string[] = ["# pack-refs with: peeled fully-peeled sorted"];
	for (const ref of refs) {
		lines.push(`${ref.hash} ${ref.name}`);
		if (ref.name.startsWith("refs/tags/")) {
			try {
				const raw = await readObject(ctx, ref.hash);
				if (raw.type === "tag") {
					let peeled = parseTag(raw.content).object;
					for (let i = 0; i < 100; i++) {
						const inner = await readObject(ctx, peeled);
						if (inner.type !== "tag") break;
						peeled = parseTag(inner.content).object;
					}
					lines.push(`^${peeled}`);
				}
			} catch {
				// skip peeling if object unreadable
			}
		}
	}

	await ctx.fs.writeFile(join(ctx.gitDir, "packed-refs"), `${lines.join("\n")}\n`);

	for (const ref of refs) {
		const loosePath = refPath(ctx, ref.name);
		if (await ctx.fs.exists(loosePath)) {
			await ctx.fs.rm(loosePath);
		}
	}

	await cleanEmptyRefDirs(ctx, join(ctx.gitDir, "refs"));

	// Real git expects refs/, refs/heads/, and refs/tags/ to always exist.
	const refsDir = join(ctx.gitDir, "refs");
	await ctx.fs.mkdir(refsDir, { recursive: true });
	await ctx.fs.mkdir(join(refsDir, "heads"), { recursive: true });
	await ctx.fs.mkdir(join(refsDir, "tags"), { recursive: true });
}

/** Recursively remove empty directories under a ref directory tree. */
async function cleanEmptyRefDirs(ctx: GitContext, dirPath: string): Promise<void> {
	if (!(await ctx.fs.exists(dirPath))) return;
	const stat = await ctx.fs.stat(dirPath);
	if (!stat.isDirectory) return;

	const entries = await ctx.fs.readdir(dirPath);
	for (const entry of entries) {
		await cleanEmptyRefDirs(ctx, join(dirPath, entry));
	}

	const remaining = await ctx.fs.readdir(dirPath);
	if (remaining.length === 0) {
		await ctx.fs.rm(dirPath, { recursive: true });
	}
}

// ── Internal helpers ────────────────────────────────────────────────

/**
 * Parse `.git/packed-refs` into a map of ref name → hash.
 * Format: `<hash> <refname>` per line; lines starting with `#` are
 * comments, lines starting with `^` are peeled hashes (ignored here).
 */
async function readPackedRefs(ctx: GitContext): Promise<Map<string, ObjectId>> {
	const path = join(ctx.gitDir, "packed-refs");
	if (!(await ctx.fs.exists(path))) return new Map();

	const content = await ctx.fs.readFile(path);
	const refs = new Map<string, ObjectId>();

	for (const line of content.split("\n")) {
		if (!line || line.startsWith("#") || line.startsWith("^")) continue;
		const spaceIdx = line.indexOf(" ");
		if (spaceIdx === -1) continue;
		const hash = line.slice(0, spaceIdx);
		const name = line.slice(spaceIdx + 1).trim();
		if (hash.length === 40 && name) {
			refs.set(name, hash);
		}
	}

	return refs;
}

/** Resolve a ref name to its absolute filesystem path. */
function refPath(ctx: GitContext, name: string): string {
	// "HEAD" and other top-level refs live directly in gitDir
	// "refs/heads/main" lives at gitDir/refs/heads/main
	return join(ctx.gitDir, name);
}

/** Recursively walk a directory collecting ref entries. */
async function walkRefs(
	ctx: GitContext,
	dirPath: string,
	prefix: string,
	results: RefEntry[],
): Promise<void> {
	const entries = await ctx.fs.readdir(dirPath);

	for (const entry of entries) {
		const fullPath = join(dirPath, entry);
		const refName = `${prefix}/${entry}`;
		const stat = await ctx.fs.stat(fullPath);

		if (stat.isDirectory) {
			await walkRefs(ctx, fullPath, refName, results);
		} else if (stat.isFile) {
			const hash = await resolveRef(ctx, refName);
			if (hash) {
				results.push({ name: refName, hash });
			}
		}
	}
}
