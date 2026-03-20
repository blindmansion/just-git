import type { GitExtensions } from "../git.ts";
import {
	fatal,
	hasStagedChanges,
	isCommandError,
	requireGitContext,
	requireWorkTree,
} from "../lib/command-utils.ts";
import { peelToCommit, readCommit, readObject } from "../lib/object-db.ts";
import { readIndex } from "../lib/index.ts";
import { listRefs, resolveHead } from "../lib/refs.ts";
import { resolveRevision } from "../lib/rev-parse.ts";
import { flattenTreeToMap } from "../lib/tree-ops.ts";
import { diffIndexToWorkTree } from "../lib/worktree.ts";
import { WM_MATCH, wildmatch } from "../lib/wildmatch.ts";
import { parseTag } from "../lib/objects/tag.ts";
import type { GitContext, GitRepo, ObjectId } from "../lib/types.ts";
import { a, type Command, f, o } from "../parse/index.ts";

interface TagCandidate {
	name: string;
	commitHash: ObjectId;
	/** Unix epoch seconds for annotated tags; 0 for lightweight. */
	timestamp: number;
}

export function registerDescribeCommand(parent: Command, ext?: GitExtensions) {
	parent.command("describe", {
		description: "Give an object a human readable name based on an available ref",
		args: [a.string().name("committish").describe("Commit to describe").optional()],
		options: {
			tags: f().describe("Use any tag, not just annotated"),
			always: f().describe("Show abbreviated hash as fallback"),
			long: f().describe("Always output long format"),
			abbrev: o.number().describe("Abbreviation length"),
			dirty: o.string().describe("Append dirty marker if worktree has changes"),
			match: o.string().describe("Only consider tags matching glob"),
			exclude: o.string().describe("Exclude tags matching glob"),
			exactMatch: f().alias("exact-match").describe("Only output exact matches"),
			firstParent: f().alias("first-parent").describe("Only follow first parent"),
			candidates: o.number().describe("Consider N most recent tags"),
		},
		transformArgs(tokens) {
			// --dirty can appear bare (no =value), meaning "-dirty" suffix.
			// The parser would try to consume the next token as its value,
			// so we normalize bare --dirty into --dirty=-dirty here.
			return tokens.map((t) => (t === "--dirty" ? "--dirty=-dirty" : t));
		},
		handler: async (args, ctx) => {
			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;
			const gitCtx = gitCtxOrError;

			const committish = args.committish as string | undefined;
			const useTags = args.tags as boolean;
			const alwaysFallback = args.always as boolean;
			const longFormat = args.long as boolean;
			const abbrev = (args.abbrev as number | undefined) ?? 7;
			const dirtySuffix = args.dirty as string | undefined;
			const matchPattern = args.match as string | undefined;
			const excludePattern = args.exclude as string | undefined;
			const exactMatch = args.exactMatch as boolean;
			const firstParent = args.firstParent as boolean;

			// Resolve the target to a commit hash (peel tags)
			let targetHash: string | null;
			if (committish) {
				const resolved = await resolveRevision(gitCtx, committish);
				if (!resolved) return fatal(`Not a valid object name ${committish}`);
				try {
					targetHash = await peelToCommit(gitCtx, resolved);
				} catch {
					return fatal(`Not a valid object name ${committish}`);
				}
			} else {
				targetHash = await resolveHead(gitCtx);
			}
			if (!targetHash) {
				return fatal("your current branch does not have any commits yet");
			}

			// Build tag candidates
			const candidates = await buildTagCandidates(gitCtx, useTags, matchPattern, excludePattern);

			// Index candidates by the commit they point to
			const commitToTags = new Map<ObjectId, TagCandidate[]>();
			let hasLightweight = false;
			for (const c of candidates) {
				if (c.timestamp === 0) hasLightweight = true;
				let list = commitToTags.get(c.commitHash);
				if (!list) {
					list = [];
					commitToTags.set(c.commitHash, list);
				}
				list.push(c);
			}

			// BFS from target commit backward through parents
			const found = await findNearestTag(
				gitCtx,
				targetHash,
				commitToTags,
				firstParent,
				exactMatch ? 0 : undefined,
			);

			if (!found) {
				if (exactMatch) {
					return fatal(`no tag exactly matches '${targetHash}'`);
				}
				if (alwaysFallback) {
					let output = targetHash.slice(0, Math.max(abbrev, 1));
					if (dirtySuffix && (await isDirty(gitCtx))) output += dirtySuffix;
					return { stdout: output + "\n", stderr: "", exitCode: 0 };
				}

				let msg: string;
				if (!useTags && hasLightweight) {
					msg =
						`fatal: No annotated tags can describe '${targetHash}'.\n` +
						"However, there were unannotated tags: try --tags.\n";
				} else if (candidates.length === 0 && !useTags) {
					// Check if there are any lightweight tags we filtered out
					const allTagRefs = await listRefs(gitCtx, "refs/tags");
					if (allTagRefs.length > 0) {
						msg =
							`fatal: No annotated tags can describe '${targetHash}'.\n` +
							"However, there were unannotated tags: try --tags.\n";
					} else {
						msg = "fatal: No names found, cannot describe anything.\n";
					}
				} else {
					msg = "fatal: No names found, cannot describe anything.\n";
				}
				return { stdout: "", stderr: msg, exitCode: 128 };
			}

			const { tag, depth } = found;
			let output: string;

			if (depth === 0 && !longFormat) {
				output = tag.name;
			} else if (abbrev === 0) {
				output = tag.name;
			} else {
				const shortHash = targetHash.slice(0, Math.max(abbrev, 1));
				output = `${tag.name}-${depth}-g${shortHash}`;
			}

			if (dirtySuffix && (await isDirty(gitCtx))) {
				output += dirtySuffix;
			}

			return { stdout: output + "\n", stderr: "", exitCode: 0 };
		},
	});
}

