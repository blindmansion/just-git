import type { GitExtensions } from "../git.ts";
import { formatCombinedDiffEntry } from "../lib/combined-diff.ts";
import {
	abbreviateHash,
	type CommandResult,
	comparePaths,
	fatal,
	getCwdPrefix,
	isCommandError,
	requireCommit,
	requireGitContext,
	requireWorkTree,
} from "../lib/command-utils.ts";
import { type FileStat, formatShortstatParts, renderStatLines } from "../lib/commit-summary.ts";
import { formatUnifiedDiff, myersDiff, splitLinesWithNL } from "../lib/diff-algorithm.ts";
import { getStage0Entries, readIndex } from "../lib/index.ts";
import { findAllMergeBases } from "../lib/merge.ts";
import {
	hashObject,
	isBinaryBytes,
	isBinaryStr,
	readBlobBytes,
	readBlobContent,
	readCommit,
} from "../lib/object-db.ts";
import { join } from "../lib/path.ts";
import { matchPathspecs, type Pathspec, parsePathspec } from "../lib/pathspec.ts";
import { parseRangeSyntax } from "../lib/range-syntax.ts";
import { readWorktreeContent } from "../lib/symlink.ts";
import { resolveHead } from "../lib/refs.ts";
import { detectRenames, formatRenamePath, type RenamePair } from "../lib/rename-detection.ts";
import { diffTrees, flattenTreeToMap } from "../lib/tree-ops.ts";
import type { GitContext, IndexEntry, ObjectId, TreeDiffEntry } from "../lib/types.ts";
import { diffIndexToWorkTree } from "../lib/worktree.ts";
import { a, type Command, f } from "../parse/index.ts";

const decoder = new TextDecoder();

// ── Types ───────────────────────────────────────────────────────────

type DiffOutputFormat = "unified" | "stat" | "name-only" | "name-status" | "shortstat" | "numstat";

interface DiffFileResult {
	path: string;
	status: "A" | "M" | "D" | "R" | "U";
	oldHash?: string;
	newHash?: string;
	oldMode?: string;
	newMode?: string;
	oldPath?: string;
	similarity?: number;
	/** When true, new content lives in the worktree file, not the object store. */
	newFromWorkTree?: boolean;
	/** For combined diff on unmerged worktree files: stage blob hashes */
	combinedParentHashes?: (string | null)[];
	/** For combined diff on unmerged worktree files: stage blob modes */
	combinedParentModes?: (string | null)[];
}

type DiffCollectResult = { items: DiffFileResult[]; stderr?: string } | CommandResult;

function isError(r: DiffCollectResult): r is CommandResult {
	return "exitCode" in r;
}

function fmtMode(mode: number): string {
	return mode.toString(8).padStart(6, "0");
}

function renameResultToItems(remaining: TreeDiffEntry[], renames: RenamePair[]): DiffFileResult[] {
	const items: DiffFileResult[] = [];
	for (const d of remaining) {
		items.push({
			path: d.path,
			status: d.status === "added" ? "A" : d.status === "deleted" ? "D" : "M",
			oldHash: d.oldHash,
			newHash: d.newHash,
			oldMode: d.oldMode,
			newMode: d.newMode,
		});
	}
	for (const r of renames) {
		items.push({
			path: r.newPath,
			status: "R",
			oldHash: r.oldHash,
			newHash: r.newHash,
			oldMode: r.oldMode,
			newMode: r.newMode,
			oldPath: r.oldPath,
			similarity: r.similarity,
		});
	}
	return items;
}

// ── Command registration ────────────────────────────────────────────

