import type { GitExtensions } from "../git.ts";
import {
	err,
	fatal,
	getCwdPrefix,
	isCommandError,
	requireGitContext,
	requireWorkTree,
} from "../lib/command-utils.ts";
import { readIndex, removeEntry, writeIndex } from "../lib/index.ts";
import { readCommit } from "../lib/object-db.ts";
import { join, relative, resolve } from "../lib/path.ts";
import { containsWildcard, matchPathspecs, parsePathspec } from "../lib/pathspec.ts";
import { resolveHead } from "../lib/refs.ts";
import { hashWorktreeEntry, lstatSafe } from "../lib/symlink.ts";
import { flattenTree } from "../lib/tree-ops.ts";
import type { GitContext, Index, ObjectId } from "../lib/types.ts";
import { a, type Command, f } from "../parse/index.ts";

export function registerRmCommand(parent: Command, ext?: GitExtensions) {
	parent.command("rm", {
		description: "Remove files from the working tree and from the index",
		args: [a.string().name("paths").describe("Files to remove").optional().variadic()],
		options: {
			cached: f().describe("Only remove from the index"),
			recursive: f().alias("r").describe("Allow recursive removal when a directory name is given"),
			force: f().alias("f").describe("Override the up-to-date check"),
			dryRun: f().alias("n").describe("Don't actually remove any file(s)"),
		},
		handler: async (args, ctx) => {
			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;
			const gitCtx = gitCtxOrError;

			const workTreeError = requireWorkTree(gitCtx);
			if (workTreeError) return workTreeError;
			const workTree = gitCtx.workTree as string;

			const paths = args.paths;
			if (paths.length === 0) {
				return err("usage: git rm [--cached] [-f] [-r] <file>...");
			}

			const cached = args.cached;
			const recursive = args.recursive;
			const force = args.force;

			let index = await readIndex(gitCtx);

			// ── Resolve paths to index entries ──────────────────────────
			const entriesToRemove: string[] = [];
			const cwdPrefix = getCwdPrefix(gitCtx, ctx.cwd);

			for (const p of paths) {
				if (containsWildcard(p)) {
					// Glob pathspec: filter index entries
					const specs = [parsePathspec(p, cwdPrefix)];
					const matched = index.entries.filter((e) => matchPathspecs(specs, e.path));
					if (matched.length === 0) {
						return fatal(`pathspec '${p}' did not match any files`);
					}
					for (const e of matched) {
						entriesToRemove.push(e.path);
					}
					continue;
				}

				const absPath = resolve(ctx.cwd, p);
				let relPath = relative(workTree, absPath);

				if (relPath === "." || relPath === "") {
					relPath = "";
				}

				if (relPath.startsWith("..")) {
					return fatal(`'${p}' is outside repository at '${workTree}'`);
				}

				// Check if it's a real directory (not a symlink to a directory)
				const isDir =
					(await ctx.fs.exists(absPath)) &&
					!(await lstatSafe(ctx.fs, absPath)).isSymbolicLink &&
					(await lstatSafe(ctx.fs, absPath)).isDirectory;

				if (isDir) {
					if (!recursive) {
						return fatal(`not removing '${relPath}' recursively without -r`);
					}
					const prefix = relPath === "" ? "" : `${relPath}/`;
					const matched = index.entries.filter((e) => prefix === "" || e.path.startsWith(prefix));
					if (matched.length === 0) {
						return fatal(`pathspec '${p}' did not match any files`);
					}
					for (const e of matched) {
						entriesToRemove.push(e.path);
					}
				} else {
					const inIndex = index.entries.some((e) => e.path === relPath);
					if (!inIndex) {
						return fatal(`pathspec '${p}' did not match any files`);
					}
					entriesToRemove.push(relPath);
				}
			}

			// ── Safety checks ───────────────────────────────────────────
			if (!force) {
				const result = await checkSafety(gitCtx, index, entriesToRemove, cached);
				if (result) return result;
			}

			// ── Dry-run: just print what would be removed ───────────────
			if (args.dryRun) {
				const removedLines = entriesToRemove.map((p) => `rm '${p}'`);
				const stdout = removedLines.length > 0 ? `${removedLines.join("\n")}\n` : "";
				return { stdout, stderr: "", exitCode: 0 };
			}

			// ── Perform removal ─────────────────────────────────────────
			const removedLines: string[] = [];
			for (const path of entriesToRemove) {
				index = removeEntry(index, path);

				if (!cached) {
					const fullPath = join(workTree, path);
					const present = await lstatSafe(ctx.fs, fullPath)
						.then(() => true)
						.catch(() => false);
					if (present) {
						await ctx.fs.rm(fullPath);
					}
				}
				removedLines.push(`rm '${path}'`);
			}

			await writeIndex(gitCtx, index);
			const stdout = removedLines.length > 0 ? `${removedLines.join("\n")}\n` : "";
			return { stdout, stderr: "", exitCode: 0 };
		},
	});
}

