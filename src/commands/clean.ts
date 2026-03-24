import type { GitExtensions } from "../git.ts";
import {
	fatal,
	getCwdPrefix,
	isCommandError,
	requireGitContext,
	requireWorkTree,
} from "../lib/command-utils.ts";
import { getConfigValue } from "../lib/config.ts";
import {
	type IgnoreStack,
	isIgnored,
	loadBaseIgnore,
	parseIgnoreFile,
	pushDirIgnore,
} from "../lib/ignore.ts";
import { readIndex } from "../lib/index.ts";
import { join } from "../lib/path.ts";
import { matchPathspecs, parsePathspec } from "../lib/pathspec.ts";
import type { GitContext } from "../lib/types.ts";
import { a, type Command, f, o } from "../parse/index.ts";

export function registerCleanCommand(parent: Command, ext?: GitExtensions) {
	parent.command("clean", {
		description: "Remove untracked files from the working tree",
		args: [
			a
				.string()
				.name("pathspec")
				.describe("Pathspec to limit which files are removed")
				.optional()
				.variadic(),
		],
		options: {
			force: f().alias("f").describe("Required to actually remove files"),
			"dry-run": f()
				.alias("n")
				.describe("Don't actually remove anything, just show what would be done"),
			directories: f().alias("d").describe("Also remove untracked directories"),
			removeIgnored: f().alias("x").describe("Remove ignored files as well"),
			onlyIgnored: f().alias("X").describe("Remove only ignored files"),
			exclude: o.string().alias("e").describe("Additional exclude pattern"),
		},
		handler: async (args, ctx) => {
			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;
			const gitCtx = gitCtxOrError;

			const workTreeError = requireWorkTree(gitCtx);
			if (workTreeError) return workTreeError;
			const workTree = gitCtx.workTree as string;

			const dryRun = args["dry-run"];
			const force = args.force;
			const removeDirs = args.directories;
			const removeIgnored = args.removeIgnored;
			const onlyIgnored = args.onlyIgnored;
			// Real git requires -f unless clean.requireForce is false
			if (!force && !dryRun) {
				const requireForce = await getConfigValue(gitCtx, "clean.requireForce");
				if (requireForce !== "false") {
					return fatal(
						"clean.requireForce defaults to true and neither -i, -n, nor -f given; refusing to clean",
					);
				}
			}

			const index = await readIndex(gitCtx);
			const trackedPaths = new Set(index.entries.map((e) => e.path));

			// Build pathspecs for filtering
			const cwdPrefix = getCwdPrefix(gitCtx, ctx.cwd);
			const rawPathspecs = args.pathspec;
			const pathspecs =
				rawPathspecs.length > 0 ? rawPathspecs.map((p) => parsePathspec(p, cwdPrefix)) : null;

			// Build extra exclude patterns from -e flag
			const extraExcludes: string[] = args.exclude ? [args.exclude] : [];

			// Walk the worktree to find candidates
			const candidates = await walkForClean(gitCtx, workTree, "", {
				trackedPaths,
				removeDirs,
				removeIgnored,
				onlyIgnored,
				extraExcludes,
			});

			// Apply pathspec filtering
			let filtered: CleanCandidate[];
			if (pathspecs) {
				filtered = candidates.filter((c) => matchPathspecs(pathspecs, c.path));
			} else {
				filtered = candidates;
			}

			// Sort for deterministic output
			filtered.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

			const lines: string[] = [];

			if (dryRun) {
				for (const c of filtered) {
					const label = c.isDir ? `Would remove ${c.path}/` : `Would remove ${c.path}`;
					lines.push(label);
				}
			} else {
				for (const c of filtered) {
					const fullPath = join(workTree, c.path);
					if (c.isDir) {
						await ctx.fs.rm(fullPath, { recursive: true });
						lines.push(`Removing ${c.path}/`);
					} else {
						await ctx.fs.rm(fullPath);
						lines.push(`Removing ${c.path}`);
					}
				}
			}

			const stdout = lines.length > 0 ? `${lines.join("\n")}\n` : "";
			return { stdout, stderr: "", exitCode: 0 };
		},
	});
}

// ── Walk for clean candidates ──────────────────────────────────────

interface CleanCandidate {
	path: string;
	isDir: boolean;
}

interface CleanWalkOptions {
	trackedPaths: Set<string>;
	removeDirs: boolean;
	removeIgnored: boolean;
	onlyIgnored: boolean;
	extraExcludes: string[];
	/** Internal: ignore stack passed through on recursive calls. */
	_ignore?: IgnoreStack;
}

