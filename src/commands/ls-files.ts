import type { GitExtensions } from "../git.ts";
import { isCommandError, requireGitContext, requireWorkTree } from "../lib/command-utils.ts";
import { readIndex } from "../lib/index.ts";
import { join } from "../lib/path.ts";
import { matchPathspecs, parsePathspec } from "../lib/pathspec.ts";
import { hashWorktreeEntry, lstatSafe } from "../lib/symlink.ts";
import type { GitContext, Index, IndexEntry } from "../lib/types.ts";
import { walkWorkTree } from "../lib/worktree.ts";
import { type Command, f } from "../parse/index.ts";

export function registerLsFilesCommand(parent: Command, ext?: GitExtensions): void {
	parent.command("ls-files", {
		description: "Show information about files in the index and the working tree",
		options: {
			cached: f().alias("c").describe("Show cached files (default)"),
			modified: f().alias("m").describe("Show modified files"),
			deleted: f().alias("d").describe("Show deleted files"),
			others: f().alias("o").describe("Show other (untracked) files"),
			unmerged: f().alias("u").describe("Show unmerged files"),
			stage: f().alias("s").describe("Show staged contents' mode, hash, and stage number"),
			"exclude-standard": f().describe(
				"Add standard git exclusions (.gitignore, info/exclude, core.excludesFile)",
			),
			"nul-terminate": f().alias("z").describe("Use \\0 as line terminator instead of \\n"),
			"show-tags": f().alias("t").describe("Show status tags"),
		},
		handler: async (_args, ctx, meta) => {
			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;
			const gitCtx = gitCtxOrError;

			const wtError = requireWorkTree(gitCtx);
			if (wtError) return wtError;
			const workTree = gitCtx.workTree as string;

			let showCached = _args.cached;
			const showModified = _args.modified;
			const showDeleted = _args.deleted;
			const showOthers = _args.others;
			const showUnmerged = _args.unmerged;
			const showStage = _args.stage;
			const excludeStandard = _args["exclude-standard"];
			const nulTerminate = _args["nul-terminate"];
			const showTags = _args["show-tags"];

			const hasExplicitMode =
				showCached || showModified || showDeleted || showOthers || showUnmerged;
			if (!hasExplicitMode) {
				showCached = true;
			}

			const index = await readIndex(gitCtx);
			const terminator = nulTerminate ? "\0" : "\n";

			const pathspecs =
				meta.passthrough.length > 0
					? meta.passthrough.map((p) => {
							const rel = ctx.cwd !== workTree ? relativePrefix(workTree, ctx.cwd) : "";
							return parsePathspec(p, rel);
						})
					: null;

			const lines: string[] = [];

			if (showCached) {
				for (const entry of index.entries) {
					if (pathspecs && !matchPathspecs(pathspecs, entry.path)) continue;
					const tag = showTags ? (entry.stage > 0 ? "M" : "H") : null;
					lines.push(formatEntry(entry, showStage, tag));
				}
			}

			if (showUnmerged && !showCached) {
				for (const entry of index.entries) {
					if (entry.stage === 0) continue;
					if (pathspecs && !matchPathspecs(pathspecs, entry.path)) continue;
					lines.push(formatEntry(entry, true, showTags ? "M" : null));
				}
			}

			if (showModified || showDeleted) {
				const diffs = await getModifiedDeleted(gitCtx, workTree, index);
				for (const { path, status } of diffs) {
					if (status === "modified" && !showModified) continue;
					if (status === "deleted" && !showDeleted) continue;
					if (pathspecs && !matchPathspecs(pathspecs, path)) continue;
					const tag = showTags ? (status === "deleted" ? "R" : "C") : null;
					lines.push(tag ? `${tag} ${path}` : path);
				}
			}

			if (showOthers) {
				const others = await getOtherFiles(gitCtx, workTree, index, excludeStandard);
				for (const path of others) {
					if (pathspecs && !matchPathspecs(pathspecs, path)) continue;
					lines.push(showTags ? `? ${path}` : path);
				}
			}

			const stdout = lines.length > 0 ? lines.join(terminator) + terminator : "";
			return { stdout, stderr: "", exitCode: 0 };
		},
	});
}

function formatEntry(entry: IndexEntry, showStage: boolean, tag: string | null): string {
	if (showStage) {
		const mode = entry.mode.toString(8).padStart(6, "0");
		const prefix = tag ? `${tag} ` : "";
		return `${prefix}${mode} ${entry.hash} ${entry.stage}\t${entry.path}`;
	}
	return tag ? `${tag} ${entry.path}` : entry.path;
}

function relativePrefix(workTree: string, cwd: string): string {
	if (cwd === workTree) return "";
	if (cwd.startsWith(`${workTree}/`)) {
		return cwd.slice(workTree.length + 1);
	}
	return "";
}

async function getModifiedDeleted(
	ctx: GitContext,
	workTree: string,
	index: Index,
): Promise<{ path: string; status: "modified" | "deleted" }[]> {
	const results: { path: string; status: "modified" | "deleted" }[] = [];
	for (const entry of index.entries) {
		if (entry.stage !== 0) continue;
		const fullPath = join(workTree, entry.path);
		const exists = await ctx.fs.exists(fullPath);
		if (!exists) {
			results.push({ path: entry.path, status: "deleted" });
			continue;
		}
		const st = await lstatSafe(ctx.fs, fullPath);
		if (!st.isFile && !st.isSymbolicLink) continue;
		const wtHash = await hashWorktreeEntry(ctx.fs, fullPath);
		if (wtHash !== entry.hash) {
			results.push({ path: entry.path, status: "modified" });
		}
	}
	return results;
}

async function getOtherFiles(
	ctx: GitContext,
	workTree: string,
	index: Index,
	excludeStandard: boolean,
): Promise<string[]> {
	const indexPaths = new Set(index.entries.map((e) => e.path));
	const allFiles = await walkWorkTree(ctx, workTree, "", {
		skipIgnore: !excludeStandard,
	});
	return allFiles.filter((p) => !indexPaths.has(p));
}