export function registerDiffCommand(parent: Command, ext?: GitExtensions) {
	parent.command("diff", {
		description: "Show changes between commits, commit and working tree, etc.",
		args: [a.string().name("commits").variadic().optional()],
		options: {
			cached: f().describe("Show staged changes (index vs HEAD)"),
			staged: f().describe("Synonym for --cached"),
			stat: f().describe("Show diffstat summary"),
			nameOnly: f().describe("Show only names of changed files"),
			nameStatus: f().describe("Show names and status of changed files"),
			shortstat: f().describe("Show only the shortstat summary line"),
			numstat: f().describe("Machine-readable insertions/deletions per file"),
		},
		handler: async (args, ctx, meta) => {
			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;
			const gitCtx = gitCtxOrError;

			const showCached = args.cached || args.staged;
			const commits = args.commits;

			const cwdPrefix = getCwdPrefix(gitCtx, ctx.cwd);
			const pathFilter =
				meta.passthrough.length > 0
					? meta.passthrough.map((p) => parsePathspec(p, cwdPrefix))
					: null;

			const format: DiffOutputFormat = args.stat
				? "stat"
				: args.nameOnly
					? "name-only"
					: args.nameStatus
						? "name-status"
						: args.shortstat
							? "shortstat"
							: args.numstat
								? "numstat"
								: "unified";

			let result: DiffCollectResult;

			const range = commits.length === 1 ? parseRangeSyntax(commits[0] as string) : null;

			if (range) {
				if (showCached) return fatal("too many arguments");
				if (range.type === "three-dot") {
					result = await collectThreeDot(gitCtx, range.left, range.right, pathFilter);
				} else {
					result = await collectCommitToCommit(gitCtx, range.left, range.right, pathFilter);
				}
			} else if (commits.length === 2) {
				result = await collectCommitToCommit(
					gitCtx,
					commits[0] as string,
					commits[1] as string,
					pathFilter,
				);
			} else if (commits.length > 2) {
				return fatal("too many arguments");
			} else if (showCached) {
				result = await collectCached(
					gitCtx,
					commits.length === 1 ? (commits[0] as string) : null,
					pathFilter,
				);
			} else if (commits.length === 1) {
				result = await collectCommitToWorkTree(gitCtx, commits[0] as string, pathFilter);
			} else {
				result = await collectUnstaged(gitCtx, pathFilter);
			}

			if (isError(result)) return result;
			const output = await formatOutput(gitCtx, result.items, format);
			if (result.stderr) output.stderr = result.stderr;
			return output;
		},
	});
}

// ── Collectors ──────────────────────────────────────────────────────

async function collectUnstaged(
	gitCtx: GitContext,
	pathFilter: Pathspec[] | null,
): Promise<DiffCollectResult> {
	const workTreeError = requireWorkTree(gitCtx);
	if (workTreeError) return workTreeError;

	const index = await readIndex(gitCtx);

	const unmergedPaths = new Set<string>();
	const stage0 = new Map<string, IndexEntry>();
	const stage2 = new Map<string, IndexEntry>();
	const stage3 = new Map<string, IndexEntry>();
	for (const e of index.entries) {
		if (e.stage === 0) stage0.set(e.path, e);
		else {
			unmergedPaths.add(e.path);
			if (e.stage === 2) stage2.set(e.path, e);
			else if (e.stage === 3) stage3.set(e.path, e);
		}
	}

	const workTreeDiffs = await diffIndexToWorkTree(gitCtx, index);
	workTreeDiffs.sort((a, b) => comparePaths(a.path, b.path));

	const items: DiffFileResult[] = [];

	for (const diff of workTreeDiffs) {
		if (diff.status === "untracked") continue;
		if (pathFilter && !matchPathspecs(pathFilter, diff.path)) continue;
		if (unmergedPaths.has(diff.path)) continue;

		const indexEntry = stage0.get(diff.path);
		if (!indexEntry) continue;

		const oldMode = fmtMode(indexEntry.mode);
		let newHash: string | undefined;
		if (diff.status === "modified" && gitCtx.workTree) {
			const fullPath = join(gitCtx.workTree, diff.path);
			const bytes = await gitCtx.fs.readFileBuffer(fullPath);
			newHash = await hashObject("blob", bytes);
		}

		items.push({
			path: diff.path,
			status: diff.status === "deleted" ? "D" : "M",
			oldHash: indexEntry.hash,
			newHash,
			oldMode,
			newMode: oldMode,
			newFromWorkTree: diff.status === "modified",
		});
	}

	for (const p of unmergedPaths) {
		if (pathFilter && !matchPathspecs(pathFilter, p)) continue;
		const s2 = stage2.get(p);
		const s3 = stage3.get(p);
		await collectUnmergedItems(items, gitCtx, p, s2, s3);
	}

	items.sort((a, b) => {
		const c = comparePaths(a.path, b.path);
		if (c !== 0) return c;
		if (a.status === "U" && b.status !== "U") return -1;
		if (a.status !== "U" && b.status === "U") return 1;
		return 0;
	});

	return { items };
}

