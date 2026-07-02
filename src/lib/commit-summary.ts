/**
 * Commit-summary / diffstat data gathering (shortstat + mode lines).
 *
 * This module is the *data* half of the commit-summary concern: it diffs trees,
 * detects renames, and computes per-file insertion/deletion counts and mode
 * changes as plain data structs. Turning that data into human output lives in
 * the presentation sibling `src/format/commit-summary.ts`. Used by git commit,
 * cherry-pick, merge, and the diffstat commands.
 */
import type { BoundAttributes } from "./attributes/bound-attributes.ts";
import { myersDiff, splitLinesWithNL } from "./diff/algorithm.ts";
import { resolveDiffStat } from "./diff/driver.ts";
import { readBlobBytes } from "./object-db.ts";
import { detectRenames, type RenamePair } from "./diff/rename-detection.ts";
import { diffTrees } from "./tree-ops.ts";
import type { GitRepo, ObjectId, TreeDiffEntry } from "./types.ts";

const textDecoder = new TextDecoder();

export interface FileStat {
	/** Raw path of the file (new path for renames). */
	path: string;
	/** Key for sorting — new path for renames, same as path otherwise. */
	sortKey: string;
	insertions: number;
	deletions: number;
	/** Binary file — show "Bin X -> Y bytes" instead of line counts. */
	isBinary?: boolean;
	oldSize?: number;
	newSize?: number;
	/** Unmerged file — show "Unmerged" instead of line counts. */
	isUnmerged?: boolean;
	/** Rename info — renderers build the "{old => new}" display path from it. */
	rename?: { oldPath: string; newPath: string };
}

/** A create/delete/rename mode change, sorted by path. Rendered by the format layer. */
export type ModeChange =
	| { kind: "create"; mode: string; path: string }
	| { kind: "delete"; mode: string; path: string }
	| { kind: "rename"; oldPath: string; newPath: string; similarity: number };

/** The gathered data for a commit summary / diffstat, ready for rendering. */
export interface DiffStats {
	fileStats: FileStat[];
	modeChanges: ModeChange[];
}

/** Count lines in content. Empty string = 0 lines. */
function countLines(content: string): number {
	if (content.length === 0) return 0;
	let count = 0;
	for (let i = 0; i < content.length; i++) {
		if (content[i] === "\n") count++;
	}
	if (content[content.length - 1] !== "\n") count++;
	return count;
}

/** Count insertions/deletions between two decoded sides. */
function countEdits(oldText: string, newText: string): { ins: number; del: number } {
	const edits = myersDiff(splitLinesWithNL(oldText), splitLinesWithNL(newText));
	let ins = 0;
	let del = 0;
	for (const edit of edits) {
		if (edit.type === "insert") ins++;
		else if (edit.type === "delete") del++;
	}
	return { ins, del };
}

/**
 * Compute per-file diff stats (insertions/deletions/binary info) and mode
 * changes for a set of tree diffs and renames. Returns plain data — no display
 * strings. Shared by the commit-summary and diffstat renderers.
 *
 * `bound` (optional) routes binariness + textconv through the path's
 * `diff=<driver>`, so `git diff`/`show`/`log` `--stat`/`--numstat` honor the
 * driver. Callers that summarize *committed* bytes (commit/merge summaries) pass
 * nothing and stay raw.
 */
