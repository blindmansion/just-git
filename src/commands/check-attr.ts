import type { CommandContext, GitExtensions } from "../git.ts";
import type { AttrValue } from "../lib/attributes/attributes.ts";
import { createAttributesProvider } from "../lib/attributes/attributes.ts";
import { getCwdPrefix } from "../lib/command-utils.ts";
import { join, relative } from "../lib/path.ts";
import { a, type Command, f } from "./kit/parse/index.ts";
import { isCommandError } from "./kit/command-errors.ts";
import { requireGitContext } from "./kit/commit-requirements.ts";

/** Decode a possibly-byte-encoded stdin payload into text. */
function stdinToText(stdin: CommandContext["stdin"]): string {
	const raw = stdin as string;
	for (let i = 0; i < raw.length; i++) {
		if (raw.charCodeAt(i) > 255) return raw;
	}
	const bytes = Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return raw;
	}
}

/** Map a resolved attribute value to git check-attr's display word. */
function describeValue(value: AttrValue): string {
	if (value === undefined) return "unspecified";
	if (value === true) return "set";
	if (value === false) return "unset";
	return value;
}

export function registerCheckAttrCommand(parent: Command, ext?: GitExtensions): void {
	parent.command("check-attr", {
		description: "Display gitattributes information for paths",
		args: [a.string().name("args").variadic().optional()],
		options: {
			all: f().alias("a").describe("List all attributes set on each path"),
			stdin: f().describe("Read pathnames from stdin (NUL-separated with -z)"),
			"nul-terminate": f().alias("z").describe("Use \\0 line termination on input and output"),
		},
		handler: async (args, ctx, meta) => {
			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;
			const gitCtx = gitCtxOrError;

			const all = args.all as boolean;
			const fromStdin = args.stdin as boolean;
			const nul = args["nul-terminate"] as boolean;
			const before: string[] = (args.args as string[] | undefined) ?? [];
			const afterDoubleDash = meta.passthrough;

			// ── Split argv into attribute names + pathnames ─────────────
			// `--all`     → no named attrs; all argv tokens are paths.
			// `--stdin`   → all argv tokens are attrs; paths come from stdin.
			// `-- ` form  → attrs before `--`, paths after.
			// bare form   → first token is the (single) attr, the rest are paths.
			let attrs: string[];
			let rawPaths: string[];
			if (all) {
				attrs = [];
				rawPaths = [...before, ...afterDoubleDash];
			} else if (fromStdin) {
				attrs = [...before, ...afterDoubleDash];
				rawPaths = [];
			} else if (afterDoubleDash.length > 0) {
				attrs = before;
				rawPaths = afterDoubleDash;
			} else {
				attrs = before.slice(0, 1);
				rawPaths = before.slice(1);
			}

			if (!all && attrs.length === 0) {
				return { stdout: "", stderr: "fatal: No attribute specified\n", exitCode: 128 };
			}

			if (fromStdin) {
				const sep = nul ? "\0" : "\n";
				rawPaths = stdinToText(ctx.stdin)
					.split(sep)
					.map((p) => (nul ? p : p.replace(/\r$/, "")))
					.filter((p) => p !== "");
			}

			// ── Resolve through the same in-tree provider the engine uses ─
			const provider = createAttributesProvider(gitCtx);
			const prefix = getCwdPrefix(gitCtx, ctx.cwd);
			const toRepoRel = (p: string): string =>
				p.startsWith("/") && gitCtx.workTree ? relative(gitCtx.workTree, p) : join(prefix, p);

			const out: string[] = [];
			const emit = (path: string, attr: string, value: AttrValue) => {
				const info = describeValue(value);
				out.push(nul ? `${path}\0${attr}\0${info}\0` : `${path}: ${attr}: ${info}\n`);
			};

			for (const display of rawPaths) {
				const repoRel = toRepoRel(display);
				if (all) {
					const decided = await provider.getAll(repoRel);
					for (const name of [...decided.keys()].sort()) {
						emit(display, name, decided.get(name));
					}
				} else {
					for (const attr of attrs) {
						emit(display, attr, await provider.get(repoRel, attr));
					}
				}
			}

			return { stdout: out.join(""), stderr: "", exitCode: 0 };
		},
	});
}