// ── Safety checks ───────────────────────────────────────────────────

/**
 * Check whether removing the given entries would lose uncommitted work.
 * Returns an error response if removal should be refused, or null if safe.
 *
 * Logic matches real git:
 * - staged_changes: index hash differs from HEAD tree hash (or path not in HEAD)
 * - local_changes: working tree content differs from index hash (or file missing)
 *
 * Refusal rules:
 * - Both staged + local: always refuse (even with --cached)
 * - Only staged, without --cached: refuse
 * - Only local, without --cached: refuse
 * - With --cached: only refuse if both staged + local
 */
async function checkSafety(
	gitCtx: GitContext,
	index: Index,
	paths: string[],
	cached: boolean,
): Promise<{ stdout: string; stderr: string; exitCode: number } | null> {
	// Build HEAD tree map
	const headHash = await resolveHead(gitCtx);
	const headMap = new Map<string, ObjectId>();
	if (headHash) {
		const headCommit = await readCommit(gitCtx, headHash);
		const treeEntries = await flattenTree(gitCtx, headCommit.tree);
		for (const e of treeEntries) {
			headMap.set(e.path, e.hash);
		}
	}

	const bothChanged: string[] = [];
	const stagedOnly: string[] = [];
	const localOnly: string[] = [];

	for (const path of paths) {
		const entry = index.entries.find((e) => e.path === path && e.stage === 0);
		if (!entry) continue;

		// Check staged: index differs from HEAD
		const headEntryHash = headMap.get(path);
		const staged = headEntryHash !== entry.hash; // also true if not in HEAD

		// Check local: working tree differs from index
		// Always check this — needed even with --cached for the "both" case
		let local = false;
		if (gitCtx.workTree) {
			const fullPath = join(gitCtx.workTree, path);
			let filePresent = false;
			try {
				await lstatSafe(gitCtx.fs, fullPath);
				filePresent = true;
			} catch {
				filePresent = false;
			}
			if (filePresent) {
				const wtHash = await hashWorktreeEntry(gitCtx.fs, fullPath);
				local = wtHash !== entry.hash;
			}
		}

		if (staged && local) {
			bothChanged.push(path);
		} else if (staged && !cached) {
			stagedOnly.push(path);
		} else if (local && !cached) {
			localOnly.push(path);
		}
	}

	// Report errors (real git batches all problematic files per category)
	if (bothChanged.length > 0) {
		const fileList = bothChanged.map((p) => `    ${p}`).join("\n");
		const noun = bothChanged.length === 1 ? "the following file has" : "the following files have";
		return err(
			`error: ${noun} staged content different from both the\nfile and the HEAD:\n${fileList}\n(use -f to force removal)\n`,
		);
	}

	if (stagedOnly.length > 0) {
		const fileList = stagedOnly.map((p) => `    ${p}`).join("\n");
		const noun = stagedOnly.length === 1 ? "the following file has" : "the following files have";
		return err(
			`error: ${noun} changes staged in the index:\n${fileList}\n(use --cached to keep the file, or -f to force removal)\n`,
		);
	}

	if (localOnly.length > 0) {
		const fileList = localOnly.map((p) => `    ${p}`).join("\n");
		const noun = localOnly.length === 1 ? "the following file has" : "the following files have";
		return err(
			`error: ${noun} local modifications:\n${fileList}\n(use --cached to keep the file, or -f to force removal)\n`,
		);
	}

	return null;
}
