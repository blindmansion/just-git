import { resolve } from "../lib/path.ts";
import { initRepository } from "../lib/repo.ts";
import { a, type Command, f, o } from "../parse/index.ts";

export function registerInitCommand(parent: Command) {
	parent.command("init", {
		description: "Initialize a new repository",
		args: [a.string().name("directory").describe("The directory to initialize").optional()],
		options: {
			bare: f().describe("Create a bare repository"),
			initialBranch: o.string().alias("b").describe("Name for the initial branch"),
		},
		examples: ["git init", "git init --bare", "git init my-project"],
		handler: async (args, ctx) => {
			const initialBranch = args.initialBranch;
			const targetDir = args.directory ? resolve(ctx.cwd, args.directory) : ctx.cwd;

			// Create the target directory if it doesn't exist
			if (args.directory) {
				await ctx.fs.mkdir(targetDir, { recursive: true });
			}

			const gitCtx = await initRepository(ctx.fs, targetDir, {
				bare: args.bare,
				...(initialBranch ? { initialBranch } : {}),
			});

			const label = args.bare ? "bare " : "";
			return {
				stdout: `Initialized empty ${label}Git repository in ${gitCtx.gitDir}/\n`,
				stderr: "",
				exitCode: 0,
			};
		},
	});
}
