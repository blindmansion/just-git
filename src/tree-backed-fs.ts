/**
 * Lazy, object-store-backed filesystem with copy-on-write overlay.
 *
 * Presents a git tree as a directory structure, reading blobs on demand
 * from an ObjectStore. Writes go to an in-memory overlay and never touch
 * the underlying store.
 *
 * Designed for ephemeral worktrees in server hooks where materializing
 * the entire tree would be wasteful.
 */

import type { FileStat, FileSystem } from "./fs.ts";
import { parseTree } from "./lib/objects/tree.ts";
import type { ObjectStore, ObjectId, TreeEntry } from "./lib/types.ts";
import { FileMode as FM } from "./lib/types.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const DIR_MODE = 0o040755;
const FILE_MODE = 0o100644;
const EXEC_MODE = 0o100755;
const SYMLINK_MODE = 0o120000;

type OverlayEntry =
	| { type: "file"; content: Uint8Array; mode: number; mtime: Date }
	| { type: "directory"; mode: number; mtime: Date }
	| { type: "symlink"; target: string; mode: number; mtime: Date };

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

function treeModeToStatMode(mode: string): number {
	switch (mode) {
		case FM.EXECUTABLE:
			return EXEC_MODE;
		case FM.SYMLINK:
			return SYMLINK_MODE;
		case FM.DIRECTORY:
			return DIR_MODE;
		default:
			return FILE_MODE;
	}
}

export class TreeBackedFs implements FileSystem {
	/** Parsed tree entries keyed by normalized directory path. */
	private treeCache = new Map<string, TreeEntry[]>();
	/** In-memory overlay for writes. */
	private overlay = new Map<string, OverlayEntry>();
	/** Paths that have been explicitly removed. */
	private removals = new Set<string>();
	/** Timestamp used for all tree-backed stat results. */
	private epoch = new Date(0);

	constructor(
		private objectStore: ObjectStore,
		private rootTreeHash: ObjectId,
		/** Absolute path prefix for the worktree root (e.g. "/" or "/repo"). */
		private rootPath: string = "/",
	) {
		// Ensure root directory exists in overlay
		const normRoot = normalize(rootPath);
		this.overlay.set(normRoot, { type: "directory", mode: DIR_MODE, mtime: this.epoch });
	}

	// ── Tree resolution ──────────────────────────────────────────────

	/**
	 * Convert an absolute path to a path relative to the worktree root.
	 * Returns null if the path is outside the root.
	 */
	private toRelative(absPath: string): string | null {
		const norm = normalize(absPath);
		const root = normalize(this.rootPath);
		if (norm === root) return "";
		const prefix = root === "/" ? "/" : `${root}/`;
		if (!norm.startsWith(prefix)) return null;
		return norm.slice(prefix.length);
	}

	/**
	 * Load and cache tree entries for a directory path (relative to root).
	 * Returns null if the path doesn't exist in the tree.
	 */
	private async loadTreeDir(relDir: string): Promise<TreeEntry[] | null> {
		const cached = this.treeCache.get(relDir);
		if (cached) return cached;

		if (relDir === "") {
			// Root tree
			const raw = await this.objectStore.read(this.rootTreeHash);
			if (raw.type !== "tree") return null;
			const tree = parseTree(raw.content);
			this.treeCache.set("", tree.entries);
			return tree.entries;
		}

		// Walk path segments: "src/lib" → load root → find "src" → load subtree → find "lib"
		const segments = relDir.split("/");
		let currentEntries = await this.loadTreeDir("");
		if (!currentEntries) return null;

		let currentPath = "";
		for (const seg of segments) {
			const entry = currentEntries.find((e) => e.name === seg);
			if (!entry || entry.mode !== FM.DIRECTORY) return null;

			currentPath = currentPath ? `${currentPath}/${seg}` : seg;
			const alreadyCached = this.treeCache.get(currentPath);
			if (alreadyCached) {
				currentEntries = alreadyCached;
				continue;
			}

			const raw = await this.objectStore.read(entry.hash);
			if (raw.type !== "tree") return null;
			const tree = parseTree(raw.content);
			this.treeCache.set(currentPath, tree.entries);
			currentEntries = tree.entries;
		}

		return currentEntries;
	}

