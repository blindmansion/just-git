import type { FileSystem } from "../fs.ts";
import type { GitExtensions } from "../git.ts";
import { isCommandError, requireGitContext } from "../lib/command-utils.ts";
import { collectAllRoots } from "../lib/gc-roots.ts";
import { findBestDeltas } from "../lib/pack/delta.ts";
import { buildPackIndexFromMeta, PackIndex } from "../lib/pack/pack-index.ts";
import { type DeltaPackInput, writePackDeltified } from "../lib/pack/packfile.ts";
import { join } from "../lib/path.ts";
import { collectEnumeration, enumerateObjectsWithContent } from "../lib/transport/object-walk.ts";
import type { GitContext, ObjectId, ObjectType } from "../lib/types.ts";
import { type Command, f } from "../parse/index.ts";

/**
 * Enumerate reachable objects that exist only as loose files (not in
 * any pack). Mirrors git's `pack-objects --all --reflog --incremental`:
 * walk from tips for reachability, skip anything already packed.
 */
async function enumerateLooseOnlyFromTips(
	gitCtx: GitContext,
	tips: ObjectId[],
): Promise<{ hash: ObjectId; type: ObjectType; content: Uint8Array }[]> {
	// Build set of already-packed hashes
	const packedHashes = new Set<string>();
	const packDir = join(gitCtx.gitDir, "objects", "pack");
	try {
		const packFiles = await gitCtx.fs.readdir(packDir);
		for (const file of packFiles) {
			if (!file.endsWith(".idx")) continue;
			const idxBuf = await gitCtx.fs.readFileBuffer(join(packDir, file));
			const idx = new PackIndex(idxBuf);
			for (const h of idx.allHashes()) packedHashes.add(h);
		}
	} catch {
		// no pack dir
	}

	if (packedHashes.size === 0) {
		return collectEnumeration(await enumerateObjectsWithContent(gitCtx, tips, []));
	}

	const all = await collectEnumeration(await enumerateObjectsWithContent(gitCtx, tips, []));
	return all.filter((obj) => !packedHashes.has(obj.hash));
}

interface RepackOptions {
	gitCtx: GitContext;
	fs: FileSystem;
	tips: ObjectId[];
	window?: number;
	depth?: number;
	cleanup?: boolean;
	/** When true, pack all objects (loose + packed). When false, only loose. */
	all?: boolean;
}

interface RepackResult {
	totalCount: number;
	deltaCount: number;
	packHash: string;
}

/**
 * Core repack logic: enumerate objects, delta-compress, write pack.
 * With `all: true`, packs all reachable objects (loose + packed).
 * Without, packs only loose objects. Returns null when nothing to pack.
 */
