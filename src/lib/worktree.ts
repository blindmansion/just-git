import { comparePaths } from "./command-utils.ts";
import { cleanForCheckin, getEolPolicy, hashCleanedWorktreeEntry, lfToCrlf } from "./eol.ts";
import { type IgnoreStack, isIgnored, loadBaseIgnore, pushDirIgnore } from "./ignore.ts";
import {
	addEntry,
	findEntry,
	getIndexTimestamp,
	indexStatFromFileStat,
	indexStatMatchesFile,
	worktreeMode,
} from "./index.ts";
import { readObject, writeObject } from "./object-db.ts";
import { isInsideWorkTree, verifyPath, verifySymlinkTarget } from "./path-safety.ts";
import { dirname, join } from "./path.ts";
import { isExecutableMode, isSubmoduleMode, isSymlinkMode, lstatSafe } from "./symlink.ts";
import { flattenTree } from "./tree-ops.ts";
import type { GitContext, Index, IndexEntry, ObjectId, WorkTreeDiff } from "./types.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ── Diff index vs working tree ──────────────────────────────────────

/**
 * Compare the index against the working tree.
 * Returns entries that differ: modified files, deleted files, and untracked files.
 */
export interface WorkTreeDiffOptions {
	/** Include untracked files. Defaults to true for backward compatibility. */
	includeUntracked?: boolean;
	/** Return as soon as the first matching difference is found. */
	stopAfterFirst?: boolean;
	/** Limit comparison to matching repository-relative paths. */
	pathFilter?: (path: string) => boolean;
}

export async function diffIndexToWorkTree(
	ctx: GitContext,
	index: Index,
	opts?: WorkTreeDiffOptions,
): Promise<WorkTreeDiff[]> {
	if (!ctx.workTree) {
		throw new Error("Cannot diff working tree in a bare repository");
	}

	const includeUntracked = opts?.includeUntracked ?? true;
	const stopAfterFirst = opts?.stopAfterFirst ?? false;
	const pathFilter = opts?.pathFilter;
	const indexTimestamp = getIndexTimestamp(index);
	const results: WorkTreeDiff[] = [];

	// Check each index entry against the working tree
	for (const entry of index.entries) {
		if (entry.stage !== 0) continue; // skip conflict entries
		if (isSubmoduleMode(entry.mode)) continue; // skip submodule (gitlink) entries
		if (pathFilter && !pathFilter(entry.path)) continue;

		const fullPath = join(ctx.workTree, entry.path);

		// Use lstat for existence check — stat() follows symlinks so a
		// broken symlink (dangling target) would be reported as deleted.
		let st: Awaited<ReturnType<typeof lstatSafe>> | null;
		try {
			st = await lstatSafe(ctx.fs, fullPath);
		} catch {
			st = null;
		}

		if (!st) {
			results.push({
				path: entry.path,
				status: "deleted",
				indexHash: entry.hash,
			});
			if (stopAfterFirst) return results;
			continue;
		}

		if (!st.isFile && !st.isSymbolicLink) {
			results.push({
				path: entry.path,
				status: "deleted",
				indexHash: entry.hash,
			});
			if (stopAfterFirst) return results;
			continue;
		}

		if (indexStatMatchesFile(ctx.fs, entry, st, indexTimestamp)) continue;

		const workTreeMode = worktreeMode(ctx.fs, entry, st);
		const workTreeHash = await hashCleanedWorktreeEntry(ctx, fullPath, entry.hash, st);

		if (workTreeHash !== entry.hash || workTreeMode !== entry.mode) {
			results.push({
				path: entry.path,
				status: "modified",
				indexHash: entry.hash,
				worktreeHash: workTreeHash,
				worktreeMode: workTreeMode,
			});
			if (stopAfterFirst) return results;
		}
	}

	if (!includeUntracked) {
		return results.sort((a, b) => comparePaths(a.path, b.path));
	}

	// Find untracked files (respecting .gitignore)
	const indexPaths = new Set(index.entries.map((e) => e.path));
	const workTreeFiles = await walkWorkTree(ctx, ctx.workTree, "", {
		stopAfterFirst,
		_fileFilter: (path) => !indexPaths.has(path) && (!pathFilter || pathFilter(path)),
	});

	for (const filePath of workTreeFiles) {
		results.push({ path: filePath, status: "untracked" });
	}

	if (stopAfterFirst) return results;
	return results.sort((a, b) => comparePaths(a.path, b.path));
}

// ── Checkout ────────────────────────────────────────────────────────

/**
 * Write a single file (or symlink) from the object store to the working tree.
 * For mode 120000 entries, creates a symlink whose target is the blob content.
 * Falls back to writing a regular file when the FS doesn't support symlinks
 * (equivalent to git's core.symlinks=false behavior).
 */