/**
 * Build DiffFileResult entries for a single unmerged path.
 * Emits a "U" entry (with combined-diff data when both stages exist),
 * plus an "M" or "D" entry for the worktree-vs-stage2 delta.
 */
async function collectUnmergedItems(
	items: DiffFileResult[],
	gitCtx: GitContext,
	path: string,
	s2: IndexEntry | undefined,
	s3: IndexEntry | undefined,
): Promise<void> {
	const workTree = gitCtx.workTree;
	if (workTree && s2 && s3) {
		const mode2 = fmtMode(s2.mode);
		const mode3 = fmtMode(s3.mode);
		const { exists: wtExists, hash: wtHash } = await hashWorkTreeFile(gitCtx.fs, workTree, path);

		items.push({
			path,
			status: "U",
			newHash: wtHash,
			newMode: mode2,
			newFromWorkTree: wtExists,
			combinedParentHashes: [s2.hash, s3.hash],
			combinedParentModes: [mode2, mode3],
		});

		appendWorkTreeDelta(items, path, s2.hash, mode2, wtExists, wtHash);
		return;
	}

	items.push({ path, status: "U" });

	if (workTree && s2) {
		const mode = fmtMode(s2.mode);
		const { exists: wtExists, hash: wtHash } = await hashWorkTreeFile(gitCtx.fs, workTree, path);
		appendWorkTreeDelta(items, path, s2.hash, mode, wtExists, wtHash);
	}
}

async function hashWorkTreeFile(
	fs: GitContext["fs"],
	workTree: string,
	relPath: string,
): Promise<{ exists: boolean; hash?: string }> {
	const fullPath = join(workTree, relPath);
	if (!(await fs.exists(fullPath))) return { exists: false };
	const bytes = await readWorktreeContent(fs, fullPath);
	return { exists: true, hash: await hashObject("blob", bytes) };
}

function appendWorkTreeDelta(
	items: DiffFileResult[],
	path: string,
	stageHash: string,
	mode: string,
	wtExists: boolean,
	wtHash: string | undefined,
): void {
	if (wtExists && wtHash && wtHash !== stageHash) {
		items.push({
			path,
			status: "M",
			oldHash: stageHash,
			newHash: wtHash,
			oldMode: mode,
			newMode: mode,
			newFromWorkTree: true,
		});
	} else if (!wtExists) {
		items.push({ path, status: "D", oldHash: stageHash, oldMode: mode });
	}
}

async function collectCached(
	gitCtx: GitContext,
	baseRev: string | null,
	pathFilter: Pathspec[] | null,
): Promise<DiffCollectResult> {
	let baseTreeHash: ObjectId | null = null;
	if (baseRev) {
		const result = await requireCommit(gitCtx, baseRev);
		if (isCommandError(result)) return result;
		baseTreeHash = result.commit.tree;
	} else {
		const headHash = await resolveHead(gitCtx);
		if (headHash) {
			const headCommit = await readCommit(gitCtx, headHash);
			baseTreeHash = headCommit.tree;
		}
	}

	const baseMap = await flattenTreeToMap(gitCtx, baseTreeHash);

	const index = await readIndex(gitCtx);

	const unmergedPaths = new Set<string>();
	for (const entry of index.entries) {
		if (entry.stage > 0) unmergedPaths.add(entry.path);
	}

	const indexMap = new Map(getStage0Entries(index).map((e) => [e.path, e]));

	const diffs: TreeDiffEntry[] = [];

	for (const [path, entry] of indexMap) {
		if (unmergedPaths.has(path)) continue;
		const baseEntry = baseMap.get(path);
		if (!baseEntry) {
			diffs.push({
				path,
				status: "added",
				newHash: entry.hash,
				newMode: fmtMode(entry.mode),
			});
		} else if (baseEntry.hash !== entry.hash) {
			diffs.push({
				path,
				status: "modified",
				oldHash: baseEntry.hash,
				newHash: entry.hash,
				oldMode: baseEntry.mode,
				newMode: fmtMode(entry.mode),
			});
		}
	}

	for (const [path, baseEntry] of baseMap) {
		if (unmergedPaths.has(path)) continue;
		if (!indexMap.has(path)) {
			diffs.push({
				path,
				status: "deleted",
				oldHash: baseEntry.hash,
				oldMode: baseEntry.mode,
			});
		}
	}

	const { remaining, renames } = await detectRenames(gitCtx, diffs);
	const items = renameResultToItems(remaining, renames);

	for (const p of unmergedPaths) {
		items.push({ path: p, status: "U" });
	}

	items.sort((a, b) => comparePaths(a.path, b.path));

	if (pathFilter) {
		return {
			items: items.filter((item) => matchPathspecs(pathFilter, item.path)),
		};
	}

	return { items };
}

