import type { GitExtensions } from "../git.ts";
import {
	ambiguousArgError,
	fatal,
	isCommandError,
	requireGitContext,
	requireHead,
} from "../lib/command-utils.ts";
import { computeDiffStats, formatShortstatParts, renderStatLines } from "../lib/commit-summary.ts";
import { CommitHeap, walkCommits } from "../lib/commit-walk.ts";
import { parseDate } from "../lib/date.ts";
import { formatUnifiedDiff, myersDiff, splitLinesWithNL } from "../lib/diff-algorithm.ts";
import { CommitGraph } from "../lib/graph.ts";
import {
	type DateMode,
	expandFormat,
	type FormatContext,
	formatPreset,
	parseFormatArg,
} from "../lib/log-format.ts";
import { findAllMergeBases } from "../lib/merge.ts";
import { isBinaryStr, peelToCommit, readBlobContent, readCommit } from "../lib/object-db.ts";
import type { Pathspec } from "../lib/pathspec.ts";
import { matchPathspecs, parsePathspec } from "../lib/pathspec.ts";
import { parseRangeSyntax } from "../lib/range-syntax.ts";
import { branchNameFromRef, listRefs, readHead, resolveHead } from "../lib/refs.ts";
import { detectRenames, formatRenamePath, type RenamePair } from "../lib/rename-detection.ts";
import { resolveRevision } from "../lib/rev-parse.ts";
import { diffTrees } from "../lib/tree-ops.ts";
import type { Commit, GitRepo, ObjectId, TreeDiffEntry } from "../lib/types.ts";
import { a, type Command, f, o } from "../parse/index.ts";

type LogDiffFormat =
	| "name-status"
	| "name-only"
	| "stat"
	| "shortstat"
	| "numstat"
	| "patch"
	| null;

