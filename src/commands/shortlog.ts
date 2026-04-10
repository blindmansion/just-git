import type { GitExtensions } from "../git.ts";
import {
	ambiguousArgError,
	firstLine,
	isCommandError,
	requireGitContext,
	requireHead,
} from "../lib/command-utils.ts";
import { CommitHeap, walkCommits } from "../lib/commit-walk.ts";
import { parseDate } from "../lib/date.ts";
import { expandFormat, type FormatContext, parseFormatArg } from "../lib/log-format.ts";
import { findAllMergeBases } from "../lib/merge.ts";
import { peelToCommit, readCommit } from "../lib/object-db.ts";
import type { Pathspec } from "../lib/pathspec.ts";
import { matchPathspecs, parsePathspec } from "../lib/pathspec.ts";
import { parseRangeSyntax } from "../lib/range-syntax.ts";
import { listRefs, resolveHead } from "../lib/refs.ts";
import { resolveRevision } from "../lib/rev-parse.ts";
import { diffTrees } from "../lib/tree-ops.ts";
import type { Commit, GitRepo, ObjectId } from "../lib/types.ts";
import { a, type Command, f, o } from "../parse/index.ts";

export function registerShortlogCommand(parent: Command, ext?: GitExtensions) {
	parent.command("shortlog", {
		description: "Summarize git log output",
		args: [a.string().name("revisions").variadic().optional()],
		options: {
			summary: f().alias("s").describe("Suppress commit descriptions, only provide count"),
			numbered: f().alias("n").describe("Sort by number of commits per author"),
			email: f().alias("e").describe("Show the email address of each author"),
			group: o.string().describe("Group commits by author or committer"),
			format: o.string().describe("Format string for each commit line"),
			all: f().describe("Walk all refs"),
			noMerges: f().describe("Exclude merge commits"),
			author: o.string().describe("Filter by author"),
			grep: o.string().describe("Filter by commit message"),
			since: o.string().describe("Show commits after date"),
			after: o.string().describe("Synonym for --since"),
			until: o.string().describe("Show commits before date"),
			before: o.string().describe("Synonym for --until"),
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
			} else if (args.all) {
				const allRefs = await listRefs(gitCtx);
				const hashes = new Set<ObjectId>();
				for (const ref of allRefs) {
					try {
						hashes.add(await peelToCommit(gitCtx, ref.hash));
					} catch {}
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
				return { stdout: "", stderr: "", exitCode: 0 };
			}

			// ── Path filter ─────────────────────────────────────────
			const pathSpecs =
				meta.passthrough.length > 0 ? meta.passthrough.map((p) => parsePathspec(p, "")) : null;

			// ── Filters ─────────────────────────────────────────────
			const authorPattern = args.author ? buildMatcher(args.author) : null;
			const grepPattern = args.grep ? buildMatcher(args.grep) : null;

			const sinceRaw = args.since ?? args.after;
			const untilRaw = args.until ?? args.before;
			const sinceTs = sinceRaw ? parseDate(sinceRaw) : null;
			const untilTs = untilRaw ? parseDate(untilRaw) : null;

			const noMerges = args.noMerges;
			const useCommitter = args.group === "committer";

			// ── Custom format ───────────────────────────────────────
			let customFormat: string | null = null;
			if (args.format !== undefined) {
				const parsed = parseFormatArg(args.format);
				customFormat = parsed.formatStr ?? parsed.preset;
			}

			// ── Walk and group ───────────────────────────────────────
			const groups = new Map<string, { name: string; lines: string[] }>();

			const walker = pathSpecs
				? walkCommitsSimplified(
						gitCtx,
						startHashes,
						pathSpecs,
						excludeHashes ? await buildExcludeSet(gitCtx, excludeHashes) : undefined,
					)
				: walkCommits(gitCtx, startHashes, { exclude: excludeHashes });

			for await (const entry of walker) {
				const { commit } = entry;

				if (noMerges && commit.parents.length > 1) continue;

				if (untilTs !== null && commit.committer.timestamp > untilTs) continue;
				if (sinceTs !== null && commit.committer.timestamp <= sinceTs) continue;

				if (authorPattern) {
					const authorStr = `${commit.author.name} <${commit.author.email}>`;
					if (!authorPattern(authorStr)) continue;
				}

				if (grepPattern) {
					if (!grepPattern(commit.message)) continue;
				}

				const identity = useCommitter ? commit.committer : commit.author;
				const key = args.email ? `${identity.name} <${identity.email}>` : identity.name;

				let group = groups.get(key);
				if (!group) {
					group = { name: key, lines: [] };
					groups.set(key, group);
				}

				let line: string;
				if (customFormat !== null) {
					const fctx: FormatContext = { hash: entry.hash, commit };
					line = expandFormat(customFormat, fctx);
				} else {
					line = firstLine(commit.message);
				}
				group.lines.push(line);
			}

			for (const g of groups.values()) g.lines.reverse();

			// ── Sort groups ─────────────────────────────────────────
			const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
			let sorted = [...groups.values()];
			if (args.numbered) {
				sorted.sort((a, b) => {
					const diff = b.lines.length - a.lines.length;
					if (diff !== 0) return diff;
					return cmp(a.name, b.name);
				});
			} else {
				sorted.sort((a, b) => cmp(a.name, b.name));
			}

			// ── Format output ───────────────────────────────────────
			if (args.summary) {
				const lines = sorted.map((g) => {
					const count = String(g.lines.length).padStart(6);
					return `${count}\t${g.name}\n`;
				});
				return { stdout: lines.join(""), stderr: "", exitCode: 0 };
			}

			const stdout = sorted.length > 0 ? formatGroupedOutput(sorted) : "";
			return { stdout, stderr: "", exitCode: 0 };
		},
	});
}

function formatGroupedOutput(groups: { name: string; lines: string[] }[]): string {
	const sections: string[] = [];
	for (const g of groups) {
		let section = `${g.name} (${g.lines.length}):\n`;
		for (const line of g.lines) {
			section += `      ${line}\n`;
		}
		sections.push(section);
	}
	return sections.join("\n") + "\n";
}

// ── Helpers ─────────────────────────────────────────────────────────

function buildMatcher(pattern: string): (text: string) => boolean {
	try {
		const re = new RegExp(pattern);
		return (text: string) => re.test(text);
	} catch {
		return (text: string) => text.includes(pattern);
	}
}

async function buildExcludeSet(ctx: GitRepo, hashes: ObjectId[]): Promise<Set<ObjectId>> {
	const set = new Set<ObjectId>();
	for await (const entry of walkCommits(ctx, hashes)) {
		set.add(entry.hash);
	}
	return set;
}

async function* walkCommitsSimplified(
	ctx: GitRepo,
	startHashes: ObjectId[],
	pathSpecs: Pathspec[],
	excludeSet?: Set<ObjectId>,
): AsyncGenerator<{ hash: ObjectId; commit: Commit }> {
	const visited = new Set<ObjectId>(excludeSet);
	const queue = new CommitHeap();

	const enqueue = async (hash: ObjectId) => {
		if (!visited.has(hash)) {
			try {
				const commit = await readCommit(ctx, hash);
				queue.push({ hash, commit });
			} catch {}
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
			} catch {}
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