	/**
	 * Look up a single entry in the tree by its relative path.
	 * Returns the tree entry and its containing directory's entries.
	 */
	private async lookupTreeEntry(
		relPath: string,
	): Promise<{ entry: TreeEntry; dirEntries: TreeEntry[] } | null> {
		if (relPath === "") return null; // root isn't a tree entry
		const lastSlash = relPath.lastIndexOf("/");
		const dirPart = lastSlash === -1 ? "" : relPath.slice(0, lastSlash);
		const namePart = lastSlash === -1 ? relPath : relPath.slice(lastSlash + 1);

		const entries = await this.loadTreeDir(dirPart);
		if (!entries) return null;

		const entry = entries.find((e) => e.name === namePart);
		if (!entry) return null;

		return { entry, dirEntries: entries };
	}

	/**
	 * Check if a relative path points to a directory in the tree.
	 */
	private async isTreeDirectory(relPath: string): Promise<boolean> {
		if (relPath === "") return true; // root is always a directory
		const result = await this.lookupTreeEntry(relPath);
		return result?.entry.mode === FM.DIRECTORY;
	}

	// ── Overlay helpers ──────────────────────────────────────────────

	private ensureOverlayParents(normPath: string): void {
		const dir = dirname(normPath);
		if (dir === normalize(this.rootPath) || dir === "/") return;
		if (!this.overlay.has(dir)) {
			this.ensureOverlayParents(dir);
			this.overlay.set(dir, { type: "directory", mode: DIR_MODE, mtime: new Date() });
		}
	}

	// ── FileSystem implementation ────────────────────────────────────

	async readFile(path: string): Promise<string> {
		return decoder.decode(await this.readFileBuffer(path));
	}

	async readFileBuffer(path: string): Promise<Uint8Array> {
		const norm = normalize(path);

		// Check removals
		if (this.removals.has(norm)) {
			throw new Error(`ENOENT: no such file or directory, open '${path}'`);
		}

		// Check overlay
		const overlayEntry = this.overlay.get(norm);
		if (overlayEntry) {
			if (overlayEntry.type !== "file") {
				throw new Error(`EISDIR: illegal operation on a directory, read '${path}'`);
			}
			return overlayEntry.content;
		}

		// Check tree
		const rel = this.toRelative(norm);
		if (rel === null || rel === "") {
			throw new Error(`ENOENT: no such file or directory, open '${path}'`);
		}

		const result = await this.lookupTreeEntry(rel);
		if (!result) {
			throw new Error(`ENOENT: no such file or directory, open '${path}'`);
		}

		if (result.entry.mode === FM.DIRECTORY) {
			throw new Error(`EISDIR: illegal operation on a directory, read '${path}'`);
		}

		const raw = await this.objectStore.read(result.entry.hash);
		if (raw.type !== "blob") {
			throw new Error(`ENOENT: no such file or directory, open '${path}'`);
		}

		return raw.content;
	}

	async writeFile(path: string, content: string | Uint8Array): Promise<void> {
		const norm = normalize(path);
		this.removals.delete(norm);
		this.ensureOverlayParents(norm);
		this.overlay.set(norm, {
			type: "file",
			content: typeof content === "string" ? encoder.encode(content) : new Uint8Array(content),
			mode: FILE_MODE,
			mtime: new Date(),
		});
	}

	async exists(path: string): Promise<boolean> {
		const norm = normalize(path);

		if (this.removals.has(norm)) return false;
		if (this.overlay.has(norm)) return true;

		const rel = this.toRelative(norm);
		if (rel === null) return false;
		if (rel === "") return true; // root always exists

		// Check if it's a directory in the tree
		if (await this.isTreeDirectory(rel)) return true;

		// Check if it's a file/symlink in the tree
		const result = await this.lookupTreeEntry(rel);
		return result !== null;
	}