export function registerLogCommand(parent: Command, ext?: GitExtensions) {
	parent.command("log", {
		description: "Show commit logs",
		transformArgs: (tokens) => tokens.map((t) => (/^-(\d+)$/.test(t) ? `-n${t.slice(1)}` : t)),
		args: [a.string().name("revisions").variadic().optional()],
		options: {
			maxCount: o.number().alias("n").describe("Limit the number of commits to output"),
			oneline: f().describe("Condense each commit to a single line"),
			all: f().describe("Walk all refs, not just HEAD"),
			author: o.string().describe("Filter by author (regex or substring)"),
			grep: o.string().describe("Filter by commit message (regex or substring)"),
			since: o.string().describe("Show commits after date"),
			after: o.string().describe("Synonym for --since"),
			until: o.string().describe("Show commits before date"),
			before: o.string().describe("Synonym for --until"),
			decorate: f().describe("Show ref names next to commit hashes"),
			reverse: f().describe("Output commits in reverse order"),
			format: o.string().describe("Pretty-print format string"),
			pretty: o.string().describe("Pretty-print format or preset name"),
			patch: f().alias("p").describe("Show diff in patch format"),
			stat: f().describe("Show diffstat summary"),
			nameStatus: f().describe("Show names and status of changed files"),
			nameOnly: f().describe("Show only names of changed files"),
			shortstat: f().describe("Show only the shortstat summary line"),
			numstat: f().describe("Machine-readable insertions/deletions per file"),
			graph: f().describe("Draw text-based graph of the commit history"),
			firstParent: f().describe("Follow only the first parent of merge commits"),
			skip: o.number().describe("Skip number of commits before starting to show output"),
			date: o
				.string()
				.describe(
					"Date format: short, iso, iso-strict, relative, rfc, raw, unix, local, human, default",
				),
		},
		handler: async (args, ctx, meta) => {
			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;
			const gitCtx = gitCtxOrError;

			// ── Determine start hashes ──────────────────────────────
			let startHashes: ObjectId[];
			let excludeHashes: ObjectId[] | undefined;
			const revisions = args.revisions;

			const range =
				revisions && revisions.length === 1 ? parseRangeSyntax(revisions[0] as string) : null;

			if (range) {
				const resolveRev = async (rev: string) => {
					const resolved = await resolveRevision(gitCtx, rev);
					if (!resolved) return ambiguousArgError(rev);
					try {
						return await peelToCommit(gitCtx, resolved);
					} catch {
						return ambiguousArgError(rev);
					}
				};

				const leftResult = await resolveRev(range.left);
				if (typeof leftResult === "object" && "exitCode" in leftResult) return leftResult;
				const rightResult = await resolveRev(range.right);
				if (typeof rightResult === "object" && "exitCode" in rightResult) return rightResult;

				const leftHash = leftResult as ObjectId;
				const rightHash = rightResult as ObjectId;

				if (range.type === "two-dot") {
					startHashes = [rightHash];
					excludeHashes = [leftHash];
				} else {
					startHashes = [leftHash, rightHash];
					const bases = await findAllMergeBases(gitCtx, leftHash, rightHash);
					excludeHashes = bases.length > 0 ? bases : undefined;
				}

				if (args.all) {
					const allRefs = await listRefs(gitCtx);
					for (const ref of allRefs) {
						try {
							const h = await peelToCommit(gitCtx, ref.hash);
							if (!startHashes.includes(h)) startHashes.push(h);
						} catch {}
					}
					const headHash = await resolveHead(gitCtx);
					if (headHash && !startHashes.includes(headHash)) startHashes.push(headHash);
				}
			} else if (args.all) {
				const allRefs = await listRefs(gitCtx);
				const hashes = new Set<ObjectId>();
				for (const ref of allRefs) {
					try {
						hashes.add(await peelToCommit(gitCtx, ref.hash));
					} catch {
						// skip refs that don't resolve to a commit (e.g. tree-only tags)
					}
				}
				const headHash = await resolveHead(gitCtx);
				if (headHash) hashes.add(headHash);
				startHashes = [...hashes];
			} else if (revisions && revisions.length > 0) {
				const hashes: ObjectId[] = [];
				for (const rev of revisions) {
					const resolved = await resolveRevision(gitCtx, rev);
					if (!resolved) return ambiguousArgError(rev);
					try {
						hashes.push(await peelToCommit(gitCtx, resolved));
					} catch {
						return ambiguousArgError(rev);
					}
				}
				startHashes = hashes;
			} else {
				const headHash = await requireHead(gitCtx);
				if (isCommandError(headHash)) return headHash;
				startHashes = [headHash];
			}

			if (startHashes.length === 0) {
				return fatal("your current branch does not have any commits yet");
			}

			// ── Path filter ─────────────────────────────────────────
			const pathSpecs =
				meta.passthrough.length > 0 ? meta.passthrough.map((p) => parsePathspec(p, "")) : null;

			// ── Author/grep filters ─────────────────────────────────
			const authorPattern = args.author ? buildMatcher(args.author) : null;
			const grepPattern = args.grep ? buildMatcher(args.grep) : null;

			// ── Date filters ────────────────────────────────────────
			const sinceRaw = args.since ?? args.after;
			const untilRaw = args.until ?? args.before;
			const sinceTs = sinceRaw ? parseDate(sinceRaw) : null;
			const untilTs = untilRaw ? parseDate(untilRaw) : null;

			// ── Determine format mode ───────────────────────────────
			const formatRaw = args.format ?? args.pretty;
			let customFormat: string | null = null;
			let presetName: string | null = null;
			let abbrevCommit = false;

			if (args.oneline) {
				presetName = "oneline";
				abbrevCommit = true;
			} else if (formatRaw !== undefined) {
				const parsed = parseFormatArg(formatRaw);
				customFormat = parsed.formatStr;
				presetName = parsed.preset;
			}

			const VALID_DATE_MODES = new Set<string>([
				"default",
				"short",
				"iso",
				"iso-strict",
				"relative",
				"rfc",
				"raw",
				"unix",
				"local",
				"human",
			]);
			if (args.date && !VALID_DATE_MODES.has(args.date)) {
				return { stdout: "", stderr: `fatal: unknown date format ${args.date}\n`, exitCode: 128 };
			}
			const dateMode: DateMode | undefined = args.date as DateMode | undefined;

			const diffFormat: LogDiffFormat = args.patch
				? "patch"
				: args.stat
					? "stat"
					: args.nameStatus
						? "name-status"
						: args.nameOnly
							? "name-only"
							: args.shortstat
								? "shortstat"
								: args.numstat
									? "numstat"
									: null;

			// ── Graph / reverse conflict ────────────────────────────
			const useGraph = args.graph;
			if (useGraph && args.reverse) {
				return fatal("options '--graph' and '--reverse' cannot be used together");
			}

			const needDecorations =
				args.decorate ||
				(customFormat != null && (customFormat.includes("%d") || customFormat.includes("%D")));

			const decoMap = needDecorations ? await buildDecorationMap(gitCtx) : null;

			const decoFn = decoMap ? (h: ObjectId) => formatDecorations(decoMap, h) : undefined;
			const decoRawFn = decoMap
				? (h: ObjectId) => {
						const s = formatDecorations(decoMap, h);
						return s.startsWith("(") && s.endsWith(")") ? s.slice(1, -1) : s;
					}
				: undefined;

			// ── Walk and filter ──────────────────────────────────────
			const maxCount = args.maxCount;
			const reverseOutput = args.reverse;

			const firstParent = args.firstParent;

			const walker = pathSpecs
				? walkCommitsSimplified(
						gitCtx,
						startHashes,
						pathSpecs,
						excludeHashes ? await buildExcludeSet(gitCtx, excludeHashes) : undefined,
						firstParent,
					)
				: walkCommits(gitCtx, startHashes, {
						exclude: excludeHashes,
						topoOrder: useGraph,
						firstParent,
					});

			const collected: CommitEntry[] = [];
			let skipRemaining = args.skip ?? 0;
			for await (const entry of walker) {
				if (maxCount !== undefined && collected.length >= maxCount) break;

				const { commit } = entry;

				if (untilTs !== null && commit.committer.timestamp > untilTs) {
					continue;
				}
				if (sinceTs !== null && commit.committer.timestamp <= sinceTs) {
					continue;
				}

				if (authorPattern) {
					const authorStr = `${commit.author.name} <${commit.author.email}>`;
					if (!authorPattern(authorStr)) continue;
				}

				if (grepPattern) {
					if (!grepPattern(commit.message)) continue;
				}

				if (skipRemaining > 0) {
					skipRemaining--;
					continue;
				}

				collected.push(entry);
			}

			const entries = reverseOutput ? collected.reverse() : collected;

			// ── Format output ───────────────────────────────────
			if (useGraph) {
				return formatWithGraph(
					entries,
					gitCtx,
					customFormat,
					presetName,
					abbrevCommit,
					diffFormat,
					decoFn,
					decoRawFn,
					dateMode,
				);
			}

			if (customFormat !== null) {
				const lines: string[] = [];
				for (const entry of entries) {
					const fctx: FormatContext = {
						hash: entry.hash,
						commit: entry.commit,
						decorations: decoFn,
						decorationsRaw: decoRawFn,
						dateMode,
					};
					let line = expandFormat(customFormat, fctx);
					const diffText = await formatCommitDiff(gitCtx, entry.commit, diffFormat);
					if (diffText) {
						line += `\n\n${diffText.replace(/\n$/, "")}`;
					}
					lines.push(line);
				}
				return {
					stdout: lines.length > 0 ? `${lines.join("\n")}\n` : "",
					stderr: "",
					exitCode: 0,
				};
			}

			const effectivePreset = presetName ?? "medium";
			const isOneline = effectivePreset === "oneline";
			const lines: string[] = [];
			for (let idx = 0; idx < entries.length; idx++) {
				const entry = entries[idx] as CommitEntry;
				const fctx: FormatContext = {
					hash: entry.hash,
					commit: entry.commit,
					decorations: decoFn,
					decorationsRaw: decoRawFn,
					dateMode,
				};
				let line = formatPreset(effectivePreset, fctx, idx === 0, abbrevCommit);
				const diffText = await formatCommitDiff(gitCtx, entry.commit, diffFormat);
				if (diffText) {
					const sep = isOneline ? "\n" : "\n\n";
					line += `${sep}${diffText.replace(/\n$/, "")}`;
				}
				lines.push(line);
			}
			return {
				stdout: lines.length > 0 ? `${lines.join("\n")}\n` : "",
				stderr: "",
				exitCode: 0,
			};
		},
	});
}