async function collectCommitToCommit(
	gitCtx: GitContext,
	rev1: string,
	rev2: string,
	pathFilter: Pathspec[] | null,
): Promise<DiffCollectResult> {
	const result1 = await requireCommit(gitCtx, rev1);
	if (isCommandError(result1)) return result1;

	const result2 = await requireCommit(gitCtx, rev2);
	if (isCommandError(result2)) return result2;

	const diffs = await diffTrees(gitCtx, result1.commit.tree, result2.commit.tree);
	return applyRenameDetectionAndFilter(gitCtx, diffs, pathFilter);
}

async function collectThreeDot(
	gitCtx: GitContext,
	revLeft: string,
	revRight: string,
	pathFilter: Pathspec[] | null,
): Promise<DiffCollectResult> {
	const leftResult = await requireCommit(gitCtx, revLeft);
	if (isCommandError(leftResult)) return leftResult;

	const rightResult = await requireCommit(gitCtx, revRight);
	if (isCommandError(rightResult)) return rightResult;

	const bases = await findAllMergeBases(gitCtx, leftResult.hash, rightResult.hash);
	if (bases.length === 0) {
		return fatal(`${revLeft}...${revRight}: no merge base`);
	}

	let stderr: string | undefined;
	if (bases.length > 1) {
		stderr = `warning: ${revLeft}...${revRight}: multiple merge bases, using ${bases[0]}\n`;
	}

	const baseHash = bases[0] as ObjectId;
	const baseCommit = await readCommit(gitCtx, baseHash);

	const diffs = await diffTrees(gitCtx, baseCommit.tree, rightResult.commit.tree);
	const result = await applyRenameDetectionAndFilter(gitCtx, diffs, pathFilter);
	if (isError(result)) return result;
	if (stderr) result.stderr = stderr;
	return result;
}

async function applyRenameDetectionAndFilter(
	gitCtx: GitContext,
	diffs: TreeDiffEntry[],
	pathFilter: Pathspec[] | null,
): Promise<DiffCollectResult> {
	const { remaining, renames } = await detectRenames(gitCtx, diffs);
	const items = renameResultToItems(remaining, renames);
	items.sort((a, b) => comparePaths(a.path, b.path));

	if (pathFilter) {
		return {
			items: items.filter((item) => matchPathspecs(pathFilter, item.path)),
		};
	}

	return { items };
}

