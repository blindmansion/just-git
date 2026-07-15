import type { FileSystem } from "../../fs/index.ts";
import { removeFile, replaceFile } from "../../fs/durable-io.ts";
import { join } from "../path.ts";
import { isPerWorktreeRef } from "./classify.ts";
import {
	type DirectRef,
	normalizeRef,
	type ObjectId,
	type Ref,
	type RefEntry,
	type RefStore,
	type SymbolicRef,
} from "../types.ts";

const SYMBOLIC_PREFIX = "ref: ";

/** Max symbolic-ref hops before we declare a loop. Shared with the resolution core. */
export const MAX_SYMREF_DEPTH = 10;

/**
 * Default filesystem-backed ref storage. Reads/writes loose ref files
 * under `.git/`, with `packed-refs` as fallback for reads and listings.
 */
export class FileSystemRefStore implements RefStore {
	private casLocks = new Map<string, Promise<boolean>>();
	private commonDir: string;

	constructor(
		private fs: FileSystem,
		private gitDir: string,
		commonDir?: string,
	) {
		this.commonDir = commonDir ?? gitDir;
	}

	/** The directory a ref lives in: private gitDir or shared commonDir. */
	private dirFor(name: string): string {
		return isPerWorktreeRef(name) ? this.gitDir : this.commonDir;
	}

	async readRef(name: string): Promise<Ref | null> {
		const path = join(this.dirFor(name), name);
		if (await this.fs.exists(path)) {
			const raw = (await this.fs.readFile(path)).trim();
			if (raw.startsWith(SYMBOLIC_PREFIX)) {
				return {
					type: "symbolic",
					target: raw.slice(SYMBOLIC_PREFIX.length),
				} satisfies SymbolicRef;
			}
			return { type: "direct", hash: raw } satisfies DirectRef;
		}

		// Per-worktree refs are loose-only; they are never packed.
		if (isPerWorktreeRef(name)) return null;

		const packed = await this.readPackedRefs();
		const hash = packed.get(name);
		if (hash) return { type: "direct", hash } satisfies DirectRef;

		return null;
	}

	async writeRef(name: string, refOrHash: Ref | string): Promise<void> {
		const ref = normalizeRef(refOrHash);
		const path = join(this.dirFor(name), name);
		if (ref.type === "symbolic") {
			await replaceFile(this.fs, path, `${SYMBOLIC_PREFIX}${ref.target}\n`);
		} else {
			await replaceFile(this.fs, path, `${ref.hash}\n`);
		}
	}

	async deleteRef(name: string): Promise<void> {
		const path = join(this.dirFor(name), name);
		await removeFile(this.fs, path);
		await this.removePackedRef(name);
	}

	async listRefs(prefix: string = "refs"): Promise<RefEntry[]> {
		const results: RefEntry[] = [];
		const seen = new Set<string>();

		const walkDir = async (base: string) => {
			const dir = join(base, prefix);
			if (!(await this.fs.exists(dir))) return;
			const found: RefEntry[] = [];
			await this.walkRefs(dir, prefix, found);
			for (const ref of found) {
				// A ref counts only from the directory it routes to, so a linked
				// worktree never lists the main worktree's per-worktree refs (and
				// vice versa) even though both walk the common dir.
				if (this.dirFor(ref.name) !== base) continue;
				if (seen.has(ref.name)) continue;
				seen.add(ref.name);
				results.push(ref);
			}
		};

		// Shared refs come from the common dir; the per-worktree namespaces add
		// from the private dir. They only differ inside a linked worktree.
		await walkDir(this.commonDir);
		if (this.gitDir !== this.commonDir) {
			await walkDir(this.gitDir);
		}

		// packed-refs lives in the common dir and holds only shared refs. Skip
		// any per-worktree name so the listing matches readRef, which never
		// resolves a per-worktree ref from packed-refs.
		const packed = await this.readPackedRefs();
		if (packed.size > 0) {
			const prefixSlash = `${prefix}/`;
			for (const [name, hash] of packed) {
				if (isPerWorktreeRef(name)) continue;
				if (name.startsWith(prefixSlash) && !seen.has(name)) {
					seen.add(name);
					results.push({ name, hash });
				}
			}
		}

		return results.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	}

