import type { GitExtensions } from "../git.ts";
import { isRejection } from "../hooks.ts";
import {
	abbreviateHash,
	err,
	fatal,
	isCommandError,
	requireGitContext,
} from "../lib/command-utils.ts";
import { getConfigValue, readConfig, writeConfig } from "../lib/config.ts";
import { ZERO_HASH } from "../lib/hex.ts";
import { listRefs, readHead, resolveHead, resolveRef } from "../lib/refs.ts";
import { parseRefspec } from "../lib/transport/refspec.ts";
import { resolveRemoteTransport } from "../lib/transport/remote.ts";
import type { PushRefUpdate } from "../lib/transport/transport.ts";
import type { GitContext, GitRepo, ObjectId } from "../lib/types.ts";
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

			// Validate flag combinations
			if (args.tags && args.all) {
				return fatal("options '--tags' and '--all/--branches' cannot be used together");
			}
			if (args.tags && args.delete) {
				return fatal("options '--delete' and '--tags' cannot be used together");
			}

			// Build push updates
			const updates: PushRefUpdate[] = [];
			const rawRefspecs = args.refspec;

			if (args.delete) {
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
			} else if (rawRefspecs && rawRefspecs.length > 0) {
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
			} else if (!args.tags) {
				// No explicit refspec and no --tags — use push.default
				const head = await readHead(gitCtx);
				if (!head || head.type !== "symbolic") {
					return fatal("You are not currently on a branch.");
				}
				const branchRef = head.target;
				const branchName = branchRef.startsWith("refs/heads/")
					? branchRef.slice("refs/heads/".length)
					: branchRef;
				const localHash = await resolveHead(gitCtx);
				if (!localHash) {
					return err("error: src refspec does not match any\n");
				}

				const pushDefault =
					(await getConfigValue(gitCtx, "push.default"))?.toLowerCase() ?? "simple";

				const pushUpdate = await resolvePushDefault(
					gitCtx,
					pushDefault,
					branchRef,
					branchName,
					localHash,
					remoteName,
					remoteRefMap,
					force,
				);
				if ("exitCode" in pushUpdate) return pushUpdate;
				updates.push(pushUpdate);
			}

			// --tags is additive: append all local tags that differ from remote
			if (args.tags) {
				const localTags = await listRefs(gitCtx, "refs/tags");
				for (const ref of localTags) {
					const oldHash = remoteRefMap.get(ref.name) ?? null;
					if (oldHash === ref.hash) continue;
					if (updates.some((u) => u.name === ref.name)) continue;
					updates.push({
						name: ref.name,
						oldHash,
						newHash: ref.hash,
						ok: force,
					});
				}
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
				const isTag = update.name.startsWith("refs/tags/");
				const shortRef = update.name.startsWith("refs/heads/")
					? update.name.slice("refs/heads/".length)
					: update.name.startsWith("refs/tags/")
						? update.name.slice("refs/tags/".length)
						: update.name;

				if (!update.ok) {
					stderr.push(
						` ! [rejected]        ${shortRef} -> ${shortRef} (${update.error ?? "failed"})\n`,
					);
					hasError = true;
				} else if (!update.oldHash) {
					const label = isTag ? "[new tag]" : "[new branch]";
					stderr.push(` * ${label}      ${shortRef} -> ${shortRef}\n`);
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

async function resolvePushDefault(
	ctx: GitContext,
	pushDefault: string,
	branchRef: string,
	branchName: string,
	localHash: ObjectId,
	remoteName: string,
	remoteRefMap: Map<string, ObjectId>,
	force: boolean,
): Promise<PushRefUpdate | { stdout: string; stderr: string; exitCode: number }> {
	if (pushDefault === "nothing") {
		return fatal("You didn't specify any refspecs to push, and " + 'push.default is "nothing".');
	}

	if (pushDefault === "current") {
		return {
			name: branchRef,
			oldHash: remoteRefMap.get(branchRef) ?? null,
			newHash: localHash,
			ok: force,
		};
	}

	if (pushDefault === "upstream") {
		const cfg = await readConfig(ctx);
		const section = cfg[`branch "${branchName}"`];
		if (!section?.remote || !section?.merge) {
			return fatal(
				`The current branch ${branchName} has no upstream branch.\n` +
					"To push the current branch and set the remote as upstream, use\n\n" +
					`    git push --set-upstream ${remoteName} ${branchName}\n`,
			);
		}
		const upstreamRef = section.merge as string;
		return {
			name: upstreamRef,
			oldHash: remoteRefMap.get(upstreamRef) ?? null,
			newHash: localHash,
			ok: force,
		};
	}

	// "simple" (default) — centralized: like upstream but refuse name mismatch;
	// triangular (different remote): like current
	const cfg = await readConfig(ctx);
	const section = cfg[`branch "${branchName}"`];
	if (section?.remote && section?.merge) {
		const trackedRemote = section.remote as string;
		const upstreamRef = section.merge as string;

		if (trackedRemote === remoteName) {
			const upstreamBranch = upstreamRef.startsWith("refs/heads/")
				? upstreamRef.slice("refs/heads/".length)
				: upstreamRef;
			if (upstreamBranch !== branchName) {
				return fatal(
					"The upstream branch of your current branch does not match\n" +
						"the name of your current branch.  To push to the upstream branch\n" +
						"on the remote, use\n\n" +
						`    git push ${remoteName} HEAD:${upstreamRef}\n\n` +
						"To push to the branch of the same name on the remote, use\n\n" +
						`    git push ${remoteName} HEAD\n`,
				);
			}
			return {
				name: upstreamRef,
				oldHash: remoteRefMap.get(upstreamRef) ?? null,
				newHash: localHash,
				ok: force,
			};
		}
	}
	// No tracking or pushing to different remote — fall back to current
	return {
		name: branchRef,
		oldHash: remoteRefMap.get(branchRef) ?? null,
		newHash: localHash,
		ok: force,
	};
}

async function resolveRefForPush(ctx: GitRepo, src: string): Promise<ObjectId | null> {
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
