import { basename, dirname, join } from "./path.ts";
import type { GitContext } from "./types.ts";

/** A linked worktree registered under the common dir's `worktrees/` directory. */
interface WorktreeEntry {
	/** The worktree id — the directory name under `.git/worktrees`. */
	id: string;
	/** Absolute path to the worktree's private admin dir (its `$GIT_DIR`). */
	privateDir: string;
}

/** Where a worktree's HEAD points: a branch ref, or a detached commit. */
export type WorktreeHead = { type: "branch"; ref: string } | { type: "detached"; hash: string };

/**
 * List the linked worktrees registered under the common dir.
 *
 * Reads `<commonDir>/worktrees/*`; returns `[]` when no worktrees exist. This
 * is the single source for "what worktrees does this repository have", used by
 * garbage collection and the `git worktree` command.
 */
export async function enumerateWorktrees(ctx: GitContext): Promise<WorktreeEntry[]> {
	const worktreesDir = join(ctx.commonDir, "worktrees");
	if (!(await ctx.fs.exists(worktreesDir))) return [];

	const entries: WorktreeEntry[] = [];
	for (const id of await ctx.fs.readdir(worktreesDir)) {
		const privateDir = join(worktreesDir, id);
		const stat = await ctx.fs.stat(privateDir);
		if (stat.isDirectory) entries.push({ id, privateDir });
	}
	return entries;
}

/**
 * Derive a unique worktree id from a path, deduplicating against the ids
 * already registered under the common dir (git appends a counter on collision).
 */
export async function deriveWorktreeId(ctx: GitContext, worktreePath: string): Promise<string> {
	const base =
		basename(worktreePath)
			.replace(/\.lock$/, "")
			.replace(/[^A-Za-z0-9._-]/g, "-") || "worktree";

	const worktreesDir = join(ctx.commonDir, "worktrees");
	let id = base;
	let n = 1;
	while (await ctx.fs.exists(join(worktreesDir, id))) {
		id = `${base}${n}`;
		n++;
	}
	return id;
}

/** Absolute path to a worktree's `.git` gitlink file. */
function gitFilePath(worktreePath: string): string {
	return join(worktreePath, ".git");
}

/** Write a worktree's `.git` gitlink file pointing at its admin directory. */
export async function writeGitFile(
	ctx: GitContext,
	worktreePath: string,
	adminDir: string,
): Promise<void> {
	await ctx.fs.mkdir(worktreePath, { recursive: true });
	await ctx.fs.writeFile(gitFilePath(worktreePath), `gitdir: ${adminDir}\n`);
}

/**
 * Create the admin directory for a new worktree under
 * `<commonDir>/worktrees/<id>`, writing HEAD, the `commondir` back-pointer, and
 * the `gitdir` pointer to the worktree's `.git` file. Returns the admin dir.
 */
export async function writeWorktreeAdmin(
	ctx: GitContext,
	id: string,
	worktreePath: string,
	head: WorktreeHead,
): Promise<string> {
	const adminDir = join(ctx.commonDir, "worktrees", id);
	await ctx.fs.mkdir(adminDir, { recursive: true });
	await ctx.fs.writeFile(join(adminDir, "commondir"), "../..\n");
	await ctx.fs.writeFile(join(adminDir, "gitdir"), `${gitFilePath(worktreePath)}\n`);
	await setWorktreeHead(ctx, adminDir, head);
	return adminDir;
}

/** Write a worktree's private HEAD file (a branch ref or a detached commit). */
export async function setWorktreeHead(
	ctx: GitContext,
	adminDir: string,
	head: WorktreeHead,
): Promise<void> {
	const content = head.type === "branch" ? `ref: ${head.ref}\n` : `${head.hash}\n`;
	await ctx.fs.writeFile(join(adminDir, "HEAD"), content);
}

export async function lockWorktree(
	ctx: GitContext,
	adminDir: string,
	reason?: string,
): Promise<void> {
	await ctx.fs.writeFile(join(adminDir, "locked"), reason ? `${reason}\n` : "\n");
}

export async function unlockWorktree(ctx: GitContext, adminDir: string): Promise<void> {
	const path = join(adminDir, "locked");
	if (await ctx.fs.exists(path)) await ctx.fs.rm(path);
}

export async function isWorktreeLocked(ctx: GitContext, adminDir: string): Promise<boolean> {
	return ctx.fs.exists(join(adminDir, "locked"));
}

/** The reason recorded when a worktree was locked, or "" if none was given. */
export async function readLockReason(ctx: GitContext, adminDir: string): Promise<string> {
	const path = join(adminDir, "locked");
	if (!(await ctx.fs.exists(path))) return "";
	return (await ctx.fs.readFile(path)).trim();
}

/**
 * The `.git` gitlink file a worktree's admin dir points at (via `gitdir`). This
 * is the file inside the worktree, not the worktree directory itself — git
 * considers a worktree prunable when this file is gone, even if the directory
 * remains.
 */