	async stat(path: string): Promise<FileStat> {
		const norm = normalize(path);

		if (this.removals.has(norm)) {
			throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
		}

		// Check overlay
		const overlayEntry = this.overlay.get(norm);
		if (overlayEntry) {
			return {
				isFile: overlayEntry.type === "file",
				isDirectory: overlayEntry.type === "directory",
				isSymbolicLink: false,
				mode: overlayEntry.mode,
				size: overlayEntry.type === "file" ? overlayEntry.content.byteLength : 0,
				mtime: overlayEntry.mtime,
			};
		}

		// Check tree
		const rel = this.toRelative(norm);
		if (rel === null) {
			throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
		}

		if (rel === "") {
			return {
				isFile: false,
				isDirectory: true,
				isSymbolicLink: false,
				mode: DIR_MODE,
				size: 0,
				mtime: this.epoch,
			};
		}

		const result = await this.lookupTreeEntry(rel);
		if (!result) {
			throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
		}

		const { entry } = result;
		const isDir = entry.mode === FM.DIRECTORY;
		const isSym = entry.mode === FM.SYMLINK;

		let size = 0;
		if (!isDir) {
			// Read blob to get size (stat needs it; the blob is likely to be
			// read soon anyway, and the object store should cache it)
			const raw = await this.objectStore.read(entry.hash);
			size = raw.content.byteLength;
		}

		return {
			isFile: !isDir && !isSym,
			isDirectory: isDir,
			isSymbolicLink: false, // stat follows symlinks
			mode: treeModeToStatMode(entry.mode),
			size,
			mtime: this.epoch,
		};
	}

	async lstat(path: string): Promise<FileStat> {
		const norm = normalize(path);

		if (this.removals.has(norm)) {
			throw new Error(`ENOENT: no such file or directory, lstat '${path}'`);
		}

		const overlayEntry = this.overlay.get(norm);
		if (overlayEntry) {
			return {
				isFile: overlayEntry.type === "file",
				isDirectory: overlayEntry.type === "directory",
				isSymbolicLink: overlayEntry.type === "symlink",
				mode: overlayEntry.mode,
				size:
					overlayEntry.type === "file"
						? overlayEntry.content.byteLength
						: overlayEntry.type === "symlink"
							? overlayEntry.target.length
							: 0,
				mtime: overlayEntry.mtime,
			};
		}

		const rel = this.toRelative(norm);
		if (rel === null) {
			throw new Error(`ENOENT: no such file or directory, lstat '${path}'`);
		}

		if (rel === "") {
			return {
				isFile: false,
				isDirectory: true,
				isSymbolicLink: false,
				mode: DIR_MODE,
				size: 0,
				mtime: this.epoch,
			};
		}

		const result = await this.lookupTreeEntry(rel);
		if (!result) {
			throw new Error(`ENOENT: no such file or directory, lstat '${path}'`);
		}

		const { entry } = result;
		const isDir = entry.mode === FM.DIRECTORY;
		const isSym = entry.mode === FM.SYMLINK;

		let size = 0;
		if (!isDir) {
			const raw = await this.objectStore.read(entry.hash);
			size = raw.content.byteLength;
		}

		return {
			isFile: !isDir && !isSym,
			isDirectory: isDir,
			isSymbolicLink: isSym,
			mode: treeModeToStatMode(entry.mode),
			size,
			mtime: this.epoch,
		};
	}

	async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
		const norm = normalize(path);
		if (this.overlay.has(norm)) {
			const entry = this.overlay.get(norm)!;
			if (entry.type !== "directory") {
				throw new Error(`EEXIST: file already exists, mkdir '${path}'`);
			}
			if (!options?.recursive) {
				throw new Error(`EEXIST: directory already exists, mkdir '${path}'`);
			}
			return;
		}

		// Check if it already exists in the tree as a directory
		const rel = this.toRelative(norm);
		if (rel !== null && !this.removals.has(norm)) {
			if (rel === "" || (await this.isTreeDirectory(rel))) {
				if (!options?.recursive) {
					throw new Error(`EEXIST: directory already exists, mkdir '${path}'`);
				}
				return;
			}
		}

		const parent = dirname(norm);
		const parentExists = this.overlay.has(parent) || (await this.exists(parent));
		if (!parentExists) {
			if (options?.recursive) {
				await this.mkdir(parent, { recursive: true });
			} else {
				throw new Error(`ENOENT: no such file or directory, mkdir '${path}'`);
			}
		}

