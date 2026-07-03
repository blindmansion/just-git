import type { GitExtensions } from "../git.ts";
import {
	FormatPatchError,
	type FormatPatchResult,
	formatPatchSeries,
} from "../lib/patch/format-patch.ts";
import { resolve } from "../lib/path.ts";
import type { Identity } from "../lib/types.ts";
import { fatal, isCommandError } from "./kit/command-result.ts";
import { requireCommitter, requireGitContext } from "./kit/commit-requirements.ts";
import { a, type Command, f, o } from "./kit/parse/index.ts";

export function registerFormatPatchCommand(parent: Command, ext?: GitExtensions) {
	parent.command("format-patch", {
		description: "Prepare patches for e-mail submission",
		// `-<n>` (e.g. `-2`) limits the number of patches. Rewrite it to the
		// internal `--count` option so the parser doesn't treat it as an unknown
		// short flag.
		transformArgs: (tokens) =>
			tokens.flatMap((t) => {
				const m = /^-(\d+)$/.exec(t);
				return m ? ["--count", m[1] as string] : [t];
			}),
		args: [a.string().name("revisions").variadic().optional()],
		options: {
			stdout: f().describe("Print all commits to stdout in mbox format"),
			output: o.string().alias("o").describe("Write patch files to the given directory"),
			numberedFiles: f().describe("Use only the commit number as the file name"),
			numbered: f().alias("n").describe("Force sequence numbers in the subject prefix"),
			noNumbered: f().alias("N").describe("Suppress sequence numbers in the subject prefix"),
			signoff: f().alias("s").describe("Add a Signed-off-by trailer to the commit message"),
			subjectPrefix: o.string().describe("Use the given prefix instead of [PATCH]"),
			rerollCount: o.number().alias("v").describe("Mark the series as the Nth reroll ([PATCH vN])"),
			rfc: f().describe("Use [RFC PATCH] instead of [PATCH]"),
			coverLetter: f().describe("Generate a cover letter for the series"),
			signature: o.string().describe("Add a signature (defaults to the git version)"),
			count: o.number().describe("Limit the number of patches (from -<n>)"),
			root: f().describe("Treat the revision as the series root (no lower bound)"),
		},
		handler: async (args, ctx) => {
			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;
			const gitCtx = gitCtxOrError;

			// git stamps the sender + current date on `--signoff` trailers and the
			// cover letter, so resolve the committer from the CLI environment here
			// (the lib engine stays identity-agnostic and takes it as input).
			let committer: Identity | undefined;
			if (args.signoff || args.coverLetter) {
				const resolved = await requireCommitter(gitCtx, ctx.env);
				if (isCommandError(resolved)) return resolved;
				committer = resolved;
			}

			let series: FormatPatchResult;
			try {
				series = await formatPatchSeries(gitCtx, {
					revisions: args.revisions,
					root: args.root,
					count: args.count,
					numbered: args.numbered,
					noNumbered: args.noNumbered,
					numberedFiles: args.numberedFiles,
					signoff: args.signoff,
					subjectPrefix: args.subjectPrefix,
					rerollCount: args.rerollCount,
					rfc: args.rfc,
					coverLetter: args.coverLetter,
					signature: args.signature,
					committer,
				});
			} catch (e) {
				if (e instanceof FormatPatchError) return fatal(e.message);
				throw e;
			}

			const { cover, patches } = series;
			if (patches.length === 0) {
				return { stdout: "", stderr: "", exitCode: 0 };
			}

			// ── Emit ────────────────────────────────────────────────
			if (args.stdout) {
				// The cover letter is separated from the first patch by a single
				// blank line, whereas consecutive patches get a double blank.
				let stdout = cover ? `${cover.content}\n` : "";
				stdout += patches.map((p) => `${p.content}\n`).join("\n");
				return { stdout, stderr: "", exitCode: 0 };
			}

			const outDir = args.output ? resolve(ctx.cwd, args.output) : ctx.cwd;
			if (!(await ctx.fs.exists(outDir))) {
				await ctx.fs.mkdir(outDir, { recursive: true });
			}

			const files = cover ? [cover, ...patches] : patches;
			let listing = "";
			for (const file of files) {
				await ctx.fs.writeFile(resolve(outDir, file.filename), `${file.content}\n`);
				listing += `${args.output ? `${args.output}/${file.filename}` : file.filename}\n`;
			}
			return { stdout: listing, stderr: "", exitCode: 0 };
		},
	});
}
