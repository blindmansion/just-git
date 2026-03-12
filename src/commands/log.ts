import type { GitExtensions } from "../git.ts";
import {
	ambiguousArgError,
	fatal,
	isCommandError,
	requireGitContext,
	requireHead,
} from "../lib/command-utils.ts";
import { CommitHeap, walkCommits } from "../lib/commit-walk.ts";
import { parseDate } from "../lib/date.ts";
import {
	expandFormat,
	type FormatContext,
	formatPreset,
	parseFormatArg,
} from "../lib/log-format.ts";
import { findAllMergeBases } from "../lib/merge.ts";
import { peelToCommit, readCommit } from "../lib/object-db.ts";
import type { Pathspec } from "../lib/pathspec.ts";
import { matchPathspecs, parsePathspec } from "../lib/pathspec.ts";
import { parseRangeSyntax } from "../lib/range-syntax.ts";
import { branchNameFromRef, listRefs, readHead, resolveHead } from "../lib/refs.ts";
import { resolveRevision } from "../lib/rev-parse.ts";
import { diffTrees } from "../lib/tree-ops.ts";
import type { Commit, GitContext, ObjectId } from "../lib/types.ts";
import { a, type Command, f, o } from "../parse/index.ts";

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

			const walker = pathSpecs
				? walkCommitsSimplified(
						gitCtx,
						startHashes,
						pathSpecs,
						excludeHashes ? await buildExcludeSet(gitCtx, excludeHashes) : undefined,
					)
				: walkCommits(gitCtx, startHashes, { exclude: excludeHashes });

			const collected: CommitEntry[] = [];
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

				collected.push(entry);
			}

			const entries = reverseOutput ? collected.reverse() : collected;

			// ── Format output ───────────────────────────────────
			if (customFormat !== null) {
				const lines: string[] = [];
				for (const entry of entries) {
					const fctx: FormatContext = {
						hash: entry.hash,
						commit: entry.commit,
						decorations: decoFn,
						decorationsRaw: decoRawFn,
					};
					lines.push(expandFormat(customFormat, fctx));
				}
				return {
					stdout: lines.length > 0 ? `${lines.join("\n")}\n` : "",
					stderr: "",
					exitCode: 0,
				};
			}

			const effectivePreset = presetName ?? "medium";
			const lines: string[] = [];
			for (let idx = 0; idx < entries.length; idx++) {
				const entry = entries[idx] as CommitEntry;
				const fctx: FormatContext = {
					hash: entry.hash,
					commit: entry.commit,
					decorations: decoFn,
					decorationsRaw: decoRawFn,
				};
				lines.push(formatPreset(effectivePreset, fctx, idx === 0, abbrevCommit));
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

async function buildExcludeSet(ctx: GitContext, hashes: ObjectId[]): Promise<Set<ObjectId>> {
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
	ctx: GitContext,
	startHashes: ObjectId[],
	pathSpecs: Pathspec[],
	excludeSet?: Set<ObjectId>,
): AsyncGenerator<CommitEntry> {
	const visited = new Set<ObjectId>(excludeSet);
	const queue = new CommitHeap();

	const enqueue = async (hash: ObjectId) => {
		if (!visited.has(hash)) {
			const commit = await readCommit(ctx, hash);
			queue.push({ hash, commit });
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
		const parents = commit.parents;

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
				const parentCommit = await readCommit(ctx, p0);
				const diff = await diffTrees(ctx, parentCommit.tree, commit.tree);
				if (diff.some((e) => matchPathspecs(pathSpecs, e.path))) {
					yield entry;
				}
				await enqueue(p0);
			}
			continue;
		}

		const treesameParents: ObjectId[] = [];
		for (const parentHash of parents) {
			const parentCommit = await readCommit(ctx, parentHash);
			const diff = await diffTrees(ctx, parentCommit.tree, commit.tree);
			if (!diff.some((e) => matchPathspecs(pathSpecs, e.path))) {
				treesameParents.push(parentHash);
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

async function buildDecorationMap(ctx: GitContext): Promise<DecorationMap> {
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
