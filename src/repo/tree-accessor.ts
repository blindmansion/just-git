import { flattenTree } from "../lib/tree-ops.ts";
import type { FileSystem } from "../fs.ts";
import type { GitRepo } from "../lib/types.ts";
import { TreeBackedFs } from "../tree-backed-fs.ts";
import { materializeEntries, type MaterializeTarget } from "./materialize.ts";

/**
 * Lazy accessor for the worktree contents at a specific tree.
 *
 * Provides progressively richer access to files without requiring
 * upfront materialization:
 *
 * - {@link readFile} / {@link readFileBytes} — read a single file (O(tree depth), no flatten)
 * - {@link files} — list all tracked file paths (walks tree objects, no blob reads)
 * - {@link fs} — get a full {@link FileSystem} view (lazy reads, in-memory writes)
 * - {@link materialize} — write all tracked files onto a target filesystem
 */
export interface TreeAccessor {
	/** The underlying git tree object hash. */
	readonly treeHash: string;
	/** Read a file's text content. Returns `null` if the file doesn't exist. */
	readFile(path: string): Promise<string | null>;
	/** Read a file's raw bytes. Returns `null` if the file doesn't exist. */
	readFileBytes(path: string): Promise<Uint8Array | null>;
	/** List all tracked file paths (no blob content is read). */
	files(): Promise<string[]>;
	/**
	 * Get a full `FileSystem` backed by this tree.
	 *
	 * Files are read lazily from the object store on demand.
	 * Writes go to an in-memory overlay and never touch the repo.
	 * Created once on first call, then cached for the lifetime of this accessor.
	 */
	fs(root?: string): FileSystem;
	/**
	 * Write all tracked files onto a filesystem.
	 *
	 * @param target — target filesystem (only needs `mkdir`, `writeFile`,
	 *   and optionally `symlink`)
	 * @param targetDir — root directory on the target fs (default `"/"`)
	 * @returns the number of files written
	 */
	materialize(target: MaterializeTarget, targetDir?: string): Promise<number>;
}

/**
 * Create a lazy {@link TreeAccessor} for a git tree hash.
 *
 * Single-file reads use O(tree depth) traversal via {@link TreeBackedFs}.
 * Full-tree operations (`files`, `materialize`) flatten on demand.
 */
export function createTreeAccessor(repo: GitRepo, treeHash: string): TreeAccessor {
	let fsCache: FileSystem | null = null;
	let fsCacheRoot: string | undefined;

	function getFs(root = "/"): TreeBackedFs {
		if (fsCache && fsCacheRoot === root) return fsCache as TreeBackedFs;
		fsCache = new TreeBackedFs(repo.objectStore, treeHash, root);
		fsCacheRoot = root;
		return fsCache as TreeBackedFs;
	}

	return {
		treeHash,
		async readFile(path: string): Promise<string | null> {
			const treeFs = getFs();
			const fullPath = path.startsWith("/") ? path : "/" + path;
			if (!(await treeFs.exists(fullPath))) return null;
			return treeFs.readFile(fullPath);
		},
		async readFileBytes(path: string): Promise<Uint8Array | null> {
			const treeFs = getFs();
			const fullPath = path.startsWith("/") ? path : "/" + path;
			if (!(await treeFs.exists(fullPath))) return null;
			return treeFs.readFileBuffer(fullPath);
		},
		async files(): Promise<string[]> {
			const entries = await flattenTree(repo, treeHash);
			return entries.map((e) => e.path);
		},
		fs(root = "/"): FileSystem {
			return getFs(root);
		},
		async materialize(target: MaterializeTarget, targetDir = "/"): Promise<number> {
			const entries = await flattenTree(repo, treeHash);
			return materializeEntries(repo, entries, target, targetDir);
		},
	};
}