/**
 * Walk the worktree to find files/dirs eligible for `git clean`.
 *
 * With default flags: finds untracked, non-ignored files.
 * With -x: finds untracked files regardless of ignore status.
 * With -X: finds only ignored files (that are untracked).
 * With -d: also returns untracked directories as collapsed entries
 *          rather than recursing into them.
 */
async function walkForClean(
	ctx: GitContext,
	dirPath: string,
	prefix: string,
	opts: CleanWalkOptions,
): Promise<CleanCandidate[]> {
	const results: CleanCandidate[] = [];

	// -x means skip ignore rules entirely; -X means we need them to find ignored files
	const useIgnore = !opts.removeIgnored;

	let stack: IgnoreStack | null = null;
	if (useIgnore || opts.onlyIgnored) {
		stack = opts._ignore ?? (await loadBaseIgnore(ctx));

		// Load per-directory .gitignore
		const gitignorePath = join(dirPath, ".gitignore");
		try {
			const content = await ctx.fs.readFile(gitignorePath);
			stack = pushDirIgnore(stack, content, prefix, gitignorePath);
		} catch {
			// no .gitignore
		}

		// Apply extra -e exclude patterns at the top-level call
		if (!opts._ignore && opts.extraExcludes.length > 0) {
			const combined = opts.extraExcludes.join("\n");
			const patternList = parseIgnoreFile(combined, "", "<cli>");
			stack = {
				...stack,
				dirPatterns: [patternList, ...stack.dirPatterns],
			};
		}
	}

	const entries = await ctx.fs.readdir(dirPath);

	for (const entry of entries) {
		if (prefix === "" && entry === ".git") continue;

		const fullPath = join(dirPath, entry);
		const relativePath = prefix ? `${prefix}/${entry}` : entry;
		const stat = await ctx.fs.stat(fullPath);

		if (stat.isDirectory) {
			const ignored = stack && isIgnored(stack, relativePath, true) === "ignored";

			// Check if any tracked file lives under this dir
			const hasTracked = dirHasTrackedFiles(opts.trackedPaths, relativePath);
			const walkSubtree = () =>
				walkForClean(ctx, fullPath, relativePath, {
					...opts,
					_ignore: stack ?? undefined,
				});

			if (opts.onlyIgnored) {
				// -X: only remove ignored items.
				// If the directory itself is ignored, recurse only when needed to find
				// tracked descendants; otherwise skip unless -d requested.
				if (ignored && !hasTracked) {
					if (opts.removeDirs) {
						results.push({ path: relativePath, isDir: true });
					}
					continue;
				}
				// Directory is not ignored (or has tracked descendants) - recurse to
				// find ignored files within.
				const sub = await walkSubtree();
				if (!hasTracked && opts.removeDirs) {
					if (sub.length > 0) {
						results.push({ path: relativePath, isDir: true });
					}
				} else {
					results.push(...sub);
				}
			} else if (hasTracked) {
				// Dir contains tracked files — must recurse
				const sub = await walkSubtree();
				results.push(...sub);
			} else if (ignored && useIgnore) {
				// Ignored untracked directory (default mode): skip entirely.
			} else if (opts.removeDirs) {
				// Entirely untracked dir with -d.
				if (opts.removeIgnored) {
					// -x includes ignored paths, so any untracked dir is removable.
					results.push({ path: relativePath, isDir: true });
				} else {
					// Default mode: collapse only when this directory is empty or
					// contains at least one cleanable descendant (non-ignored).
					const sub = await walkSubtree();
					const childEntries = await ctx.fs.readdir(fullPath);
					if (sub.length > 0 || childEntries.length === 0) {
						results.push({ path: relativePath, isDir: true });
					}
				}
			} else {
				// No -d: do not recurse into fully untracked directories.
			}
		} else if (stat.isFile) {
			if (opts.trackedPaths.has(relativePath)) continue;

			const ignored = stack && isIgnored(stack, relativePath, false) === "ignored";

			if (opts.onlyIgnored) {
				if (ignored) results.push({ path: relativePath, isDir: false });
			} else if (ignored && useIgnore) {
			} else {
				results.push({ path: relativePath, isDir: false });
			}
		}
	}

	return results;
}

function dirHasTrackedFiles(trackedPaths: Set<string>, dir: string): boolean {
	const prefix = `${dir}/`;
	for (const p of trackedPaths) {
		if (p.startsWith(prefix)) return true;
	}
	return false;
}
