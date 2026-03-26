import { buildIndex, defaultStat, writeIndex } from "../lib/index.ts";
import { readCommit as _readCommit } from "../lib/object-db.ts";
import { join } from "../lib/path.ts";
import { resolveRevisionRepo } from "../lib/rev-parse.ts";
import { flattenTree as _flattenTree, type FlatTreeEntry } from "../lib/tree-ops.ts";
import type { GitContext, GitRepo } from "../lib/types.ts";
import type { FileSystem } from "../fs.ts";
import { TreeBackedFs } from "../tree-backed-fs.ts";
import { materializeEntries } from "./materialize.ts";
import { overlayRepo } from "./safety.ts";

// ── Internal helpers ────────────────────────────────────────────────

async function resolveToCommitHash(repo: GitRepo, refOrHash: string): Promise<string> {
	const resolved = await resolveRevisionRepo(repo, refOrHash);
	if (resolved) return resolved;
	throw new Error(`ref or commit '${refOrHash}' not found`);
}

function indexFromEntries(entries: FlatTreeEntry[]) {
	return buildIndex(
		entries.map((e) => ({
			path: e.path,
			mode: parseInt(e.mode, 8),
			hash: e.hash,
			stage: 0,
			stat: defaultStat(),
		})),
	);
}

// ── Extract tree ────────────────────────────────────────────────────

/** Result of {@link extractTree}. */
export interface ExtractTreeResult {
	commitHash: string;
	treeHash: string;
	filesWritten: number;
}

/**
 * Materialize the worktree of a commit onto an arbitrary filesystem.
 *
 * Accepts a ref name ("HEAD", "refs/heads/main") or a raw commit hash.
 * Writes all tracked files under `targetDir` (default "/"). No `.git`
 * directory is created — just the working tree.
 */
export async function extractTree(
	repo: GitRepo,
	refOrHash: string,
	fs: FileSystem,
	targetDir = "/",
): Promise<ExtractTreeResult> {
	const commitHash = await resolveToCommitHash(repo, refOrHash);
	const commit = await _readCommit(repo, commitHash);
	const entries = await _flattenTree(repo, commit.tree);
	const filesWritten = await materializeEntries(repo, entries, fs, targetDir);

	return { commitHash, treeHash: commit.tree, filesWritten };
}

// ── Create worktree context ─────────────────────────────────────────

export interface CreateWorktreeOptions {
	/** Ref name or commit hash to check out (default: "HEAD"). */
	ref?: string;
	/** Root of the working tree on the VFS (default: "/"). */
	workTree?: string;
	/** Path to the `.git` directory on the VFS (default: `<workTree>/.git`). */
	gitDir?: string;
}

/** Result of {@link createWorktree} and {@link createSandboxWorktree}. */
export interface WorktreeResult {
	/** The fully-wired GitContext, ready for use with lib/ functions. */
	ctx: GitContext;
	commitHash: string;
	treeHash: string;
	filesWritten: number;
}

/**
 * Create a full `GitContext` backed by a repo's abstract stores.
 *
 * Populates the worktree and index on the provided filesystem from
 * a commit, then returns a `GitContext` whose `objectStore` and
 * `refStore` point at the repo's backing stores (e.g. SQLite) while
 * worktree, index, config, and reflog live on the VFS.
 *
 * The returned context can be used directly with lib/ functions.
 * To use it with `createGit()` + `Bash`, pass the repo's stores
 * through `GitOptions.objectStore` / `GitOptions.refStore` so that
 * command handlers use the shared stores instead of the VFS:
 *
 * ```ts
 * const repo = await storage.createRepo("my-repo");
 * const fs = new InMemoryFs();
 * const { ctx } = await createWorktree(repo, fs);
 * const git = createGit({
 *   objectStore: repo.objectStore,
 *   refStore: repo.refStore,
 * });
 * const bash = new Bash({ fs, cwd: ctx.workTree!, customCommands: [git] });
 * ```
 */
export async function createWorktree(
	repo: GitRepo,
	fs: FileSystem,
	options?: CreateWorktreeOptions,
): Promise<WorktreeResult> {
	const workTree = options?.workTree ?? "/";
	const gitDir = options?.gitDir ?? join(workTree, ".git");
	const ref = options?.ref ?? "HEAD";

	await fs.mkdir(gitDir, { recursive: true });

	const commitHash = await resolveToCommitHash(repo, ref);
	const commit = await _readCommit(repo, commitHash);
	const entries = await _flattenTree(repo, commit.tree);

	const ctx: GitContext = {
		...repo,
		fs,
		gitDir,
		workTree,
	};

	const filesWritten = await materializeEntries(repo, entries, fs, workTree);
	await writeIndex(ctx, indexFromEntries(entries));

	return { ctx, commitHash, treeHash: commit.tree, filesWritten };
}

// ── Sandbox worktree ────────────────────────────────────────────────

/**
 * Create an ephemeral worktree backed by overlay stores and a lazy filesystem.
 *
 * - Object/ref writes go to an in-memory overlay (real repo untouched)
 * - Worktree files are read lazily from the object store on demand
 * - All state is discarded when the returned context goes out of scope
 *
 * Designed for server hooks that need to run tools against pushed code
 * without paying the cost of materializing the entire tree and without
 * risking mutation of the real repository.
 *
 * ```ts
 * hooks: {
 *   async preReceive({ repo, updates }) {
 *     const { ctx } = await createSandboxWorktree(repo, {
 *       ref: updates[0].newHash,
 *     });
 *     const git = createGit({
 *       objectStore: ctx.objectStore,
 *       refStore: ctx.refStore,
 *     });
 *     const bash = new Bash({ fs: ctx.fs, cwd: ctx.workTree! });
 *     const result = await bash.exec("cat package.json");
 *   }
 * }
 * ```
 */
export async function createSandboxWorktree(
	repo: GitRepo,
	options?: { ref?: string; workTree?: string; gitDir?: string },
): Promise<WorktreeResult> {
	const overlay = overlayRepo(repo);
	const workTree = options?.workTree ?? "/";
	const gitDir = options?.gitDir ?? join(workTree, ".git");
	const ref = options?.ref ?? "HEAD";

	const commitHash = await resolveToCommitHash(overlay, ref);
	const commit = await _readCommit(overlay, commitHash);
	const fs = new TreeBackedFs(overlay.objectStore, commit.tree, workTree);

	const branchRef = "refs/heads/main";
	await overlay.refStore.writeRef("HEAD", { type: "symbolic", target: branchRef });
	await overlay.refStore.writeRef(branchRef, { type: "direct", hash: commitHash });

	const ctx: GitContext = {
		...overlay,
		fs,
		gitDir,
		workTree,
	};

	const entries = await _flattenTree(overlay, commit.tree);
	await writeIndex(ctx, indexFromEntries(entries));

	return { ctx, commitHash, treeHash: commit.tree, filesWritten: 0 };
}
