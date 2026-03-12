import { splitLines } from "./diff-algorithm.ts";
import { myersDiff } from "./diff-algorithm.ts";
import { readBlobContent, readCommit } from "./object-db.ts";
import { detectRenames } from "./rename-detection.ts";
import { diffTrees, flattenTreeToMap } from "./tree-ops.ts";
import type { Commit, GitContext, Identity, ObjectId } from "./types.ts";

// ── Types ────────────────────────────────────────────────────────────

export interface BlameEntry {
	hash: ObjectId;
	origPath: string;
	/** 1-based line number in the originating commit's version. */
	origLine: number;
	/** 1-based line number in the final file. */
	finalLine: number;
	content: string;
	author: Identity;
	committer: Identity;
	summary: string;
	boundary: boolean;
	previous?: { hash: ObjectId; path: string };
}

interface BlameOptions {
	startLine?: number;
	endLine?: number;
}

// ── Helpers ──────────────────────────────────────────────────────────

async function getBlobHashAtPath(
	ctx: GitContext,
	treeHash: ObjectId,
	path: string,
): Promise<ObjectId | null> {
	const map = await flattenTreeToMap(ctx, treeHash);
	const entry = map.get(path);
	return entry?.hash ?? null;
}

/**
 * If the file at `path` was renamed between parentTree and currentTree,
 * return the old path. Otherwise return null.
 */
async function findRenamedPath(
	ctx: GitContext,
	parentTree: ObjectId,
	currentTree: ObjectId,
	path: string,
): Promise<string | null> {
	const diffs = await diffTrees(ctx, parentTree, currentTree);
	const addedEntry = diffs.find((d) => d.status === "added" && d.path === path);
	if (!addedEntry) return null;

	const { renames } = await detectRenames(ctx, diffs);
	const rename = renames.find((r) => r.newPath === path);
	return rename?.oldPath ?? null;
}

// ── Tracking structures ──────────────────────────────────────────────

interface UnblamedLine {
	/** 0-based index into the final result array. */
	finalIdx: number;
	/** 1-based line number in the current commit's version of the file. */
	currentLine: number;
}

// ── Core algorithm ───────────────────────────────────────────────────

export async function blame(
	ctx: GitContext,
	commitHash: ObjectId,
	path: string,
	opts?: BlameOptions,
): Promise<BlameEntry[]> {
	const commit = await readCommit(ctx, commitHash);
	const blobHash = await getBlobHashAtPath(ctx, commit.tree, path);
	if (!blobHash) {
		throw new Error(`no such path '${path}' in ${commitHash.slice(0, 7)}`);
	}

	const content = await readBlobContent(ctx, blobHash);
	const allLines = splitLines(content);

	const startLine = opts?.startLine ?? 1;
	const endLine = opts?.endLine ?? allLines.length;
	const rangeLines = allLines.slice(startLine - 1, endLine);

	const result: BlameEntry[] = new Array(rangeLines.length);

	let unblamed: UnblamedLine[] = rangeLines.map((_, i) => ({
		finalIdx: i,
		currentLine: startLine + i,
	}));

	let currentHash = commitHash;
	let currentPath = path;
	let currentLines = allLines;

	while (unblamed.length > 0) {
		const currentCommit = await readCommit(ctx, currentHash);

		if (currentCommit.parents.length === 0) {
			for (const u of unblamed) {
				result[u.finalIdx] = makeEntry(
					currentHash,
					currentPath,
					u.currentLine,
					startLine + u.finalIdx,
					rangeLines[u.finalIdx]!,
					currentCommit,
					true,
					undefined,
				);
			}
			break;
		}

		const parentHash = currentCommit.parents[0] as ObjectId;
		const parentCommit = await readCommit(ctx, parentHash);

		let parentPath = currentPath;
		let parentBlobHash = await getBlobHashAtPath(ctx, parentCommit.tree, parentPath);

		if (!parentBlobHash) {
			const renamedFrom = await findRenamedPath(
				ctx,
				parentCommit.tree,
				currentCommit.tree,
				currentPath,
			);
			if (renamedFrom) {
				parentPath = renamedFrom;
				parentBlobHash = await getBlobHashAtPath(ctx, parentCommit.tree, parentPath);
			}
		}

		if (!parentBlobHash) {
			for (const u of unblamed) {
				result[u.finalIdx] = makeEntry(
					currentHash,
					currentPath,
					u.currentLine,
					startLine + u.finalIdx,
					rangeLines[u.finalIdx]!,
					currentCommit,
					false,
					undefined,
				);
			}
			break;
		}

		const parentContent = await readBlobContent(ctx, parentBlobHash);
		const parentLines = splitLines(parentContent);

		const currentBlobHash = await getBlobHashAtPath(ctx, currentCommit.tree, currentPath);
		if (currentBlobHash === parentBlobHash) {
			currentHash = parentHash;
			currentPath = parentPath;
			currentLines = parentLines;
			continue;
		}

		const edits = myersDiff(parentLines, currentLines);

		const newToOld = new Map<number, number>();
		for (const edit of edits) {
			if (edit.type === "keep") {
				newToOld.set(edit.newLineNo, edit.oldLineNo);
			}
		}

		const nextUnblamed: UnblamedLine[] = [];
		for (const u of unblamed) {
			const oldLine = newToOld.get(u.currentLine);
			if (oldLine !== undefined) {
				nextUnblamed.push({ finalIdx: u.finalIdx, currentLine: oldLine });
			} else {
				result[u.finalIdx] = makeEntry(
					currentHash,
					currentPath,
					u.currentLine,
					startLine + u.finalIdx,
					rangeLines[u.finalIdx]!,
					currentCommit,
					false,
					{ hash: parentHash, path: parentPath },
				);
			}
		}

		unblamed = nextUnblamed;
		currentHash = parentHash;
		currentPath = parentPath;
		currentLines = parentLines;
	}

	return result;
}

function makeEntry(
	hash: ObjectId,
	origPath: string,
	origLine: number,
	finalLine: number,
	content: string,
	commit: Commit,
	boundary: boolean,
	previous: { hash: ObjectId; path: string } | undefined,
): BlameEntry {
	return {
		hash,
		origPath,
		origLine,
		finalLine,
		content,
		author: commit.author,
		committer: commit.committer,
		summary: commit.message.split("\n")[0]!,
		boundary,
		previous,
	};
}
