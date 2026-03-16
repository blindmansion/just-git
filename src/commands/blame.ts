import type { GitExtensions } from "../git.ts";
import { type BlameEntry, blame } from "../lib/blame.ts";
import {
	fatal,
	isCommandError,
	requireGitContext,
	requireHead,
	requireRevision,
} from "../lib/command-utils.ts";
import { isBinaryStr, peelToCommit, readBlobContent } from "../lib/object-db.ts";
import { flattenTreeToMap } from "../lib/tree-ops.ts";
import { readCommit } from "../lib/object-db.ts";
import { relative } from "../lib/path.ts";
import type { ObjectId } from "../lib/types.ts";
import { a, type Command, f, o } from "../parse/index.ts";

// ── Date formatting ──────────────────────────────────────────────────

function parseTzOffset(tz: string): number {
	const sign = tz.startsWith("-") ? -1 : 1;
	const abs = tz.replace(/^[+-]/, "");
	const h = parseInt(abs.slice(0, 2), 10) || 0;
	const m = parseInt(abs.slice(2, 4), 10) || 0;
	return sign * (h * 60 + m);
}

function formatBlameDate(timestamp: number, timezone: string): string {
	const offsetMinutes = parseTzOffset(timezone);
	const date = new Date((timestamp + offsetMinutes * 60) * 1000);
	const year = date.getUTCFullYear();
	const month = (date.getUTCMonth() + 1).toString().padStart(2, "0");
	const day = date.getUTCDate().toString().padStart(2, "0");
	const hours = date.getUTCHours().toString().padStart(2, "0");
	const minutes = date.getUTCMinutes().toString().padStart(2, "0");
	const seconds = date.getUTCSeconds().toString().padStart(2, "0");
	return `${year}-${month}-${day} ${hours}:${minutes}:${seconds} ${timezone}`;
}

// ── Output formatting ────────────────────────────────────────────────

function formatDefault(
	entries: BlameEntry[],
	finalPath: string,
	longHash: boolean,
	showEmail: boolean,
	suppress: boolean,
): string {
	if (entries.length === 0) return "";

	const maxLineNo = Math.max(...entries.map((e) => e.finalLine));
	const lineNoWidth = String(maxLineNo).length;

	const hasRename = entries.some((e) => e.origPath !== finalPath);

	let maxAuthorWidth = 0;
	if (!suppress) {
		for (const e of entries) {
			const label = showEmail ? `<${e.author.email}>` : e.author.name;
			if (label.length > maxAuthorWidth) maxAuthorWidth = label.length;
		}
	}

	let maxPathWidth = 0;
	if (hasRename) {
		for (const e of entries) {
			if (e.origPath.length > maxPathWidth) maxPathWidth = e.origPath.length;
		}
	}

	const lines: string[] = [];
	for (const e of entries) {
		let hash: string;
		if (longHash) {
			hash = e.boundary ? `^${e.hash.slice(0, 39)}` : e.hash;
		} else {
			hash = e.boundary ? `^${e.hash.slice(0, 7)}` : e.hash.slice(0, 8);
		}

		const filenamePart = hasRename ? ` ${e.origPath.padEnd(maxPathWidth)}` : "";

		if (suppress) {
			lines.push(
				`${hash}${filenamePart} ${String(e.finalLine).padStart(lineNoWidth)}) ${e.content}`,
			);
		} else {
			const authorLabel = showEmail ? `<${e.author.email}>` : e.author.name;
			const date = formatBlameDate(e.author.timestamp, e.author.timezone);
			lines.push(
				`${hash}${filenamePart} (${authorLabel.padEnd(maxAuthorWidth)} ${date} ${String(e.finalLine).padStart(lineNoWidth)}) ${e.content}`,
			);
		}
	}

	return `${lines.join("\n")}\n`;
}

function formatPorcelain(entries: BlameEntry[], lineFormat: boolean): string {
	const seen = new Set<ObjectId>();
	const lines: string[] = [];

	for (const e of entries) {
		const firstTime = !seen.has(e.hash);
		seen.add(e.hash);

		lines.push(`${e.hash} ${e.origLine} ${e.finalLine} 1`);

		if (firstTime || lineFormat) {
			lines.push(`author ${e.author.name}`);
			lines.push(`author-mail <${e.author.email}>`);
			lines.push(`author-time ${e.author.timestamp}`);
			lines.push(`author-tz ${e.author.timezone}`);
			lines.push(`committer ${e.committer.name}`);
			lines.push(`committer-mail <${e.committer.email}>`);
			lines.push(`committer-time ${e.committer.timestamp}`);
			lines.push(`committer-tz ${e.committer.timezone}`);
			lines.push(`summary ${e.summary}`);
			if (e.boundary) lines.push("boundary");
			if (e.previous) {
				lines.push(`previous ${e.previous.hash} ${e.previous.path}`);
			}
			lines.push(`filename ${e.origPath}`);
		}

		lines.push(`\t${e.content}`);
	}

	return `${lines.join("\n")}\n`;
}

