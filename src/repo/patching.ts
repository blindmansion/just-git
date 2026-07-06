/**
 * Tree-level patch APIs on the `just-git/repo` surface.
 *
 * A worktree-free, index-free peer to the CLI `git apply` engine
 * (`src/lib/patch/apply.ts`): given a patch and an `onto` tree-ish, produce a
 * new tree hash — or, on failure, structured **rejects-as-data** rather than
 * `.rej` files or stderr. The reject payload carries each unplaced hunk with
 * its raw bytes plus the current file content, so a caller (e.g. an LLM agent)
 * can be re-prompted to fix and retry.
 *
 * This module is the imperative **shell** (matching `merge()` / `rebase()`):
 * it resolves `onto`, reads the needed blobs, drives the pure planners in
 * `lib/patch/tree-apply.ts`, and folds the resulting {@link BlobEffect}s into a
 * new tree via `updateTree` — all-or-nothing, exactly like git's
 * `check_patch_list` → `write_out_results`. The planning itself is pure and
 * lives in `lib`, alongside the other functional cores the shell drives.
 */
import { readBlobBytes, readObject, writeObject } from "../lib/object-db.ts";
import { reversePatch, type WhitespaceAction } from "../lib/patch/apply.ts";
import { parsePatch, type ParsedPatch } from "../lib/patch/parse-patch.ts";
import {
	type BlobEffect,
	type FileReject,
	planBinaryApply,
	planTextApply,
	type PreparedApply,
} from "../lib/patch/tree-apply.ts";
import { type FlatTreeEntry, flattenTreeToMap } from "../lib/tree-ops.ts";
import type { GitRepo } from "../lib/types.ts";
import { readCommit, revParse } from "./reading.ts";
import { type TreeUpdate, updateTree } from "./writing.ts";

// ── Re-exported patch primitives (promote lib → repo surface) ────────

export {
	ApplyParseError,
	parsePatch,
	type ApplyHunkLine,
	type ParsedPatch,
	type PatchChangeKind,
	type PatchFragment,
} from "../lib/patch/parse-patch.ts";
export { reversePatch, type WhitespaceAction } from "../lib/patch/apply.ts";
export {
	formatPatchSeries,
	FormatPatchError,
	type FormatPatchOptions,
	type FormatPatchResult,
	type PatchRecord,
} from "../lib/patch/format-patch.ts";
export type { BlobEffect, FileReject, HunkReject } from "../lib/patch/tree-apply.ts";

// ── Public option / result types ────────────────────────────────────

/** Options for {@link applyPatch}. */
export interface ApplyPatchOptions {
	/** Patch text (unified / git-extended diff) or pre-parsed patches. */
	patch: string | ParsedPatch[];
	/** Tree-ish to apply onto: a commit-ish or a raw tree hash (rev-parse expr ok). */
	onto: string;
	/** `-R`: reverse the patch before applying. Default `false`. */
	reverse?: boolean;
	/** `-p<n>` path-strip when parsing `patch` text. Default `1`. Ignored for `ParsedPatch[]`. */
	strip?: number;
	/** Whitespace policy for added lines (git's `--whitespace`). Default `"nowarn"`. */
	whitespace?: WhitespaceAction;
}

/** Outcome of {@link applyPatch}. */
export type ApplyPatchResult =
	| { status: "applied"; treeHash: string }
	| { status: "rejected"; rejects: FileReject[] };

// ── Shell (GitRepo) ─────────────────────────────────────────────────

const decoder = new TextDecoder();

/** Resolve an `onto` tree-ish to a tree object hash (peels commits to their tree). */
async function resolveOntoTree(repo: GitRepo, onto: string): Promise<string> {
	const hash = await revParse(repo, onto);
	if (!hash) throw new Error(`cannot resolve '${onto}' to a tree or commit`);
	const obj = await readObject(repo, hash);
	if (obj.type === "tree") return hash;
	if (obj.type === "commit") return (await readCommit(repo, hash)).tree;
	throw new Error(`'${onto}' resolves to a ${obj.type}, expected a commit or tree`);
}

/** Result mode for a patch: explicit new/old mode, else the source tree mode. */
function resolveTreeMode(patch: ParsedPatch, entryMode: string | undefined): number {
	if (patch.newMode) return patch.newMode;
	if (patch.oldMode) return patch.oldMode;
	if (entryMode) return parseInt(entryMode, 8);
	return 0o100644;
}

/** Load a patch's preimage from the `onto` tree, or report a whole-file reject. */
async function preparePatch(
	repo: GitRepo,
	entries: Map<string, FlatTreeEntry>,
	patch: ParsedPatch,
): Promise<PreparedApply | { reject: FileReject }> {
	const path = (patch.kind === "delete" ? patch.oldName : patch.newName) ?? patch.oldName ?? "";

	if (patch.kind === "new") {
		const newPath = patch.newName ?? path;
		const existing = entries.get(newPath);
		if (existing) {
			const current = decoder.decode(await readBlobBytes(repo, existing.hash));
			return {
				reject: {
					path: newPath,
					currentContent: current,
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

/**
 * Apply a patch to a tree, returning a new tree hash on success or structured
 * {@link FileReject}s on failure — never touching a worktree, index, or `.rej`
 * file. All-or-nothing: if any file rejects, no blobs or trees are folded into
 * a result (only the reject data comes back).
 *
 * ```ts
 * const res = await applyPatch(repo, { patch: diffText, onto: "main" });
 * if (res.status === "applied") {
 *   // res.treeHash is the new tree
 * } else {
 *   // res.rejects[i] carries the unplaced hunks + current file content
 * }
 * ```
 */
export async function applyPatch(
	repo: GitRepo,
	opts: ApplyPatchOptions,
): Promise<ApplyPatchResult> {
	const parsed =
		typeof opts.patch === "string" ? parsePatch(opts.patch, opts.strip ?? 1) : opts.patch;
	const reverse = opts.reverse ?? false;
	const effective = reverse ? parsed.map((p) => reversePatch(p)) : parsed;
	const whitespace = opts.whitespace ?? "nowarn";

	const ontoTree = await resolveOntoTree(repo, opts.onto);
	const entries = await flattenTreeToMap(repo, ontoTree);

	const effects: BlobEffect[] = [];
	const rejects: FileReject[] = [];

	for (const patch of effective) {
		const prepared = await preparePatch(repo, entries, patch);
		if ("reject" in prepared) {
			rejects.push(prepared.reject);
			continue;
		}
		const res = patch.isBinary
			? await planBinaryApply(prepared, reverse)
			: planTextApply(prepared, whitespace);
		if ("reject" in res) rejects.push(res.reject);
		else effects.push(...res.effects);
	}

	// Two-pass, all-or-nothing (git's check_patch_list → write_out_results): a
	// single reject blocks every write, so a failed apply leaves the store
	// untouched and hands back only the reject data.
	if (rejects.length > 0) return { status: "rejected", rejects };

	const updates: TreeUpdate[] = [];
	for (const e of effects) {
		if ("delete" in e) {
			updates.push({ path: e.path, hash: null });
		} else {
			updates.push({
				path: e.path,
				hash: await writeObject(repo, "blob", e.content),
				mode: e.mode,
			});
		}
	}
	const treeHash = await updateTree(repo, ontoTree, updates);
	return { status: "applied", treeHash };
}
