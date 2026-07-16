import { isDurable, type FileSystem } from "../../fs/index.ts";
import { removeFile, replaceFile } from "../../fs/durable-io.ts";
import {
	parseLooseRef,
	readPackedRefs,
	refPath,
	removePackedRef,
	serializeLooseRef,
	walkLooseRefs,
} from "../file-ref-database.ts";
import { isPerWorktreeRef } from "./classify.ts";
import { rawRefsEqual } from "./equality.ts";
import {
	createNativeRefMutation,
	type NativeRefMutation,
} from "./native-mutation.ts";
import {
	type DirectRef,
	normalizeRef,
	type ObjectId,
	type Ref,
	type RefEntry,
	type RefStore,
} from "../types.ts";

/** Max symbolic-ref hops before we declare a loop. Shared with the resolution core. */
export const MAX_SYMREF_DEPTH = 10;

/**
 * Default filesystem-backed ref storage. Reads/writes loose ref files
 * under `.git/`, with `packed-refs` as fallback for reads and listings.
 */
export class FileSystemRefStore implements RefStore {
	private casLocks = new Map<string, Promise<boolean>>();
	private commonDir: string;
	private nativeMutation: NativeRefMutation | null;

	constructor(
		private fs: FileSystem,
		private gitDir: string,
		commonDir?: string,
	) {
		this.commonDir = commonDir ?? gitDir;
		this.nativeMutation = isDurable(fs)
			? createNativeRefMutation(fs, { gitDir, commonDir: this.commonDir })
			: null;
	}

	/** The directory a ref lives in: private gitDir or shared commonDir. */
	private dirFor(name: string): string {
		return isPerWorktreeRef(name) ? this.gitDir : this.commonDir;
	}

	async readRef(name: string): Promise<Ref | null> {
		const path = refPath(this.dirFor(name), name);
		if (await this.fs.exists(path)) {
			return parseLooseRef(await this.fs.readFile(path));
		}

		// Per-worktree refs are loose-only; they are never packed.
		if (isPerWorktreeRef(name)) return null;

		const packed = await readPackedRefs(this.fs, this.commonDir);
		const hash = packed.get(name);
		if (hash) return { type: "direct", hash } satisfies DirectRef;

		return null;
	}

	async writeRef(name: string, refOrHash: Ref | string): Promise<void> {
		const ref = normalizeRef(refOrHash);
		if (this.nativeMutation) {
			await this.nativeMutation.putRef(name, ref);
			return;
		}
		const path = refPath(this.dirFor(name), name);
		await replaceFile(this.fs, path, serializeLooseRef(ref));
	}

	async deleteRef(name: string): Promise<void> {
		if (this.nativeMutation) {
			await this.nativeMutation.removeRef(name);
			return;
		}
		const path = refPath(this.dirFor(name), name);
		await removeFile(this.fs, path);
		await removePackedRef(this.fs, this.commonDir, name);
	}

	async listRefs(prefix: string = "refs"): Promise<RefEntry[]> {
		const results: RefEntry[] = [];
		const seen = new Set<string>();

		const walkDir = async (base: string) => {
			const found = await walkLooseRefs(this.fs, base, prefix);
			for (const raw of found) {
				// A ref counts only from the directory it routes to, so a linked
				// worktree never lists the main worktree's per-worktree refs (and
				// vice versa) even though both walk the common dir.
				if (this.dirFor(raw.name) !== base) continue;
				if (seen.has(raw.name)) continue;
				const hash = await this.resolveRefInternal(raw.name);
				if (!hash) continue;
				seen.add(raw.name);
				results.push({ name: raw.name, hash });
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
		const packed = await readPackedRefs(this.fs, this.commonDir);
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
		expectedOld: Ref | null,
		newRef: Ref | null,
	): Promise<boolean> {
		if (this.nativeMutation) {
			return this.nativeMutation.compareAndSwapRef(name, expectedOld, newRef);
		}

		const prev = this.casLocks.get(name) ?? Promise.resolve(false);
		const result = prev.then(
			() => this.compareAndSwapNonDurable(name, expectedOld, newRef),
			() => this.compareAndSwapNonDurable(name, expectedOld, newRef),
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

	private async compareAndSwapNonDurable(
		name: string,
		expectedOld: Ref | null,
		newRef: Ref | null,
	): Promise<boolean> {
		const current = await this.readRef(name);
		if (!rawRefsEqual(current, expectedOld)) return false;

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
}
