import type { GitExtensions } from "../git.ts";
import {
	err,
	fatal,
	getCwdPrefix,
	isCommandError,
	requireGitContext,
	requireWorkTree,
} from "../lib/command-utils.ts";
import { isIgnored, loadBaseIgnore, pushDirIgnore } from "../lib/ignore.ts";
import { readIndex, removeEntry, writeIndex } from "../lib/index.ts";
import { join, relative, resolve } from "../lib/path.ts";
import {
	containsWildcard,
	matchPathspec,
	matchPathspecs,
	PATHSPEC_EXCLUDE,
	type Pathspec,
	parsePathspec,
} from "../lib/pathspec.ts";
import type { GitContext, Index } from "../lib/types.ts";
import { stageFile, walkWorkTree } from "../lib/worktree.ts";
import { a, type Command, f } from "../parse/index.ts";

interface AddOptions {
	skipIgnore?: boolean;
	updateOnly?: boolean;
	actions?: string[];
}

export function registerAddCommand(parent: Command, ext?: GitExtensions) {
	parent.command("add", {
		description: "Add file contents to the index",
		args: [a.string().name("paths").describe("Pathspec of files to add").optional().variadic()],
		options: {
			all: f().alias("A").describe("Add changes from all tracked and untracked files"),
			force: f().alias("f").describe("Allow adding otherwise ignored files"),
			update: f().alias("u").describe("Update tracked files"),
			"dry-run": f().alias("n").describe("Don't actually add the file(s)"),
		},
		handler: async (args, ctx) => {
			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;
			const gitCtx = gitCtxOrError;

			const workTreeError = requireWorkTree(gitCtx);
			if (workTreeError) return workTreeError;
			const workTree = gitCtx.workTree as string;

			const opts: AddOptions = {
				skipIgnore: args.force,
				updateOnly: args.update,
				actions: args["dry-run"] ? [] : undefined,
			};

			const paths = args.paths;

			// -A or -u without paths: operate on entire worktree
			if ((args.all || args.update) && paths.length === 0) {
				let index = await readIndex(gitCtx);
				index = await stageDirectory(gitCtx, index, workTree, "", opts);
				if (!args["dry-run"]) await writeIndex(gitCtx, index);
				const stdout = opts.actions ? opts.actions.join("") : "";
				return { stdout, stderr: "", exitCode: 0 };
			}

			if (paths.length === 0) {
				return {
					stdout: "",
					stderr: "Nothing specified, nothing added.\nMaybe you wanted to say 'git add .'?",
					exitCode: 0,
				};
			}

			let index = await readIndex(gitCtx);

			// Separate literal paths from glob pathspecs
			const literalPaths: string[] = [];
			const globRaws: string[] = [];
			for (const p of paths) {
				if (containsWildcard(p)) {
					globRaws.push(p);
				} else {
					literalPaths.push(p);
				}
			}

			// Process literal paths (existing fast path)
			const ignoredPaths: string[] = [];
			for (const p of literalPaths) {
				const absPath = resolve(ctx.cwd, p);
				let relPath = relative(workTree, absPath);

				if (relPath === "." || relPath === "") {
					relPath = "";
				}

				if (relPath.startsWith("..")) {
					return fatal(`'${p}' is outside repository at '${workTree}'`);
				}

				const exists = await ctx.fs.exists(absPath);

				if (exists) {
					if (!args.force && relPath !== "") {
						const isTracked = index.entries.some(
							(e) => e.path === relPath || e.path.startsWith(`${relPath}/`),
						);
						const ignoredAs = await checkExplicitPathIgnored(gitCtx, workTree, relPath, isTracked);
						if (ignoredAs) {
							ignoredPaths.push(ignoredAs);
							continue;
						}
					}

					const stat = await ctx.fs.stat(absPath);
					if (stat.isDirectory) {
						index = await stageDirectory(gitCtx, index, absPath, relPath, opts);
					} else {
						const oldHash = index.entries.find((e) => e.path === relPath && e.stage === 0)?.hash;
						const result = await stageFile(gitCtx, index, relPath);
						index = result.index;
						if (opts.actions && result.hash !== oldHash) opts.actions.push(`add '${relPath}'\n`);
					}
				} else {
					const hasEntry = index.entries.some(
						(e) => e.path === relPath || e.path.startsWith(`${relPath}/`),
					);
					if (hasEntry) {
						if (opts.actions) {
							for (const e of index.entries) {
								if (e.path === relPath || e.path.startsWith(`${relPath}/`)) {
									opts.actions.push(`remove '${e.path}'\n`);
								}
							}
						}
						index = {
							...index,
							entries: index.entries.filter(
								(e) => e.path !== relPath && !e.path.startsWith(`${relPath}/`),
							),
						};
					} else {
						return fatal(`pathspec '${p}' did not match any files`);
					}
				}
			}

			if (ignoredPaths.length > 0) {
				return err(
					"The following paths are ignored by one of your .gitignore files:\n" +
						`${ignoredPaths.join("\n")}\n` +
						"hint: Use -f if you really want to add them.\n" +
						'hint: Disable this message with "git config set advice.addIgnoredFile false"\n',
				);
			}

			// Process glob pathspecs
			if (globRaws.length > 0) {
				const result = await stageByPathspec(gitCtx, ctx.cwd, index, globRaws, opts);
				if (result.error) return result.error;
				index = result.index;
			}

			if (!args["dry-run"]) await writeIndex(gitCtx, index);
			const stdout = opts.actions ? opts.actions.join("") : "";
			return { stdout, stderr: "", exitCode: 0 };
		},
	});
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Stage files matching glob pathspecs. Two-phase approach:
 * Phase 1: update/remove tracked files that match the pathspecs
 * Phase 2: walk the worktree to discover new untracked files
 */
async function stageByPathspec(
	gitCtx: GitContext,
	cwd: string,
	index: Index,
	raws: string[],
	opts?: AddOptions,
): Promise<{
	index: Index;
	error?: { stdout: string; stderr: string; exitCode: number };
}> {
	const workTree = gitCtx.workTree as string;
	const cwdPrefix = getCwdPrefix(gitCtx, cwd);
	const specs = raws.map((r) => parsePathspec(r, cwdPrefix));
	const specMatched = new Array<boolean>(specs.length).fill(false);

	const markMatches = (path: string) => {
		for (let i = 0; i < specs.length; i++) {
			if (!(specs[i] as Pathspec).hasWildcard) continue;
			if (matchPathspec(specs[i] as Pathspec, path)) specMatched[i] = true;
		}
	};

	// Phase 1: update tracked files matching pathspecs
	const toRemove: string[] = [];
	for (const entry of index.entries) {
		if (entry.stage > 0) continue;
		if (!matchPathspecs(specs, entry.path)) continue;

		markMatches(entry.path);
		const fullPath = join(workTree, entry.path);
		if (await gitCtx.fs.exists(fullPath)) {
			const result = await stageFile(gitCtx, index, entry.path);
			index = result.index;
			if (opts?.actions && result.hash !== entry.hash) opts.actions.push(`add '${entry.path}'\n`);
		} else {
			if (opts?.actions) opts.actions.push(`remove '${entry.path}'\n`);
			toRemove.push(entry.path);
		}
	}
	for (const path of toRemove) {
		index = removeEntry(index, path);
	}

	// Phase 2: walk worktree for new untracked files
	if (!opts?.updateOnly) {
		const trackedPaths = new Set(index.entries.map((e) => e.path));
		const allFiles = await walkWorkTree(gitCtx, workTree, "", {
			skipIgnore: opts?.skipIgnore,
		});

		for (const filePath of allFiles) {
			if (trackedPaths.has(filePath)) continue;
			if (!matchPathspecs(specs, filePath)) continue;

			markMatches(filePath);
			if (opts?.actions) opts.actions.push(`add '${filePath}'\n`);
			const result = await stageFile(gitCtx, index, filePath);
			index = result.index;
		}
	}

	// Report unmatched pathspecs
	for (let i = 0; i < specs.length; i++) {
		const spec = specs[i] as Pathspec;
		if (!specMatched[i] && !(spec.magic & PATHSPEC_EXCLUDE)) {
			return {
				index,
				error: fatal(`pathspec '${spec.original}' did not match any files`),
			};
		}
	}

	return { index };
}

/**
 * Stage all files within a directory, mirroring real git's two-phase approach:
 *
 * Phase 1 (index-driven): iterate index entries under this directory,
 *   compare each against the working tree. Re-stage modified files,
 *   remove deleted files. .gitignore is irrelevant here — these files
 *   are already tracked.
 *
 * Phase 2 (walk-driven): walk the filesystem with .gitignore filtering
 *   to discover new untracked files and add them to the index.
 *   Skipped when updateOnly is set.
 */
async function stageDirectory(
	gitCtx: GitContext,
	index: Index,
	absDir: string,
	relDir: string,
	opts?: AddOptions,
): Promise<Index> {
	const prefix = relDir === "" ? "" : `${relDir}/`;
	const workTree = gitCtx.workTree as string;

	// ── Phase 1: update/remove tracked files ──────────────────────
	const toRemove: string[] = [];
	const seen = new Set<string>();
	for (const entry of index.entries) {
		if (!(prefix === "" || entry.path.startsWith(prefix))) continue;
		if (seen.has(entry.path)) continue;
		seen.add(entry.path);

		const fullPath = join(workTree, entry.path);
		if (await gitCtx.fs.exists(fullPath)) {
			const wasConflicted = entry.stage > 0;
			const result = await stageFile(gitCtx, index, entry.path);
			index = result.index;
			if (opts?.actions && (wasConflicted || result.hash !== entry.hash))
				opts.actions.push(`add '${entry.path}'\n`);
		} else {
			if (opts?.actions) opts.actions.push(`remove '${entry.path}'\n`);
			toRemove.push(entry.path);
		}
	}
	for (const path of toRemove) {
		index = removeEntry(index, path);
	}

	// ── Phase 2: add new untracked files (respecting .gitignore) ─
	if (!opts?.updateOnly) {
		const trackedPaths = new Set(index.entries.map((e) => e.path));
		const newFiles = await walkWorkTree(gitCtx, absDir, relDir === "" ? "" : relDir, {
			skipIgnore: opts?.skipIgnore,
		});

		for (const filePath of newFiles) {
			if (trackedPaths.has(filePath)) continue;
			if (opts?.actions) opts.actions.push(`add '${filePath}'\n`);
			const result = await stageFile(gitCtx, index, filePath);
			index = result.index;
		}
	}

	return index;
}

/**
 * Check if an explicit path is ignored by .gitignore rules.
 * Walks directory components from root to leaf, loading .gitignore
 * at each level. Returns the ignored component (e.g. ".vscode" if
 * the directory itself is ignored) or null if not ignored.
 */
async function checkExplicitPathIgnored(
	ctx: GitContext,
	workTree: string,
	relPath: string,
	isTracked: boolean,
): Promise<string | null> {
	let stack = await loadBaseIgnore(ctx);

	// Load root .gitignore
	try {
		const content = await ctx.fs.readFile(join(workTree, ".gitignore"));
		stack = pushDirIgnore(stack, content, "", join(workTree, ".gitignore"));
	} catch {
		// no root .gitignore
	}

	const parts = relPath.split("/");

	// Check each directory ancestor — a directory ignore blocks even tracked
	// files (the intent is "nothing under this dir should be tracked").
	for (let i = 0; i < parts.length - 1; i++) {
		const dirRel = parts.slice(0, i + 1).join("/");
		const dirAbs = join(workTree, dirRel);

		if (isIgnored(stack, dirRel, true) === "ignored") {
			return dirRel;
		}

		try {
			const content = await ctx.fs.readFile(join(dirAbs, ".gitignore"));
			stack = pushDirIgnore(stack, content, dirRel, join(dirAbs, ".gitignore"));
		} catch {
			// no .gitignore in this directory
		}
	}

	// For the leaf path itself, only block untracked files. Tracked files
	// that are directly ignored (not via a directory pattern) can be re-added.
	if (!isTracked) {
		const pathIsDir = await ctx.fs
			.stat(join(workTree, relPath))
			.then((s) => s.isDirectory)
			.catch(() => false);

		if (isIgnored(stack, relPath, pathIsDir) === "ignored") {
			return relPath;
		}
	}

	return null;
}