async function buildTagCandidates(
	ctx: GitRepo,
	includeLightweight: boolean,
	matchPattern: string | undefined,
	excludePattern: string | undefined,
): Promise<TagCandidate[]> {
	const tagRefs = await listRefs(ctx, "refs/tags");
	const candidates: TagCandidate[] = [];

	for (const ref of tagRefs) {
		const tagName = ref.name.replace("refs/tags/", "");

		if (matchPattern && wildmatch(matchPattern, tagName, 0) !== WM_MATCH) continue;
		if (excludePattern && wildmatch(excludePattern, tagName, 0) === WM_MATCH) continue;

		const raw = await readObject(ctx, ref.hash);

		if (raw.type === "tag") {
			const tag = parseTag(raw.content);
			let commitHash: ObjectId;
			try {
				commitHash = await peelToCommit(ctx, tag.object);
			} catch {
				continue;
			}
			candidates.push({
				name: tagName,
				commitHash,
				timestamp: tag.tagger.timestamp,
			});
		} else if (raw.type === "commit" && includeLightweight) {
			candidates.push({
				name: tagName,
				commitHash: ref.hash,
				timestamp: 0,
			});
		}
	}

	return candidates;
}

async function findNearestTag(
	ctx: GitRepo,
	startHash: ObjectId,
	commitToTags: Map<ObjectId, TagCandidate[]>,
	firstParent: boolean,
	maxDepth?: number,
): Promise<{ tag: TagCandidate; depth: number } | null> {
	const visited = new Set<ObjectId>();
	const queue: { hash: ObjectId; depth: number }[] = [{ hash: startHash, depth: 0 }];

	while (queue.length > 0) {
		const { hash, depth } = queue.shift()!;
		if (visited.has(hash)) continue;
		visited.add(hash);

		if (maxDepth !== undefined && depth > maxDepth) continue;

		const tags = commitToTags.get(hash);
		if (tags && tags.length > 0) {
			const best = pickBestTag(tags);
			return { tag: best, depth };
		}

		let commit;
		try {
			commit = await readCommit(ctx, hash);
		} catch {
			continue;
		}

		if (firstParent) {
			if (commit.parents.length > 0 && !visited.has(commit.parents[0]!)) {
				queue.push({ hash: commit.parents[0]!, depth: depth + 1 });
			}
		} else {
			for (const parent of commit.parents) {
				if (!visited.has(parent)) {
					queue.push({ hash: parent, depth: depth + 1 });
				}
			}
		}
	}

	return null;
}

/** When multiple tags point to the same commit, prefer newest, then alphabetically first. */
function pickBestTag(tags: TagCandidate[]): TagCandidate {
	return tags.sort((a, b) => {
		if (b.timestamp !== a.timestamp) return b.timestamp - a.timestamp;
		return a.name.localeCompare(b.name);
	})[0]!;
}

async function isDirty(ctx: GitContext): Promise<boolean> {
	const wtErr = requireWorkTree(ctx);
	if (wtErr) return false;

	const headHash = await resolveHead(ctx);
	if (!headHash) return false;

	const commit = await readCommit(ctx, headHash);
	const headMap = await flattenTreeToMap(ctx, commit.tree);
	const index = await readIndex(ctx);

	if (hasStagedChanges(index, headMap)) return true;

	const worktreeDiff = await diffIndexToWorkTree(ctx, index);
	return worktreeDiff.length > 0;
}
