import type { GitExtensions } from "../git.ts";
import { abbreviateHash, isCommandError, requireGitContext } from "../lib/command-utils.ts";
import { join } from "../lib/path.ts";
import { readReflog, ZERO_HASH } from "../lib/reflog.ts";
import { resolveRef } from "../lib/refs.ts";
import type { GitContext } from "../lib/types.ts";
import { a, type Command, o } from "../parse/index.ts";

function formatReflogEntryLine(
	refName: string,
	index: number,
	newHash: string,
	message: string,
): string {
	return `${abbreviateHash(newHash)} ${refName}@{${index}}: ${message}`;
}

async function showReflog(
	gitCtx: GitContext,
	refName: string,
	maxCount: number | undefined,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const canonicalRef = refName === "HEAD" ? "HEAD" : `refs/heads/${refName}`;

	const resolved = await resolveRef(gitCtx, canonicalRef);
	if (!resolved) {
		return {
			stdout: "",
			stderr: `fatal: ambiguous argument '${refName}': unknown revision or path not in the working tree.\nUse '--' to separate paths from revisions, like this:\n'git <command> [<revision>...] -- [<file>...]'\n`,
			exitCode: 128,
		};
	}

	const entries = await readReflog(gitCtx, canonicalRef);

	const lines: string[] = [];
	const limit = maxCount !== undefined ? maxCount : entries.length;
	let count = 0;

	for (let i = entries.length - 1; i >= 0 && count < limit; i--) {
		const entry = entries[i];
		if (!entry) continue;
		const idx = entries.length - 1 - i;
		if (entry.newHash === ZERO_HASH) continue;
		lines.push(formatReflogEntryLine(refName, idx, entry.newHash, entry.message));
		count++;
	}

	const stdout = lines.length > 0 ? `${lines.join("\n")}\n` : "";
	return { stdout, stderr: "", exitCode: 0 };
}

export function registerReflogCommand(parent: Command, ext?: GitExtensions) {
	const reflog = parent.command("reflog", {
		description: "Manage reflog information",
		args: [a.string().name("args").variadic().optional()],
		options: {
			maxCount: o.number().alias("n").describe("Limit the number of entries to output"),
		},
		handler: async (args, ctx) => {
			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;
			const gitCtx = gitCtxOrError;

			const positional: string[] = args.args;

			if (positional.length === 0) {
				return showReflog(gitCtx, "HEAD", args.maxCount);
			}

			const first = positional[0];
			if (!first) return showReflog(gitCtx, "HEAD", args.maxCount);

			if (first === "show") {
				const ref = positional[1] ?? "HEAD";
				return showReflog(gitCtx, ref, args.maxCount);
			}

			if (first === "exists") {
				const ref = positional[1];
				if (!ref) {
					return {
						stdout: "",
						stderr: "fatal: reflog exists requires a ref argument\n",
						exitCode: 128,
					};
				}
				const reflogFile = join(gitCtx.gitDir, "logs", ref);
				return {
					stdout: "",
					stderr: "",
					exitCode: (await gitCtx.fs.exists(reflogFile)) ? 0 : 1,
				};
			}

			// No recognized subcommand — treat as a ref name (bare `git reflog <ref>`)
			return showReflog(gitCtx, first, args.maxCount);
		},
	});

	return reflog;
}