// ── Helpers ─────────────────────────────────────────────────────────

async function buildExcludeSet(ctx: GitRepo, hashes: ObjectId[]): Promise<Set<ObjectId>> {
	const set = new Set<ObjectId>();
	for await (const entry of walkCommits(ctx, hashes)) {
		set.add(entry.hash);
	}
	return set;
}

function buildMatcher(pattern: string): (text: string) => boolean {
	try {
		const re = new RegExp(pattern);
		return (text: string) => re.test(text);
	} catch {
		return (text: string) => text.includes(pattern);
	}
}

interface CommitEntry {
	hash: ObjectId;
	commit: Commit;
}

/**
 * Walk commit graph with Git's default history simplification for
 * path-filtered log. Only yields commits that modify the given paths,
 * and at merge points prunes branches where the path is TREESAME
 * (unchanged from a parent).
 *
 * Simplification rules:
 * - Root commit: yield if path exists in tree
 * - Single parent: yield if path changed from parent
 * - Merge: if TREESAME to any parent, skip and follow only TREESAME
 *   parents. If not TREESAME to any, yield and follow all parents.
 */
async function* walkCommitsSimplified(
	ctx: GitRepo,
	startHashes: ObjectId[],
	pathSpecs: Pathspec[],
	excludeSet?: Set<ObjectId>,
	firstParent?: boolean,
): AsyncGenerator<CommitEntry> {
	const visited = new Set<ObjectId>(excludeSet);
	const queue = new CommitHeap();

	const enqueue = async (hash: ObjectId) => {
		if (!visited.has(hash)) {
			try {
				const commit = await readCommit(ctx, hash);
				queue.push({ hash, commit });
			} catch {
				// Parent object may be missing in a shallow repo
			}
		}
	};

	for (const h of startHashes) {
		await enqueue(h);
	}

	while (queue.size > 0) {
		const entry = queue.pop()!;
		if (visited.has(entry.hash)) continue;
		visited.add(entry.hash);

		const { commit } = entry;
		const parents = firstParent ? commit.parents.slice(0, 1) : commit.parents;

		if (parents.length === 0) {
			const diff = await diffTrees(ctx, null, commit.tree);
			if (diff.some((e) => matchPathspecs(pathSpecs, e.path))) {
				yield entry;
			}
			continue;
		}

		if (parents.length === 1) {
			const p0 = parents[0];
			if (p0) {
				try {
					const parentCommit = await readCommit(ctx, p0);
					const diff = await diffTrees(ctx, parentCommit.tree, commit.tree);
					if (diff.some((e) => matchPathspecs(pathSpecs, e.path))) {
						yield entry;
					}
				} catch {
					yield entry;
				}
				await enqueue(p0);
			}
			continue;
		}

		const treesameParents: ObjectId[] = [];
		for (const parentHash of parents) {
			try {
				const parentCommit = await readCommit(ctx, parentHash);
				const diff = await diffTrees(ctx, parentCommit.tree, commit.tree);
				if (!diff.some((e) => matchPathspecs(pathSpecs, e.path))) {
					treesameParents.push(parentHash);
				}
			} catch {
				// Parent missing in shallow repo — not treesame
			}
		}

		if (treesameParents.length > 0 && treesameParents[0]) {
			await enqueue(treesameParents[0]);
		} else {
			yield entry;
			for (const p of parents) {
				await enqueue(p);
			}
		}
	}
}

