import type { GitExtensions } from "../git.ts";
import {
	type CommandResult,
	fatal,
	getCwdPrefix,
	isCommandError,
	requireGitContext,
	requireRevision,
} from "../lib/command-utils.ts";
import { readIndex } from "../lib/index.ts";
import { isBinaryStr, peelToCommit, readBlobContent, readCommit } from "../lib/object-db.ts";
import { join, relative } from "../lib/path.ts";
import { matchPathspecs, parsePathspec, type Pathspec } from "../lib/pathspec.ts";
import { flattenTree, type FlatTreeEntry } from "../lib/tree-ops.ts";
import type { GitContext, ObjectId } from "../lib/types.ts";
import { a, type Command, f, o } from "../parse/index.ts";

// ── Pattern compilation ─────────────────────────────────────────────

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compilePattern(
	raw: string,
	fixed: boolean,
	ignoreCase: boolean,
	wordRegexp: boolean,
): RegExp | CommandResult {
	let src = fixed ? escapeRegex(raw) : raw;
	if (wordRegexp) src = `\\b${src}\\b`;
	const flags = ignoreCase ? "i" : "";
	try {
		return new RegExp(src, flags);
	} catch {
		return fatal(`command line, '${raw}': invalid regular expression`);
	}
}

// ── File enumeration ────────────────────────────────────────────────

interface GrepFile {
	path: string;
	getContent: () => Promise<string>;
}

async function filesFromWorktree(ctx: GitContext): Promise<GrepFile[]> {
	const index = await readIndex(ctx);
	const seen = new Set<string>();
	const files: GrepFile[] = [];
	for (const entry of index.entries) {
		if (entry.stage !== 0) continue;
		if (seen.has(entry.path)) continue;
		seen.add(entry.path);
		const fullPath = join(ctx.workTree!, entry.path);
		files.push({
			path: entry.path,
			getContent: async () => {
				try {
					return await ctx.fs.readFile(fullPath);
				} catch {
					return "";
				}
			},
		});
	}
	return files;
}

async function filesFromIndex(ctx: GitContext): Promise<GrepFile[]> {
	const index = await readIndex(ctx);
	const seen = new Set<string>();
	const files: GrepFile[] = [];
	for (const entry of index.entries) {
		if (entry.stage !== 0) continue;
		if (seen.has(entry.path)) continue;
		seen.add(entry.path);
		const hash = entry.hash;
		files.push({
			path: entry.path,
			getContent: () => readBlobContent(ctx, hash),
		});
	}
	return files;
}

async function filesFromTree(ctx: GitContext, treeHash: ObjectId): Promise<GrepFile[]> {
	const entries = await flattenTree(ctx, treeHash);
	return entries
		.filter((e) => !e.mode.startsWith("120"))
		.map((e: FlatTreeEntry) => ({
			path: e.path,
			getContent: () => readBlobContent(ctx, e.hash),
		}));
}

// ── Helpers ─────────────────────────────────────────────────────────

function pathDepth(p: string): number {
	let count = 0;
	for (let i = 0; i < p.length; i++) {
		if (p[i] === "/") count++;
	}
	return count;
}

function displayPath(filePath: string, cwdPrefix: string, fullName: boolean): string {
	if (fullName || cwdPrefix === "") return filePath;
	return relative(cwdPrefix, filePath);
}

// ── Core grep logic ─────────────────────────────────────────────────

interface GrepMatch {
	lineNo: number;
	line: string;
}

function grepFileContent(
	content: string,
	patterns: RegExp[],
	allMatch: boolean,
	invert: boolean,
): { matches: GrepMatch[]; binary: boolean } {
	if (isBinaryStr(content)) {
		const hasMatch = patterns.some((p) => p.test(content));
		return { matches: [], binary: hasMatch };
	}

	const lines = content.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

	if (allMatch && patterns.length > 1) {
		const allHit = patterns.every((p) => lines.some((l) => p.test(l)));
		if (!allHit) return { matches: [], binary: false };
	}

	const matches: GrepMatch[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const hit = patterns.some((p) => p.test(line));
		if (invert ? !hit : hit) {
			matches.push({ lineNo: i + 1, line });
		}
	}

	return { matches, binary: false };
}

// ── Command registration ────────────────────────────────────────────

