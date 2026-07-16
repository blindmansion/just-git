import type { DurableFileSystem } from "../fs/index.ts";
import {
	listLoosePseudoRefs,
	parseLooseRef,
	readPackedRefs,
	refPath,
	walkLooseRefs,
} from "../lib/file-ref-database.ts";
import { join } from "../lib/path.ts";
import { createNativeRefMutation, type NativeRefMutation } from "../lib/refs/native-mutation.ts";
import type { Ref } from "../lib/types.ts";
import type { RawRefEntry } from "./repo-store.ts";

/**
 * Native-layout ref persistence for one bare repository.
 *
 * Object persistence is composed alongside this class by createFsRepoStorage
 * in Phase 3.4.
 */
export class FsRefStorage {
	private mutation: NativeRefMutation;

	constructor(
		private fs: DurableFileSystem,
		private repoDir: string,
	) {
		this.mutation = createNativeRefMutation(fs, {
			gitDir: repoDir,
			commonDir: repoDir,
		});
	}

	async getRef(name: string): Promise<Ref | null> {
		const path = refPath(this.repoDir, name);
		if (await this.fs.exists(path)) {
			return parseLooseRef(await this.fs.readFile(path));
		}
		const hash = (await readPackedRefs(this.fs, this.repoDir)).get(name);
		return hash ? { type: "direct", hash } : null;
	}

	async putRef(name: string, ref: Ref): Promise<void> {
		await this.mutation.putRef(name, ref);
	}

	async removeRef(name: string): Promise<void> {
		await this.mutation.removeRef(name);
	}

	async listRefs(prefix?: string): Promise<RawRefEntry[]> {
		validateRefPrefix(this.repoDir, prefix);

		const byName = new Map<string, Ref>();
		for (const [name, hash] of await readPackedRefs(this.fs, this.repoDir)) {
			if (name.startsWith("refs/") && isSafeStoredName(this.repoDir, name)) {
				byName.set(name, { type: "direct", hash });
			}
		}
		if (await this.fs.exists(join(this.repoDir, "refs"))) {
			for (const entry of await walkLooseRefs(this.fs, this.repoDir, "refs")) {
				byName.set(entry.name, entry.ref);
			}
		}
		for (const entry of await listLoosePseudoRefs(this.fs, this.repoDir)) {
			byName.set(entry.name, entry.ref);
		}

		const entries: RawRefEntry[] = [];
		for (const [name, ref] of byName) {
			if (prefix === undefined || name.startsWith(prefix)) entries.push({ name, ref });
		}
		return entries.sort((a, b) => a.name.localeCompare(b.name));
	}

	compareAndSwapRef(name: string, expectedOld: Ref | null, newRef: Ref | null): Promise<boolean> {
		return this.mutation.compareAndSwapRef(name, expectedOld, newRef);
	}
}

function validateRefPrefix(repoDir: string, prefix?: string): void {
	if (prefix === undefined || prefix === "") return;
	refPath(repoDir, prefix.endsWith("/") ? prefix.slice(0, -1) : prefix);
}

function isSafeStoredName(repoDir: string, name: string): boolean {
	try {
		refPath(repoDir, name);
		return true;
	} catch {
		return false;
	}
}
