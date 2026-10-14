import type { GitExtensions } from "../git.ts";
import { formatCombinedDiffEntry } from "../lib/combined-diff.ts";
import {
	buildAbbrevResolver,
	fatal,
	getCwdPrefix,
	isCommandError,
	quietFlag,
	requireCommit,
	requireGitContext,
	requireHead,
	requireRevision,
} from "../lib/command-utils.ts";
import {
	computeDiffStats,
	formatShortstatParts,
	formatSummaryLines,
	renderStatLines,
	withSummary,
} from "../lib/commit-summary.ts";
import { formatDate } from "../lib/date.ts";
import { formatUnifiedDiff, myersDiff, splitLinesWithNL } from "../lib/diff-algorithm.ts";
import {
	expandFormat,
	type FormatContext,
	formatPreset,
	parseFormatArg,
} from "../lib/log-format.ts";
import { isBinaryStr, readBlobContent, readCommit, readObject, readTag } from "../lib/object-db.ts";
import {
	detectRenames,
	formatRenameLimitWarning,
	formatRenamePath,
	type RenamePair,
	resolveRenameLimit,
} from "../lib/rename-detection.ts";
import { parseRevPath } from "../lib/rev-parse.ts";
import { parseTree } from "../lib/objects/tree.ts";
import { join } from "../lib/path.ts";
import { matchPathspecs, type Pathspec, parsePathspec } from "../lib/pathspec.ts";
import { isTypeChange } from "../lib/symlink.ts";
import { diffTrees, flattenTreeToMap } from "../lib/tree-ops.ts";
import type {
	Commit,
	GitContext,
	GitRepo,
	ObjectId,
	Tag,
	Tree,
	TreeDiffEntry,
} from "../lib/types.ts";
import { a, type Command, f, o } from "../parse/index.ts";

const decoder = new TextDecoder();

const QUIET_NAME_CONFLICT =
	"options '--name-only', '--name-status', '--check', and '-s' cannot be used together";

/** The diff a commit is shown with: a main format and/or the --summary lines. */
interface ShowDiffOutput {
	format: ShowDiffFormat;
	summary: boolean;
}

type ShowDiffFormat =
	| "patch"
	| "stat"
	| "name-only"
	| "name-status"
	| "shortstat"
	| "numstat"
	| null;

