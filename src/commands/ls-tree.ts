import type { GitExtensions } from "../git.ts";
import {
	DEFAULT_ABBREV,
	fatal,
	getCwdPrefix,
	isCommandError,
	requireGitContext,
	uniqueAbbrev,
} from "../lib/command-utils.ts";
import { readObject } from "../lib/object-db.ts";
import { parseCommit } from "../lib/objects/commit.ts";
import { parseTag } from "../lib/objects/tag.ts";
import { join, relative } from "../lib/path.ts";
import { resolveRevision } from "../lib/rev-parse.ts";
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

			const [treeIsh, ...rawPaths] =
				args["tree-ish"] === undefined
					? meta.passthrough
					: [args["tree-ish"], ...(args.path ?? []), ...meta.passthrough];
			if (treeIsh === undefined) return { stdout: "", stderr: USAGE, exitCode: 129 };

			const resolved = await resolveRevision(gitCtx, treeIsh);
			if (!resolved) return fatal(`Not a valid object name ${treeIsh}`);
			if (rawPaths.includes("")) {
				return fatal(
					"empty string is not a valid pathspec. please use . instead if you meant to match all paths",
				);
			}

			const prefix = args.fullTree ? "" : getCwdPrefix(gitCtx, ctx.cwd);
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

			const treeHash = await peelToTree(gitCtx, resolved);
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
			let stdout = "";
			for (const entry of entries) {
				const shown = displayPath(prefix, entry.path);
				const name = args.nulTerminate ? shown : quotePath(shown);
				if (nameOnly) {
					stdout += name + terminator;
					continue;
				}
				const oid = args.abbrev ? await uniqueAbbrev(gitCtx, entry.hash, args.abbrev) : entry.hash;
				stdout += `${entry.mode} ${objectType(entry.mode)} ${oid}\t${name}${terminator}`;
			}
			return { stdout, stderr: "", exitCode: 0 };
		},
	});
}

async function peelToTree(ctx: GitRepo, hash: ObjectId): Promise<ObjectId | null> {
	let current = hash;
	for (;;) {
		const raw = await readObject(ctx, current);
		if (raw.type === "tree") return current;
		if (raw.type === "commit") return parseCommit(raw.content).tree;
		if (raw.type !== "tag") return null;
		current = parseTag(raw.content).object;
	}
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

const C_ESCAPES: Record<number, string> = {
	0x07: "\\a",
	0x08: "\\b",
	0x09: "\\t",
	0x0a: "\\n",
	0x0b: "\\v",
	0x0c: "\\f",
	0x0d: "\\r",
	0x22: '\\"',
	0x5c: "\\\\",
};

function quotePath(path: string): string {
	const bytes = new TextEncoder().encode(path);
	let out = "";
	let quoted = false;
	for (const byte of bytes) {
		const escape = C_ESCAPES[byte];
		if (escape) {
			out += escape;
			quoted = true;
		} else if (byte < 0x20 || byte >= 0x7f) {
			out += `\\${byte.toString(8).padStart(3, "0")}`;
			quoted = true;
		} else {
			out += String.fromCharCode(byte);
		}
	}
	return quoted ? `"${out}"` : path;
}