export async function repackFromTips(options: RepackOptions): Promise<RepackResult | null> {
	const { gitCtx, fs, tips, cleanup } = options;
	const window = options.window ?? 10;
	const depth = options.depth ?? 50;

	if (tips.length === 0) return null;

	const walkObjects = options.all
		? await collectEnumeration(await enumerateObjectsWithContent(gitCtx, tips, []))
		: await enumerateLooseOnlyFromTips(gitCtx, tips);
	if (walkObjects.length === 0) return null;

	const totalCount = walkObjects.length;

	const results = findBestDeltas(walkObjects, { window, depth });
	const deltaCount = results.filter((r) => r.delta).length;

	const packInputs: DeltaPackInput[] = results.map((r) => ({
		hash: r.hash,
		type: r.type,
		content: r.content,
		delta: r.delta,
		deltaBaseHash: r.deltaBase,
	}));

	const { data: packData, entries: packEntries } = await writePackDeltified(packInputs);
	const idxData = await buildPackIndexFromMeta(packData, packEntries);

	const checksumBytes = packData.subarray(packData.byteLength - 20);
	let packHash = "";
	for (let i = 0; i < 20; i++) {
		const b = checksumBytes[i] as number;
		packHash += (b >> 4).toString(16) + (b & 0xf).toString(16);
	}

	const packDir = join(gitCtx.gitDir, "objects", "pack");
	await fs.mkdir(packDir, { recursive: true });

	const packName = `pack-${packHash}`;
	const packPath = join(packDir, `${packName}.pack`);
	const idxPath = join(packDir, `${packName}.idx`);
	await fs.writeFile(packPath, packData);
	await fs.writeFile(idxPath, idxData);

	const packedHashes = new Set(results.map((r) => r.hash));

	// Pack files changed on disk — tell the object store to re-discover
	gitCtx.objectStore.invalidatePacks?.();

	if (cleanup) {
		const packFiles = await fs.readdir(packDir);

		// Only delete old packs that are fully covered by the new pack.
		// An old pack is "redundant" if every object in it is also in
		// the new pack. This prevents losing unreachable objects that
		// might still be needed (e.g., blobs referenced by conflict
		// stage entries created after the last repack).
		for (const file of packFiles) {
			if (!file.endsWith(".idx")) continue;
			const base = file.slice(0, -4);
			if (base === packName) continue;

			const oldIdxPath = join(packDir, `${base}.idx`);
			let redundant = true;
			try {
				const idxBuf = await fs.readFileBuffer(oldIdxPath);
				const oldIdx = new PackIndex(idxBuf);
				for (const h of oldIdx.allHashes()) {
					if (!packedHashes.has(h)) {
						redundant = false;
						break;
					}
				}
			} catch {
				redundant = false;
			}

			if (redundant) {
				try {
					await fs.rm(join(packDir, `${base}.pack`));
				} catch {}
				try {
					await fs.rm(oldIdxPath);
				} catch {}
			}
		}

		// Delete loose objects that are in the new pack
		const objectsDir = join(gitCtx.gitDir, "objects");
		let entries: string[];
		try {
			entries = await fs.readdir(objectsDir);
		} catch {
			entries = [];
		}

		for (const dir of entries) {
			if (dir === "pack" || dir === "info" || dir.length !== 2) continue;
			const dirPath = join(objectsDir, dir);
			let files: string[];
			try {
				files = await fs.readdir(dirPath);
			} catch {
				continue;
			}

			for (const file of files) {
				const hash = `${dir}${file}`;
				if (packedHashes.has(hash)) {
					await fs.rm(join(dirPath, file));
				}
			}

			try {
				const remaining = await fs.readdir(dirPath);
				if (remaining.length === 0) {
					await fs.rm(dirPath, { recursive: true });
				}
			} catch {
				// ignore
			}
		}
	}

	return { totalCount, deltaCount, packHash };
}

export function formatRepackStderr(
	totalCount: number,
	deltaCount: number,
	includeCounting = false,
): string {
	const compressedCount = totalCount - deltaCount;
	const lines = [`Enumerating objects: ${totalCount}, done.`];
	if (includeCounting) {
		lines.push(`Counting objects: 100% (${totalCount}/${totalCount}), done.`);
	}
	lines.push(
		"Delta compression using 1 thread.",
		`Compressing objects: 100% (${compressedCount}/${totalCount}), done.`,
		`Writing objects: 100% (${totalCount}/${totalCount}), done.`,
		`Total ${totalCount} (delta ${deltaCount}), reused 0 (delta 0), pack-reused 0`,
	);
	return lines.join("\n");
}

export function registerRepackCommand(parent: Command, ext?: GitExtensions) {
	parent.command("repack", {
		description: "Pack unpacked objects in a repository",
		options: {
			all: f().alias("a").describe("Pack all objects, including already-packed"),
			delete: f().alias("d").describe("After packing, remove redundant packs and loose objects"),
		},
		handler: async (args, ctx) => {
			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;
			const gitCtx = gitCtxOrError;

			const tips = await collectAllRoots(gitCtx);

			const result = await repackFromTips({
				gitCtx,
				fs: ctx.fs,
				tips,
				cleanup: args.delete as boolean | undefined,
				all: args.all as boolean | undefined,
			});

			if (!result) {
				return {
					stdout: "Nothing new to pack.\n",
					stderr: "",
					exitCode: 0,
				};
			}

			const stderr = formatRepackStderr(result.totalCount, result.deltaCount);
			return { stdout: "", stderr: `${stderr}\n`, exitCode: 0 };
		},
	});
}
