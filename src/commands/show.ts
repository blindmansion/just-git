import type { GitExtensions } from "../git.ts";
import { formatCombinedDiffEntry } from "../lib/combined-diff.ts";
import {
	ambiguousArgError,
	buildAbbrevResolver,
	type CommandResult,
	fatal,
	getCwdPrefix,
	isCommandError,
	quietFlag,
	requireCommit,
	requireGitContext,
	requireHead,
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
import { parseRevPath, resolveRevision, resolveRevPath } from "../lib/rev-parse.ts";
import { parseTree } from "../lib/objects/tree.ts";
import { join } from "../lib/path.ts";
import { matchPathspecs, type Pathspec, parsePathspec } from "../lib/pathspec.ts";
import { isTypeChange } from "../lib/symlink.ts";
import { diffTrees, flattenTreeToMap } from "../lib/tree-ops.ts";
import {
	type Commit,
	FileMode,
	type GitContext,
	type GitRepo,
	type ObjectId,
	type Tag,
	type Tree,
	type TreeDiffEntry,
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

			const cwdPrefix = getCwdPrefix(gitCtx, ctx.cwd);
			const dashDash = meta.passthrough.length > 0;

			// Like git, every name is resolved before anything is shown, so a
			// bad one fails the whole command. Without `--`, the first name
			// that isn't an object starts the paths, which must all exist.
			const objectArgs = args.object;
			const targets: ShowTarget[] = [];
			const pathArgs = [...meta.passthrough];
			for (let i = 0; i < objectArgs.length; i++) {
				const name = objectArgs[i]!;
				const resolved = await resolveShowObject(gitCtx, name, cwdPrefix);
				if (resolved === null) {
					if (dashDash) return fatal(`bad revision '${name}'`);
					if (!(await existsInWorkTree(gitCtx, ctx.cwd, name))) return ambiguousArgError(name);
					for (const path of objectArgs.slice(i + 1)) {
						if (!(await existsInWorkTree(gitCtx, ctx.cwd, path))) {
							return fatal(
								`${path}: no such path in the working tree.\n` +
									"Use 'git <command> -- <path>...' to specify paths that do not exist locally.",
							);
						}
					}
					pathArgs.push(...objectArgs.slice(i));
					break;
				}
				if (isCommandError(resolved)) return resolved;
				targets.push({ name, hash: resolved });
			}
			if (targets.length === 0) {
				const headHash = await requireHead(gitCtx);
				if (isCommandError(headHash)) return headHash;
				targets.push({ name: "HEAD", hash: headHash });
			}

			// -q adds git's NO_OUTPUT diff format, which conflicts with these.
			if (args.quiet && (args.nameOnly || args.nameStatus)) return fatal(QUIET_NAME_CONFLICT);

			// Paths limit the diff. Since git 2.55 a commit that doesn't touch
			// them is still shown, with just its header.
			const pathSpecs =
				pathArgs.length > 0 ? pathArgs.map((p) => parsePathspec(p, cwdPrefix)) : null;

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

			const state: ShowState = {
				renameState: { limit: await resolveRenameLimit(gitCtx, "diff") },
				diffOutput,
				customFormat,
				presetName,
				// `format:` separates commits instead of terminating each one.
				useTerminator:
					presetName === "oneline" || (customFormat !== null && !formatRaw?.startsWith("format:")),
				pathSpecs,
				shownOne: false,
				shownCommits: new Set(),
			};
			let stdout = "";
			for (const target of targets) {
				stdout += await showObject(gitCtx, target.name, target.hash, state);
			}
			return {
				stdout,
				stderr: formatRenameLimitWarning("diff", state.renameState.needed),
				exitCode: 0,
			};
		},
	});
}

// ── Object resolution ───────────────────────────────────────────────

interface ShowTarget {
	/** The name as given, which git prints for trees and tags. */
	name: string;
	hash: ObjectId;
}

/**
 * Resolve one `git show` argument to an object. Returns null when the name
 * isn't an object at all (so it may be a path), or an error for a name git
 * rejects outright.
 */
async function resolveShowObject(
	ctx: GitContext,
	name: string,
	cwdPrefix: string,
): Promise<ObjectId | CommandResult | null> {
	const revPath = parseRevPath(name);
	if (revPath) {
		const target = await resolveRevPath(ctx, name, cwdPrefix);
		if (target && "hash" in target) return target.hash;
		return revPathError(ctx, revPath.rev, revPath.path);
	}
	if (name === "HEAD") {
		const headHash = await requireHead(ctx);
		if (isCommandError(headHash)) return headHash;
	}
	const hash = await resolveRevision(ctx, name);
	if (hash) return hash;
	if (/^[0-9a-f]{40}$/.test(name)) return fatal(`bad object ${name}`);
	return null;
}

