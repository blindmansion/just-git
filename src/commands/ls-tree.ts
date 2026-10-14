import type { GitExtensions } from "../git.ts";
import {
	buildAbbrevResolver,
	DEFAULT_ABBREV,
	err,
	fatal,
	getCwdPrefix,
	isCommandError,
	requireGitContext,
} from "../lib/command-utils.ts";
import { join, relative } from "../lib/path.ts";
import { quoteCPath } from "../lib/quote.ts";
import { peelToTree, resolveRevision, resolveRevPath } from "../lib/rev-parse.ts";
import { readTreeEntries } from "../lib/tree-ops.ts";
import { FileMode, type GitRepo, type ObjectId, type TreeEntry } from "../lib/types.ts";
import { a, type Command, f, o } from "../parse/index.ts";

const USAGE = "usage: git ls-tree [<options>] <tree-ish> [<path>...]\n";

interface WalkOptions {
	recursive: boolean;
	showTrees: boolean;
	treesOnly: boolean;
	filters: PathFilter[];
}

interface PathFilter {
	path: string;
	listContents: boolean;
}

interface ListedEntry extends TreeEntry {
	path: string;
}

export function registerLsTreeCommand(parent: Command, ext?: GitExtensions): void {
	parent.command("ls-tree", {
		description: "List the contents of a tree object",
		args: [
			a.string().name("tree-ish").describe("Tree, commit or tag to list").optional(),
			a.string().name("path").variadic().optional(),
		],
		options: {
			treesOnly: f().alias("d").describe("Only show trees"),
			recursive: f().alias("r").describe("Recurse into subtrees"),
			showTrees: f().alias("t").describe("Show trees when recursing"),
			nulTerminate: f().alias("z").describe("Terminate entries with NUL byte"),
			nameOnly: f().describe("List only filenames"),
			nameStatus: f().describe("List only filenames"),
			fullTree: f().describe("List entire tree; not just current directory"),
			abbrev: o
				.number()
				.impliedValue(String(DEFAULT_ABBREV))
				.describe("Use <n> digits to display object names"),
		},
		handler: async (args, ctx, meta) => {
			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;
			const gitCtx = gitCtxOrError;

			// git's OPT_CMDMODE: the error names the later option first. The parser
			// adds flags to `args` in the order they appear on the command line.
			if (args.nameOnly && args.nameStatus) {
				const modes = Object.keys(args)
					.filter((k) => k === "nameOnly" || k === "nameStatus")
					.map((k) => (k === "nameOnly" ? "--name-only" : "--name-status"));
				return err(`error: options '${modes[1]}' and '${modes[0]}' cannot be used together\n`, 129);
			}

			const [treeIsh, ...rawPaths] =
				args["tree-ish"] === undefined
					? meta.passthrough
					: [args["tree-ish"], ...(args.path ?? []), ...meta.passthrough];
			if (treeIsh === undefined) return { stdout: "", stderr: USAGE, exitCode: 129 };

			const cwdPrefix = getCwdPrefix(gitCtx, ctx.cwd);
			const revPath = await resolveRevPath(gitCtx, treeIsh, cwdPrefix);
			const resolved = revPath ?? (await resolveRevision(gitCtx, treeIsh));
			if (!resolved) return fatal(`Not a valid object name ${treeIsh}`);
			if (typeof resolved !== "string" && "error" in resolved) return fatal(resolved.error);
			if (rawPaths.includes("")) {
				return fatal(
					"empty string is not a valid pathspec. please use . instead if you meant to match all paths",
				);
			}

			const prefix = args.fullTree ? "" : cwdPrefix;
			const filters: PathFilter[] = [];
			for (const raw of rawPaths) {
				const filter = resolvePathFilter(raw, prefix, gitCtx.workTree);
				if (filter === null) {
					return fatal(
						`${raw}: '${raw}' is outside repository at '${gitCtx.workTree ?? gitCtx.gitDir}'`,
					);
				}
				filters.push(filter);
			}
			if (filters.length === 0 && prefix !== "") filters.push({ path: prefix, listContents: true });

			// A <rev>:<path> naming a blob or gitlink is not a tree; check the mode
			// so a gitlink's (usually missing) commit is never read.
			const treeHash =
				typeof resolved === "string"
					? await peelToTree(gitCtx, resolved)
					: resolved.mode === undefined || resolved.mode === FileMode.DIRECTORY
						? resolved.hash
						: null;
			if (!treeHash) return fatal("not a tree object");

			const entries: ListedEntry[] = [];
			await collect(gitCtx, treeHash, "", entries, {
				recursive: args.recursive,
				showTrees: args.showTrees || (args.recursive && args.treesOnly),
				treesOnly: args.treesOnly,
				filters,
			});

			const nameOnly = args.nameOnly || args.nameStatus;
			const terminator = args.nulTerminate ? "\0" : "\n";
			const minAbbrev = args.abbrev;
			const abbrev =
				minAbbrev && !nameOnly
					? await buildAbbrevResolver(
							gitCtx,
							entries.map((e) => e.hash),
							minAbbrev,
						)
					: null;
			let stdout = "";
			for (const entry of entries) {
				const shown = displayPath(prefix, entry.path);
				const name = args.nulTerminate ? shown : quoteCPath(shown);
				if (nameOnly) {
					stdout += name + terminator;
					continue;
				}
				const oid = abbrev ? abbrev(entry.hash) : entry.hash;
				stdout += `${entry.mode} ${objectType(entry.mode)} ${oid}\t${name}${terminator}`;
			}
			return { stdout, stderr: "", exitCode: 0 };
		},
	});
}

