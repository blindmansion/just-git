import type { GitExtensions } from "../git.ts";
import {
	abbreviateHash,
	ensureTrailingNewline,
	err,
	fatal,
	isCommandError,
	requireCommitter,
	requireGitContext,
	requireRevision,
} from "../lib/command-utils.ts";
import { readCommit, readObject, readTag, writeObject } from "../lib/object-db.ts";
import { serializeTag } from "../lib/objects/tag.ts";
import {
	deleteRef,
	isValidTagName,
	listRefs,
	resolveHead,
	resolveRef,
	updateRef,
} from "../lib/refs.ts";
import type { GitRepo, ObjectId } from "../lib/types.ts";
import { WM_MATCH, wildmatch } from "../lib/wildmatch.ts";
import { a, type Command, f, o } from "../parse/index.ts";

export function registerTagCommand(parent: Command, ext?: GitExtensions) {
	parent.command("tag", {
		description: "Create, list, or delete tags",
		args: [
			a.string().name("name").describe("Tag name to create or delete").optional(),
			a.string().name("commit").describe("Commit to tag (defaults to HEAD)").optional(),
		],
		options: {
			annotate: f().alias("a").describe("Make an annotated tag object"),
			message: o.string().alias("m").describe("Tag message"),
			delete: f().alias("d").describe("Delete a tag"),
			force: f().alias("f").describe("Replace an existing tag"),
			list: f().alias("l").describe("List tags matching pattern"),
			sort: o
				.string()
				.describe(
					"Sort order (e.g. creatordate, -creatordate, refname, -refname, version:refname, -version:refname)",
				),
		},
		handler: async (args, ctx) => {
			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;
			const gitCtx = gitCtxOrError;

			// ── Delete tag ──────────────────────────────────────────────
			if (args.delete) {
				if (!args.name) {
					return fatal("tag name required");
				}

				const refName = `refs/tags/${args.name}`;
				const hash = await resolveRef(gitCtx, refName);
				if (!hash) {
					return err(`error: tag '${args.name}' not found.\n`);
				}

				await deleteRef(gitCtx, refName);
				return {
					stdout: `Deleted tag '${args.name}' (was ${abbreviateHash(hash)})\n`,
					stderr: "",
					exitCode: 0,
				};
			}

			// ── List tags with pattern (-l [<pattern>]) ─────────────────
			if (args.list) {
				return listTags(gitCtx, args.name || undefined, args.sort);
			}

			// ── Create tag ──────────────────────────────────────────────
			if (args.name) {
				if (!isValidTagName(args.name)) {
					return fatal(`'${args.name}' is not a valid tag name`);
				}

				const commitArg = args.commit;
				let targetHash: string | null;
				if (commitArg) {
					const resolved = await requireRevision(
						gitCtx,
						commitArg,
						`Failed to resolve '${commitArg}' as a valid ref.`,
					);
					if (isCommandError(resolved)) return resolved;
					targetHash = resolved;
				} else {
					targetHash = await resolveHead(gitCtx);
					if (!targetHash) {
						return fatal("Failed to resolve 'HEAD' as a valid ref.");
					}
				}

				const refName = `refs/tags/${args.name}`;
				const existing = await resolveRef(gitCtx, refName);
				if (existing && !args.force) {
					return fatal(`tag '${args.name}' already exists`);
				}

				const isAnnotated = args.annotate || args.message;

				let newRefHash: string;
				if (isAnnotated) {
					if (!args.message) {
						return fatal("no tag message specified (use -m)");
					}

					const tagger = await requireCommitter(gitCtx, ctx.env);
					if (isCommandError(tagger)) return tagger;

					const message = ensureTrailingNewline(args.message);

					const tagContent = serializeTag({
						type: "tag",
						object: targetHash,
						objectType: "commit",
						name: args.name,
						tagger,
						message,
					});
					const tagHash = await writeObject(gitCtx, "tag", tagContent);
					await updateRef(gitCtx, refName, tagHash);
					newRefHash = tagHash;
				} else {
					await updateRef(gitCtx, refName, targetHash);
					newRefHash = targetHash;
				}

				const forceMessage =
					existing && args.force && existing !== newRefHash
						? `Updated tag '${args.name}' (was ${abbreviateHash(existing)})\n`
						: "";
				return { stdout: forceMessage, stderr: "", exitCode: 0 };
			}

			// ── List tags (no args) ─────────────────────────────────────
			return listTags(gitCtx, undefined, args.sort);
		},
	});
}

async function listTags(gitCtx: GitRepo, pattern?: string, sort?: string) {
	const refs = await listRefs(gitCtx, "refs/tags");
	if (refs.length === 0) {
		return { stdout: "", stderr: "", exitCode: 0 };
	}

	let filtered = refs.map((ref) => ({ name: ref.name.replace("refs/tags/", ""), hash: ref.hash }));
	if (pattern) {
		filtered = filtered.filter((t) => wildmatch(pattern, t.name, 0) === WM_MATCH);
	}

	if (filtered.length === 0) {
		return { stdout: "", stderr: "", exitCode: 0 };
	}

	if (sort) {
		const reverse = sort.startsWith("-");
		const key = reverse ? sort.slice(1) : sort;

		if (key === "creatordate") {
			const withDate = await Promise.all(
				filtered.map(async (t) => ({
					...t,
					date: await getCreatorDate(gitCtx, t.hash),
				})),
			);
			withDate.sort((a, b) => {
				const d = a.date - b.date;
				return d !== 0 ? d : a.name.localeCompare(b.name);
			});
			if (reverse) withDate.reverse();
			filtered = withDate;
		} else if (key === "version:refname" || key === "v:refname") {
			filtered.sort((a, b) => compareVersions(a.name, b.name));
			if (reverse) filtered.reverse();
		} else if (key === "refname") {
			filtered.sort((a, b) => a.name.localeCompare(b.name));
			if (reverse) filtered.reverse();
		}
	}

	return {
		stdout: `${filtered.map((t) => t.name).join("\n")}\n`,
		stderr: "",
		exitCode: 0,
	};
}

async function getCreatorDate(ctx: GitRepo, hash: ObjectId): Promise<number> {
	const raw = await readObject(ctx, hash);
	if (raw.type === "tag") {
		const tag = await readTag(ctx, hash);
		return tag.tagger.timestamp;
	}
	try {
		const commit = await readCommit(ctx, hash);
		return commit.committer.timestamp;
	} catch {
		return 0;
	}
}

function compareVersions(a: string, b: string): number {
	const pa = a.replace(/^v/i, "").split(/[.\-+]/);
	const pb = b.replace(/^v/i, "").split(/[.\-+]/);
	const len = Math.max(pa.length, pb.length);
	for (let i = 0; i < len; i++) {
		const sa = pa[i] ?? "";
		const sb = pb[i] ?? "";
		const na = Number(sa);
		const nb = Number(sb);
		if (!Number.isNaN(na) && !Number.isNaN(nb)) {
			if (na !== nb) return na - nb;
		} else {
			const cmp = sa.localeCompare(sb);
			if (cmp !== 0) return cmp;
		}
	}
	return 0;
}
