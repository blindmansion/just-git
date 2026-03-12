import type { FileSystem } from "../fs.ts";
import { type GitConfig, serializeConfig } from "./config.ts";
import { join } from "./path.ts";
import { createSymbolicRef } from "./refs.ts";
import type { GitContext } from "./types.ts";

// ── Repository discovery ────────────────────────────────────────────

/**
 * Walk up from `startPath` looking for a `.git` directory.
 * Returns a GitContext if found, null otherwise.
 */
export async function findGitDir(fs: FileSystem, startPath: string): Promise<GitContext | null> {
	let current = startPath;

	while (true) {
		const candidate = join(current, ".git");

		if (await fs.exists(candidate)) {
			const stat = await fs.stat(candidate);
			if (stat.isDirectory) {
				return {
					fs,
					gitDir: candidate,
					workTree: current,
				};
			}
		}

		// Move up one level
		const parent = parentDir(current);
		if (parent === current) {
			// Reached filesystem root
			return null;
		}
		current = parent;
	}
}

// ── Repository initialization ───────────────────────────────────────

interface InitOptions {
	/** Create a bare repository (no working tree). */
	bare?: boolean;
	/** Name of the initial branch (default: "main"). */
	initialBranch?: string;
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
 */
export async function initRepository(
	fs: FileSystem,
	path: string,
	options: InitOptions = {},
): Promise<GitContext> {
	const { bare = false, initialBranch = "main" } = options;

	const gitDir = bare ? path : join(path, ".git");
	const workTree = bare ? null : path;

	// Create the directory structure
	await fs.mkdir(join(gitDir, "objects"), { recursive: true });
	await fs.mkdir(join(gitDir, "refs", "heads"), { recursive: true });
	await fs.mkdir(join(gitDir, "refs", "tags"), { recursive: true });

	const ctx: GitContext = { fs, gitDir, workTree };

	// Write HEAD as a symbolic ref to the initial branch
	await createSymbolicRef(ctx, "HEAD", `refs/heads/${initialBranch}`);

	// Write default config
	const config: GitConfig = {
		core: {
			repositoryformatversion: "0",
			filemode: "true",
			bare: bare ? "true" : "false",
		},
	};
	await fs.writeFile(join(gitDir, "config"), serializeConfig(config));

	return ctx;
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