export async function checkoutEntry(
	ctx: GitContext,
	entry: { path: string; hash: ObjectId; mode?: number | string },
): Promise<void> {
	if (!ctx.workTree) {
		throw new Error("Cannot checkout in a bare repository");
	}

	if (!verifyPath(entry.path)) {
		throw new Error(`refusing to check out unsafe path '${entry.path}'`);
	}

	if (entry.mode != null && isSubmoduleMode(entry.mode)) {
		const fullPath = join(ctx.workTree, entry.path);
		await ctx.fs.mkdir(fullPath, { recursive: true });
		return;
	}

	const raw = await readObject(ctx, entry.hash);
	if (raw.type !== "blob") {
		throw new Error(`Expected blob for ${entry.path}, got ${raw.type}`);
	}

	const fullPath = join(ctx.workTree, entry.path);

	if (!isInsideWorkTree(ctx.workTree, fullPath)) {
		throw new Error(`refusing to check out path outside worktree: '${entry.path}'`);
	}

	// Ensure parent directories exist
	const lastSlash = fullPath.lastIndexOf("/");
	if (lastSlash > 0) {
		await ctx.fs.mkdir(fullPath.slice(0, lastSlash), { recursive: true });
	}

	if (entry.mode != null && isSymlinkMode(entry.mode) && ctx.fs.symlink) {
		const target = decoder.decode(raw.content);
		if (!verifySymlinkTarget(target)) {
			throw new Error(`refusing to create symlink with unsafe target '${target}'`);
		}
		// Remove any existing entry (file, dir, or symlink) before creating
		// the symlink. Use lstat to detect broken symlinks that exists()
		// would miss (exists follows symlinks; broken targets → false).
		const pathPresent = await lstatSafe(ctx.fs, fullPath)
			.then(() => true)
			.catch(() => false);
		if (pathPresent) {
			await ctx.fs.rm(fullPath, { force: true });
		}
		await ctx.fs.symlink(target, fullPath);
	} else {
		// For regular files, remove a stale symlink at the same path so that
		// writeFile doesn't follow it. Otherwise remember the existing mode:
		// writeFile keeps it on real filesystems, so a 100644 entry over an
		// executable file must clear the bit explicitly.
		let existingMode: number | null = null;
		try {
			const st = await lstatSafe(ctx.fs, fullPath);
			if (st.isSymbolicLink) {
				await ctx.fs.rm(fullPath, { force: true });
			} else {
				existingMode = st.mode;
			}
		} catch {}
		// Smudge: with core.autocrlf=true, checkout writes CRLF line endings
		// (lfToCrlf declines for binary or already-CR content).
		const policy = await getEolPolicy(ctx);
		const content = policy.smudgeCrlf ? lfToCrlf(raw.content) : raw.content;
		await ctx.fs.writeFile(fullPath, content);
		if (ctx.fs.chmod) {
			if (entry.mode != null && isExecutableMode(entry.mode)) {
				await ctx.fs.chmod(fullPath, 0o755);
			} else if (existingMode !== null && existingMode & 0o111) {
				await ctx.fs.chmod(fullPath, 0o644);
			}
		}
	}
}

/**
 * Check out an entire tree to the working tree.
 * Writes all files from the tree, creating directories as needed.
 */
export async function checkoutTree(ctx: GitContext, treeHash: ObjectId): Promise<void> {
	const entries = await flattenTree(ctx, treeHash);

	for (const entry of entries) {
		await checkoutEntry(ctx, entry);
	}
}

// ── Staging ─────────────────────────────────────────────────────────

/**
 * Read a working tree file, write it as a blob to the object store,
 * and add it to the index. Returns the updated index and the blob hash.
 */
export async function stageFile(
	ctx: GitContext,
	index: Index,
	path: string,
): Promise<{ index: Index; hash: ObjectId }> {
	if (!ctx.workTree) {
		throw new Error("Cannot stage in a bare repository");
	}

	if (!verifyPath(path)) {
		throw new Error(`refusing to stage unsafe path '${path}'`);
	}

	const fullPath = join(ctx.workTree, path);

	if (!(await ctx.fs.exists(fullPath))) {
		throw new Error(`Path does not exist: ${path}`);
	}

	const st = await lstatSafe(ctx.fs, fullPath);

	// Symlinks: store the link target as the blob, mode 120000
	if (st.isSymbolicLink && ctx.fs.readlink) {
		const target = await ctx.fs.readlink(fullPath);
		const targetBytes = encoder.encode(target);
		const hash = await writeObject(ctx, "blob", targetBytes);
		const entry: IndexEntry = {
			path,
			mode: 0o120000,
			hash,
			stage: 0,
			stat: indexStatFromFileStat(st, targetBytes.byteLength),
		};
		return { index: addEntry(index, entry), hash };
	}

	const existing = findEntry(index, path);
	const content = await ctx.fs.readFileBuffer(fullPath);
	const blobContent = await cleanForCheckin(ctx, content, existing?.hash);
	const hash = await writeObject(ctx, "blob", blobContent);

	const entry: IndexEntry = {
		path,
		mode: worktreeMode(ctx.fs, existing, st),
		hash,
		stage: 0,
		// Index stat data describes the worktree file, not the cleaned blob.
		stat: indexStatFromFileStat(st, content.byteLength),
	};

	return { index: addEntry(index, entry), hash };
}

