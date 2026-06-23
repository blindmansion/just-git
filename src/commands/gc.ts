import type { GitExtensions } from "../git.ts";
import { isCommandError, requireGitContext } from "../lib/command-utils.ts";
import { collectRootsAndExpireReflogs } from "../lib/gc-roots.ts";
import { clearDetachPoint } from "../lib/operation-state.ts";
import { writePackedRefs } from "../lib/refs.ts";
import { type Command, f } from "../parse/index.ts";
import { formatRepackStderr, repackFromTips } from "../lib/repack.ts";

export function registerGcCommand(parent: Command, ext?: GitExtensions) {
	parent.command("gc", {
		description: "Cleanup unnecessary files and optimize the local repository",
		options: {
			aggressive: f().describe("More aggressively optimize the repository"),
		},
		handler: async (args, ctx) => {
			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;
			const gitCtx = gitCtxOrError;

			// Step 1: Pack refs
			await writePackedRefs(gitCtx);

			// Step 2: Expire reflogs + collect all roots in a single pass
			await clearDetachPoint(gitCtx);
			const tips = await collectRootsAndExpireReflogs(gitCtx);

			if (tips.length > 0) {
				const window = args.aggressive ? 250 : 10;
				const depth = args.aggressive ? 250 : 50;

				const result = await repackFromTips({
					gitCtx,
					fs: ctx.fs,
					tips,
					window,
					depth,
					cleanup: true,
					all: true,
				});

				if (result) {
					const stderr = formatRepackStderr(result.totalCount, result.deltaCount, true);
					return { stdout: "", stderr: `${stderr}\n`, exitCode: 0 };
				}
			}

			return { stdout: "", stderr: "", exitCode: 0 };
		},
	});
}
