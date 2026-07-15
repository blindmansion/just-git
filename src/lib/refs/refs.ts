import { ensureDirectory, removeFile, replaceFile } from "../../fs/durable-io.ts";
import { readObject } from "../object-db.ts";
import { parseTag } from "../objects/tag.ts";
import { join } from "../path.ts";
import { isPerWorktreeRef } from "./classify.ts";
import { FileSystemRefStore, MAX_SYMREF_DEPTH } from "./store.ts";
import { applyReflogEffects, type ReflogEffect, reflogDelete } from "./reflog.ts";
import type { GitContext, GitRepo, ObjectId, Ref, RefEntry } from "../types.ts";

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
	const oldHash = ctx.capabilities?.hooks ? await resolveRef(ctx, name) : null;
	await ctx.refStore.writeRef(name, { type: "direct", hash });
	ctx.capabilities?.hooks?.onRefUpdate?.({ repo: ctx, ref: name, oldHash, newHash: hash });
}

/** Write a symbolic ref (a file containing `ref: <target>`). */
export async function createSymbolicRef(ctx: GitRepo, name: string, target: string): Promise<void> {
	await ctx.refStore.writeRef(name, { type: "symbolic", target });
}

/**
 * Create `refs/remotes/<remote>/HEAD` as a symbolic ref pointing at the
 * remote's default branch — but only on first encounter (skips if already set).
 * Used by clone and successful default fetch/pull paths.
 *
 * When `headTarget` is provided (e.g. `"refs/heads/main"` from the transport's
 * symref capability), it is used directly. Otherwise falls back to hash matching,
 * which is ambiguous when multiple branches share the same commit hash.
 */
export async function ensureRemoteHead(
	ctx: GitRepo,
	remoteName: string,
	remoteRefs: ReadonlyArray<{ name: string; hash: string }>,
	headTarget?: string,
): Promise<void> {
	const headRef = remoteRefs.find((r) => r.name === "HEAD");
	if (!headRef) return;

	let branchName: string | undefined;
	if (headTarget?.startsWith("refs/heads/")) {
		branchName = headTarget.slice("refs/heads/".length);
	} else {
		const headBranch = remoteRefs.find(
			(r) => r.name.startsWith("refs/heads/") && r.hash === headRef.hash,
		);
		if (!headBranch) return;
		branchName = headBranch.name.slice("refs/heads/".length);
	}

	const remoteHeadRef = `refs/remotes/${remoteName}/HEAD`;
	const existing = await ctx.refStore.readRef(remoteHeadRef);
	if (existing) return;
	const trackingRef = `refs/remotes/${remoteName}/${branchName}`;
	await ctx.refStore.writeRef(remoteHeadRef, { type: "symbolic", target: trackingRef });
}

/**
 * Delete a ref on a {@link GitRepo}: removes it from the ref store and emits
 * the delete hook, returning the reflog effect for the shell to apply.
 *
 * This is the `GitRepo`-shaped core of {@link deleteRef}. The ref write goes
 * through `refStore` (already on `GitRepo`); the reflog side comes back as a
 * {@link ReflogEffect} so the caller's imperative shell owns the fs write.
 */
export async function deleteRefEffects(repo: GitRepo, name: string): Promise<ReflogEffect[]> {
	const hooks = repo.capabilities?.hooks;
	const oldHash = hooks ? await resolveRef(repo, name) : null;
	await repo.refStore.deleteRef(name);
	if (hooks && oldHash) {
		hooks.onRefDelete?.({ repo, ref: name, oldHash });
	}
	return [reflogDelete(name)];
}

/** Delete a ref (removes from storage, deletes reflog, emits hook). */
export async function deleteRef(ctx: GitContext, name: string): Promise<void> {
	await applyReflogEffects(ctx, await deleteRefEffects(ctx, name));
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

	// Per-worktree refs are loose-only and live in the private dir; only the
	// shared refs are packed, and only the common dir's packed-refs is written.
	const refs = (await listRefs(ctx, "refs")).filter((ref) => !isPerWorktreeRef(ref.name));
	if (refs.length === 0) return;

	const lines: string[] = ["# pack-refs with: peeled fully-peeled sorted"];
	const packed: string[] = [];
	for (const ref of refs) {
		const loosePath = join(ctx.commonDir, ref.name);
		if (await ctx.fs.exists(loosePath)) {
			const raw = (await ctx.fs.readFile(loosePath)).trim();
			if (raw.startsWith("ref: ")) continue;
		}
		packed.push(ref.name);
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

	await replaceFile(ctx.fs, join(ctx.commonDir, "packed-refs"), `${lines.join("\n")}\n`);

	for (const name of packed) {
		const loosePath = join(ctx.commonDir, name);
		await removeFile(ctx.fs, loosePath);
	}

	await cleanEmptyRefDirs(ctx, join(ctx.commonDir, "refs"));

	const refsDir = join(ctx.commonDir, "refs");
	await ensureDirectory(ctx.fs, refsDir);
	await ensureDirectory(ctx.fs, join(refsDir, "heads"));
	await ensureDirectory(ctx.fs, join(refsDir, "tags"));
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