export function registerShowCommand(parent: Command, ext?: GitExtensions) {
	parent.command("show", {
		description: "Show various types of objects",
		args: [a.string().name("object").variadic().optional()],
		options: {
			patch: f().alias("p").describe("Show diff in patch format"),
			noPatch: f().describe("Suppress diff output"),
			quiet: quietFlag("suppress diff output"),
			stat: f().describe("Show diffstat summary"),
			nameOnly: f().describe("Show only names of changed files"),
			nameStatus: f().describe("Show names and status of changed files"),
			shortstat: f().describe("Show only the shortstat summary line"),
			numstat: f().describe("Machine-readable insertions/deletions per file"),
			summary: f().describe("Show creations, deletions, renames and mode changes"),
			format: o.string().describe("Pretty-print format string"),
			pretty: o.string().describe("Pretty-print format or preset name"),
		},
		handler: async (args, ctx, meta) => {
			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;
			const gitCtx = gitCtxOrError;

			// Paths after `--` limit the diff, and a commit that doesn't touch
			// them is not shown at all.
			const cwdPrefix = getCwdPrefix(gitCtx, ctx.cwd);
			const pathSpecs =
				meta.passthrough.length > 0
					? meta.passthrough.map((p) => parsePathspec(p, cwdPrefix))
					: null;

			const objectArgs = args.object;
			const rev = objectArgs[0] ?? "HEAD";

			// -q adds git's NO_OUTPUT diff format, which conflicts with these.
			const quietConflict = args.quiet && (args.nameOnly || args.nameStatus);

			// ── Handle <rev>:<path> syntax ─────────────────────────
			const revPath = parseRevPath(rev);
			if (revPath) {
				return handleRevPath(gitCtx, revPath.rev, revPath.path, quietConflict);
			}

			// For HEAD default, check if there are commits
			if (rev === "HEAD") {
				const headHash = await requireHead(gitCtx);
				if (isCommandError(headHash)) return headHash;
			}

			const hash = await requireRevision(gitCtx, rev, `bad object '${rev}'`);
			if (isCommandError(hash)) return hash;
			if (quietConflict) return fatal(QUIET_NAME_CONFLICT);

			const raw = await readObject(gitCtx, hash);
			const renameState: RenameWarningState = {
				limit: await resolveRenameLimit(gitCtx, "diff"),
			};

			// Determine diff output format
			let diffFormat: ShowDiffFormat;
			if (args.noPatch) {
				diffFormat = null;
			} else if (args.stat) {
				diffFormat = "stat";
			} else if (args.nameOnly) {
				diffFormat = "name-only";
			} else if (args.nameStatus) {
				diffFormat = "name-status";
			} else if (args.shortstat) {
				diffFormat = "shortstat";
			} else if (args.numstat) {
				diffFormat = "numstat";
			} else if ((args.quiet || args.summary) && !args.patch) {
				diffFormat = null;
			} else {
				diffFormat = "patch";
			}
			// Git drops --summary when a name format or --no-patch is in effect.
			const summary =
				args.summary && !args.noPatch && diffFormat !== "name-only" && diffFormat !== "name-status";
			const diffOutput: ShowDiffOutput | null =
				diffFormat || summary ? { format: diffFormat, summary } : null;

			// Determine header format
			const formatRaw = args.format ?? args.pretty;
			let customFormat: string | null = null;
			let presetName: string | null = null;
			if (formatRaw !== undefined) {
				const parsed = parseFormatArg(formatRaw);
				customFormat = parsed.formatStr;
				presetName = parsed.preset;
			}

			switch (raw.type) {
				case "commit": {
					const commit = await readCommit(gitCtx, hash);
					const output = await formatCommitShow(
						gitCtx,
						hash,
						commit,
						renameState,
						diffOutput,
						customFormat,
						presetName,
						pathSpecs,
					);
					return {
						stdout: output,
						stderr: formatRenameLimitWarning("diff", renameState.needed),
						exitCode: 0,
					};
				}
				case "tag": {
					const tag = await readTag(gitCtx, hash);
					const output = await formatTagShow(
						gitCtx,
						tag,
						renameState,
						diffOutput,
						customFormat,
						presetName,
						pathSpecs,
					);
					return {
						stdout: output,
						stderr: formatRenameLimitWarning("diff", renameState.needed),
						exitCode: 0,
					};
				}
				case "tree": {
					const tree: Tree = parseTree(raw.content);
					const output = formatTreeShow(tree);
					return { stdout: output, stderr: "", exitCode: 0 };
				}
				case "blob": {
					const content = decoder.decode(raw.content);
					return { stdout: content, stderr: "", exitCode: 0 };
				}
			}
		},
	});
}

// ── rev:path handling ───────────────────────────────────────────────

