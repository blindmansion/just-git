import type { GitExtensions } from "../git.ts";
import { isRejection } from "../hooks.ts";
import {
	abbreviateHash,
	err,
	fatal,
	isCommandError,
	requireGitContext,
} from "../lib/command-utils.ts";
import { readConfig, writeConfig } from "../lib/config.ts";
import { ZERO_HASH } from "../lib/hex.ts";
import { listRefs, readHead, resolveHead, resolveRef } from "../lib/refs.ts";
import { parseRefspec } from "../lib/transport/refspec.ts";
import { resolveRemoteTransport } from "../lib/transport/remote.ts";
import type { PushRefUpdate } from "../lib/transport/transport.ts";
import type { GitContext, ObjectId } from "../lib/types.ts";
import { a, type Command, f } from "../parse/index.ts";

export function registerPushCommand(parent: Command, ext?: GitExtensions) {
	parent.command("push", {
		description: "Update remote refs along with associated objects",
		args: [
			a.string().name("remote").describe("Remote to push to").optional(),
			a.string().name("refspec").describe("Refspec(s) to push").optional().variadic(),
		],
		options: {
			force: f().alias("f").describe("Force push"),
			"set-upstream": f().alias("u").describe("Set upstream tracking reference"),
			all: f().describe("Push all branches"),
			delete: f().alias("d").describe("Delete remote refs"),
			tags: f().describe("Push all tags"),
		},
		handler: async (args, ctx) => {
			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;
			const gitCtx = gitCtxOrError;

			const remoteName = args.remote || "origin";
			let resolved;
			try {
				resolved = await resolveRemoteTransport(gitCtx, remoteName, ctx.env);
			} catch (e) {
				const msg = e instanceof Error ? e.message : "";
				if (msg.startsWith("network")) return fatal(msg);
				throw e;
			}
			if (!resolved) {
				return fatal(`'${remoteName}' does not appear to be a git repository`);
			}

			const { transport, config } = resolved;
			const force = args.force;

			// Get remote refs for oldHash values
			const remoteRefs = await transport.advertiseRefs();
			const remoteRefMap = new Map<string, ObjectId>();
			for (const r of remoteRefs) {
				remoteRefMap.set(r.name, r.hash);
			}

			// Build push updates
			const updates: PushRefUpdate[] = [];
			const rawRefspecs = args.refspec;

			if (args.delete) {
				// --delete: treat refspecs as refs to delete on the remote
				const refs = rawRefspecs && rawRefspecs.length > 0 ? rawRefspecs : [];
				if (refs.length === 0) {
					return fatal("--delete requires a ref argument");
				}
				for (const ref of refs) {
					const fullRef = ref.startsWith("refs/") ? ref : `refs/heads/${ref}`;
					const oldHash = remoteRefMap.get(fullRef) ?? null;
					if (!oldHash) {
						return err(`error: unable to delete '${ref}': remote ref does not exist\n`);
					}
					updates.push({
						name: fullRef,
						oldHash,
						newHash: ZERO_HASH,
						ok: force,
					});
				}
			} else if (args.all) {
				// --all: push all local branches
				const localRefs = await listRefs(gitCtx, "refs/heads");
				for (const ref of localRefs) {
					const remoteBranch = ref.name;
					const oldHash = remoteRefMap.get(remoteBranch) ?? null;
					updates.push({
						name: remoteBranch,
						oldHash,
						newHash: ref.hash,
						ok: force,
					});
				}
			} else if (args.tags) {
				// --tags: push all tags
				const localRefs = await listRefs(gitCtx, "refs/tags");
				for (const ref of localRefs) {
					const oldHash = remoteRefMap.get(ref.name) ?? null;
					if (oldHash === ref.hash) continue;
					updates.push({
						name: ref.name,
						oldHash,
						newHash: ref.hash,
						ok: force,
					});
				}
			} else if (rawRefspecs && rawRefspecs.length > 0) {
				// Explicit refspecs
				for (const raw of rawRefspecs) {
					const spec = parseRefspec(raw);
					const srcHash = await resolveRefForPush(gitCtx, spec.src);
					if (!srcHash) {
						return err(`error: src refspec '${spec.src}' does not match any\n`);
					}
					const dstRef = spec.dst.startsWith("refs/") ? spec.dst : `refs/heads/${spec.dst}`;
					const oldHash = remoteRefMap.get(dstRef) ?? null;
					updates.push({
						name: dstRef,
						oldHash,
						newHash: srcHash,
						ok: force || spec.force,
					});
				}
			} else {
				// Default: push current branch to same-named remote branch
				const head = await readHead(gitCtx);
				if (!head || head.type !== "symbolic") {
					return fatal("You are not currently on a branch.");
				}
				const branchRef = head.target;
				const localHash = await resolveHead(gitCtx);
				if (!localHash) {
					return err("error: src refspec does not match any\n");
				}
				const oldHash = remoteRefMap.get(branchRef) ?? null;
				updates.push({
					name: branchRef,
					oldHash,
					newHash: localHash,
					ok: force,
				});
			}

			if (updates.length === 0) {
				return {
					stdout: "Everything up-to-date\n",
					stderr: "",
					exitCode: 0,
				};
			}

			// pre-push hook
			const prePushRej = await ext?.hooks?.prePush?.({
				repo: gitCtx,
				remote: remoteName,
				url: config.url,
				refs: updates.map((u) => ({
					srcRef: u.newHash === ZERO_HASH ? null : u.name,
					srcHash: u.newHash === ZERO_HASH ? null : u.newHash,
					dstRef: u.name,
					dstHash: u.oldHash,
					force: !!u.ok,
					delete: u.newHash === ZERO_HASH,
				})),
			});
			if (isRejection(prePushRej)) return err(prePushRej.message ?? "");

			// Execute the push
			const result = await transport.push(updates);

			// Build output
			const stderr: string[] = [];
			stderr.push(`To ${config.url}\n`);
			let hasError = false;

			for (const update of result.updates) {
				const shortRef = update.name.startsWith("refs/heads/")
					? update.name.slice("refs/heads/".length)
					: update.name;

				if (!update.ok) {
					stderr.push(
						` ! [rejected]        ${shortRef} -> ${shortRef} (${update.error ?? "failed"})\n`,
					);
					hasError = true;
				} else if (!update.oldHash) {
					stderr.push(` * [new branch]      ${shortRef} -> ${shortRef}\n`);
				} else if (update.newHash === ZERO_HASH) {
					stderr.push(` - [deleted]         ${shortRef}\n`);
				} else {
					const shortOld = abbreviateHash(update.oldHash);
					const shortNew = abbreviateHash(update.newHash);
					stderr.push(`   ${shortOld}..${shortNew}  ${shortRef} -> ${shortRef}\n`);
				}
			}

			// Set upstream if -u was passed
			if (args["set-upstream"] && !hasError) {
				const head = await readHead(gitCtx);
				if (head?.type === "symbolic") {
					const branchName = head.target.startsWith("refs/heads/")
						? head.target.slice("refs/heads/".length)
						: head.target;
					const cfg = await readConfig(gitCtx);
					cfg[`branch "${branchName}"`] = {
						remote: remoteName,
						merge: `refs/heads/${branchName}`,
					};
					await writeConfig(gitCtx, cfg);
					stderr.push(`branch '${branchName}' set up to track '${remoteName}/${branchName}'.\n`);
				}
			}

			const response = {
				stdout: "",
				stderr: stderr.join(""),
				exitCode: hasError ? 1 : 0,
			};
			if (!hasError) {
				await ext?.hooks?.postPush?.({
					repo: gitCtx,
					remote: remoteName,
					url: config.url,
					refs: updates.map((u) => ({
						srcRef: u.newHash === ZERO_HASH ? null : u.name,
						srcHash: u.newHash === ZERO_HASH ? null : u.newHash,
						dstRef: u.name,
						dstHash: u.oldHash,
						force: !!u.ok,
						delete: u.newHash === ZERO_HASH,
					})),
				});
			}
			return response;
		},
	});
}

async function resolveRefForPush(ctx: GitContext, src: string): Promise<ObjectId | null> {
	if (src.startsWith("refs/")) {
		return resolveRef(ctx, src);
	}
	// Try as branch name
	const asBranch = await resolveRef(ctx, `refs/heads/${src}`);
	if (asBranch) return asBranch;
	// Try as tag
	const asTag = await resolveRef(ctx, `refs/tags/${src}`);
	if (asTag) return asTag;
	// Try HEAD
	if (src === "HEAD") return resolveHead(ctx);
	return null;
}
