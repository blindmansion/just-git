import type { GitExtensions } from "../git.ts";
import { formatCombinedDiffEntry } from "../lib/combined-diff.ts";
import {
	abbreviateHash,
	fatal,
	isCommandError,
	requireCommit,
	requireGitContext,
	requireHead,
	requireRevision,
} from "../lib/command-utils.ts";
import { formatDate } from "../lib/date.ts";
import { formatUnifiedDiff } from "../lib/diff-algorithm.ts";
import { readBlobContent, readCommit, readObject, readTag } from "../lib/object-db.ts";
import { detectRenames, type RenamePair } from "../lib/rename-detection.ts";
import { parseRevPath } from "../lib/rev-parse.ts";
import { parseTree } from "../lib/objects/tree.ts";
import { join } from "../lib/path.ts";
import { diffTrees, flattenTreeToMap } from "../lib/tree-ops.ts";
import type { Commit, GitContext, ObjectId, Tag, Tree, TreeDiffEntry } from "../lib/types.ts";
import { a, type Command } from "../parse/index.ts";

const decoder = new TextDecoder();

export function registerShowCommand(parent: Command, ext?: GitExtensions) {
	parent.command("show", {
		description: "Show various types of objects",
		args: [a.string().name("object").variadic().optional()],
		handler: async (args, ctx) => {
			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;
			const gitCtx = gitCtxOrError;

			const objectArgs = args.object;
			const rev = objectArgs[0] ?? "HEAD";

			// ── Handle <rev>:<path> syntax ─────────────────────────
			const revPath = parseRevPath(rev);
			if (revPath) {
				return handleRevPath(gitCtx, revPath.rev, revPath.path);
			}

			// For HEAD default, check if there are commits
			if (rev === "HEAD") {
				const headHash = await requireHead(gitCtx);
				if (isCommandError(headHash)) return headHash;
			}

			const hash = await requireRevision(gitCtx, rev, `bad object '${rev}'`);
			if (isCommandError(hash)) return hash;

			const raw = await readObject(gitCtx, hash);

			switch (raw.type) {
				case "commit": {
					const commit = await readCommit(gitCtx, hash);
					const output = await formatCommitShow(gitCtx, hash, commit);
					return { stdout: output, stderr: "", exitCode: 0 };
				}
				case "tag": {
					const tag = await readTag(gitCtx, hash);
					const output = await formatTagShow(gitCtx, tag);
					return { stdout: output, stderr: "", exitCode: 0 };
				}
				case "tree": {
					const tree: Tree = parseTree(raw.content);
					const output = formatTreeShow(tree);
					return { stdout: output, stderr: "", exitCode: 0 };
				}
				case "blob": {
					const content = decoder.decode(raw.content);
					return { stdout: content, stderr: "", exitCode: 0 };
				}
			}
		},
	});
}

// ── rev:path handling ───────────────────────────────────────────────