async function handleRevPath(
	ctx: GitContext,
	rev: string,
	path: string,
	quietConflict: boolean,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const result = await requireCommit(ctx, rev);
	if (isCommandError(result)) return result;
	const treeHash = result.commit.tree;

	const normalizedPath = path.replace(/^\//, "");

	const treeMap = await flattenTreeToMap(ctx, treeHash);
	const entry = treeMap.get(normalizedPath);
	if (!entry) {
		let msg = `path '${normalizedPath}' does not exist in '${rev}'`;
		if (ctx.workTree) {
			const diskPath = join(ctx.workTree, normalizedPath);
			if (await ctx.fs.exists(diskPath)) {
				msg = `path '${normalizedPath}' exists on disk, but not in '${rev}'`;
			}
		}
		return fatal(msg);
	}
	if (quietConflict) return fatal(QUIET_NAME_CONFLICT);

	const raw = await readObject(ctx, entry.hash);
	if (raw.type === "blob") {
		return { stdout: decoder.decode(raw.content), stderr: "", exitCode: 0 };
	}
	if (raw.type === "tree") {
		const tree: Tree = parseTree(raw.content);
		const output = formatTreeShow(tree);
		return { stdout: output, stderr: "", exitCode: 0 };
	}

	return { stdout: decoder.decode(raw.content), stderr: "", exitCode: 0 };
}

// ── Commit display ──────────────────────────────────────────────────

interface RenameWarningState {
	limit: number;
	needed?: number;
}

async function formatCommitShow(
	ctx: GitRepo,
	hash: ObjectId,
	commit: Commit,
	renameState: RenameWarningState,
	diffOutput: ShowDiffOutput | null,
	customFormat: string | null = null,
	presetName: string | null = null,
	pathSpecs: Pathspec[] | null = null,
): Promise<string> {
	if (pathSpecs && !(await commitTouchesPaths(ctx, commit, pathSpecs))) return "";

	// ── Header ──────────────────────────────────────────────────
	const abbrev = await buildAbbrevResolver(ctx, [hash, commit.tree, ...commit.parents]);
	let header: string;
	if (customFormat !== null) {
		const fctx: FormatContext = { hash, commit, abbrev };
		header = expandFormat(customFormat, fctx);
	} else if (presetName !== null) {
		const fctx: FormatContext = { hash, commit, abbrev };
		header = formatPreset(presetName, fctx, true, false);
	} else {
		const lines: string[] = [];
		lines.push(`commit ${hash}`);
		if (commit.parents.length >= 2) {
			const abbrevParents = commit.parents.map((p) => abbrev(p)).join(" ");
			lines.push(`Merge: ${abbrevParents}`);
		}
		lines.push(`Author: ${commit.author.name} <${commit.author.email}>`);
		lines.push(`Date:   ${formatDate(commit.author.timestamp, commit.author.timezone)}`);
		lines.push("");
		const msg = commit.message.replace(/\n$/, "");
		for (const msgLine of msg.split("\n")) {
			lines.push(`    ${msgLine}`);
		}
		header = lines.join("\n");
	}

	if (!diffOutput) {
		return `${header}\n`;
	}

	// ── Diff ────────────────────────────────────────────────────
	let body = "";
	let hasChanges = false;
	if (commit.parents.length <= 1) {
		const parentTree =
			commit.parents.length === 1
				? (await readCommit(ctx, commit.parents[0] as ObjectId)).tree
				: null;
		const { diffs, renames } = await diffWithRenames(
			ctx,
			parentTree,
			commit.tree,
			renameState,
			pathSpecs,
		);
		hasChanges = diffs.length > 0 || renames.length > 0;
		body = await formatShowDiff(ctx, diffs, renames, diffOutput);
	} else {
		body = await formatMergeShowDiff(ctx, commit, renameState, diffOutput, pathSpecs);
	}

	if (body) {
		return `${header}\n\n${body.replace(/\n$/, "")}\n`;
	}
	// Git still prints the separator line when a commit has changes but the
	// requested output is empty, e.g. --summary on a content-only change.
	if (hasChanges || commit.parents.length >= 2) {
		return `${header}\n\n`;
	}
	return `${header}\n`;
}

/**
 * Whether a commit is shown for a pathspec: git prunes a commit that is
 * TREESAME to any parent (or, for a root commit, adds nothing) in those paths.
 */
async function commitTouchesPaths(
	ctx: GitRepo,
	commit: Commit,
	pathSpecs: Pathspec[],
): Promise<boolean> {
	const parentTrees =
		commit.parents.length === 0
			? [null]
			: await Promise.all(commit.parents.map(async (p) => (await readCommit(ctx, p)).tree));
	for (const parentTree of parentTrees) {
		const diffs = await diffTrees(ctx, parentTree, commit.tree);
		if (!diffs.some((d) => matchPathspecs(pathSpecs, d.path))) return false;
	}
	return true;
}

async function diffWithRenames(
	ctx: GitRepo,
	parentTree: ObjectId | null,
	tree: ObjectId,
	renameState: RenameWarningState,
	pathSpecs: Pathspec[] | null,
): Promise<{ diffs: TreeDiffEntry[]; renames: RenamePair[] }> {
	// Like git, the pathspec limits the diff before rename detection.
	let rawDiffs = await diffTrees(ctx, parentTree, tree);
	if (pathSpecs) rawDiffs = rawDiffs.filter((d) => matchPathspecs(pathSpecs, d.path));
	const { remaining, renames, neededRenameLimit } = await detectRenames(ctx, rawDiffs, {
		limit: renameState.limit,
	});
	renameState.needed = Math.max(renameState.needed ?? 0, neededRenameLimit ?? 0) || undefined;
	return { diffs: remaining, renames };
}

/**
 * Git shows a merge's patch as a combined diff, but its stat formats and
 * --summary compare the merge with its first parent. The name formats
 * print nothing here.
 */
async function formatMergeShowDiff(
	ctx: GitRepo,
	commit: Commit,
	renameState: RenameWarningState,
	output: ShowDiffOutput,
	pathSpecs: Pathspec[] | null,
): Promise<string> {
	const statFormat =
		output.format === "stat" || output.format === "shortstat" || output.format === "numstat"
			? output.format
			: null;
	let firstParent = "";
	if (statFormat || output.summary) {
		const parentTree = (await readCommit(ctx, commit.parents[0] as ObjectId)).tree;
		const { diffs, renames } = await diffWithRenames(
			ctx,
			parentTree,
			commit.tree,
			renameState,
			pathSpecs,
		);
		firstParent = await formatShowDiff(ctx, diffs, renames, {
			format: statFormat,
			summary: output.summary,
		});
	}
	const combined =
		output.format === "patch" ? await formatCombinedDiff(ctx, commit, pathSpecs) : "";
	return withSummary(combined, firstParent, combined !== "");
}

// ── Tag display ─────────────────────────────────────────────────────

async function formatTagShow(
	ctx: GitRepo,
	tag: Tag,
	renameState: RenameWarningState,
	diffOutput: ShowDiffOutput | null,
	customFormat: string | null = null,
	presetName: string | null = null,
	pathSpecs: Pathspec[] | null = null,
): Promise<string> {
	const lines: string[] = [];

	lines.push(`tag ${tag.name}`);
	lines.push(`Tagger: ${tag.tagger.name} <${tag.tagger.email}>`);
	lines.push(`Date:   ${formatDate(tag.tagger.timestamp, tag.tagger.timezone)}`);
	lines.push("");
	const msg = tag.message.replace(/\n$/, "");
	for (const msgLine of msg.split("\n")) {
		lines.push(`    ${msgLine}`);
	}

	if (tag.objectType === "commit") {
		const commit = await readCommit(ctx, tag.object);
		const commitOutput = await formatCommitShow(
			ctx,
			tag.object,
			commit,
			renameState,
			diffOutput,
			customFormat,
			presetName,
			pathSpecs,
		);
		if (commitOutput) {
			lines.push("");
			lines.push(commitOutput.replace(/\n$/, ""));
		}
	}

	return `${lines.join("\n")}\n`;
}

// ── Tree display ────────────────────────────────────────────────────

function formatTreeShow(tree: Tree): string {
	const lines: string[] = [];
	for (const entry of tree.entries) {
		const type = entry.mode === "040000" ? "tree" : "blob";
		lines.push(`${entry.mode} ${type} ${entry.hash}\t${entry.name}`);
	}
	return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

// ── Diff format dispatch ────────────────────────────────────────────

async function formatShowDiff(
	ctx: GitRepo,
	diffs: TreeDiffEntry[],
	renames: RenamePair[],
	output: ShowDiffOutput,
): Promise<string> {
	const main = await formatShowDiffFormat(ctx, diffs, renames, output.format);
	if (!output.summary) return main;
	return withSummary(main, formatSummaryLines(diffs, renames), output.format === "patch");
}

async function formatShowDiffFormat(
	ctx: GitRepo,
	diffs: TreeDiffEntry[],
	renames: RenamePair[],
	format: ShowDiffFormat,
): Promise<string> {
	switch (format) {
		case "patch":
			return formatDiffsWithRenames(ctx, diffs, renames);
		case "stat":
			return showStat(ctx, diffs, renames);
		case "shortstat":
			return showShortstat(ctx, diffs, renames);
		case "numstat":
			return showNumstat(ctx, diffs, renames);
		case "name-only":
			return showNameOnly(diffs, renames);
		case "name-status":
			return showNameStatus(diffs, renames);
		default:
			return "";
	}
}

function showNameOnly(diffs: TreeDiffEntry[], renames: RenamePair[]): string {
	const paths: string[] = [];
	for (const d of diffs) paths.push(d.path);
	for (const r of renames) paths.push(r.newPath);
	paths.sort();
	return paths.length > 0 ? `${paths.join("\n")}\n` : "";
}

function showNameStatus(diffs: TreeDiffEntry[], renames: RenamePair[]): string {
	const items: { key: string; line: string }[] = [];
	for (const d of diffs) {
		const s =
			d.status === "added"
				? "A"
				: d.status === "deleted"
					? "D"
					: isTypeChange(d.oldMode, d.newMode)
						? "T"
						: "M";
		items.push({ key: d.path, line: `${s}\t${d.path}` });
	}
	for (const r of renames) {
		const score = String(r.similarity ?? 100).padStart(3, "0");
		items.push({ key: r.newPath, line: `R${score}\t${r.oldPath}\t${r.newPath}` });
	}
	items.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
	return items.length > 0 ? items.map((i) => `${i.line}\n`).join("") : "";
}

async function showStat(
	ctx: GitRepo,
	diffs: TreeDiffEntry[],
	renames: RenamePair[],
): Promise<string> {
	const fileStats = await computeDiffStats(ctx, diffs, renames);
	fileStats.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
	return renderStatLines(fileStats);
}

async function showShortstat(
	ctx: GitRepo,
	diffs: TreeDiffEntry[],
	renames: RenamePair[],
): Promise<string> {
	const fileStats = await computeDiffStats(ctx, diffs, renames);
	let totalIns = 0;
	let totalDel = 0;
	for (const s of fileStats) {
		totalIns += s.insertions;
		totalDel += s.deletions;
	}
	const line = formatShortstatParts(fileStats.length, totalIns, totalDel);
	return line ? `${line}\n` : "";
}

async function showNumstat(
	ctx: GitRepo,
	diffs: TreeDiffEntry[],
	renames: RenamePair[],
): Promise<string> {
	const items: { key: string; oldHash?: string; newHash?: string; display: string }[] = [];
	for (const d of diffs) {
		items.push({ key: d.path, oldHash: d.oldHash, newHash: d.newHash, display: d.path });
	}
	for (const r of renames) {
		items.push({
			key: r.newPath,
			oldHash: r.oldHash,
			newHash: r.newHash,
			display: formatRenamePath(r.oldPath, r.newPath),
		});
	}
	items.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

	let out = "";
	for (const item of items) {
		const oldContent = item.oldHash ? await readBlobContent(ctx, item.oldHash) : "";
		const newContent = item.newHash ? await readBlobContent(ctx, item.newHash) : "";
		if (isBinaryStr(oldContent) || isBinaryStr(newContent)) {
			out += `-\t-\t${item.display}\n`;
		} else {
			const oldLines = splitLinesWithNL(oldContent);
			const newLines = splitLinesWithNL(newContent);
			const edits = myersDiff(oldLines, newLines);
			let ins = 0;
			let del = 0;
			for (const edit of edits) {
				if (edit.type === "insert") ins++;
				else if (edit.type === "delete") del++;
			}
			out += `${ins}\t${del}\t${item.display}\n`;
		}
	}
	return out;
}

// ── Patch formatting helpers ────────────────────────────────────────

async function formatTreeDiff(ctx: GitRepo, diff: TreeDiffEntry): Promise<string> {
	const oldContent = diff.oldHash ? await readBlobContent(ctx, diff.oldHash) : "";
	const newContent = diff.newHash ? await readBlobContent(ctx, diff.newHash) : "";

	return formatUnifiedDiff({
		path: diff.path,
		oldContent,
		newContent,
		oldMode: diff.oldMode,
		newMode: diff.newMode,
		oldHash: diff.oldHash,
		newHash: diff.newHash,
	});
}

async function formatRenameDiff(ctx: GitRepo, rename: RenamePair): Promise<string> {
	const oldContent = rename.oldHash ? await readBlobContent(ctx, rename.oldHash) : "";
	const newContent = rename.newHash ? await readBlobContent(ctx, rename.newHash) : "";

	return formatUnifiedDiff({
		path: rename.oldPath,
		oldContent,
		newContent,
		oldMode: rename.oldMode,
		newMode: rename.newMode,
		oldHash: rename.oldHash,
		newHash: rename.newHash,
		renameTo: rename.newPath,
		similarity: rename.similarity,
	});
}

async function formatDiffsWithRenames(
	ctx: GitRepo,
	diffs: TreeDiffEntry[],
	renames: RenamePair[],
): Promise<string> {
	// Combine remaining diffs and renames, sorted by path
	type DiffItem = { type: "diff"; entry: TreeDiffEntry } | { type: "rename"; entry: RenamePair };
	const allItems: DiffItem[] = [];
	for (const d of diffs) allItems.push({ type: "diff", entry: d });
	for (const r of renames) allItems.push({ type: "rename", entry: r });
	allItems.sort((a, b) => {
		const pathA = a.type === "diff" ? a.entry.path : a.entry.newPath;
		const pathB = b.type === "diff" ? b.entry.path : b.entry.newPath;
		return pathA < pathB ? -1 : pathA > pathB ? 1 : 0;
	});

	let output = "";
	for (const item of allItems) {
		if (item.type === "rename") {
			output += await formatRenameDiff(ctx, item.entry);
		} else {
			output += await formatTreeDiff(ctx, item.entry);
		}
	}
	return output;
}

// ── Combined diff for merge commits ─────────────────────────────────

interface FlatEntry {
	path: string;
	mode: string;
	hash: string;
}

async function formatCombinedDiff(
	ctx: GitRepo,
	commit: Commit,
	pathSpecs: Pathspec[] | null,
): Promise<string> {
	if (commit.parents.length < 2) return "";

	// Get flat tree entries for each parent and the result
	const parentMaps = await Promise.all(
		commit.parents.map(async (p) => {
			const c = await readCommit(ctx, p as ObjectId);
			return flattenTreeToMap(ctx, c.tree);
		}),
	);
	const resultMap = await flattenTreeToMap(ctx, commit.tree);

	// Collect all paths from all parents and result
	const allPaths = new Set<string>();
	for (const m of parentMaps) for (const p of m.keys()) allPaths.add(p);
	for (const p of resultMap.keys()) allPaths.add(p);

	// Find "interesting" paths: those where the result differs from ALL parents
	const interestingPaths: string[] = [];
	for (const path of allPaths) {
		if (pathSpecs && !matchPathspecs(pathSpecs, path)) continue;
		const resultEntry = resultMap.get(path);
		const resultHash = resultEntry?.hash ?? null;
		const differsFromAll = parentMaps.every((pm) => {
			const pe = pm.get(path);
			return (pe?.hash ?? null) !== resultHash;
		});
		if (differsFromAll) {
			interestingPaths.push(path);
		}
	}
	interestingPaths.sort();

	if (interestingPaths.length === 0) return "";

	let output = "";
	for (const path of interestingPaths) {
		output += await formatCombinedEntry(ctx, path, parentMaps, resultMap);
	}
	return output;
}

async function formatCombinedEntry(
	ctx: GitRepo,
	path: string,
	parentMaps: Map<string, FlatEntry>[],
	resultMap: Map<string, FlatEntry>,
): Promise<string> {
	const resultEntry = resultMap.get(path);
	const parentEntries = parentMaps.map((pm) => pm.get(path) ?? null);

	const resultHash = resultEntry?.hash ?? null;
	const resultMode = resultEntry?.mode ?? null;
	const parentHashes = parentEntries.map((e) => e?.hash ?? null);
	const parentModes = parentEntries.map((e) => e?.mode ?? null);

	const parentContents = await Promise.all(
		parentHashes.map(async (h) => (h ? await readBlobContent(ctx, h) : "")),
	);
	const resultContent = resultHash ? await readBlobContent(ctx, resultHash) : "";

	return formatCombinedDiffEntry({
		path,
		parentHashes,
		parentModes,
		parentContents,
		resultHash,
		resultMode,
		resultContent,
	});
}
