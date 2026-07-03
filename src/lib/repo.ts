import type { FileSystem } from "../fs/index.ts";
import { PackedObjectStore } from "./object-store.ts";
import { join, resolve } from "./path.ts";
import { createSymbolicRef } from "./refs/refs.ts";
import type { GitContext } from "./types.ts";
import { FileSystemRefStore } from "./refs/store.ts";
import { type GitConfig, serializeConfig } from "./config/parse.ts";

// ── Repository discovery ────────────────────────────────────────────

/**
 * Walk up from `startPath` looking for a git repository.
 * Checks for both normal repos (`.git/` subdirectory) and bare repos
 * (`HEAD` + `objects/` + `refs/` directly in the directory).
 * Returns a GitContext if found, null otherwise.
 *
 * The returned handle is **inert**: it carries no `capabilities`, so
 * host-provided behaviors (filters, signing, merge driver, hooks, ...) are
 * silently skipped — an absent capability is a no-op, never an error. Attach
 * them with `withCapabilities` (the `Git.findRepo()` method does this for you).
 */
export async function findRepo(fs: FileSystem, startPath: string): Promise<GitContext | null> {
	let current = startPath;

	while (true) {
		// Check for normal repo (.git/ subdirectory)
		const candidate = join(current, ".git");
		if (await fs.exists(candidate)) {
			const stat = await fs.stat(candidate);
			if (stat.isDirectory) {
				return buildContext(fs, candidate, candidate, current);
			}
			if (stat.isFile) {
				// A `.git` file points at a linked worktree's private dir. A
				// present-but-broken pointer is a hard stop, not a walk-up that
				// would silently attach this cwd to an unrelated ancestor repo.
				const resolved = await resolveGitDirFile(fs, candidate, current);
				return resolved ? buildContext(fs, resolved.gitDir, resolved.commonDir, current) : null;
			}
		}

		// Check for bare repo (HEAD + objects/ + refs/ in directory itself)
		if (await isBareGitDir(fs, current)) {
			return buildContext(fs, current, current, null);
		}

		// Move up one level
		const parent = parentDir(current);
		if (parent === current) {
			return null;
		}
		current = parent;
	}
}

/**
 * Build a GitContext from its resolved directories. The object store is rooted
 * at the shared `commonDir`; the ref store at the private `gitDir`. For a plain
 * repo, a bare repo, and the main worktree these coincide.
 */
function buildContext(
	fs: FileSystem,
	gitDir: string,
	commonDir: string,
	workTree: string | null,
): GitContext {
	return {
		fs,
		gitDir,
		commonDir,
		workTree,
		objectStore: new PackedObjectStore(fs, commonDir),
		refStore: new FileSystemRefStore(fs, gitDir, commonDir),
	};
}

/**
 * Resolve a `.git` *file* (a linked worktree's gitlink) to its private
 * `gitDir` and shared `commonDir`.
 *
 * The file holds a `gitdir: <path>` pointer, resolved against the worktree
 * directory. The private dir's `commondir` file (usually `../..`) names the
 * shared dir; absent, `commonDir` falls back to `gitDir`. Returns null when
 * the file is not a `gitdir:` pointer or names a target that does not exist.
 */
export async function resolveGitDirFile(
	fs: FileSystem,
	dotGitFile: string,
	workTree: string,
): Promise<{ gitDir: string; commonDir: string } | null> {
	const content = (await fs.readFile(dotGitFile)).trim();
	const prefix = "gitdir:";
	if (!content.startsWith(prefix)) return null;

	const pointer = content.slice(prefix.length).trim();
	if (!pointer) return null;

	const gitDir = resolve(workTree, pointer);
	if (!(await fs.exists(gitDir))) return null;

	const commonDirFile = join(gitDir, "commondir");
	if (!(await fs.exists(commonDirFile))) {
		return { gitDir, commonDir: gitDir };
	}

	const rel = (await fs.readFile(commonDirFile)).trim();
	return { gitDir, commonDir: rel ? resolve(gitDir, rel) : gitDir };
}

/**
 * Check whether a directory is a bare git repository.
 * Matches real git's `is_git_directory()` heuristic:
 * the directory must contain HEAD, objects/, and refs/.
 */
async function isBareGitDir(fs: FileSystem, path: string): Promise<boolean> {
	const headPath = join(path, "HEAD");
	if (!(await fs.exists(headPath))) return false;

	try {
		const headStat = await fs.stat(headPath);
		if (!headStat.isFile) return false;
	} catch {
		return false;
	}

	for (const sub of ["objects", "refs"]) {
		const subPath = join(path, sub);
		if (!(await fs.exists(subPath))) return false;
		try {
			const stat = await fs.stat(subPath);
			if (!stat.isDirectory) return false;
		} catch {
			return false;
		}
	}

	return true;
}

// ── Repository initialization ───────────────────────────────────────

interface InitOptions {
	/** Create a bare repository (no working tree). */
	bare?: boolean;
	/** Name of the initial branch (default: "main"). */
	initialBranch?: string;
}

interface InitResult {
	ctx: GitContext;
	/** True when an existing repository was reinitialized. */
	reinit: boolean;
}

/**
 * Initialize a new Git repository at the given path.
 *
 * Creates the full `.git` directory structure:
 *   .git/
 *     HEAD            (symbolic ref → refs/heads/<initialBranch>)
 *     config          (repository config)
 *     objects/        (object database)
 *     refs/
 *       heads/        (branch refs)
 *       tags/         (tag refs)
 *
 * For bare repos, the structure is created directly in `path`
 * instead of `path/.git`.
 *
 * On reinit (HEAD already exists), HEAD and config are preserved.
 */
export async function initRepository(
	fs: FileSystem,
	path: string,
	options: InitOptions = {},
): Promise<InitResult> {
	const { bare = false, initialBranch = "main" } = options;

	const gitDir = bare ? path : join(path, ".git");
	const workTree = bare ? null : path;
	const headPath = join(gitDir, "HEAD");
	const reinit = await fs.exists(headPath);

	// Create the directory structure (idempotent with recursive: true)
	await fs.mkdir(join(gitDir, "objects"), { recursive: true });
	await fs.mkdir(join(gitDir, "refs", "heads"), { recursive: true });
	await fs.mkdir(join(gitDir, "refs", "tags"), { recursive: true });

	const ctx: GitContext = {
		fs,
		gitDir,
		commonDir: gitDir,
		workTree,
		objectStore: new PackedObjectStore(fs, gitDir),
		refStore: new FileSystemRefStore(fs, gitDir),
	};

	if (!reinit) {
		await createSymbolicRef(ctx, "HEAD", `refs/heads/${initialBranch}`);

		const config: GitConfig = {
			core: {
				repositoryformatversion: "0",
				filemode: "true",
				bare: bare ? "true" : "false",
				...(bare ? {} : { logallrefupdates: "true" }),
			},
		};
		await fs.writeFile(join(gitDir, "config"), serializeConfig(config));
	}

	return { ctx, reinit };
}

// ── Helpers ─────────────────────────────────────────────────────────

/** Get the parent directory of a path. Returns "/" for the root. */
function parentDir(path: string): string {
	const lastSlash = path.lastIndexOf("/");
	if (lastSlash <= 0) return "/";
	return path.slice(0, lastSlash);
}
