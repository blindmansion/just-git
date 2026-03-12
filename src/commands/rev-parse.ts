import type { GitExtensions } from "../git.ts";
import {
	abbreviateHash,
	ambiguousArgError,
	fatal,
	isCommandError,
	requireGitContext,
} from "../lib/command-utils.ts";
import { relative } from "../lib/path.ts";
import { readHead, resolveRef } from "../lib/refs.ts";
import { resolveRevision } from "../lib/rev-parse.ts";
import type { GitContext } from "../lib/types.ts";
import { a, type Command, f } from "../parse/index.ts";

export function registerRevParseCommand(parent: Command, ext?: GitExtensions) {
	parent.command("rev-parse", {
		description: "Pick out and massage parameters",
		args: [
			a
				.string()
				.name("args")
				.describe("Refs or revision expressions to resolve")
				.optional()
				.variadic(),
		],
		options: {
			verify: f().describe(
				"Verify that exactly one parameter is provided and resolves to an object",
			),
			short: f().describe("Abbreviate object name (default 7 chars)"),
			"abbrev-ref": f().describe("Output abbreviated ref name instead of object hash"),
			"symbolic-full-name": f().describe("Output the full symbolic ref name"),
			"show-toplevel": f().describe("Show the absolute path of the top-level directory"),
			"git-dir": f().describe("Show the path to the .git directory"),
			"is-inside-work-tree": f().describe("Output whether cwd is inside the work tree"),
			"is-bare-repository": f().describe("Output whether the repository is bare"),
			"show-prefix": f().describe("Show path of cwd relative to top-level directory"),
			"show-cdup": f().describe("Show relative path from cwd up to top-level directory"),
		},
		handler: async (args, ctx) => {
			const revArgs = args.args.filter((s) => s !== "");
			const verify = args.verify;
			const short = args.short;
			const abbrevRef = args["abbrev-ref"];
			const symbolicFullName = args["symbolic-full-name"];
			const showToplevel = args["show-toplevel"];
			const showGitDir = args["git-dir"];
			const isInsideWorkTree = args["is-inside-work-tree"];
			const isBareRepository = args["is-bare-repository"];
			const showPrefix = args["show-prefix"];
			const showCdup = args["show-cdup"];

			const hasInfoQuery =
				showToplevel ||
				showGitDir ||
				isInsideWorkTree ||
				isBareRepository ||
				showPrefix ||
				showCdup;

			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;
			const gitCtx = gitCtxOrError;

			const lines: string[] = [];

			if (showToplevel) {
				if (!gitCtx.workTree) {
					return fatal("this operation must be run in a work tree");
				}
				lines.push(gitCtx.workTree);
			}

			if (showGitDir) {
				lines.push(gitCtx.gitDir);
			}

			if (isInsideWorkTree) {
				lines.push(gitCtx.workTree ? "true" : "false");
			}

			if (isBareRepository) {
				lines.push(gitCtx.workTree ? "false" : "true");
			}

			if (showPrefix) {
				if (!gitCtx.workTree) {
					return fatal("this operation must be run in a work tree");
				}
				const rel = relative(gitCtx.workTree, ctx.cwd);
				lines.push(rel === "" ? "" : `${rel}/`);
			}

			if (showCdup) {
				if (!gitCtx.workTree) {
					return fatal("this operation must be run in a work tree");
				}
				const rel = relative(ctx.cwd, gitCtx.workTree);
				lines.push(rel === "" ? "" : `${rel}/`);
			}

			if (hasInfoQuery && revArgs.length === 0) {
				const out = lines.map((l) => `${l}\n`).join("");
				return { stdout: out, stderr: "", exitCode: 0 };
			}

			if (verify && revArgs.length !== 1) {
				return fatal("Needed a single revision");
			}

			for (const rev of revArgs) {
				if (abbrevRef) {
					const name = await resolveAbbrevRef(gitCtx, rev);
					if (name === null) {
						return revError(rev, verify);
					}
					lines.push(name);
					continue;
				}

				if (symbolicFullName) {
					const name = await resolveSymbolicFullName(gitCtx, rev);
					if (name === null) {
						return revError(rev, verify);
					}
					lines.push(name);
					continue;
				}

				const hash = await resolveRevision(gitCtx, rev);
				if (!hash) {
					return revError(rev, verify);
				}

				lines.push(short ? abbreviateHash(hash) : hash);
			}

			const out = lines.map((l) => `${l}\n`).join("");
			return { stdout: out, stderr: "", exitCode: 0 };
		},
	});
}

function revError(
	rev: string,
	verify: boolean,
): { stdout: string; stderr: string; exitCode: number } {
	if (verify) {
		return fatal("Needed a single revision");
	}
	return ambiguousArgError(rev);
}

async function resolveAbbrevRef(ctx: GitContext, rev: string): Promise<string | null> {
	if (rev === "HEAD" || rev === "@") {
		const head = await readHead(ctx);
		if (!head) return null;
		if (head.type === "symbolic") {
			const target = head.target;
			if (target.startsWith("refs/heads/")) {
				return target.slice("refs/heads/".length);
			}
			return target;
		}
		return "HEAD";
	}

	const hash = await resolveRevision(ctx, rev);
	if (!hash) return null;
	return rev;
}

async function resolveSymbolicFullName(ctx: GitContext, rev: string): Promise<string | null> {
	if (rev === "HEAD" || rev === "@") {
		const head = await readHead(ctx);
		if (!head) return null;
		if (head.type === "symbolic") return head.target;
		return "HEAD";
	}

	const hash = await resolveRevision(ctx, rev);
	if (!hash) return null;

	if (rev.startsWith("refs/")) return rev;

	for (const prefix of ["refs/heads/", "refs/tags/", "refs/remotes/"]) {
		const candidate = `${prefix}${rev}`;
		if (await resolveRef(ctx, candidate)) return candidate;
	}

	return rev;
}
