import type { DurableFileSystem } from "../fs/index.ts";
import { removeFileDurable, replaceFileDurable, withFileLock } from "../fs/durable-io.ts";
import {
	listLoosePseudoRefs,
	parseLooseRef,
	readPackedRefs,
	refPath,
	removePackedRef,
	serializeLooseRef,
	walkLooseRefs,
} from "../lib/file-ref-database.ts";
import { join } from "../lib/path.ts";
import type { Ref } from "../lib/types.ts";
import type { MaybeAsync, RawRefEntry, RefOps } from "./repo-store.ts";

export const REF_LOCK = ".just-git-ref.lock";

/**
 * Native-layout ref persistence for one bare repository.
 *
 * Object persistence is composed alongside this class by createFsRepoStorage
 * in Phase 3.4.
 */
export class FsRefStorage {
	private lockPath: string;

	constructor(
		private fs: DurableFileSystem,
		private repoDir: string,
	) {
		this.lockPath = join(repoDir, REF_LOCK);
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
		refPath(this.repoDir, name);
		await this.withRefLock(() => this.putRefUnlocked(name, ref));
	}

	async removeRef(name: string): Promise<void> {
		refPath(this.repoDir, name);
		await this.withRefLock(() => this.removeRefUnlocked(name));
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

	async atomicRefUpdate<T>(fn: (ops: RefOps) => MaybeAsync<T>): Promise<T> {
		return this.withRefLock(async () => {
			const overlay = new Map<string, Ref | null>();
			let mutatedName: string | undefined;

			const stage = (name: string, ref: Ref | null) => {
				refPath(this.repoDir, name);
				if (mutatedName !== undefined && mutatedName !== name) {
					throw new Error("filesystem ref transactions may mutate only one distinct ref");
				}
				mutatedName = name;
				overlay.set(name, ref === null ? null : cloneRef(ref));
			};

			const result = await fn({
				getRef: async (name) => {
					refPath(this.repoDir, name);
					return overlay.has(name) ? (overlay.get(name) ?? null) : this.getRef(name);
				},
				putRef: (name, ref) => stage(name, ref),
				removeRef: (name) => stage(name, null),
			});

			if (mutatedName !== undefined) {
				const ref = overlay.get(mutatedName) ?? null;
				if (ref === null) {
					await this.removeRefUnlocked(mutatedName);
				} else {
					await this.putRefUnlocked(mutatedName, ref);
				}
			}
			return result;
		});
	}

	private async withRefLock<T>(fn: () => Promise<T>): Promise<T> {
		try {
			return await withFileLock(this.fs, this.lockPath, fn);
		} catch (error) {
			if (isAlreadyExistsError(error)) {
				throw new Error(
					`EEXIST: filesystem repository ref lock is already present at ${JSON.stringify(this.lockPath)}; explicit stale-lock recovery is required`,
				);
			}
			throw error;
		}
	}

	private async putRefUnlocked(name: string, ref: Ref): Promise<void> {
		await replaceFileDurable(this.fs, refPath(this.repoDir, name), serializeLooseRef(ref));
	}

	private async removeRefUnlocked(name: string): Promise<void> {
		// Remove the hidden packed copy first. While a loose copy exists it
		// remains authoritative, so removing it last is the visibility point.
		await removePackedRef(this.fs, this.repoDir, name);
		await removeFileDurable(this.fs, refPath(this.repoDir, name));
	}
}

function validateRefPrefix(repoDir: string, prefix?: string): void {
	if (prefix === undefined || prefix === "") return;
	refPath(repoDir, prefix.endsWith("/") ? prefix.slice(0, -1) : prefix);
}

function cloneRef(ref: Ref): Ref {
	return ref.type === "direct"
		? { type: "direct", hash: ref.hash }
		: { type: "symbolic", target: ref.target };
}

function isSafeStoredName(repoDir: string, name: string): boolean {
	try {
		refPath(repoDir, name);
		return true;
	} catch {
		return false;
	}
}

function isAlreadyExistsError(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	if ("code" in error && (error as { code?: unknown }).code === "EEXIST") return true;
	return "message" in error && /^EEXIST\b/.test(String((error as { message?: unknown }).message));
}