export function registerGrepCommand(parent: Command, ext?: GitExtensions) {
	parent.command("grep", {
		description: "Print lines matching a pattern",
		args: [a.string().name("args").variadic().optional()],
		options: {
			cached: f().describe("Search blobs registered in the index"),
			lineNumber: f().alias("n").describe("Prefix the line number to matching lines"),
			filesWithMatches: f().alias("l").describe("Show only filenames"),
			filesWithoutMatch: f().alias("L").describe("Show only filenames without matches"),
			count: f().alias("c").describe("Show count of matching lines per file"),
			ignoreCase: f().alias("i").describe("Case insensitive matching"),
			wordRegexp: f().alias("w").describe("Match whole words only"),
			invertMatch: f().alias("v").describe("Invert the sense of matching"),
			fixedStrings: f().alias("F").describe("Interpret pattern as fixed string"),
			extendedRegexp: f().alias("E").describe("Interpret pattern as extended regexp"),
			basicRegexp: f().alias("G").describe("Interpret pattern as basic regexp"),
			suppressFilename: f().alias("h").describe("Suppress filename prefix"),
			forceFilename: f().alias("H").describe("Force filename prefix"),
			fullName: f().describe("Force paths to be output relative to project top"),
			quiet: f().alias("q").describe("Do not output matched lines; exit with status 0 on match"),
			allMatch: f().describe("Require all patterns to match in a file"),
			maxDepth: o.number().describe("Descend at most <n> levels of directories"),
			maxCount: o.number().alias("m").describe("Maximum number of matches per file"),
			afterContext: o.number().alias("A").describe("Show <n> lines after match"),
			beforeContext: o.number().alias("B").describe("Show <n> lines before match"),
			context: o.number().alias("C").describe("Show <n> lines before and after match"),
			heading: f().describe("Show filename above matches"),
			break: f().describe("Print empty line between results from different files"),
			pattern: o.string().alias("e").repeatable().describe("Match <pattern>"),
		},
		handler: async (args, ctx, meta) => {
			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;
			const gitCtx = gitCtxOrError;

			// ── Parse positionals & passthrough ─────────────────────
			const positionals: string[] = args.args ?? [];
			const rawPathspecs: string[] = meta.passthrough ?? [];
			const patternStrs: string[] = args.pattern as string[];
			const revs: string[] = [];

			let posIdx = 0;
			if (patternStrs.length === 0) {
				if (positionals.length === 0) {
					return fatal("no pattern given");
				}
				patternStrs.push(positionals[posIdx++]!);
			}

			for (; posIdx < positionals.length; posIdx++) {
				revs.push(positionals[posIdx]!);
			}

			// ── Compile patterns ────────────────────────────────────
			const patterns: RegExp[] = [];
			for (const raw of patternStrs) {
				const compiled = compilePattern(
					raw,
					!!args.fixedStrings,
					!!args.ignoreCase,
					!!args.wordRegexp,
				);
				if (isCommandError(compiled)) return compiled;
				patterns.push(compiled);
			}

			// ── Resolve search sources ──────────────────────────────
			interface SearchSource {
				prefix: string;
				files: GrepFile[];
			}
			const sources: SearchSource[] = [];

			if (revs.length > 0) {
				for (const rev of revs) {
					const resolved = await requireRevision(gitCtx, rev);
					if (isCommandError(resolved)) return resolved;
					let commitHash: ObjectId;
					try {
						commitHash = await peelToCommit(gitCtx, resolved);
					} catch {
						return fatal(`bad revision '${rev}'`);
					}
					const commit = await readCommit(gitCtx, commitHash);
					const files = await filesFromTree(gitCtx, commit.tree);
					sources.push({ prefix: `${rev}:`, files });
				}
			} else if (args.cached) {
				sources.push({ prefix: "", files: await filesFromIndex(gitCtx) });
			} else {
				if (!gitCtx.workTree) {
					return fatal("this operation must be run in a work tree");
				}
				sources.push({ prefix: "", files: await filesFromWorktree(gitCtx) });
			}

			// ── Pathspec filtering ──────────────────────────────────
			const cwdPrefix = getCwdPrefix(gitCtx, ctx.cwd);
			let specs: Pathspec[] | null = null;
			if (rawPathspecs.length > 0) {
				specs = rawPathspecs.map((r) => parsePathspec(r, cwdPrefix));
			}

			const maxDepth = args.maxDepth as number | undefined;
			const maxCount = args.maxCount as number | undefined;

			// ── Flags ───────────────────────────────────────────────
			const showLineNumber = !!(
				args.lineNumber ||
				args.afterContext != null ||
				args.beforeContext != null ||
				args.context != null
			);
			const filesOnly = !!args.filesWithMatches;
			const filesWithout = !!args.filesWithoutMatch;
			const countOnly = !!args.count;
			const quietMode = !!args.quiet;
			const useHeading = !!args.heading;
			const useBreak = !!(args as any).break;
			const suppressFile = !!args.suppressFilename;
			const invert = !!args.invertMatch;
			const allMatch = !!args.allMatch;

			const afterCtx =
				(args.context as number | undefined) ?? (args.afterContext as number | undefined) ?? 0;
			const beforeCtx =
				(args.context as number | undefined) ?? (args.beforeContext as number | undefined) ?? 0;
			const hasContext = afterCtx > 0 || beforeCtx > 0;

			// ── Search ──────────────────────────────────────────────
			const outputLines: string[] = [];
			let anyMatch = false;
			let firstFileOutput = true;

			for (const source of sources) {
				const sortedFiles = source.files
					.slice()
					.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

				for (const file of sortedFiles) {
					if (specs && !matchPathspecs(specs, file.path)) continue;
					if (maxDepth !== undefined && pathDepth(file.path) > maxDepth) continue;

					const content = await file.getContent();
					const result = grepFileContent(content, patterns, allMatch, invert);

					const dp = displayPath(file.path, cwdPrefix, !!args.fullName);
					const prefix = source.prefix;

					if (result.binary) {
						anyMatch = true;
						if (quietMode) return { stdout: "", stderr: "", exitCode: 0 };
						if (filesOnly) {
							outputLines.push(`${prefix}${dp}`);
						} else if (!filesWithout && !countOnly) {
							outputLines.push(`Binary file ${prefix}${dp} matches`);
						}
						continue;
					}

					if (result.matches.length === 0) {
						if (filesWithout) {
							outputLines.push(`${prefix}${dp}`);
						}
						continue;
					}

					anyMatch = true;
					if (quietMode) return { stdout: "", stderr: "", exitCode: 0 };
					if (filesWithout) continue;

					if (filesOnly) {
						outputLines.push(`${prefix}${dp}`);
						continue;
					}

					if (countOnly) {
						const count =
							maxCount !== undefined
								? Math.min(result.matches.length, maxCount)
								: result.matches.length;
						outputLines.push(`${prefix}${dp}:${count}`);
						continue;
					}

					let matches = result.matches;
					if (maxCount !== undefined) {
						matches = matches.slice(0, maxCount);
					}

					if (hasContext) {
						formatWithContext(
							outputLines,
							content,
							matches,
							prefix,
							dp,
							suppressFile,
							beforeCtx,
							afterCtx,
							useHeading,
							useBreak,
							firstFileOutput,
						);
					} else if (useHeading) {
						if (!firstFileOutput && useBreak) outputLines.push("");
						outputLines.push(`${prefix}${dp}`);
						for (const m of matches) {
							if (showLineNumber) {
								outputLines.push(`${m.lineNo}:${m.line}`);
							} else {
								outputLines.push(m.line);
							}
						}
					} else {
						if (!firstFileOutput && useBreak) outputLines.push("");
						for (const m of matches) {
							const filePart = suppressFile ? "" : `${prefix}${dp}:`;
							if (showLineNumber) {
								outputLines.push(`${filePart}${m.lineNo}:${m.line}`);
							} else {
								outputLines.push(`${filePart}${m.line}`);
							}
						}
					}

					firstFileOutput = false;
				}
			}

			if (quietMode) {
				return { stdout: "", stderr: "", exitCode: anyMatch ? 0 : 1 };
			}

			const stdout = outputLines.length > 0 ? `${outputLines.join("\n")}\n` : "";
			return { stdout, stderr: "", exitCode: anyMatch ? 0 : 1 };
		},
	});
}