async function collectCommitToWorkTree(
	gitCtx: GitContext,
	rev: string,
	pathFilter: Pathspec[] | null,
): Promise<DiffCollectResult> {
	const workTreeError = requireWorkTree(gitCtx);
	if (workTreeError) return workTreeError;

	const result = await requireCommit(gitCtx, rev);
	if (isCommandError(result)) return result;

	const workTree = gitCtx.workTree as string;
	const commitMap = await flattenTreeToMap(gitCtx, result.commit.tree);
	const index = await readIndex(gitCtx);
	const indexMap = new Map(getStage0Entries(index).map((e) => [e.path, e]));

	const items: DiffFileResult[] = [];

	for (const [path, entry] of commitMap) {
		if (pathFilter && !matchPathspecs(pathFilter, path)) continue;
		const fullPath = join(workTree, path);

		if (!(await gitCtx.fs.exists(fullPath))) {
			items.push({
				path,
				status: "D",
				oldHash: entry.hash,
				oldMode: entry.mode,
			});
			continue;
		}

		const content = await gitCtx.fs.readFileBuffer(fullPath);
		const workTreeHash = await hashObject("blob", content);

		if (workTreeHash !== entry.hash) {
			items.push({
				path,
				status: "M",
				oldHash: entry.hash,
				newHash: workTreeHash,
				oldMode: entry.mode,
				newMode: entry.mode,
				newFromWorkTree: true,
			});
		}
	}

	for (const [path, entry] of indexMap) {
		if (commitMap.has(path)) continue;
		if (pathFilter && !matchPathspecs(pathFilter, path)) continue;
		const fullPath = join(workTree, path);
		if (!(await gitCtx.fs.exists(fullPath))) continue;

		const content = await gitCtx.fs.readFileBuffer(fullPath);
		const newHash = await hashObject("blob", content);

		items.push({
			path,
			status: "A",
			newHash,
			newMode: fmtMode(entry.mode),
			newFromWorkTree: true,
		});
	}

	items.sort((a, b) => comparePaths(a.path, b.path));

	return { items };
}

// ── Format dispatcher ───────────────────────────────────────────────

async function formatOutput(
	gitCtx: GitContext,
	items: DiffFileResult[],
	format: DiffOutputFormat,
): Promise<CommandResult> {
	let stdout: string;
	switch (format) {
		case "stat":
			stdout = await formatAsStat(gitCtx, items);
			break;
		case "shortstat":
			stdout = await formatAsShortstat(gitCtx, items);
			break;
		case "numstat":
			stdout = await formatAsNumstat(gitCtx, items);
			break;
		case "name-only":
			stdout = formatAsNameOnly(items);
			break;
		case "name-status":
			stdout = formatAsNameStatus(items);
			break;
		default:
			stdout = await formatAsUnified(gitCtx, items);
			break;
	}
	return { stdout, stderr: "", exitCode: 0 };
}

// ── Output formatters ───────────────────────────────────────────────

async function formatAsUnified(gitCtx: GitContext, items: DiffFileResult[]): Promise<string> {
	let output = "";
	const combinedDiffPaths = new Set<string>();
	const hashAbbrevs = await buildRepoAwareDiffHashAbbrevs(gitCtx, items);

	// Pass 1: combined diffs for unmerged paths (real git outputs these first)
	for (const item of items) {
		if (item.status !== "U") continue;
		if (item.combinedParentHashes) {
			const parentContents = await Promise.all(
				item.combinedParentHashes.map(async (h) => (h ? await readBlobContent(gitCtx, h) : "")),
			);
			const newContent = await readNewContentStr(gitCtx, item);

			const hasBinary = parentContents.some((c) => isBinaryStr(c)) || isBinaryStr(newContent);
			if (hasBinary) {
				const parentHashAbbrevs = item.combinedParentHashes.map((h) =>
					h ? abbreviateHash(h) : "0000000",
				);
				output +=
					`diff --cc ${item.path}\n` +
					`index ${parentHashAbbrevs.join(",")}..${"0000000"}\n` +
					`Binary files differ\n`;
				combinedDiffPaths.add(item.path);
			} else {
				const cc = formatCombinedDiffEntry({
					path: item.path,
					parentHashes: item.combinedParentHashes,
					parentModes: item.combinedParentModes ?? [],
					parentContents,
					resultHash: null,
					resultMode: item.newMode ?? null,
					resultContent: newContent,
				});
				if (cc) {
					output += cc;
					combinedDiffPaths.add(item.path);
				} else {
					output += `* Unmerged path ${item.path}\n`;
				}
			}
		} else {
			output += `* Unmerged path ${item.path}\n`;
		}
	}

	// Pass 2: regular diffs — skip unmerged entries and worktree-vs-stage2
	// diffs whose path already got a combined diff above.
	for (const item of items) {
		if (item.status === "U") continue;
		if (combinedDiffPaths.has(item.path)) continue;

		const oldContent = item.oldHash ? await readBlobContent(gitCtx, item.oldHash) : "";
		const newContent = await readNewContentStr(gitCtx, item);

		if (item.status === "R" && item.oldPath) {
			output += formatUnifiedDiff({
				path: item.oldPath,
				oldContent,
				newContent,
				oldMode: item.oldMode,
				newMode: item.newMode,
				oldHash: abbreviateDiffHash(item.oldHash, hashAbbrevs),
				newHash: abbreviateDiffHash(item.newHash, hashAbbrevs),
				renameTo: item.path,
				similarity: item.similarity,
			});
		} else {
			output += formatUnifiedDiff({
				path: item.path,
				oldContent,
				newContent,
				oldMode: item.oldMode,
				newMode: item.newMode,
				oldHash: abbreviateDiffHash(item.oldHash, hashAbbrevs),
				newHash: abbreviateDiffHash(item.newHash, hashAbbrevs),
				isNew: item.status === "A",
				isDeleted: item.status === "D",
			});
		}
	}
	return output;
}

