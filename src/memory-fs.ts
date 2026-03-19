import type { FileStat, FileSystem } from "./fs.ts";

type Entry =
	| { type: "file"; content: Uint8Array; mode: number; mtime: Date }
	| { type: "directory"; mode: number; mtime: Date }
	| { type: "symlink"; target: string; mode: number; mtime: Date };

const DIR_MODE = 0o040755;
const FILE_MODE = 0o100644;
const SYMLINK_MODE = 0o120000;
const MAX_SYMLINK_DEPTH = 40;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function normalize(path: string): string {
	const parts: string[] = [];
	for (const seg of path.split("/")) {
		if (seg === "." || seg === "") continue;
		if (seg === "..") {
			parts.pop();
		} else {
			parts.push(seg);
		}
	}
	return "/" + parts.join("/");
}

function dirname(path: string): string {
	const i = path.lastIndexOf("/");
	return i <= 0 ? "/" : path.slice(0, i);
}

/**
 * Minimal in-memory filesystem implementing the just-git {@link FileSystem}
 * interface. Supports files, directories, and symlinks.
 *
 * ```ts
 * const fs = new MemoryFileSystem({ "/repo/README.md": "# Hello" });
 * ```
 */
export class MemoryFileSystem implements FileSystem {
	private data = new Map<string, Entry>();

	constructor(initialFiles?: Record<string, string | Uint8Array>) {
		this.data.set("/", { type: "directory", mode: DIR_MODE, mtime: new Date() });
		if (initialFiles) {
			for (const [path, content] of Object.entries(initialFiles)) {
				const norm = normalize(path);
				this.ensureParents(norm);
				this.data.set(norm, {
					type: "file",
					content: typeof content === "string" ? encoder.encode(content) : content,
					mode: FILE_MODE,
					mtime: new Date(),
				});
			}
		}
	}

	private ensureParents(path: string): void {
		const dir = dirname(path);
		if (dir === "/") return;
		if (!this.data.has(dir)) {
			this.ensureParents(dir);
			this.data.set(dir, { type: "directory", mode: DIR_MODE, mtime: new Date() });
		}
	}

	private resolve(path: string): string {
		let resolved = "";
		const seen = new Set<string>();
		for (const part of normalize(path).slice(1).split("/")) {
			resolved = `${resolved}/${part}`;
			let depth = 0;
			let entry = this.data.get(resolved);
			while (entry?.type === "symlink" && depth < MAX_SYMLINK_DEPTH) {
				if (seen.has(resolved)) {
					throw new Error(`ELOOP: too many levels of symbolic links, '${path}'`);
				}
				seen.add(resolved);
				const target = entry.target;
				resolved = target.startsWith("/")
					? normalize(target)
					: normalize(dirname(resolved) + "/" + target);
				entry = this.data.get(resolved);
				depth++;
			}
			if (depth >= MAX_SYMLINK_DEPTH) {
				throw new Error(`ELOOP: too many levels of symbolic links, '${path}'`);
			}
		}
		return resolved;
	}

	private resolveParent(path: string): string {
		const norm = normalize(path);
		if (norm === "/") return "/";
		const parts = norm.slice(1).split("/");
		if (parts.length <= 1) return norm;
		let resolved = "";
		const seen = new Set<string>();
		for (let i = 0; i < parts.length - 1; i++) {
			resolved = `${resolved}/${parts[i]}`;
			let entry = this.data.get(resolved);
			let depth = 0;
			while (entry?.type === "symlink" && depth < MAX_SYMLINK_DEPTH) {
				if (seen.has(resolved))
					throw new Error(`ELOOP: too many levels of symbolic links, '${path}'`);
				seen.add(resolved);
				const target = entry.target;
				resolved = target.startsWith("/")
					? normalize(target)
					: normalize(dirname(resolved) + "/" + target);
				entry = this.data.get(resolved);
				depth++;
			}
		}
		return `${resolved}/${parts[parts.length - 1]}`;
	}

	async readFile(path: string): Promise<string> {
		return decoder.decode(await this.readFileBuffer(path));
	}

	async readFileBuffer(path: string): Promise<Uint8Array> {
		const entry = this.data.get(this.resolve(path));
		if (!entry) throw new Error(`ENOENT: no such file or directory, open '${path}'`);
		if (entry.type !== "file")
			throw new Error(`EISDIR: illegal operation on a directory, read '${path}'`);
		return entry.content;
	}

