import type { DurableFileSystem, FileStat } from "./index.ts";

interface NodeFileHandle {
	sync(): Promise<void>;
	close(): Promise<void>;
}

interface NodeStats {
	isFile(): boolean;
	isDirectory(): boolean;
	isSymbolicLink(): boolean;
	mode: number;
	size: number;
	mtime: Date;
}

/**
 * The subset of `node:fs/promises` used by
 * {@link durableFileSystemFromNodeFs}.
 *
 * This structural type keeps just-git's public declarations usable without
 * requiring Node types in browser-only projects.
 */
export interface NodeFsPromises {
	readFile(path: string): Promise<Uint8Array>;
	readFile(path: string, options: { encoding: "utf8" }): Promise<string>;
	writeFile(path: string, content: string | Uint8Array): Promise<void>;
	access(path: string): Promise<void>;
	stat(path: string): Promise<NodeStats>;
	lstat(path: string): Promise<NodeStats>;
	mkdir(path: string, options?: { recursive?: boolean }): Promise<unknown>;
	readdir(path: string): Promise<string[]>;
	rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
	open(path: string, flags: string): Promise<NodeFileHandle>;
	rename(src: string, dest: string): Promise<void>;
	link(existingPath: string, newPath: string): Promise<void>;
	readlink(path: string): Promise<string>;
	symlink(target: string, path: string): Promise<void>;
	chmod(path: string, mode: number): Promise<void>;
}

/**
 * Adapt a `node:fs/promises`-compatible implementation to just-git's durable
 * filesystem contract.
 *
 * Paths are passed through unchanged. Callers should therefore use absolute
 * host paths, matching the absolute-path contract of {@link DurableFileSystem}.
 */
export function durableFileSystemFromNodeFs(nodeFs: NodeFsPromises): DurableFileSystem {
	const toStat = (stat: NodeStats): FileStat => ({
		isFile: stat.isFile(),
		isDirectory: stat.isDirectory(),
		isSymbolicLink: stat.isSymbolicLink(),
		mode: stat.mode,
		size: stat.size,
		mtime: stat.mtime,
	});

	const rename = async (src: string, dest: string): Promise<void> => {
		await nodeFs.rename(src, dest);
	};

	return {
		async readFile(path) {
			return nodeFs.readFile(path, { encoding: "utf8" });
		},
		async readFileBuffer(path) {
			return nodeFs.readFile(path);
		},
		async writeFile(path, content) {
			await nodeFs.writeFile(path, content);
		},
		async exists(path) {
			try {
				await nodeFs.access(path);
				return true;
			} catch (error) {
				if (isMissingPathError(error)) return false;
				throw error;
			}
		},
		async stat(path) {
			return toStat(await nodeFs.stat(path));
		},
		async mkdir(path, options) {
			await nodeFs.mkdir(path, options);
		},
		async readdir(path) {
			return nodeFs.readdir(path);
		},
		async rm(path, options) {
			await nodeFs.rm(path, options);
		},
		async lstat(path) {
			return toStat(await nodeFs.lstat(path));
		},
		async readlink(path) {
			return nodeFs.readlink(path);
		},
		async symlink(target, path) {
			await nodeFs.symlink(target, path);
		},
		mv: rename,
		async chmod(path, mode) {
			await nodeFs.chmod(path, mode);
		},
		async fsync(path) {
			const handle = await nodeFs.open(path, "r");
			try {
				await handle.sync();
			} finally {
				await handle.close();
			}
		},
		rename,
		async link(existingPath, newPath) {
			await nodeFs.link(existingPath, newPath);
		},
	};
}

function isMissingPathError(error: unknown): boolean {
	if (typeof error !== "object" || error === null || !("code" in error)) return false;
	const code = (error as { code?: unknown }).code;
	return code === "ENOENT" || code === "ENOTDIR";
}