interface Decoration {
	label: string;
	fullRef: string;
}

interface DecorationMap {
	headTarget: string | null;
	headHash: ObjectId | null;
	byHash: Map<ObjectId, Decoration[]>;
}

async function buildDecorationMap(ctx: GitRepo): Promise<DecorationMap> {
	const head = await readHead(ctx);
	const headTarget = head?.type === "symbolic" ? branchNameFromRef(head.target) : null;
	const headHash = await resolveHead(ctx);

	const byHash = new Map<ObjectId, Decoration[]>();

	const addDeco = (hash: ObjectId, label: string, fullRef: string) => {
		let list = byHash.get(hash);
		if (!list) {
			list = [];
			byHash.set(hash, list);
		}
		list.push({ label, fullRef });
	};

	const localRefs = await listRefs(ctx, "refs/heads");
	for (const ref of localRefs) {
		addDeco(ref.hash, branchNameFromRef(ref.name), ref.name);
	}

	const remoteRefs = await listRefs(ctx, "refs/remotes");
	for (const ref of remoteRefs) {
		addDeco(ref.hash, ref.name.replace("refs/remotes/", ""), ref.name);
	}

	const tagRefs = await listRefs(ctx, "refs/tags");
	for (const ref of tagRefs) {
		let targetHash = ref.hash;
		try {
			targetHash = await peelToCommit(ctx, ref.hash);
		} catch {
			// keep original hash if tag doesn't peel to a commit
		}
		addDeco(targetHash, `tag: ${ref.name.replace("refs/tags/", "")}`, ref.name);
	}

	return { headTarget, headHash, byHash };
}