	async compareAndSwapRef(
		name: string,
		expectedOldHash: string | null,
		newRef: Ref | null,
	): Promise<boolean> {
		const prev = this.casLocks.get(name) ?? Promise.resolve(false);
		const result = prev.then(
			() => this.compareAndSwapUnsafe(name, expectedOldHash, newRef),
			() => this.compareAndSwapUnsafe(name, expectedOldHash, newRef),
		);
		this.casLocks.set(name, result);
		try {
			return await result;
		} finally {
			if (this.casLocks.get(name) === result) {
				this.casLocks.delete(name);
			}
		}
	}

	private async compareAndSwapUnsafe(
		name: string,
		expectedOldHash: string | null,
		newRef: Ref | null,
	): Promise<boolean> {
		const currentHash = await this.resolveRefInternal(name);

		if (expectedOldHash === null) {
			const current = await this.readRef(name);
			if (current !== null) return false;
		} else {
			if (currentHash !== expectedOldHash) return false;
		}

		if (newRef === null) {
			await this.deleteRef(name);
		} else {
			await this.writeRef(name, newRef);
		}
		return true;
	}

	private async resolveRefInternal(name: string): Promise<ObjectId | null> {
		let current = name;
		for (let depth = 0; depth < MAX_SYMREF_DEPTH; depth++) {
			const ref = await this.readRef(current);
			if (!ref) return null;
			if (ref.type === "direct") return ref.hash;
			current = ref.target;
		}
		throw new Error(`Symbolic ref loop detected resolving "${name}"`);
	}

	private async readPackedRefs(): Promise<Map<string, ObjectId>> {
		const path = join(this.commonDir, "packed-refs");
		if (!(await this.fs.exists(path))) return new Map();

		const content = await this.fs.readFile(path);
		const refs = new Map<string, ObjectId>();

		for (const line of content.split("\n")) {
			if (!line || line.startsWith("#") || line.startsWith("^")) continue;
			const spaceIdx = line.indexOf(" ");
			if (spaceIdx === -1) continue;
			const hash = line.slice(0, spaceIdx);
			const name = line.slice(spaceIdx + 1).trim();
			if (hash.length === 40 && name) {
				refs.set(name, hash);
			}
		}

		return refs;
	}

	private async removePackedRef(name: string): Promise<void> {
		const packedPath = join(this.commonDir, "packed-refs");
		if (!(await this.fs.exists(packedPath))) return;

		const content = await this.fs.readFile(packedPath);
		const lines = content.split("\n");
		const filtered: string[] = [];
		let skipPeeled = false;

		for (const line of lines) {
			if (skipPeeled && line.startsWith("^")) {
				skipPeeled = false;
				continue;
			}
			skipPeeled = false;

			if (!line || line.startsWith("#")) {
				filtered.push(line);
				continue;
			}

			const spaceIdx = line.indexOf(" ");
			if (spaceIdx !== -1) {
				const refName = line.slice(spaceIdx + 1).trim();
				if (refName === name) {
					skipPeeled = true;
					continue;
				}
			}
			filtered.push(line);
		}

		const hasRefs = filtered.some((l) => l && !l.startsWith("#") && !l.startsWith("^"));
		if (!hasRefs) {
			await removeFile(this.fs, packedPath);
		} else {
			await replaceFile(this.fs, packedPath, filtered.join("\n"));
		}
	}

	private async walkRefs(dirPath: string, prefix: string, results: RefEntry[]): Promise<void> {
		const entries = await this.fs.readdir(dirPath);

		for (const entry of entries) {
			const fullPath = join(dirPath, entry);
			const refName = `${prefix}/${entry}`;
			const stat = await this.fs.stat(fullPath);

			if (stat.isDirectory) {
				await this.walkRefs(fullPath, refName, results);
			} else if (stat.isFile) {
				const hash = await this.resolveRefInternal(refName);
				if (hash) {
					results.push({ name: refName, hash });
				}
			}
		}
	}
}