async function buildRepoAwareDiffHashAbbrevs(
	gitCtx: GitContext,
	items: DiffFileResult[],
): Promise<Map<string, string>> {
	const hashes = new Set<string>();
	for (const item of items) {
		if (item.oldHash && item.oldHash.length === 40) hashes.add(item.oldHash);
		if (item.newHash && item.newHash.length === 40) hashes.add(item.newHash);
	}
	const fanoutCache = new Map<string, string[]>();
	const readFanout = async (fanout: string): Promise<string[]> => {
		const cached = fanoutCache.get(fanout);
		if (cached) return cached;
		const dir = join(gitCtx.gitDir, "objects", fanout);
		const entries = (await gitCtx.fs.exists(dir)) ? await gitCtx.fs.readdir(dir) : [];
		fanoutCache.set(fanout, entries);
		return entries;
	};
	const isUniqueAt = async (hash: string, len: number): Promise<boolean> => {
		const fanout = hash.slice(0, 2);
		const restPrefix = hash.slice(2, len);
		const entries = await readFanout(fanout);
		let matches = 0;
		for (const entry of entries) {
			if (entry.startsWith(restPrefix)) {
				matches++;
				if (matches > 1) return false;
			}
		}
		return matches === 1;
	};

	const out = new Map<string, string>();
	for (const hash of hashes) {
		let len = 7;
		while (len < 40) {
			if (await isUniqueAt(hash, len)) break;
			len++;
		}
		out.set(hash, hash.slice(0, len));
	}
	return out;
}

function abbreviateDiffHash(
	hash: string | undefined,
	abbrevs: Map<string, string>,
): string | undefined {
	if (!hash) return undefined;
	if (hash.length !== 40) return hash;
	return abbrevs.get(hash) ?? abbreviateHash(hash);
}

function formatAsNameOnly(items: DiffFileResult[]): string {
	let output = "";
	for (const item of items) {
		output += `${item.path}\n`;
	}
	return output;
}

function formatAsNameStatus(items: DiffFileResult[]): string {
	let output = "";
	for (const item of items) {
		if (item.status === "R") {
			const score = String(item.similarity ?? 100).padStart(3, "0");
			output += `R${score}\t${item.oldPath}\t${item.path}\n`;
		} else {
			output += `${item.status}\t${item.path}\n`;
		}
	}
	return output;
}

async function formatAsNumstat(gitCtx: GitContext, items: DiffFileResult[]): Promise<string> {
	let output = "";
	for (const item of items) {
		if (item.status === "U") {
			output += `0\t0\t${item.path}\n`;
			continue;
		}

		const oldContent = item.oldHash ? await readBlobContent(gitCtx, item.oldHash) : "";
		const newContent = await readNewContentStr(gitCtx, item);

		const binary = isBinaryStr(oldContent) || isBinaryStr(newContent);
		let insStr: string;
		let delStr: string;
		if (binary) {
			insStr = "-";
			delStr = "-";
		} else {
			const { ins, del } = countInsertionsDeletions(oldContent, newContent);
			insStr = String(ins);
			delStr = String(del);
		}

		if (item.status === "R" && item.oldPath) {
			const display = formatRenamePath(item.oldPath, item.path);
			output += `${insStr}\t${delStr}\t${display}\n`;
		} else {
			output += `${insStr}\t${delStr}\t${item.path}\n`;
		}
	}
	return output;
}