function resolvePathFilter(
	raw: string,
	prefix: string,
	workTree: string | null,
): PathFilter | null {
	const listContents = raw.endsWith("/") || /(^|\/)\.\.?$/.test(raw);
	let path: string;
	if (raw.startsWith("/")) {
		if (!workTree) return null;
		path = relative(workTree, raw);
	} else {
		path = join(prefix, raw);
	}
	path = path.replace(/\/$/, "");
	if (path === ".") path = "";
	if (path === ".." || path.startsWith("../")) return null;
	return { path, listContents: listContents || path === "" };
}

async function collect(
	ctx: GitRepo,
	treeHash: ObjectId,
	base: string,
	out: ListedEntry[],
	opts: WalkOptions,
): Promise<void> {
	for (const entry of await readTreeEntries(ctx, treeHash)) {
		const path = base ? `${base}/${entry.name}` : entry.name;
		if (opts.filters.length > 0 && !opts.filters.some((f) => filterMatches(f, path, entry.mode))) {
			continue;
		}
		if (entry.mode === FileMode.DIRECTORY) {
			const descend =
				opts.recursive ||
				opts.filters.some(
					(f) => f.path.startsWith(`${path}/`) || (f.listContents && f.path === path),
				);
			if (!descend || opts.showTrees) out.push({ ...entry, path });
			if (descend) await collect(ctx, entry.hash, path, out, opts);
			continue;
		}
		if (opts.treesOnly && entry.mode !== FileMode.SUBMODULE) continue;
		out.push({ ...entry, path });
	}
}

function filterMatches(filter: PathFilter, path: string, mode: string): boolean {
	if (filter.path === "" || path.startsWith(`${filter.path}/`)) return true;
	if (path === filter.path) {
		return !filter.listContents || mode === FileMode.DIRECTORY || mode === FileMode.SUBMODULE;
	}
	return mode === FileMode.DIRECTORY && filter.path.startsWith(`${path}/`);
}

function displayPath(prefix: string, path: string): string {
	if (!prefix) return path;
	const rel = relative(prefix, path) || ".";
	return prefix === path || prefix.startsWith(`${path}/`) ? `${rel}/` : rel;
}

function objectType(mode: string): "tree" | "commit" | "blob" {
	if (mode === FileMode.DIRECTORY) return "tree";
	if (mode === FileMode.SUBMODULE) return "commit";
	return "blob";
}