async function revPathError(ctx: GitContext, rev: string, path: string): Promise<CommandResult> {
	const result = await requireCommit(ctx, rev);
	if (isCommandError(result)) return result;
	// git checks the path as given, so `HEAD:/x` is never on disk.
	if (ctx.workTree && !path.startsWith("/") && (await ctx.fs.exists(join(ctx.workTree, path)))) {
		return fatal(`path '${path}' exists on disk, but not in '${rev}'`);
	}
	return fatal(`path '${path}' does not exist in '${rev}'`);
}

async function existsInWorkTree(ctx: GitContext, cwd: string, path: string): Promise<boolean> {
	if (!ctx.workTree) return false;
	return ctx.fs.exists(join(cwd, path));
}

// ── Object display ──────────────────────────────────────────────────

interface ShowState {
	renameState: RenameWarningState;
	diffOutput: ShowDiffOutput | null;
	customFormat: string | null;
	presetName: string | null;
	/** Whether each commit's header ends its own line (oneline, tformat). */
	useTerminator: boolean;
	pathSpecs: Pathspec[] | null;
	/** Whether a tree, tag or commit has been shown, so the next needs a separator. */
	shownOne: boolean;
	/** Commits already shown, which git skips if named again. */
	shownCommits: Set<ObjectId>;
}

/**
 * Show one object as git's cmd_show does. Trees and tags are preceded by a
 * blank line once something has been shown, and commits too unless their
 * format terminates each one; blobs are written as-is. A commit is shown
 * only once.
 */
async function showObject(
	ctx: GitRepo,
	name: string,
	hash: ObjectId,
	state: ShowState,
): Promise<string> {
	const raw = await readObject(ctx, hash);
	switch (raw.type) {
		case "blob":
			return decoder.decode(raw.content);
		case "tree": {
			const sep = state.shownOne ? "\n" : "";
			state.shownOne = true;
			return `${sep}tree ${name}\n\n${formatTreeShow(parseTree(raw.content))}`;
		}
		case "tag": {
			const sep = state.shownOne ? "\n" : "";
			state.shownOne = true;
			const tag = await readTag(ctx, hash);
			// The tagged object follows under the same name.
			const header = formatTagHeader(
				tag,
				state.customFormat === null ? state.presetName : "format",
			);
			return `${sep}${header}${await showObject(ctx, name, tag.object, state)}`;
		}
		case "commit": {
			if (state.shownCommits.has(hash)) return "";
			const commit = await readCommit(ctx, hash);
			const output = await formatCommitShow(ctx, hash, commit, state);
			const sep = state.shownOne && !state.useTerminator ? "\n" : "";
			state.shownOne = true;
			state.shownCommits.add(hash);
			return `${sep}${output}`;
		}
	}
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
	state: ShowState,
): Promise<string> {
	const { renameState, diffOutput, customFormat, presetName, pathSpecs } = state;

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

	// A user format ends its line only as a terminator (tformat), and an
	// empty one prints nothing at all. The diff follows a blank line, except
	// after oneline or an empty format.
	const headerLine =
		customFormat === null
			? `${header}\n`
			: state.useTerminator && customFormat
				? `${header}\n`
				: header;
	const blank = presetName === "oneline" || customFormat === "" ? "" : "\n";

	if (!diffOutput) {
		return headerLine;
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
		return `${headerLine}${blank}${body.replace(/\n$/, "")}\n`;
	}
	// Git still prints the separator line when a commit has changes but the
	// requested output is empty, e.g. --summary on a content-only change.
	if (hasChanges || commit.parents.length >= 2) {
		return `${headerLine}${blank}`;
	}
	return headerLine;
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

/**
 * git prints a tag's tagger lines in the commit preset's style (none for
 * oneline, a date only for medium and fuller), then its message verbatim.
 */
function formatTagHeader(tag: Tag, presetName: string | null): string {
	const { name, email, timestamp, timezone } = tag.tagger;
	let tagger: string;
	if (presetName === "oneline") {
		tagger = "";
	} else if (presetName === "fuller") {
		tagger = `Tagger:     ${name} <${email}>\nTaggerDate: ${formatDate(timestamp, timezone)}\n`;
	} else if (presetName === null || presetName === "medium") {
		tagger = `Tagger: ${name} <${email}>\nDate:   ${formatDate(timestamp, timezone)}\n`;
	} else {
		tagger = `Tagger: ${name} <${email}>\n`;
	}
	return `tag ${tag.name}\n${tagger}\n${tag.message}`;
}

// ── Tree display ────────────────────────────────────────────────────

function formatTreeShow(tree: Tree): string {
	return tree.entries
		.map((entry) => `${entry.name}${entry.mode === FileMode.DIRECTORY ? "/" : ""}\n`)
		.join("");
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