async function formatAsStat(gitCtx: GitContext, items: DiffFileResult[]): Promise<string> {
	const fileStats = await buildFileStats(gitCtx, items);
	return renderStatLines(fileStats);
}

async function formatAsShortstat(gitCtx: GitContext, items: DiffFileResult[]): Promise<string> {
	const fileStats = await buildFileStats(gitCtx, items);
	if (fileStats.length === 0) return "";

	let totalIns = 0;
	let totalDel = 0;
	let changedFiles = 0;
	for (const stat of fileStats) {
		if (stat.isUnmerged) continue;
		changedFiles++;
		totalIns += stat.insertions;
		totalDel += stat.deletions;
	}

	const shortstat = formatShortstatParts(changedFiles, totalIns, totalDel);
	if (shortstat) return `${shortstat}\n`;
	if (fileStats.some((f) => f.isUnmerged)) return " 0 files changed\n";
	return "";
}

// ── Helpers ─────────────────────────────────────────────────────────

async function readNewContentStr(gitCtx: GitContext, item: DiffFileResult): Promise<string> {
	if (!item.newHash) return "";
	if (item.newFromWorkTree && gitCtx.workTree) {
		const fullPath = join(gitCtx.workTree, item.path);
		const bytes = await readWorktreeContent(gitCtx.fs, fullPath);
		return decoder.decode(bytes);
	}
	return readBlobContent(gitCtx, item.newHash);
}

async function readNewContentBytes(gitCtx: GitContext, item: DiffFileResult): Promise<Uint8Array> {
	if (!item.newHash) return new Uint8Array(0);
	if (item.newFromWorkTree && gitCtx.workTree) {
		const fullPath = join(gitCtx.workTree, item.path);
		return readWorktreeContent(gitCtx.fs, fullPath);
	}
	return readBlobBytes(gitCtx, item.newHash);
}

function countInsertionsDeletions(
	oldContent: string,
	newContent: string,
): { ins: number; del: number } {
	const oldLines = splitLinesWithNL(oldContent);
	const newLines = splitLinesWithNL(newContent);
	const edits = myersDiff(oldLines, newLines);
	let ins = 0;
	let del = 0;
	for (const edit of edits) {
		if (edit.type === "insert") ins++;
		else if (edit.type === "delete") del++;
	}
	return { ins, del };
}

async function buildFileStats(gitCtx: GitContext, items: DiffFileResult[]): Promise<FileStat[]> {
	const stats: FileStat[] = [];
	for (const item of items) {
		if (item.status === "U") {
			stats.push({
				path: item.path,
				sortKey: item.path,
				insertions: 0,
				deletions: 0,
				isUnmerged: true,
			});
			continue;
		}

		const displayPath =
			item.status === "R" && item.oldPath ? formatRenamePath(item.oldPath, item.path) : item.path;

		const oldBytes = item.oldHash ? await readBlobBytes(gitCtx, item.oldHash) : new Uint8Array(0);
		const newBytes = await readNewContentBytes(gitCtx, item);

		if (isBinaryBytes(oldBytes) || isBinaryBytes(newBytes)) {
			stats.push({
				path: displayPath,
				sortKey: item.path,
				insertions: 0,
				deletions: 0,
				isBinary: true,
				oldSize: oldBytes.byteLength,
				newSize: newBytes.byteLength,
			});
		} else {
			const oldContent = decoder.decode(oldBytes);
			const newContent = decoder.decode(newBytes);
			const { ins, del } = countInsertionsDeletions(oldContent, newContent);
			stats.push({
				path: displayPath,
				sortKey: item.path,
				insertions: ins,
				deletions: del,
			});
		}
	}
	return stats;
}