function formatDecorations(deco: DecorationMap, hash: ObjectId): string {
	const decos = deco.byHash.get(hash);
	const isDetachedHead = !deco.headTarget && deco.headHash !== null && deco.headHash === hash;

	if ((!decos || decos.length === 0) && !isDetachedHead) return "";

	const parts: string[] = [];

	const headDeco = deco.headTarget && decos ? decos.find((d) => d.label === deco.headTarget) : null;
	if (headDeco) {
		parts.push(`HEAD -> ${headDeco.label}`);
	} else if (isDetachedHead) {
		parts.push("HEAD");
	}

	const filtered = decos ? decos.filter((d) => d !== headDeco) : [];
	// Git iterates refs alphabetically via for_each_ref but prepends each to a
	// linked list, so decorations appear in reverse alphabetical order by full
	// ref name.
	filtered.sort((a, b) => (a.fullRef > b.fullRef ? -1 : a.fullRef < b.fullRef ? 1 : 0));
	for (const d of filtered) {
		parts.push(d.label);
	}

	return parts.length > 0 ? `(${parts.join(", ")})` : "";
}

// ── Graph-aware output ──────────────────────────────────────────────

async function formatWithGraph(
	entries: CommitEntry[],
	gitCtx: GitRepo,
	customFormat: string | null,
	presetName: string | null,
	abbrevCommit: boolean,
	diffFormat: LogDiffFormat,
	decoFn: ((h: ObjectId) => string) | undefined,
	decoRawFn: ((h: ObjectId) => string) | undefined,
	dateMode?: DateMode,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const graph = new CommitGraph();
	const effectivePreset = presetName ?? "medium";
	const isOneline = effectivePreset === "oneline";
	const output: string[] = [];

	for (let idx = 0; idx < entries.length; idx++) {
		const entry = entries[idx] as CommitEntry;
		const fctx: FormatContext = {
			hash: entry.hash,
			commit: entry.commit,
			decorations: decoFn,
			decorationsRaw: decoRawFn,
			dateMode,
		};

		let msgContent: string;
		if (customFormat !== null) {
			msgContent = expandFormat(customFormat, fctx);
		} else {
			msgContent = formatPreset(effectivePreset, fctx, true, abbrevCommit);
		}

		graph.update(entry.hash, entry.commit.parents);

		// Non-first commits in multi-line formats get a separator padding line
		if (idx > 0 && !isOneline && customFormat === null) {
			output.push(graph.paddingPrefix());
		}

		const msgLines = msgContent.split("\n");
		let ci = 0;

		// Output pre-commit expansion lines + commit line
		while (true) {
			const { prefix, isCommitLine } = graph.nextLine();
			if (isCommitLine) {
				output.push(prefix + (msgLines[ci++] ?? ""));
				break;
			}
			output.push(prefix);
		}

		// Output remaining message lines with graph prefixes
		while (ci < msgLines.length) {
			const { prefix } = graph.nextLine();
			output.push(prefix + msgLines[ci++]);
		}

		// Flush remaining structural lines (POST_MERGE, COLLAPSING)
		// before diff/stat output — real git emits these between message
		// and diff so that collapsing columns resolve before stats.
		while (!graph.isFinished()) {
			const { prefix } = graph.nextLine();
			output.push(prefix);
		}

		// Compute diff/stat after graph columns have settled so we can
		// reduce the stat width by the graph prefix width (like real git).
		const statWidth = 80 - graph.width;
		const diffText = await formatCommitDiff(gitCtx, entry.commit, diffFormat, statWidth);

		// Diff/stat output gets padding prefixes (columns already settled)
		if (diffText) {
			const diffLines = diffText.replace(/\n$/, "").split("\n");
			if (isOneline || customFormat !== null) {
				for (const dl of diffLines) {
					output.push(graph.paddingPrefix() + dl);
				}
			} else {
				// Medium/full format: blank separator before diff
				output.push(graph.paddingPrefix());
				for (const dl of diffLines) {
					output.push(graph.paddingPrefix() + dl);
				}
			}
		}
	}

	return {
		stdout: output.length > 0 ? `${output.join("\n")}\n` : "",
		stderr: "",
		exitCode: 0,
	};
}

// ── Diff output for log ─────────────────────────────────────────────

async function formatCommitDiff(
	ctx: GitRepo,
	commit: Commit,
	format: LogDiffFormat,
	statWidth?: number,
): Promise<string> {
	if (!format) return "";
	if (commit.parents.length >= 2) return "";

	const parentTree =
		commit.parents.length === 1
			? (await readCommit(ctx, commit.parents[0] as ObjectId)).tree
			: null;

	const rawDiffs = await diffTrees(ctx, parentTree, commit.tree);
	const { remaining, renames } = await detectRenames(ctx, rawDiffs);

	switch (format) {
		case "name-only":
			return logNameOnly(remaining, renames);
		case "name-status":
			return logNameStatus(remaining, renames);
		case "stat":
			return logStat(ctx, remaining, renames, statWidth);
		case "shortstat":
			return logShortstat(ctx, remaining, renames);
		case "numstat":
			return logNumstat(ctx, remaining, renames);
		case "patch":
			return logPatch(ctx, remaining, renames);
	}
}