// ── Arg resolution ───────────────────────────────────────────────────

function resolveFilePath(rawPath: string, cwd: string, workTree: string): string {
	if (rawPath.startsWith("/")) {
		return relative(workTree, rawPath);
	}
	const cwdRel = relative(workTree, cwd);
	if (cwdRel === "" || cwdRel === ".") return rawPath;
	return `${cwdRel}/${rawPath}`;
}

// ── Command registration ─────────────────────────────────────────────

export function registerBlameCommand(parent: Command, ext?: GitExtensions) {
	parent.command("blame", {
		description: "Show what revision and author last modified each line of a file",
		args: [a.string().name("args").variadic().optional()],
		options: {
			lineRange: o
				.string()
				.alias("L")
				.describe("Annotate only the given line range (<start>,<end>)"),
			long: f().alias("l").describe("Show long revision"),
			showEmail: f().alias("e").describe("Show author email instead of name"),
			suppress: f().alias("s").describe("Suppress author name and date"),
			porcelain: f().alias("p").describe("Show in machine-readable format"),
			linePorcelain: f().describe("Show porcelain format with full headers for each line"),
		},
		handler: async (args, ctx, meta) => {
			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;
			const gitCtx = gitCtxOrError;

			if (!gitCtx.workTree) {
				return fatal("this operation must be run in a work tree");
			}

			const headHash = await requireHead(gitCtx);
			if (isCommandError(headHash)) return headHash;

			const positionals: string[] = args.args ?? [];
			const passthrough: string[] = meta.passthrough ?? [];

			let rev: string | null = null;
			let filePath: string | null = null;

			if (passthrough.length > 0) {
				filePath = passthrough[passthrough.length - 1] as string;
				if (positionals.length > 0) {
					rev = positionals[0] as string;
				}
			} else if (positionals.length === 2) {
				rev = positionals[0] as string;
				filePath = positionals[1] as string;
			} else if (positionals.length === 1) {
				filePath = positionals[0] as string;
			}

			if (!filePath) {
				return fatal("no file specified");
			}

			const resolvedPath = resolveFilePath(filePath, ctx.cwd, gitCtx.workTree);

			let commitHash: ObjectId;
			if (rev) {
				const resolved = await requireRevision(gitCtx, rev);
				if (isCommandError(resolved)) return resolved;
				commitHash = await peelToCommit(gitCtx, resolved);
			} else {
				commitHash = headHash;
			}

			const commit = await readCommit(gitCtx, commitHash);
			const treeMap = await flattenTreeToMap(gitCtx, commit.tree);
			if (!treeMap.has(resolvedPath)) {
				return fatal(`no such path ${resolvedPath} in ${rev ?? "HEAD"}`);
			}

			const blobHash = treeMap.get(resolvedPath)!.hash;
			const content = await readBlobContent(gitCtx, blobHash);
			if (isBinaryStr(content)) {
				return fatal(`cannot blame binary file '${resolvedPath}'`);
			}

			let startLine: number | undefined;
			let endLine: number | undefined;
			if (args.lineRange) {
				const rangeStr = args.lineRange as string;
				const match = rangeStr.match(/^(\d+),(\d+)$/);
				if (match) {
					startLine = parseInt(match[1]!, 10);
					endLine = parseInt(match[2]!, 10);
				} else {
					return fatal(`invalid -L range: '${rangeStr}'`);
				}
			}

			let entries: BlameEntry[];
			try {
				entries = await blame(gitCtx, commitHash, resolvedPath, { startLine, endLine });
			} catch (e: unknown) {
				const msg = e instanceof Error ? e.message : String(e);
				return fatal(msg);
			}

			let stdout: string;
			if (args.porcelain || args.linePorcelain) {
				stdout = formatPorcelain(entries, !!args.linePorcelain);
			} else {
				stdout = formatDefault(
					entries,
					resolvedPath,
					!!args.long,
					!!args.showEmail,
					!!args.suppress,
				);
			}

			return { stdout, stderr: "", exitCode: 0 };
		},
	});
}
