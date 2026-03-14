import type { GitExtensions } from "../git.ts";
import { restoreConflicted, restoreFiles } from "../lib/checkout-utils.ts";
import {
	err,
	fatal,
	getCwdPrefix,
	isCommandError,
	requireCommit,
	requireGitContext,
} from "../lib/command-utils.ts";
import { addEntry, defaultStat, readIndex, removeEntry, writeIndex } from "../lib/index.ts";
import { readCommit } from "../lib/object-db.ts";
import { matchPathspecs, parsePathspec } from "../lib/pathspec.ts";
import { resolveHead } from "../lib/refs.ts";
import { flattenTreeToMap } from "../lib/tree-ops.ts";
import type { GitContext, ObjectId } from "../lib/types.ts";
import { checkoutEntry } from "../lib/worktree.ts";
import { a, type Command, f, o } from "../parse/index.ts";

export function registerRestoreCommand(parent: Command, ext?: GitExtensions) {
	parent.command("restore", {
		description: "Restore working tree files",
		args: [a.string().name("pathspec").variadic().optional()],
		options: {
			source: o.string().alias("s").describe("Restore from tree-ish"),
			staged: f().alias("S").describe("Restore the index"),
			worktree: f().alias("W").describe("Restore the working tree (default)"),
			ours: f().describe("Checkout our version for unmerged files"),
			theirs: f().describe("Checkout their version for unmerged files"),
		},
		handler: async (args, ctx, meta) => {
			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;
			const gitCtx = gitCtxOrError;

			const paths: string[] = [...(args.pathspec ?? []), ...meta.passthrough];

			if (paths.length === 0) {
				return fatal("you must specify path(s) to restore");
			}

			if (args.ours && args.theirs) {
				return fatal("--ours and --theirs are incompatible");
			}

			const doStaged = !!args.staged;
			const doWorktree = args.worktree !== undefined ? !!args.worktree : !doStaged;

			const cwdPrefix = getCwdPrefix(gitCtx, ctx.cwd);

			// ── --ours / --theirs ─────────────────────────────────
			if (args.ours || args.theirs) {
				if (args.source) {
					return fatal("cannot specify both --source and --ours/--theirs");
				}
				if (doStaged) {
					return fatal("cannot use --ours/--theirs with --staged");
				}
				return restoreConflicted(gitCtx, paths, cwdPrefix, args.theirs ? 3 : 2, {
					deleteOnMissing: true,
				});
			}

			// ── Resolve source tree ───────────────────────────────
			let sourceTree: ObjectId | null = null;

			if (args.source) {
				const result = await requireCommit(
					gitCtx,
					args.source,
					`could not resolve '${args.source}'`,
				);
				if (isCommandError(result)) return result;
				sourceTree = result.commit.tree;
			} else if (doStaged) {
				// Default source for --staged is HEAD
				const headHash = await resolveHead(gitCtx);
				if (headHash) {
					const headCommit = await readCommit(gitCtx, headHash);
					sourceTree = headCommit.tree;
				}
			}

			// ── Restore both staged and worktree ──────────────────
			if (doStaged && doWorktree) {
				return restoreStagedAndWorktree(gitCtx, paths, cwdPrefix, sourceTree);
			}

			// ── Restore staged only (unstage) ─────────────────────
			if (doStaged) {
				return restoreStagedOnly(gitCtx, paths, cwdPrefix, sourceTree);
			}

			// ── Restore worktree only (default) ───────────────────
			if (sourceTree) {
				return restoreWorktreeFromTree(gitCtx, paths, cwdPrefix, sourceTree);
			}
			return restoreFiles(gitCtx, paths, cwdPrefix);
		},
	});
}

/**
 * Restore the index from a source tree without touching the worktree.
 * Similar to `git reset -- <paths>` but with restore semantics.
 */
async function restoreStagedOnly(
	gitCtx: GitContext,
	paths: string[],
	cwdPrefix: string,
	sourceTree: ObjectId | null,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const treeMap = await flattenTreeToMap(gitCtx, sourceTree);
	let index = await readIndex(gitCtx);
	const specs = paths.map((p) => parsePathspec(p, cwdPrefix));

	const allPaths = new Set<string>();
	for (const [p] of treeMap) allPaths.add(p);
	for (const e of index.entries) allPaths.add(e.path);

	let matched = false;
	for (const path of allPaths) {
		if (!matchPathspecs(specs, path)) continue;
		matched = true;
		const treeEntry = treeMap.get(path);
		if (treeEntry) {
			index = addEntry(index, {
				path: treeEntry.path,
				mode: parseInt(treeEntry.mode, 8),
				hash: treeEntry.hash,
				stage: 0,
				stat: defaultStat(),
			});
		} else {
			const hasConflict = index.entries.some((e) => e.path === path && e.stage > 0);
			if (hasConflict) {
				return {
					stdout: "",
					stderr: `error: path '${path}' is unmerged\n`,
					exitCode: 1,
				};
			}
			index = removeEntry(index, path);
		}
	}
	if (!matched) {
		return err(`error: pathspec '${paths[0]}' did not match any file(s) known to git\n`);
	}

	await writeIndex(gitCtx, index);
	return { stdout: "", stderr: "", exitCode: 0 };
}

