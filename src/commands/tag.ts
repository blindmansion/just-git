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
import { writeObject } from "../lib/object-db.ts";
import { serializeTag } from "../lib/objects/tag.ts";
import {
	deleteRef,
	isValidTagName,
	listRefs,
	resolveHead,
	resolveRef,
	updateRef,
} from "../lib/refs.ts";
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
				return listTags(gitCtx, args.name || undefined);
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
				} else {
					await updateRef(gitCtx, refName, targetHash);
				}

				return { stdout: "", stderr: "", exitCode: 0 };
			}

			// ── List tags (no args) ─────────────────────────────────────
			return listTags(gitCtx);
		},
	});
}

async function listTags(gitCtx: Parameters<typeof listRefs>[0], pattern?: string) {
	const refs = await listRefs(gitCtx, "refs/tags");
	if (refs.length === 0) {
		return { stdout: "", stderr: "", exitCode: 0 };
	}

	let names = refs.map((ref) => ref.name.replace("refs/tags/", ""));
	if (pattern) {
		names = names.filter((name) => wildmatch(pattern, name, 0) === WM_MATCH);
	}

	if (names.length === 0) {
		return { stdout: "", stderr: "", exitCode: 0 };
	}

	return {
		stdout: `${names.join("\n")}\n`,
		stderr: "",
		exitCode: 0,
	};
}