export async function computeDiffStats(
	ctx: GitRepo,
	diffs: TreeDiffEntry[],
	renames: RenamePair[],
	bound?: BoundAttributes,
): Promise<DiffStats> {
	const fileStats: FileStat[] = [];
	const createModes: { path: string; mode: string }[] = [];
	const deleteModes: { path: string; mode: string }[] = [];
	const empty = new Uint8Array(0);

	for (const diff of diffs) {
		if (diff.status === "added" && diff.newHash && diff.newMode) {
			const raw = await readBlobBytes(ctx, diff.newHash);
			const st = await resolveDiffStat(bound, diff.path, empty, undefined, raw, diff.newHash);
			if (st.binary) {
				fileStats.push({
					path: diff.path,
					sortKey: diff.path,
					insertions: 0,
					deletions: 0,
					isBinary: true,
					oldSize: 0,
					newSize: st.newBytes.byteLength,
				});
			} else {
				fileStats.push({
					path: diff.path,
					sortKey: diff.path,
					insertions: countLines(textDecoder.decode(st.newBytes)),
					deletions: 0,
				});
			}
			createModes.push({ path: diff.path, mode: diff.newMode });
		} else if (diff.status === "deleted" && diff.oldHash && diff.oldMode) {
			const raw = await readBlobBytes(ctx, diff.oldHash);
			const st = await resolveDiffStat(bound, diff.path, raw, diff.oldHash, empty, undefined);
			if (st.binary) {
				fileStats.push({
					path: diff.path,
					sortKey: diff.path,
					insertions: 0,
					deletions: 0,
					isBinary: true,
					oldSize: st.oldBytes.byteLength,
					newSize: 0,
				});
			} else {
				fileStats.push({
					path: diff.path,
					sortKey: diff.path,
					insertions: 0,
					deletions: countLines(textDecoder.decode(st.oldBytes)),
				});
			}
			deleteModes.push({ path: diff.path, mode: diff.oldMode });
		} else if (diff.status === "modified" && diff.oldHash && diff.newHash) {
			const oldRaw = await readBlobBytes(ctx, diff.oldHash);
			const newRaw = await readBlobBytes(ctx, diff.newHash);
			const st = await resolveDiffStat(
				bound,
				diff.path,
				oldRaw,
				diff.oldHash,
				newRaw,
				diff.newHash,
			);
			if (st.binary) {
				fileStats.push({
					path: diff.path,
					sortKey: diff.path,
					insertions: 0,
					deletions: 0,
					isBinary: true,
					oldSize: st.oldBytes.byteLength,
					newSize: st.newBytes.byteLength,
				});
			} else {
				const { ins, del } = countEdits(
					textDecoder.decode(st.oldBytes),
					textDecoder.decode(st.newBytes),
				);
				fileStats.push({
					path: diff.path,
					sortKey: diff.path,
					insertions: ins,
					deletions: del,
				});
			}
			if (diff.oldMode && diff.newMode && diff.oldMode !== diff.newMode) {
				deleteModes.push({ path: diff.path, mode: diff.oldMode });
				createModes.push({ path: diff.path, mode: diff.newMode });
			}
		}
	}

	for (const rename of renames) {
		let ins = 0;
		let del = 0;
		if (rename.similarity < 100 && rename.oldHash && rename.newHash) {
			const oldRaw = await readBlobBytes(ctx, rename.oldHash);
			const newRaw = await readBlobBytes(ctx, rename.newHash);
			const st = await resolveDiffStat(
				bound,
				rename.newPath,
				oldRaw,
				rename.oldHash,
				newRaw,
				rename.newHash,
			);
			if (!st.binary) {
				({ ins, del } = countEdits(
					textDecoder.decode(st.oldBytes),
					textDecoder.decode(st.newBytes),
				));
			}
		}
		fileStats.push({
			path: rename.newPath,
			sortKey: rename.newPath,
			insertions: ins,
			deletions: del,
			rename: { oldPath: rename.oldPath, newPath: rename.newPath },
		});
	}

	const sortable: { sortKey: string; change: ModeChange }[] = [];
	for (const { path, mode } of createModes) {
		sortable.push({ sortKey: path, change: { kind: "create", mode, path } });
	}
	for (const { path, mode } of deleteModes) {
		sortable.push({ sortKey: path, change: { kind: "delete", mode, path } });
	}
	for (const rename of renames) {
		sortable.push({
			sortKey: rename.newPath,
			change: {
				kind: "rename",
				oldPath: rename.oldPath,
				newPath: rename.newPath,
				similarity: rename.similarity,
			},
		});
	}
	sortable.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));

	return { fileStats, modeChanges: sortable.map((m) => m.change) };
}

/**
 * Gather the diff stats for a commit summary / diffstat between two trees:
 * diff, detect renames, and compute per-file stats. Pure data — the format
 * layer turns the result into `--stat`/summary output.
 */
export async function gatherCommitStats(
	ctx: GitRepo,
	oldTree: ObjectId | null,
	newTree: ObjectId,
): Promise<DiffStats> {
	const rawDiffs = await diffTrees(ctx, oldTree, newTree);
	const { remaining: diffs, renames } = await detectRenames(ctx, rawDiffs);
	return computeDiffStats(ctx, diffs, renames);
}