async function handleRevPath(
	ctx: GitContext,
	rev: string,
	path: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const result = await requireCommit(ctx, rev);
	if (isCommandError(result)) return result;
	const treeHash = result.commit.tree;

	const normalizedPath = path.replace(/^\//, "");

	const treeMap = await flattenTreeToMap(ctx, treeHash);
	const entry = treeMap.get(normalizedPath);
	if (!entry) {
		let msg = `path '${normalizedPath}' does not exist in '${rev}'`;
		if (ctx.workTree) {
			const diskPath = join(ctx.workTree, normalizedPath);
			if (await ctx.fs.exists(diskPath)) {
				msg = `path '${normalizedPath}' exists on disk, but not in '${rev}'`;
			}
		}
		return fatal(msg);
	}

	const raw = await readObject(ctx, entry.hash);
	if (raw.type === "blob") {
		return { stdout: decoder.decode(raw.content), stderr: "", exitCode: 0 };
	}
	if (raw.type === "tree") {
		const tree: Tree = parseTree(raw.content);
		const output = formatTreeShow(tree);
		return { stdout: output, stderr: "", exitCode: 0 };
	}

	return { stdout: decoder.decode(raw.content), stderr: "", exitCode: 0 };
}

// ── Commit display ──────────────────────────────────────────────────

async function formatCommitShow(ctx: GitContext, hash: ObjectId, commit: Commit): Promise<string> {
	const lines: string[] = [];

	lines.push(`commit ${hash}`);
	if (commit.parents.length >= 2) {
		const abbrevParents = commit.parents.map((p) => abbreviateHash(p)).join(" ");
		lines.push(`Merge: ${abbrevParents}`);
	}
	lines.push(`Author: ${commit.author.name} <${commit.author.email}>`);
	lines.push(`Date:   ${formatDate(commit.author.timestamp, commit.author.timezone)}`);
	lines.push("");
	const msg = commit.message.replace(/\n$/, "");
	for (const msgLine of msg.split("\n")) {
		lines.push(`    ${msgLine}`);
	}

	if (commit.parents.length <= 1) {
		// Non-merge: show unified diff against parent
		const parentTree =
			commit.parents.length === 1
				? (await readCommit(ctx, commit.parents[0] as ObjectId)).tree
				: null;

		const rawDiffs = await diffTrees(ctx, parentTree, commit.tree);
		const { remaining: diffs, renames } = await detectRenames(ctx, rawDiffs);
		const diffOutput = await formatDiffsWithRenames(ctx, diffs, renames);
		if (diffOutput) {
			lines.push("");
			lines.push(diffOutput.replace(/\n$/, ""));
		}
	} else {
		// Merge commit: show combined diff (diff --cc)
		const combinedOutput = await formatCombinedDiff(ctx, commit);
		if (combinedOutput) {
			lines.push("");
			lines.push(combinedOutput.replace(/\n$/, ""));
		} else {
			// Real git adds a trailing blank line even with no combined diff
			lines.push("");
		}
	}

	return `${lines.join("\n")}\n`;
}

// ── Tag display ─────────────────────────────────────────────────────

async function formatTagShow(ctx: GitContext, tag: Tag): Promise<string> {
	const lines: string[] = [];

	lines.push(`tag ${tag.name}`);
	lines.push(`Tagger: ${tag.tagger.name} <${tag.tagger.email}>`);
	lines.push(`Date:   ${formatDate(tag.tagger.timestamp, tag.tagger.timezone)}`);
	lines.push("");
	const msg = tag.message.replace(/\n$/, "");
	for (const msgLine of msg.split("\n")) {
		lines.push(`    ${msgLine}`);
	}

	// Then show the tagged object (typically a commit)
	if (tag.objectType === "commit") {
		const commit = await readCommit(ctx, tag.object);
		const commitOutput = await formatCommitShow(ctx, tag.object, commit);
		lines.push("");
		lines.push(commitOutput.replace(/\n$/, ""));
	}

	return `${lines.join("\n")}\n`;
}

// ── Tree display ────────────────────────────────────────────────────

function formatTreeShow(tree: Tree): string {
	const lines: string[] = [];
	for (const entry of tree.entries) {
		const type = entry.mode === "040000" ? "tree" : "blob";
		lines.push(`${entry.mode} ${type} ${entry.hash}\t${entry.name}`);
	}
	return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

// ── Helpers ─────────────────────────────────────────────────────────

async function formatTreeDiff(ctx: GitContext, diff: TreeDiffEntry): Promise<string> {
	const oldContent = diff.oldHash ? await readBlobContent(ctx, diff.oldHash) : "";
	const newContent = diff.newHash ? await readBlobContent(ctx, diff.newHash) : "";

	return formatUnifiedDiff({
		path: diff.path,
		oldContent,
		newContent,
		oldMode: diff.oldMode,
		newMode: diff.newMode,
		oldHash: diff.oldHash,
		newHash: diff.newHash,
	});
}

async function formatRenameDiff(ctx: GitContext, rename: RenamePair): Promise<string> {
	const oldContent = rename.oldHash ? await readBlobContent(ctx, rename.oldHash) : "";
	const newContent = rename.newHash ? await readBlobContent(ctx, rename.newHash) : "";

	return formatUnifiedDiff({
		path: rename.oldPath,
		oldContent,
		newContent,
		oldMode: rename.oldMode,
		newMode: rename.newMode,
		oldHash: rename.oldHash,
		newHash: rename.newHash,
		renameTo: rename.newPath,
		similarity: rename.similarity,
	});
}

async function formatDiffsWithRenames(
	ctx: GitContext,
	diffs: TreeDiffEntry[],
	renames: RenamePair[],
): Promise<string> {
	// Combine remaining diffs and renames, sorted by path
	type DiffItem = { type: "diff"; entry: TreeDiffEntry } | { type: "rename"; entry: RenamePair };
	const allItems: DiffItem[] = [];
	for (const d of diffs) allItems.push({ type: "diff", entry: d });
	for (const r of renames) allItems.push({ type: "rename", entry: r });
	allItems.sort((a, b) => {
		const pathA = a.type === "diff" ? a.entry.path : a.entry.newPath;
		const pathB = b.type === "diff" ? b.entry.path : b.entry.newPath;
		return pathA < pathB ? -1 : pathA > pathB ? 1 : 0;
	});

	let output = "";
	for (const item of allItems) {
		if (item.type === "rename") {
			output += await formatRenameDiff(ctx, item.entry);
		} else {
			output += await formatTreeDiff(ctx, item.entry);
		}
	}
	return output;
}

// ── Combined diff for merge commits ─────────────────────────────────

interface FlatEntry {
	path: string;
	mode: string;
	hash: string;
}

async function formatCombinedDiff(ctx: GitContext, commit: Commit): Promise<string> {
	if (commit.parents.length < 2) return "";

	// Get flat tree entries for each parent and the result
	const parentMaps = await Promise.all(
		commit.parents.map(async (p) => {
			const c = await readCommit(ctx, p as ObjectId);
			return flattenTreeToMap(ctx, c.tree);
		}),
	);
	const resultMap = await flattenTreeToMap(ctx, commit.tree);

	// Collect all paths from all parents and result
	const allPaths = new Set<string>();
	for (const m of parentMaps) for (const p of m.keys()) allPaths.add(p);
	for (const p of resultMap.keys()) allPaths.add(p);

	// Find "interesting" paths: those where the result differs from ALL parents
	const interestingPaths: string[] = [];
	for (const path of allPaths) {
		const resultEntry = resultMap.get(path);
		const resultHash = resultEntry?.hash ?? null;
		const differsFromAll = parentMaps.every((pm) => {
			const pe = pm.get(path);
			return (pe?.hash ?? null) !== resultHash;
		});
		if (differsFromAll) {
			interestingPaths.push(path);
		}
	}
	interestingPaths.sort();

	if (interestingPaths.length === 0) return "";

	let output = "";
	for (const path of interestingPaths) {
		output += await formatCombinedEntry(ctx, path, parentMaps, resultMap);
	}
	return output;
}

async function formatCombinedEntry(
	ctx: GitContext,
	path: string,
	parentMaps: Map<string, FlatEntry>[],
	resultMap: Map<string, FlatEntry>,
): Promise<string> {
	const resultEntry = resultMap.get(path);
	const parentEntries = parentMaps.map((pm) => pm.get(path) ?? null);

	const resultHash = resultEntry?.hash ?? null;
	const resultMode = resultEntry?.mode ?? null;
	const parentHashes = parentEntries.map((e) => e?.hash ?? null);
	const parentModes = parentEntries.map((e) => e?.mode ?? null);

	const parentContents = await Promise.all(
		parentHashes.map(async (h) => (h ? await readBlobContent(ctx, h) : "")),
	);
	const resultContent = resultHash ? await readBlobContent(ctx, resultHash) : "";

	return formatCombinedDiffEntry({
		path,
		parentHashes,
		parentModes,
		parentContents,
		resultHash,
		resultMode,
		resultContent,
	});
}
