/**
 * GitRepo-shaped shell for the pure tree patch planners.
 *
 * Both the public repo `applyPatch` API and `am`'s fake-ancestor three-way
 * reconstruction use this mechanism. Keeping it below `repo/` lets command and
 * repo orchestration share tree application without depending on each other.
 */
import { defaultStat } from "../index.ts";
import { readBlobBytes, writeObject } from "../object-db.ts";
import { buildTreeFromIndex, type FlatTreeEntry, flattenTreeToMap } from "../tree-ops.ts";
import type { GitRepo, IndexEntry } from "../types.ts";
import type { WhitespaceAction } from "./apply.ts";
import type { ParsedPatch } from "./parse-patch.ts";
import {
	type BlobEffect,
	type FileReject,
	planBinaryApply,
	planTextApply,
	type PreparedApply,
} from "./tree-apply.ts";

const decoder = new TextDecoder();

export interface ApplyPatchesToTreeOptions {
	reverse: boolean;
	whitespace: WhitespaceAction;
}

export type ApplyPatchesToTreeResult =
	| { status: "applied"; treeHash: string }
	| { status: "rejected"; rejects: FileReject[] };

/** Result mode for a patch: explicit new/old mode, else the source tree mode. */
function resolveTreeMode(patch: ParsedPatch, entryMode: string | undefined): number {
	if (patch.newMode) return patch.newMode;
	if (patch.oldMode) return patch.oldMode;
	if (entryMode) return parseInt(entryMode, 8);
	return 0o100644;
}

/** Load a patch's preimage from a tree, or report a whole-file reject. */
async function preparePatch(
	repo: GitRepo,
	entries: ReadonlyMap<string, FlatTreeEntry>,
	patch: ParsedPatch,
): Promise<PreparedApply | { reject: FileReject }> {
	const path = (patch.kind === "delete" ? patch.oldName : patch.newName) ?? patch.oldName ?? "";

	if (patch.kind === "new") {
		const newPath = patch.newName ?? path;
		const existing = entries.get(newPath);
		if (existing) {
			return {
				reject: {
					path: newPath,
					currentContent: decoder.decode(await readBlobBytes(repo, existing.hash)),
					appliedHunks: 0,
					rejectedHunks: [],
					error: `${newPath}: already exists in onto`,
				},
			};
		}
		return {
			patch,
			path,
			preimageText: "",
			preimageBytes: new Uint8Array(0),
			mode: resolveTreeMode(patch, undefined),
		};
	}

	const src = patch.oldName;
	if (!src) {
		return {
			reject: {
				path,
				currentContent: null,
				appliedHunks: 0,
				rejectedHunks: [],
				error: "missing source path",
			},
		};
	}
	const entry = entries.get(src);
	if (!entry) {
		return {
			reject: {
				path,
				currentContent: null,
				appliedHunks: 0,
				rejectedHunks: [],
				error: `${src}: does not exist in onto`,
			},
		};
	}
	const bytes = await readBlobBytes(repo, entry.hash);
	return {
		patch,
		path,
		preimageText: decoder.decode(bytes),
		preimageBytes: bytes,
		mode: resolveTreeMode(patch, entry.mode),
	};
}

/** Fold planned blob effects into a new tree after every patch has validated. */
async function writeEffects(
	repo: GitRepo,
	entries: ReadonlyMap<string, FlatTreeEntry>,
	effects: BlobEffect[],
): Promise<string> {
	const result = new Map(entries);
	for (const effect of effects) {
		if ("delete" in effect) {
			result.delete(effect.path);
		} else {
			result.set(effect.path, {
				path: effect.path,
				hash: await writeObject(repo, "blob", effect.content),
				mode: effect.mode,
			});
		}
	}
	const indexEntries: IndexEntry[] = [...result.values()].map((entry) => ({
		path: entry.path,
		hash: entry.hash,
		mode: parseInt(entry.mode, 8),
		stage: 0,
		stat: defaultStat(),
	}));
	return buildTreeFromIndex(repo, indexEntries);
}

/**
 * Apply parsed patches to an already-resolved tree hash.
 *
 * Validation is two-pass and all-or-nothing: no blob/tree is written until all
 * patches have produced effects without rejects.
 */
export async function applyPatchesToTree(
	repo: GitRepo,
	patches: ParsedPatch[],
	ontoTree: string,
	options: ApplyPatchesToTreeOptions,
): Promise<ApplyPatchesToTreeResult> {
	const entries = await flattenTreeToMap(repo, ontoTree);
	const effects: BlobEffect[] = [];
	const rejects: FileReject[] = [];

	for (const patch of patches) {
		const prepared = await preparePatch(repo, entries, patch);
		if ("reject" in prepared) {
			rejects.push(prepared.reject);
			continue;
		}
		const result = patch.isBinary
			? await planBinaryApply(prepared, options.reverse)
			: planTextApply(prepared, options.whitespace);
		if ("reject" in result) rejects.push(result.reject);
		else effects.push(...result.effects);
	}

	if (rejects.length > 0) return { status: "rejected", rejects };
	return { status: "applied", treeHash: await writeEffects(repo, entries, effects) };
}
