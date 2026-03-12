import type { GitExtensions } from "../git.ts";
import {
	err,
	fatal,
	isCommandError,
	requireGitContext,
	requireWorkTree,
} from "../lib/command-utils.ts";
import { addEntry, findEntry, readIndex, removeEntry, writeIndex } from "../lib/index.ts";
import { basename, dirname, join, relative, resolve } from "../lib/path.ts";
import type { IndexEntry } from "../lib/types.ts";
import { cleanEmptyDirs } from "../lib/worktree.ts";
import { a, type Command, f } from "../parse/index.ts";

export function registerMvCommand(parent: Command, ext?: GitExtensions) {
	parent.command("mv", {
		description: "Move or rename a file, directory, or symlink",
		args: [
			a.string().name("sources").describe("Source file(s) or directory").optional().variadic(),
		],
		options: {
			force: f().alias("f").describe("Force renaming even if target exists"),
			"dry-run": f().alias("n").describe("Do nothing; only show what would happen"),
			skip: f().alias("k").describe("Skip move/rename actions that would lead to errors"),
		},
		handler: async (args, ctx) => {
			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;
			const gitCtx = gitCtxOrError;

			const workTreeError = requireWorkTree(gitCtx);
			if (workTreeError) return workTreeError;

			const workTree = gitCtx.workTree as string;
			const allArgs = args.sources;
			if (allArgs.length < 2) {
				return err("usage: git mv [<options>] <source>... <destination>\n");
			}

			// Last argument is the destination
			const destination = allArgs[allArgs.length - 1]!;
			const sources = allArgs.slice(0, -1);

			const absDest = resolve(ctx.cwd, destination);
			const relDest = relative(workTree, absDest);

			if (relDest.startsWith("..")) {
				return fatal(`'${destination}' is outside repository at '${workTree}'`);
			}

			let index = await readIndex(gitCtx);

			// When there are multiple sources, destination must be a directory
			const destExists = await ctx.fs.exists(absDest);
			const destIsDir = destExists && (await ctx.fs.stat(absDest)).isDirectory;

			if (sources.length > 1 && !destIsDir) {
				return fatal(
					destExists
						? `destination '${destination}' is not a directory`
						: `destination directory '${destination}' does not exist`,
				);
			}

			// ── Build move plan ─────────────────────────────────────────
			interface MoveOp {
				srcRel: string;
				dstRel: string;
				srcAbs: string;
				dstAbs: string;
			}

			const moves: MoveOp[] = [];

			for (const src of sources) {
				const absSrc = resolve(ctx.cwd, src);
				const relSrc = relative(workTree, absSrc);

				if (relSrc.startsWith("..")) {
					if (args.skip) continue;
					return fatal(`'${src}' is outside repository at '${workTree}'`);
				}

				// Source must exist in the working tree
				const srcExists = await ctx.fs.exists(absSrc);
				if (!srcExists) {
					if (args.skip) continue;
					return fatal(`bad source, source=${relSrc}, destination=${relDest}`);
				}

				const srcStat = await ctx.fs.stat(absSrc);
				const srcIsDir = srcStat.isDirectory;

				// Source must be tracked (in the index)
				const srcTracked = srcIsDir
					? index.entries.some((e) => e.path === relSrc || e.path.startsWith(`${relSrc}/`))
					: index.entries.some((e) => e.path === relSrc && e.stage === 0);

				if (!srcTracked) {
					// Check if the file is conflicted (has stage > 0 entries but no stage 0)
					const isConflicted =
						!srcIsDir && index.entries.some((e) => e.path === relSrc && e.stage > 0);
					if (args.skip) continue;
					return fatal(
						isConflicted
							? `conflicted, source=${relSrc}, destination=${relDest}`
							: `not under version control, source=${relSrc}, destination=${relDest}`,
					);
				}

				// Compute actual destination path
				let actualDstRel: string;
				let actualDstAbs: string;

				if (destIsDir) {
					// Move into the directory
					const name = basename(relSrc);
					actualDstRel = relDest === "" || relDest === "." ? name : `${relDest}/${name}`;
					actualDstAbs = join(absDest, name);
				} else {
					actualDstRel = relDest;
					actualDstAbs = absDest;
				}

				// Check if destination already exists
				const dstAlreadyExists = await ctx.fs.exists(actualDstAbs);
				if (dstAlreadyExists && !args.force) {
					// Check if destination is a directory — if so, move into it
					const dstStat = await ctx.fs.stat(actualDstAbs);
					if (dstStat.isDirectory) {
						const name = basename(relSrc);
						actualDstRel = `${actualDstRel}/${name}`;
						actualDstAbs = join(actualDstAbs, name);
					} else {
						if (args.skip) continue;
						return fatal(`destination exists, source=${relSrc}, destination=${actualDstRel}`);
					}
				}

				// Check if source and destination are the same
				if (relSrc === actualDstRel) {
					if (args.skip) continue;
					return fatal(
						`can not move directory into itself, source=${relSrc}, destination=${actualDstRel}`,
					);
				}

				// Check that destination parent directory exists
				// (real git does not auto-create intermediate directories)
				const dstParent = dirname(actualDstAbs);
				if (!(await ctx.fs.exists(dstParent))) {
					if (args.skip) continue;
					return fatal(`renaming '${relSrc}' failed: No such file or directory`);
				}

				if (srcIsDir) {
					// Expand directory entries
					const prefix = `${relSrc}/`;
					const dirEntries = index.entries.filter(
						(e) => e.path.startsWith(prefix) && e.stage === 0,
					);
					for (const entry of dirEntries) {
						const suffix = entry.path.slice(relSrc.length);
						const entryDstRel = actualDstRel + suffix;
						const entryDstAbs = actualDstAbs + suffix;
						moves.push({
							srcRel: entry.path,
							dstRel: entryDstRel,
							srcAbs: join(workTree, entry.path),
							dstAbs: entryDstAbs,
						});
					}
				} else {
					moves.push({
						srcRel: relSrc,
						dstRel: actualDstRel,
						srcAbs: absSrc,
						dstAbs: actualDstAbs,
					});
				}
			}

			if (moves.length === 0) {
				return { stdout: "", stderr: "", exitCode: 0 };
			}

			// ── Dry run ─────────────────────────────────────────────────
			if (args["dry-run"]) {
				return { stdout: "", stderr: "", exitCode: 0 };
			}

			// ── Execute moves ───────────────────────────────────────────
			for (const move of moves) {
				// 1. Move file in the working tree
				// Ensure destination directory exists (for directory moves,
				// nested subdirectories may need creation)
				const dstDir = dirname(move.dstAbs);
				if (!(await ctx.fs.exists(dstDir))) {
					await ctx.fs.mkdir(dstDir, { recursive: true });
				}

				const content = await ctx.fs.readFileBuffer(move.srcAbs);
				await ctx.fs.writeFile(move.dstAbs, content);
				await ctx.fs.rm(move.srcAbs);

				// 2. Update the index: remove old entry, add new entry
				const oldEntry = findEntry(index, move.srcRel, 0);
				if (oldEntry) {
					index = removeEntry(index, move.srcRel);
					const newEntry: IndexEntry = {
						...oldEntry,
						path: move.dstRel,
					};
					index = addEntry(index, newEntry);
				}
			}

			// Clean up empty directories left behind
			for (const move of moves) {
				await cleanEmptyDirs(ctx.fs, dirname(move.srcAbs), workTree);
			}

			await writeIndex(gitCtx, index);

			return { stdout: "", stderr: "", exitCode: 0 };
		},
	});
}
