import type { FileSystem } from "../fs.ts";
import { readObject } from "./object-db.ts";
import { parseTag } from "./objects/tag.ts";
import { join } from "./path.ts";
import { deleteReflog } from "./reflog.ts";
import { ensureParentDir } from "./repo.ts";
import type {
	DirectRef,
	GitContext,
	GitRepo,
	ObjectId,
	Ref,
	RefEntry,
	RefStore,
	SymbolicRef,
} from "./types.ts";

// ── Constants ───────────────────────────────────────────────────────

const SYMBOLIC_PREFIX = "ref: ";
const MAX_SYMREF_DEPTH = 10;

// ── FileSystemRefStore ──────────────────────────────────────────────

/**
 * Default filesystem-backed ref storage. Reads/writes loose ref files
 * under `.git/`, with `packed-refs` as fallback for reads and listings.
 */
export class FileSystemRefStore implements RefStore {
	constructor(
		private fs: FileSystem,
		private gitDir: string,
	) {}

	async readRef(name: string): Promise<Ref | null> {
		const path = join(this.gitDir, name);
		if (await this.fs.exists(path)) {
			const raw = (await this.fs.readFile(path)).trim();
			if (raw.startsWith(SYMBOLIC_PREFIX)) {
				return {
					type: "symbolic",
					target: raw.slice(SYMBOLIC_PREFIX.length),
				} satisfies SymbolicRef;
			}
			return { type: "direct", hash: raw } satisfies DirectRef;
		}

		const packed = await this.readPackedRefs();
		const hash = packed.get(name);
		if (hash) return { type: "direct", hash } satisfies DirectRef;

		return null;
	}

	async writeRef(name: string, ref: Ref): Promise<void> {
		const path = join(this.gitDir, name);
		await ensureParentDir(this.fs, path);
		if (ref.type === "symbolic") {
			await this.fs.writeFile(path, `${SYMBOLIC_PREFIX}${ref.target}\n`);
		} else {
			await this.fs.writeFile(path, `${ref.hash}\n`);
		}
	}

	async deleteRef(name: string): Promise<void> {
		const path = join(this.gitDir, name);
		if (await this.fs.exists(path)) {
			await this.fs.rm(path);
		}
		await this.removePackedRef(name);
	}

