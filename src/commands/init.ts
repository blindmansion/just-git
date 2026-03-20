import type { GitExtensions } from "../git.ts";
import { resolve } from "../lib/path.ts";
import { initRepository } from "../lib/repo.ts";
import { a, type Command, f, o } from "../parse/index.ts";

export function registerInitCommand(parent: Command, ext?: GitExtensions) {
	parent.command("init", {
		description: "Initialize a new repository",
		args: [a.string().name("directory").describe("The directory to initialize").optional()],
		options: {
			bare: f().describe("Create a bare repository"),
			initialBranch: o.string().alias("b").describe("Name for the initial branch"),
		},
		examples: ["git init", "git init --bare", "git init my-project"],
		handler: async (args, ctx) => {
			const initialBranch =
				args.initialBranch ??
				ext?.configOverrides?.locked?.["init.defaultBranch"] ??
				ext?.configOverrides?.defaults?.["init.defaultBranch"];
			const targetDir = args.directory ? resolve(ctx.cwd, args.directory) : ctx.cwd;

			if (args.directory) {
				await ctx.fs.mkdir(targetDir, { recursive: true });
			}

			const { ctx: gitCtx, reinit } = await initRepository(ctx.fs, targetDir, {
				bare: args.bare,
				...(initialBranch ? { initialBranch } : {}),
			});

			let stderr = "";
			if (reinit && initialBranch) {
				stderr = `warning: re-init: ignored --initial-branch=${initialBranch}\n`;
			}

			const label = args.bare ? "bare " : "";
			const verb = reinit ? "Reinitialized existing" : "Initialized empty";
			return {
				stdout: `${verb} ${label}Git repository in ${gitCtx.gitDir}/\n`,
				stderr,
				exitCode: 0,
			};
		},
	});
}