// ── Working tree walk ───────────────────────────────────────────────

interface WalkOptions {
	/**
	 * Skip .gitignore filtering. Use when enumerating worktree files to
	 * compare against the index/HEAD (stash, rebase, checkout safety)
	 * where tracked files matching ignore patterns must still be visible.
	 */
	skipIgnore?: boolean;
	/** Stop after finding the first file accepted by the filter. */
	stopAfterFirst?: boolean;
	/** Internal: ignore stack passed through on recursive calls. */
	_ignore?: IgnoreStack;
	/** Internal: select files to include in the result. */
	_fileFilter?: (path: string) => boolean;
}

/**
 * Recursively walk a directory in the working tree, returning file paths
 * relative to the work tree root. Skips the .git directory. By default,
 * respects .gitignore, $GIT_DIR/info/exclude, and core.excludesFile.
 * Pass `{ skipIgnore: true }` when you need to see all files regardless
 * of ignore status (e.g. comparing worktree against the index).
 */
export async function walkWorkTree(
	ctx: GitContext,
	dirPath: string,
	prefix: string,
	opts?: WalkOptions,
): Promise<string[]> {
	const skipIgnore = opts?.skipIgnore ?? false;
	const stopAfterFirst = opts?.stopAfterFirst ?? false;
	const fileFilter = opts?._fileFilter;

	let stack: IgnoreStack | null = null;
	if (!skipIgnore) {
		stack = opts?._ignore ?? (await loadBaseIgnore(ctx));
		const gitignorePath = join(dirPath, ".gitignore");
		try {
			const content = await ctx.fs.readFile(gitignorePath);
			stack = pushDirIgnore(stack, content, prefix, gitignorePath);
		} catch {
			// No .gitignore in this directory
		}
	}

	const results: string[] = [];
	const entries = await ctx.fs.readdir(dirPath);

	for (const entry of entries) {
		if (prefix === "" && entry === ".git") continue;

		const fullPath = join(dirPath, entry);
		const relativePath = prefix ? `${prefix}/${entry}` : entry;
		const st = await lstatSafe(ctx.fs, fullPath);

		if (st.isSymbolicLink) {
			// Symlinks are leaf entries — never recurse into symlinked directories
			if (stack && isIgnored(stack, relativePath, false) === "ignored") {
				continue;
			}
			if (!fileFilter || fileFilter(relativePath)) results.push(relativePath);
		} else if (st.isDirectory) {
			if (stack && isIgnored(stack, relativePath, true) === "ignored") {
				continue;
			}
			const subResults = await walkWorkTree(ctx, fullPath, relativePath, {
				skipIgnore,
				stopAfterFirst,
				_ignore: stack ?? undefined,
				_fileFilter: fileFilter,
			});
			results.push(...subResults);
		} else if (st.isFile) {
			if (stack && isIgnored(stack, relativePath, false) === "ignored") {
				continue;
			}
			if (!fileFilter || fileFilter(relativePath)) results.push(relativePath);
		}
		if (stopAfterFirst && results.length > 0) break;
	}

	return results;
}

// ── Empty directory cleanup ─────────────────────────────────────────

/**
 * Remove empty directories up to (but not including) the given stop directory.
 * Matches real git's behavior of cleaning up empty parent directories after
 * file deletions.
 */
export async function cleanEmptyDirs(
	fs: {
		exists(p: string): Promise<boolean>;
		stat(p: string): Promise<{ isDirectory: boolean }>;
		readdir(p: string): Promise<string[]>;
		rm(p: string, options?: { recursive?: boolean }): Promise<void>;
	},
	dir: string,
	stopAt: string,
): Promise<void> {
	// Don't remove the stop directory or anything above it
	if (dir === stopAt || dir === "/" || !dir.startsWith(stopAt)) {
		return;
	}
	if (!(await fs.exists(dir))) return;
	const stat = await fs.stat(dir);
	if (!stat.isDirectory) return;
	const entries = await fs.readdir(dir);
	if (entries.length === 0) {
		await fs.rm(dir, { recursive: true });
		// Recurse up
		await cleanEmptyDirs(fs, dirname(dir), stopAt);
	}
}