	async writeFile(path: string, content: string | Uint8Array): Promise<void> {
		const norm = this.resolve(path);
		this.ensureParents(norm);
		this.data.set(norm, {
			type: "file",
			content: typeof content === "string" ? encoder.encode(content) : content,
			mode: FILE_MODE,
			mtime: new Date(),
		});
	}

	async exists(path: string): Promise<boolean> {
		try {
			return this.data.has(this.resolve(path));
		} catch {
			return false;
		}
	}

	async stat(path: string): Promise<FileStat> {
		const entry = this.data.get(this.resolve(path));
		if (!entry) throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
		return {
			isFile: entry.type === "file",
			isDirectory: entry.type === "directory",
			isSymbolicLink: false,
			mode: entry.mode,
			size: entry.type === "file" ? entry.content.byteLength : 0,
			mtime: entry.mtime,
		};
	}

	async lstat(path: string): Promise<FileStat> {
		const resolved = this.resolveParent(path);
		const entry = this.data.get(resolved);
		if (!entry) throw new Error(`ENOENT: no such file or directory, lstat '${path}'`);
		return {
			isFile: entry.type === "file",
			isDirectory: entry.type === "directory",
			isSymbolicLink: entry.type === "symlink",
			mode: entry.mode,
			size:
				entry.type === "file"
					? entry.content.byteLength
					: entry.type === "symlink"
						? entry.target.length
						: 0,
			mtime: entry.mtime,
		};
	}

	async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
		const norm = normalize(path);
		if (this.data.has(norm)) {
			const entry = this.data.get(norm)!;
			if (entry.type !== "directory")
				throw new Error(`EEXIST: file already exists, mkdir '${path}'`);
			if (!options?.recursive) throw new Error(`EEXIST: directory already exists, mkdir '${path}'`);
			return;
		}
		const parent = dirname(norm);
		if (parent !== "/" && !this.data.has(parent)) {
			if (options?.recursive) {
				await this.mkdir(parent, { recursive: true });
			} else {
				throw new Error(`ENOENT: no such file or directory, mkdir '${path}'`);
			}
		}
		this.data.set(norm, { type: "directory", mode: DIR_MODE, mtime: new Date() });
	}

	async readdir(path: string): Promise<string[]> {
		const norm = this.resolve(path);
		const entry = this.data.get(norm);
		if (!entry) throw new Error(`ENOENT: no such file or directory, scandir '${path}'`);
		if (entry.type !== "directory") throw new Error(`ENOTDIR: not a directory, scandir '${path}'`);
		const prefix = norm === "/" ? "/" : `${norm}/`;
		const names = new Set<string>();
		for (const p of this.data.keys()) {
			if (p !== norm && p.startsWith(prefix)) {
				const rest = p.slice(prefix.length);
				const name = rest.split("/")[0];
				if (name) names.add(name);
			}
		}
		return [...names].sort();
	}

	async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
		const norm = normalize(path);
		const entry = this.data.get(norm);
		if (!entry) {
			if (options?.force) return;
			throw new Error(`ENOENT: no such file or directory, rm '${path}'`);
		}
		if (entry.type === "directory") {
			if (!options?.recursive) {
				const children = await this.readdir(norm);
				if (children.length > 0) throw new Error(`ENOTEMPTY: directory not empty, rm '${path}'`);
			}
			const prefix = norm === "/" ? "/" : `${norm}/`;
			for (const p of [...this.data.keys()]) {
				if (p.startsWith(prefix)) this.data.delete(p);
			}
		}
		this.data.delete(norm);
	}

	async readlink(path: string): Promise<string> {
		const resolved = this.resolveParent(path);
		const entry = this.data.get(resolved);
		if (!entry) throw new Error(`ENOENT: no such file or directory, readlink '${path}'`);
		if (entry.type !== "symlink") throw new Error(`EINVAL: invalid argument, readlink '${path}'`);
		return entry.target;
	}

	async symlink(target: string, linkPath: string): Promise<void> {
		const norm = normalize(linkPath);
		if (this.data.has(norm)) throw new Error(`EEXIST: file already exists, symlink '${linkPath}'`);
		this.ensureParents(norm);
		this.data.set(norm, { type: "symlink", target, mode: SYMLINK_MODE, mtime: new Date() });
	}
}
