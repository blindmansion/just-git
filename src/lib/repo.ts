import type { FileSystem } from "../fs.ts";
import { type GitConfig, serializeConfig } from "./config.ts";
import { PackedObjectStore } from "./object-store.ts";
import { join } from "./path.ts";
import { createSymbolicRef, FileSystemRefStore } from "./refs.ts";
import type { GitContext } from "./types.ts";

// ── Repository discovery ────────────────────────────────────────────

/**
 * Walk up from `startPath` looking for a git repository.
 * Checks for both normal repos (`.git/` subdirectory) and bare repos
 * (`HEAD` + `objects/` + `refs/` directly in the directory).
 * Returns a GitContext if found, null otherwise.
 */
export async function findRepo(fs: FileSystem, startPath: string): Promise<GitContext | null> {
	let current = startPath;

	while (true) {
		// Check for normal repo (.git/ subdirectory)
		const candidate = join(current, ".git");
		if (await fs.exists(candidate)) {
			const stat = await fs.stat(candidate);
			if (stat.isDirectory) {
				return {
					fs,
					gitDir: candidate,
					workTree: current,
					objectStore: new PackedObjectStore(fs, candidate),
					refStore: new FileSystemRefStore(fs, candidate),
				};
			}
		}

		// Check for bare repo (HEAD + objects/ + refs/ in directory itself)
		if (await isBareGitDir(fs, current)) {
			return {
				fs,
				gitDir: current,
				workTree: null,
				objectStore: new PackedObjectStore(fs, current),
				refStore: new FileSystemRefStore(fs, current),
			};
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

/** Ensure the parent directory of a file path exists. */
export async function ensureParentDir(fs: FileSystem, path: string): Promise<void> {
	const lastSlash = path.lastIndexOf("/");
	if (lastSlash > 0) {
		const dir = path.slice(0, lastSlash);
		await fs.mkdir(dir, { recursive: true });
	}
}

/** Get the parent directory of a path. Returns "/" for the root. */
function parentDir(path: string): string {
	const lastSlash = path.lastIndexOf("/");
	if (lastSlash <= 0) return "/";
	return path.slice(0, lastSlash);
}