		this.removals.delete(norm);
		this.overlay.set(norm, { type: "directory", mode: DIR_MODE, mtime: new Date() });
	}

	async readdir(path: string): Promise<string[]> {
		const norm = normalize(path);

		if (this.removals.has(norm)) {
			throw new Error(`ENOENT: no such file or directory, scandir '${path}'`);
		}

		const names = new Set<string>();

		// Collect from tree
		const rel = this.toRelative(norm);
		if (rel !== null) {
			const entries = await this.loadTreeDir(rel);
			if (entries) {
				for (const e of entries) {
					const childNorm = norm === "/" ? `/${e.name}` : `${norm}/${e.name}`;
					if (!this.removals.has(childNorm)) {
						names.add(e.name);
					}
				}
			}
		}

		// Collect from overlay
		const prefix = norm === "/" ? "/" : `${norm}/`;
		for (const p of this.overlay.keys()) {
			if (p !== norm && p.startsWith(prefix)) {
				const rest = p.slice(prefix.length);
				const name = rest.split("/")[0];
				if (name && !this.removals.has(norm === "/" ? `/${name}` : `${norm}/${name}`)) {
					names.add(name);
				}
			}
		}

		// Verify the directory itself exists
		if (names.size === 0) {
			const overlayEntry = this.overlay.get(norm);
			if (overlayEntry?.type === "directory") return [];
			if (rel !== null && (rel === "" || (await this.isTreeDirectory(rel)))) return [];
			throw new Error(`ENOENT: no such file or directory, scandir '${path}'`);
		}

		return [...names].sort();
	}

	async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
		const norm = normalize(path);
		const pathExists = await this.exists(norm);

		if (!pathExists) {
			if (options?.force) return;
			throw new Error(`ENOENT: no such file or directory, rm '${path}'`);
		}

		// Remove from overlay
		const prefix = norm === "/" ? "/" : `${norm}/`;
		if (options?.recursive) {
			for (const p of [...this.overlay.keys()]) {
				if (p.startsWith(prefix)) {
					this.overlay.delete(p);
					this.removals.add(p);
				}
			}
		}
		this.overlay.delete(norm);
		this.removals.add(norm);

		// Also mark tree children as removed if recursive
		if (options?.recursive) {
			const rel = this.toRelative(norm);
			if (rel !== null) {
				await this.markTreeChildrenRemoved(rel, norm);
			}
		}
	}

	private async markTreeChildrenRemoved(relDir: string, normDir: string): Promise<void> {
		const entries = await this.loadTreeDir(relDir);
		if (!entries) return;
		for (const e of entries) {
			const childNorm = normDir === "/" ? `/${e.name}` : `${normDir}/${e.name}`;
			this.removals.add(childNorm);
			if (e.mode === FM.DIRECTORY) {
				const childRel = relDir ? `${relDir}/${e.name}` : e.name;
				await this.markTreeChildrenRemoved(childRel, childNorm);
			}
		}
	}

	async readlink(path: string): Promise<string> {
		const norm = normalize(path);

		if (this.removals.has(norm)) {
			throw new Error(`ENOENT: no such file or directory, readlink '${path}'`);
		}

		const overlayEntry = this.overlay.get(norm);
		if (overlayEntry) {
			if (overlayEntry.type !== "symlink") {
				throw new Error(`EINVAL: invalid argument, readlink '${path}'`);
			}
			return overlayEntry.target;
		}

		const rel = this.toRelative(norm);
		if (rel === null || rel === "") {
			throw new Error(`EINVAL: invalid argument, readlink '${path}'`);
		}

		const result = await this.lookupTreeEntry(rel);
		if (!result || result.entry.mode !== FM.SYMLINK) {
			throw new Error(`EINVAL: invalid argument, readlink '${path}'`);
		}

		// Symlink target is stored as blob content
		const raw = await this.objectStore.read(result.entry.hash);
		return decoder.decode(raw.content);
	}

	async symlink(target: string, linkPath: string): Promise<void> {
		const norm = normalize(linkPath);
		if (await this.exists(norm)) {
			throw new Error(`EEXIST: file already exists, symlink '${linkPath}'`);
		}
		this.ensureOverlayParents(norm);
		this.removals.delete(norm);
		this.overlay.set(norm, {
			type: "symlink",
			target,
			mode: SYMLINK_MODE,
			mtime: new Date(),
		});
	}
}