// ── Context output helper ───────────────────────────────────────────

function formatWithContext(
	out: string[],
	content: string,
	matches: GrepMatch[],
	prefix: string,
	dp: string,
	suppressFile: boolean,
	before: number,
	after: number,
	useHeading: boolean,
	useBreak: boolean,
	isFirstFile: boolean,
): void {
	const lines = content.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

	const matchLineNos = new Set(matches.map((m) => m.lineNo));

	const ranges: Array<[number, number]> = [];
	for (const m of matches) {
		const start = Math.max(1, m.lineNo - before);
		const end = Math.min(lines.length, m.lineNo + after);
		ranges.push([start, end]);
	}

	const merged: Array<[number, number]> = [];
	for (const [s, e] of ranges) {
		if (merged.length > 0 && s <= merged[merged.length - 1]![1] + 1) {
			merged[merged.length - 1]![1] = Math.max(merged[merged.length - 1]![1], e);
		} else {
			merged.push([s, e]);
		}
	}

	const filePart = suppressFile ? "" : `${prefix}${dp}`;

	if (useHeading) {
		if (!isFirstFile && useBreak) out.push("");
		out.push(`${prefix}${dp}`);
	} else if (!isFirstFile && useBreak) {
		out.push("");
	}

	for (let gi = 0; gi < merged.length; gi++) {
		if (gi > 0) out.push("--");
		const [start, end] = merged[gi]!;
		for (let lineNo = start; lineNo <= end; lineNo++) {
			const line = lines[lineNo - 1]!;
			const isMatch = matchLineNos.has(lineNo);
			const sep = isMatch ? ":" : "-";
			if (useHeading) {
				out.push(`${lineNo}${sep}${line}`);
			} else {
				out.push(`${filePart}${sep}${lineNo}${sep}${line}`);
			}
		}
	}
}
