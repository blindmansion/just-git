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

/**
 * Recursively blame a subset of lines starting from a given commit.
 * Used when a merge commit's lines trace to a non-first parent.
 * Returns a map of finalIdx → BlameEntry.
 */
async function blameLines(
	ctx: GitContext,
	commitHash: ObjectId,
	path: string,
	lines: UnblamedLine[],
	rangeLines: string[],
	startLine: number,
): Promise<Map<number, BlameEntry>> {
	const blobHash = await getBlobHashAtPath(ctx, (await readCommit(ctx, commitHash)).tree, path);
	if (!blobHash) {
		const entries = new Map<number, BlameEntry>();
		const commit = await readCommit(ctx, commitHash);
		for (const u of lines) {
			entries.set(
				u.finalIdx,
				makeEntry(
					commitHash,
					path,
					u.currentLine,
					startLine + u.finalIdx,
					rangeLines[u.finalIdx]!,
					commit,
					false,
					undefined,
				),
			);
		}
		return entries;
	}

	const content = await readBlobContent(ctx, blobHash);
	const allLines = splitLines(content);

	const subResult: BlameEntry[] = new Array(rangeLines.length);
	let unblamed = [...lines];
	let currentHash = commitHash;
	let currentPath = path;
	let currentLines = allLines;

	while (unblamed.length > 0) {
		const currentCommit = await readCommit(ctx, currentHash);

		if (currentCommit.parents.length === 0) {
			for (const u of unblamed) {
				subResult[u.finalIdx] = makeEntry(
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

		const curBlobHash = await getBlobHashAtPath(ctx, currentCommit.tree, currentPath);

		let identicalParent: { hash: ObjectId; path: string } | null = null;
		const candidates: { hash: ObjectId; path: string; blobHash: ObjectId }[] = [];

		for (const pid of currentCommit.parents) {
			const pc = await readCommit(ctx, pid);
			let pp = currentPath;
			let pbh = await getBlobHashAtPath(ctx, pc.tree, pp);
			if (!pbh) {
				const renamedFrom = await findRenamedPath(ctx, pc.tree, currentCommit.tree, currentPath);
				if (renamedFrom) {
					pp = renamedFrom;
					pbh = await getBlobHashAtPath(ctx, pc.tree, pp);
				}
			}
			if (pbh) {
				candidates.push({ hash: pid, path: pp, blobHash: pbh });
				if (pbh === curBlobHash) {
					identicalParent = { hash: pid, path: pp };
					break;
				}
			}
		}

		if (identicalParent) {
			currentHash = identicalParent.hash;
			currentPath = identicalParent.path;
			continue;
		}

		if (candidates.length === 0) {
			for (const u of unblamed) {
				subResult[u.finalIdx] = makeEntry(
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

		const parent = candidates[0]!;
		const parentContent = await readBlobContent(ctx, parent.blobHash);
		const parentLines = splitLines(parentContent);
		const edits = myersDiff(parentLines, currentLines);
		const newToOld = new Map<number, number>();
		for (const edit of edits) {
			if (edit.type === "keep") newToOld.set(edit.newLineNo, edit.oldLineNo);
		}

		const nextUnblamed: UnblamedLine[] = [];
		for (const u of unblamed) {
			const oldLine = newToOld.get(u.currentLine);
			if (oldLine !== undefined) {
				nextUnblamed.push({ finalIdx: u.finalIdx, currentLine: oldLine });
			} else {
				subResult[u.finalIdx] = makeEntry(
					currentHash,
					currentPath,
					u.currentLine,
					startLine + u.finalIdx,
					rangeLines[u.finalIdx]!,
					currentCommit,
					false,
					{ hash: parent.hash, path: parent.path },
				);
			}
		}

		unblamed = nextUnblamed;
		currentHash = parent.hash;
		currentPath = parent.path;
		currentLines = parentLines;
	}

	const resultMap = new Map<number, BlameEntry>();
	for (const u of lines) {
		if (subResult[u.finalIdx]) {
			resultMap.set(u.finalIdx, subResult[u.finalIdx]!);
		}
	}
	return resultMap;
}

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

		const currentBlobHash = await getBlobHashAtPath(ctx, currentCommit.tree, currentPath);

		// Resolve each parent's blob hash (with rename detection).
		// If any parent has an identical blob, follow it immediately (fast path).
		interface ParentInfo {
			hash: ObjectId;
			path: string;
			blobHash: ObjectId;
		}
		const parentCandidates: ParentInfo[] = [];
		let identicalParent: ParentInfo | null = null;

		for (const pid of currentCommit.parents) {
			const pc = await readCommit(ctx, pid);
			let pp = currentPath;
			let pbh = await getBlobHashAtPath(ctx, pc.tree, pp);

			if (!pbh) {
				const renamedFrom = await findRenamedPath(ctx, pc.tree, currentCommit.tree, currentPath);
				if (renamedFrom) {
					pp = renamedFrom;
					pbh = await getBlobHashAtPath(ctx, pc.tree, pp);
				}
			}

			if (pbh) {
				const info: ParentInfo = { hash: pid, path: pp, blobHash: pbh };
				parentCandidates.push(info);
				if (pbh === currentBlobHash) {
					identicalParent = info;
					break;
				}
			}
		}

		if (identicalParent) {
			currentHash = identicalParent.hash;
			currentPath = identicalParent.path;
			continue;
		}

		if (parentCandidates.length === 0) {
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

		if (parentCandidates.length === 1) {
			// Single parent with the file — standard diff attribution.
			const parent = parentCandidates[0]!;
			const parentContent = await readBlobContent(ctx, parent.blobHash);
			const parentLines = splitLines(parentContent);

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
						{ hash: parent.hash, path: parent.path },
					);
				}
			}

			unblamed = nextUnblamed;
			currentHash = parent.hash;
			currentPath = parent.path;
			currentLines = parentLines;
			continue;
		}

		// Multiple parents, blob differs from all — multi-parent blame.
		// Diff against each parent. Lines traceable to any parent pass through
		// (preferring first parent); lines new in all parents are blamed on the merge.
		const parentDiffs: { info: ParentInfo; newToOld: Map<number, number> }[] = [];
		for (const info of parentCandidates) {
			const pContent = await readBlobContent(ctx, info.blobHash);
			const pLines = splitLines(pContent);
			const edits = myersDiff(pLines, currentLines);
			const newToOld = new Map<number, number>();
			for (const edit of edits) {
				if (edit.type === "keep") {
					newToOld.set(edit.newLineNo, edit.oldLineNo);
				}
			}
			parentDiffs.push({ info, newToOld });
		}

		// For each unblamed line, find the first parent that has it.
		// Group lines by which parent they'll follow.
		const followGroups = new Map<number, { info: ParentInfo; lines: UnblamedLine[] }>();
		for (const u of unblamed) {
			let attributed = false;
			for (let pi = 0; pi < parentDiffs.length; pi++) {
				const pd = parentDiffs[pi]!;
				const oldLine = pd.newToOld.get(u.currentLine);
				if (oldLine !== undefined) {
					let group = followGroups.get(pi);
					if (!group) {
						group = { info: pd.info, lines: [] };
						followGroups.set(pi, group);
					}
					group.lines.push({ finalIdx: u.finalIdx, currentLine: oldLine });
					attributed = true;
					break;
				}
			}
			if (!attributed) {
				result[u.finalIdx] = makeEntry(
					currentHash,
					currentPath,
					u.currentLine,
					startLine + u.finalIdx,
					rangeLines[u.finalIdx]!,
					currentCommit,
					false,
					{ hash: parentCandidates[0]!.hash, path: parentCandidates[0]!.path },
				);
			}
		}

		// Continue blame walk for lines that traced to parents.
		// We can only follow one parent linearly; recursively blame the rest.
		const firstGroup = followGroups.get(0);
		for (const [pi, group] of followGroups) {
			if (pi === 0) continue;
			const subEntries = await blameLines(
				ctx,
				group.info.hash,
				group.info.path,
				group.lines,
				rangeLines,
				startLine,
			);
			for (const [idx, entry] of subEntries) {
				result[idx] = entry;
			}
		}

		if (firstGroup && firstGroup.lines.length > 0) {
			unblamed = firstGroup.lines;
			currentHash = firstGroup.info.hash;
			currentPath = firstGroup.info.path;
			const pContent = await readBlobContent(ctx, firstGroup.info.blobHash);
			currentLines = splitLines(pContent);
		} else {
			break;
		}
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
