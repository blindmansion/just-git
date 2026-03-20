/** File/directory metadata returned by {@link FileSystem.stat} and {@link FileSystem.lstat}. */
export interface FileStat {
	/** True if the path points to a regular file. */
	isFile: boolean;
	/** True if the path points to a directory. */
	isDirectory: boolean;
	/** True if the path is a symbolic link (only meaningful from {@link FileSystem.lstat}). */
	isSymbolicLink: boolean;
	/** Unix file mode (e.g. `0o100644` for a regular file, `0o040755` for a directory). */
	mode: number;
	/** File size in bytes (0 for directories). */
	size: number;
	/** Last modification time. */
	mtime: Date;
}

/**
 * Filesystem interface required by just-git.
 *
 * Implement this to run git operations against any storage backend —
 * in-memory, real disk, IndexedDB, remote, etc. All paths are absolute
 * POSIX-style strings (e.g. `"/repo/src/index.ts"`).
 *
 * The three optional symlink methods (`lstat`, `readlink`, `symlink`) enable
 * symlink support. When omitted, symlinks degrade to plain files containing
 * the target path as content (`core.symlinks=false` behavior).
 *
 * See {@link MemoryFileSystem} for a ready-made in-memory implementation.
 */
export interface FileSystem {
	/**
	 * Read a file's contents as a UTF-8 string.
	 * @throws Error if the path doesn't exist or is a directory.
	 */
	readFile(path: string): Promise<string>;
	/**
	 * Read a file's contents as raw bytes.
	 * @throws Error if the path doesn't exist or is a directory.
	 */
	readFileBuffer(path: string): Promise<Uint8Array>;
	/**
	 * Write content to a file, creating it if it doesn't exist and
	 * overwriting if it does. Parent directories must already exist.
	 */
	writeFile(path: string, content: string | Uint8Array): Promise<void>;
	/** Check whether a path exists (file, directory, or symlink). */
	exists(path: string): Promise<boolean>;
	/**
	 * Get file/directory metadata, following symlinks.
	 * @throws Error if the path doesn't exist.
	 */
	stat(path: string): Promise<FileStat>;
	/**
	 * Create a directory.
	 * @throws Error if the parent doesn't exist (unless `recursive: true`) or the path already exists as a file.
	 */
	mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
	/**
	 * List the names of entries in a directory (not full paths).
	 * @throws Error if the path doesn't exist or is not a directory.
	 */
	readdir(path: string): Promise<string[]>;
	/**
	 * Remove a file or directory.
	 * @throws Error if the path doesn't exist (unless `force: true`) or is a non-empty directory (unless `recursive: true`).
	 */
	rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
	/**
	 * Get file/directory metadata without following symlinks.
	 * Falls back to {@link stat} semantics when not implemented.
	 * @throws Error if the path doesn't exist.
	 */
	lstat?(path: string): Promise<FileStat>;
	/**
	 * Read the target path of a symbolic link.
	 * @throws Error if the path doesn't exist or is not a symlink.
	 */
	readlink?(path: string): Promise<string>;
	/**
	 * Create a symbolic link at `path` pointing to `target`.
	 * @param target - The path the symlink should point to.
	 * @param path - Where to create the symlink.
	 * @throws Error if `path` already exists.
	 */
	symlink?(target: string, path: string): Promise<void>;
}
