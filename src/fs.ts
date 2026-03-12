export interface FileStat {
	isFile: boolean;
	isDirectory: boolean;
	isSymbolicLink: boolean;
	mode: number;
	size: number;
	mtime: Date;
}

export interface FileSystem {
	readFile(path: string): Promise<string>;
	readFileBuffer(path: string): Promise<Uint8Array>;
	writeFile(path: string, content: string | Uint8Array): Promise<void>;
	exists(path: string): Promise<boolean>;
	stat(path: string): Promise<FileStat>;
	mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
	readdir(path: string): Promise<string[]>;
	rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
	/** Stat without following symlinks. Falls back to stat() semantics when not implemented. */
	lstat?(path: string): Promise<FileStat>;
	/** Read the target of a symbolic link. */
	readlink?(path: string): Promise<string>;
	/** Create a symbolic link pointing to target at the given path. */
	symlink?(target: string, path: string): Promise<void>;
}