/**
 * Restore worktree from a tree (--source <tree> without --staged).
 * Only touches the worktree, not the index.
 */
async function restoreWorktreeFromTree(
	gitCtx: GitContext,
	paths: string[],
	cwdPrefix: string,
	treeHash: ObjectId,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	if (!gitCtx.workTree) {
		return fatal("this operation must be run in a work tree");
	}

	const treeMap = await flattenTreeToMap(gitCtx, treeHash);
	const specs = paths.map((p) => parsePathspec(p, cwdPrefix));
	const matchedPaths: string[] = [];

	const index = await readIndex(gitCtx);
	const allPaths = new Set<string>();
	for (const [p] of treeMap) allPaths.add(p);
	for (const e of index.entries) allPaths.add(e.path);

	for (const path of allPaths) {
		if (matchPathspecs(specs, path)) {
			if (!treeMap.has(path)) {
				const hasConflict = index.entries.some((e) => e.path === path && e.stage !== 0);
				if (hasConflict) {
					return {
						stdout: "",
						stderr: `error: path '${path}' is unmerged\n`,
						exitCode: 1,
					};
				}
			}
			matchedPaths.push(path);
		}
	}
	if (matchedPaths.length === 0) {
		return err(`error: pathspec '${paths[0]}' did not match any file(s) known to git\n`);
	}

	for (const path of matchedPaths) {
		const treeEntry = treeMap.get(path);
		if (treeEntry) {
			await checkoutEntry(gitCtx, {
				path: treeEntry.path,
				hash: treeEntry.hash,
				mode: treeEntry.mode,
			});
		} else {
			const fullPath = `${gitCtx.workTree}/${path}`;
			if (await gitCtx.fs.exists(fullPath)) {
				await gitCtx.fs.rm(fullPath);
			}
		}
	}

	return { stdout: "", stderr: "", exitCode: 0 };
}

/**
 * Restore both staged and worktree from a source tree.
 * Updates the index entries and writes files to the worktree.
 */
async function restoreStagedAndWorktree(
	gitCtx: GitContext,
	paths: string[],
	cwdPrefix: string,
	sourceTree: ObjectId | null,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	if (!gitCtx.workTree) {
		return fatal("this operation must be run in a work tree");
	}

	const treeMap = await flattenTreeToMap(gitCtx, sourceTree);
	let index = await readIndex(gitCtx);
	const specs = paths.map((p) => parsePathspec(p, cwdPrefix));
	const matchedPaths: string[] = [];

	const allPaths = new Set<string>();
	for (const [p] of treeMap) allPaths.add(p);
	for (const e of index.entries) allPaths.add(e.path);

	for (const path of allPaths) {
		if (matchPathspecs(specs, path)) {
			matchedPaths.push(path);
		}
	}
	if (matchedPaths.length === 0) {
		return err(`error: pathspec '${paths[0]}' did not match any file(s) known to git\n`);
	}

	for (const path of matchedPaths) {
		const treeEntry = treeMap.get(path);
		if (treeEntry) {
			index = addEntry(index, {
				path: treeEntry.path,
				mode: parseInt(treeEntry.mode, 8),
				hash: treeEntry.hash,
				stage: 0,
				stat: defaultStat(),
			});
			await checkoutEntry(gitCtx, {
				path: treeEntry.path,
				hash: treeEntry.hash,
				mode: treeEntry.mode,
			});
		} else {
			const hasConflict = index.entries.some((e) => e.path === path && e.stage > 0);
			if (hasConflict) {
				return {
					stdout: "",
					stderr: `error: path '${path}' is unmerged\n`,
					exitCode: 1,
				};
			}
			index = removeEntry(index, path);
			const fullPath = `${gitCtx.workTree}/${path}`;
			if (await gitCtx.fs.exists(fullPath)) {
				await gitCtx.fs.rm(fullPath);
			}
		}
	}

	await writeIndex(gitCtx, index);
	return { stdout: "", stderr: "", exitCode: 0 };
}