async function worktreeGitlinkFor(ctx: GitContext, adminDir: string): Promise<string | null> {
	const gitdirFile = join(adminDir, "gitdir");
	if (!(await ctx.fs.exists(gitdirFile))) return null;
	const pointer = (await ctx.fs.readFile(gitdirFile)).trim();
	return pointer || null;
}

/** The main worktree's working-directory path, or null for a bare repo. */
function mainWorktreePath(ctx: GitContext): string | null {
	if (ctx.workTree && ctx.gitDir === ctx.commonDir) return ctx.workTree;
	// A linked worktree: the main worktree is the parent of `<main>/.git`.
	if (basename(ctx.commonDir) === ".git") return dirname(ctx.commonDir);
	return null;
}

/** A worktree as seen by `git worktree list`. */
export interface WorktreeInfo {
	path: string;
	adminDir: string;
	branch: string | null;
	head: string | null;
	isMain: boolean;
	bare: boolean;
	locked: boolean;
	lockReason: string | null;
	/** A reason string when the worktree can be pruned, else null. */
	prunable: string | null;
}

async function readAdminHead(
	ctx: GitContext,
	adminDir: string,
): Promise<{ branch: string | null; hash: string | null }> {
	const headPath = join(adminDir, "HEAD");
	if (!(await ctx.fs.exists(headPath))) return { branch: null, hash: null };
	const raw = (await ctx.fs.readFile(headPath)).trim();
	if (raw.startsWith("ref: ")) return { branch: raw.slice(5), hash: null };
	return { branch: null, hash: raw };
}

/**
 * Describe every worktree (the main worktree first, then the linked worktrees)
 * for `git worktree list`. A linked worktree whose admin HEAD names a branch
 * resolves the branch tip; a detached one reports its commit directly.
 */
export async function listWorktrees(ctx: GitContext): Promise<WorktreeInfo[]> {
	const resolveHeadInfo = async (
		adminDir: string,
	): Promise<{ branch: string | null; head: string | null }> => {
		const { branch, hash } = await readAdminHead(ctx, adminDir);
		if (hash) return { branch: null, head: hash };
		if (!branch) return { branch: null, head: null };
		const ref = await ctx.refStore.readRef(branch);
		return { branch, head: ref?.type === "direct" ? ref.hash : null };
	};

	const result: WorktreeInfo[] = [];

	const bare = ctx.workTree === null && ctx.gitDir === ctx.commonDir;
	const mainPath = bare ? ctx.commonDir : mainWorktreePath(ctx);
	if (mainPath) {
		const info = bare ? { branch: null, head: null } : await resolveHeadInfo(ctx.commonDir);
		result.push({
			path: mainPath,
			adminDir: ctx.commonDir,
			branch: info.branch,
			head: info.head,
			isMain: true,
			bare,
			locked: false,
			lockReason: null,
			prunable: null,
		});
	}

	for (const wt of await enumerateWorktrees(ctx)) {
		const gitlink = await worktreeGitlinkFor(ctx, wt.privateDir);
		const path = gitlink ? dirname(gitlink) : null;
		const locked = await isWorktreeLocked(ctx, wt.privateDir);
		let prunable: string | null = null;
		if (!gitlink) prunable = "gitdir file does not exist";
		else if (!(await ctx.fs.exists(gitlink)))
			prunable = "gitdir file points to non-existent location";

		const info = await resolveHeadInfo(wt.privateDir);
		result.push({
			path: path ?? "",
			adminDir: wt.privateDir,
			branch: info.branch,
			head: info.head,
			isMain: false,
			bare: false,
			locked,
			lockReason: locked ? (await readLockReason(ctx, wt.privateDir)) || null : null,
			prunable,
		});
	}

	return result;
}

/**
 * The resolved HEAD commit of every worktree (the main worktree and each linked
 * one). These are extra traversal roots for `--all`, which in git reaches
 * commits held only by another worktree's HEAD — for example a detached
 * checkout pinning a commit no branch points at.
 */
export async function worktreeHeadCommits(ctx: GitContext): Promise<string[]> {
	const heads: string[] = [];
	for (const wt of await listWorktrees(ctx)) {
		if (wt.head) heads.push(wt.head);
	}
	return heads;
}

/**
 * Find the worktree currently holding `branchRef` checked out, if any. Scans
 * the main worktree and every linked worktree, optionally skipping one admin
 * dir (the worktree being created or operated on).
 */
export async function branchCheckedOutAt(
	ctx: GitContext,
	branchRef: string,
	skipAdminDir?: string,
): Promise<string | null> {
	for (const wt of await listWorktrees(ctx)) {
		if (wt.adminDir === skipAdminDir) continue;
		if (wt.branch === branchRef) return wt.path;
	}
	return null;
}