	async listRefs(prefix: string = "refs"): Promise<RefEntry[]> {
		const results: RefEntry[] = [];
		const dir = join(this.gitDir, prefix);

		if (await this.fs.exists(dir)) {
			await this.walkRefs(dir, prefix, results);
		}

		const packed = await this.readPackedRefs();
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

	private async resolveRefInternal(name: string): Promise<ObjectId | null> {
		let current = name;
		for (let depth = 0; depth < MAX_SYMREF_DEPTH; depth++) {
			const ref = await this.readRef(current);
			if (!ref) return null;
			if (ref.type === "direct") return ref.hash;
			current = ref.target;
		}
		throw new Error(`Symbolic ref loop detected resolving "${name}"`);
	}

	private async readPackedRefs(): Promise<Map<string, ObjectId>> {
		const path = join(this.gitDir, "packed-refs");
		if (!(await this.fs.exists(path))) return new Map();

		const content = await this.fs.readFile(path);
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

	private async removePackedRef(name: string): Promise<void> {
		const packedPath = join(this.gitDir, "packed-refs");
		if (!(await this.fs.exists(packedPath))) return;

		const content = await this.fs.readFile(packedPath);
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
			await this.fs.rm(packedPath);
		} else {
			await this.fs.writeFile(packedPath, filtered.join("\n"));
		}
	}

	private async walkRefs(dirPath: string, prefix: string, results: RefEntry[]): Promise<void> {
		const entries = await this.fs.readdir(dirPath);

		for (const entry of entries) {
			const fullPath = join(dirPath, entry);
			const refName = `${prefix}/${entry}`;
			const stat = await this.fs.stat(fullPath);

			if (stat.isDirectory) {
				await this.walkRefs(fullPath, refName, results);
			} else if (stat.isFile) {
				const hash = await this.resolveRefInternal(refName);
				if (hash) {
					results.push({ name: refName, hash });
				}
			}
		}
	}
}

// ── Read ────────────────────────────────────────────────────────────

async function readRef(ctx: GitRepo, name: string): Promise<Ref | null> {
	return ctx.refStore.readRef(name);
}

/**
 * Resolve a ref name all the way to a concrete ObjectId,
 * following symbolic refs recursively.
 * Returns null if the ref doesn't exist or points to a nonexistent target
 * (e.g. HEAD on an empty repo pointing to refs/heads/main which doesn't exist yet).
 */
export async function resolveRef(ctx: GitRepo, name: string): Promise<ObjectId | null> {
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
export async function readHead(ctx: GitRepo): Promise<Ref | null> {
	return readRef(ctx, "HEAD");
}

/** Shorthand: resolve HEAD to a commit hash (null on empty repo). */
export async function resolveHead(ctx: GitRepo): Promise<ObjectId | null> {
	return resolveRef(ctx, "HEAD");
}

// ── Write ───────────────────────────────────────────────────────────

/** Write a direct ref (a file containing just a hex hash). */
export async function updateRef(ctx: GitRepo, name: string, hash: ObjectId): Promise<void> {
	const oldHash = ctx.hooks ? await resolveRef(ctx, name) : null;
	await ctx.refStore.writeRef(name, { type: "direct", hash });
	ctx.hooks?.emit("ref:update", {
		ref: name,
		oldHash,
		newHash: hash,
	});
}

/** Write a symbolic ref (a file containing `ref: <target>`). */
export async function createSymbolicRef(ctx: GitRepo, name: string, target: string): Promise<void> {
	await ctx.refStore.writeRef(name, { type: "symbolic", target });
}

/** Delete a ref (removes from storage, deletes reflog, emits hook). */
export async function deleteRef(ctx: GitContext, name: string): Promise<void> {
	const oldHash = ctx.hooks ? await resolveRef(ctx, name) : null;
	await ctx.refStore.deleteRef(name);
	await deleteReflog(ctx, name);
	if (ctx.hooks && oldHash) {
		ctx.hooks.emit("ref:delete", { ref: name, oldHash });
	}
}

// ── Enumeration ─────────────────────────────────────────────────────

/**
 * List all refs under a prefix (e.g. "refs/heads", "refs/tags").
 * Returns resolved hashes (follows symbolic refs).
 * Merges loose refs with packed-refs; loose refs take precedence.
 */
export async function listRefs(ctx: GitRepo, prefix: string = "refs"): Promise<RefEntry[]> {
	return ctx.refStore.listRefs(prefix);
}

// ── Branch helpers ──────────────────────────────────────────────────

/** Extract the short branch name from a full ref path like "refs/heads/main" → "main". */
export function branchNameFromRef(ref: string): string {
	return ref.replace("refs/heads/", "");
}

/** Advance the current branch (or detached HEAD) to point at `hash`. */
export async function advanceBranchRef(ctx: GitRepo, hash: ObjectId): Promise<void> {
	const head = await readHead(ctx);
	if (head && head.type === "symbolic") {
		await updateRef(ctx, head.target, hash);
	} else {
		await updateRef(ctx, "HEAD", hash);
	}
}

// ── Pack refs ───────────────────────────────────────────────────────

/**
 * Pack all loose refs under `refs/` into the `packed-refs` file.
 * Removes loose ref files after packing and cleans empty directories.
 * Symbolic refs (e.g. HEAD) are not packed.
 *
 * No-ops when a non-filesystem RefStore is in use.
 */
export async function writePackedRefs(ctx: GitContext): Promise<void> {
	if (ctx.refStore && !(ctx.refStore instanceof FileSystemRefStore)) return;

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
		const loosePath = join(ctx.gitDir, ref.name);
		if (await ctx.fs.exists(loosePath)) {
			await ctx.fs.rm(loosePath);
		}
	}

	await cleanEmptyRefDirs(ctx, join(ctx.gitDir, "refs"));

	const refsDir = join(ctx.gitDir, "refs");
	await ctx.fs.mkdir(refsDir, { recursive: true });
	await ctx.fs.mkdir(join(refsDir, "heads"), { recursive: true });
	await ctx.fs.mkdir(join(refsDir, "tags"), { recursive: true });
}

/**
 * Recursively remove empty directories under a ref directory tree.
 * No-ops when a non-filesystem RefStore is in use.
 */
async function cleanEmptyRefDirs(ctx: GitContext, dirPath: string): Promise<void> {
	if (ctx.refStore && !(ctx.refStore instanceof FileSystemRefStore)) return;

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
