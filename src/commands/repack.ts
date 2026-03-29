import type { GitExtensions } from "../git.ts";
import { isCommandError, requireGitContext } from "../lib/command-utils.ts";
import { collectAllRoots } from "../lib/gc-roots.ts";
import { formatRepackStderr, repackFromTips } from "../lib/repack.ts";
import { type Command, f } from "../parse/index.ts";

export function registerRepackCommand(parent: Command, ext?: GitExtensions) {
	parent.command("repack", {
		description: "Pack unpacked objects in a repository",
		options: {
			all: f().alias("a").describe("Pack all objects, including already-packed"),
			delete: f().alias("d").describe("After packing, remove redundant packs and loose objects"),
		},
		handler: async (args, ctx) => {
			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;
			const gitCtx = gitCtxOrError;

			const tips = await collectAllRoots(gitCtx);

			const result = await repackFromTips({
				gitCtx,
				fs: ctx.fs,
				tips,
				cleanup: args.delete as boolean | undefined,
				all: args.all as boolean | undefined,
			});

			if (!result) {
				return {
					stdout: "Nothing new to pack.\n",
					stderr: "",
					exitCode: 0,
				};
			}

			const stderr = formatRepackStderr(result.totalCount, result.deltaCount);
			return { stdout: "", stderr: `${stderr}\n`, exitCode: 0 };
		},
	});
}