function logNameOnly(remaining: TreeDiffEntry[], renames: RenamePair[]): string {
	const items: { key: string; line: string }[] = [];
	for (const d of remaining) items.push({ key: d.path, line: d.path });
	for (const r of renames) items.push({ key: r.newPath, line: r.newPath });
	items.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
	return items.map((i) => `${i.line}\n`).join("");
}

function logNameStatus(remaining: TreeDiffEntry[], renames: RenamePair[]): string {
	const items: { key: string; line: string }[] = [];
	for (const d of remaining) {
		const s = d.status === "added" ? "A" : d.status === "deleted" ? "D" : "M";
		items.push({ key: d.path, line: `${s}\t${d.path}` });
	}
	for (const r of renames) {
		const score = String(r.similarity ?? 100).padStart(3, "0");
		items.push({ key: r.newPath, line: `R${score}\t${r.oldPath}\t${r.newPath}` });
	}
	items.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
	return items.map((i) => `${i.line}\n`).join("");
}

async function logStat(
	ctx: GitRepo,
	remaining: TreeDiffEntry[],
	renames: RenamePair[],
	statWidth?: number,
): Promise<string> {
	const { fileStats } = await computeDiffStats(ctx, remaining, renames);
	fileStats.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
	return renderStatLines(fileStats, statWidth);
}

async function logShortstat(
	ctx: GitRepo,
	remaining: TreeDiffEntry[],
	renames: RenamePair[],
): Promise<string> {
	const { fileStats } = await computeDiffStats(ctx, remaining, renames);
	let totalIns = 0;
	let totalDel = 0;
	for (const s of fileStats) {
		totalIns += s.insertions;
		totalDel += s.deletions;
	}
	const line = formatShortstatParts(fileStats.length, totalIns, totalDel);
	return line ? `${line}\n` : "";
}

async function logNumstat(
	ctx: GitRepo,
	remaining: TreeDiffEntry[],
	renames: RenamePair[],
): Promise<string> {
	const items: { key: string; oldHash?: string; newHash?: string; display: string }[] = [];
	for (const d of remaining) {
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

async function logPatch(
	ctx: GitRepo,
	remaining: TreeDiffEntry[],
	renames: RenamePair[],
): Promise<string> {
	type DiffItem = { type: "diff"; entry: TreeDiffEntry } | { type: "rename"; entry: RenamePair };
	const allItems: DiffItem[] = [];
	for (const d of remaining) allItems.push({ type: "diff", entry: d });
	for (const r of renames) allItems.push({ type: "rename", entry: r });
	allItems.sort((a, b) => {
		const pathA = a.type === "diff" ? a.entry.path : a.entry.newPath;
		const pathB = b.type === "diff" ? b.entry.path : b.entry.newPath;
		return pathA < pathB ? -1 : pathA > pathB ? 1 : 0;
	});

	let output = "";
	for (const item of allItems) {
		if (item.type === "rename") {
			const r = item.entry;
			const oldContent = r.oldHash ? await readBlobContent(ctx, r.oldHash) : "";
			const newContent = r.newHash ? await readBlobContent(ctx, r.newHash) : "";
			output += formatUnifiedDiff({
				path: r.oldPath,
				oldContent,
				newContent,
				oldMode: r.oldMode,
				newMode: r.newMode,
				oldHash: r.oldHash,
				newHash: r.newHash,
				renameTo: r.newPath,
				similarity: r.similarity,
			});
		} else {
			const d = item.entry;
			const oldContent = d.oldHash ? await readBlobContent(ctx, d.oldHash) : "";
			const newContent = d.newHash ? await readBlobContent(ctx, d.newHash) : "";
			output += formatUnifiedDiff({
				path: d.path,
				oldContent,
				newContent,
				oldMode: d.oldMode,
				newMode: d.newMode,
				oldHash: d.oldHash,
				newHash: d.newHash,
				isNew: d.status === "added",
				isDeleted: d.status === "deleted",
			});
		}
	}
	return output;
}
