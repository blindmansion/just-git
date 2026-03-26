import type { GitExtensions } from "../git.ts";
import { isRejection } from "../hooks.ts";
import {
	abbreviateHash,
	err,
	fatal,
	formatTransferRefLines,
	isCommandError,
	requireGitContext,
	type TransferRefLine,
} from "../lib/command-utils.ts";
import { getConfigValue, readConfig, writeConfig } from "../lib/config.ts";
import { isAncestor } from "../lib/merge.ts";
import { ZERO_HASH } from "../lib/hex.ts";
import {
	deleteRef,
	listRefs,
	readHead,
	resolveHead,
	resolveRef,
	shortenRef,
	updateRef,
} from "../lib/refs.ts";
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
			const rawRefspecs = args.refspec;

			// Real git checks detached HEAD before connecting to the remote
			if (!args.delete && !args.all && !args.tags && (!rawRefspecs || rawRefspecs.length === 0)) {
				const head = await readHead(gitCtx);
				if (!head || head.type !== "symbolic") {
					return fatal(
						"You are not currently on a branch.\n" +
							"To push the history leading to the current (detached HEAD)\n" +
							"state now, use\n\n" +
							"    git push origin HEAD:<name-of-remote-branch>\n",
					);
				}
			}

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

			if (args.delete) {
				const refs = rawRefspecs && rawRefspecs.length > 0 ? rawRefspecs : [];
				if (refs.length === 0) {
					return fatal("--delete requires a ref argument");
				}
				const deleteErrors: string[] = [];
				for (const ref of refs) {
					const fullRef = ref.startsWith("refs/") ? ref : `refs/heads/${ref}`;
					const oldHash = remoteRefMap.get(fullRef) ?? null;
					if (!oldHash) {
						deleteErrors.push(`error: unable to delete '${ref}': remote ref does not exist\n`);
						continue;
					}
					updates.push({
						name: fullRef,
						oldHash,
						newHash: ZERO_HASH,
						ok: force,
					});
				}
				if (deleteErrors.length > 0 && updates.length === 0) {
					return err(
						deleteErrors.join("") + `error: failed to push some refs to '${config.url}'\n`,
					);
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
					const hasExplicitDst = raw.replace(/^\+/, "").includes(":");

					let effectiveDst = spec.dst;
					if (!hasExplicitDst && spec.src === "HEAD") {
						const head = await readHead(gitCtx);
						if (head?.type === "symbolic") {
							effectiveDst = head.target.startsWith("refs/heads/")
								? head.target.slice("refs/heads/".length)
								: head.target;
						} else {
							return {
								stdout: "",
								stderr:
									"error: The destination you provided is not a full refname (i.e.,\n" +
									'starting with "refs/"). We tried to guess what you meant by:\n' +
									"\n" +
									"- Looking for a ref that matches 'HEAD' on the remote side.\n" +
									"- Checking if the <src> being pushed ('HEAD')\n" +
									'  is a ref in "refs/{heads,tags}/". If so we add a corresponding\n' +
									"  refs/{heads,tags}/ prefix on the remote side.\n" +
									"\n" +
									"Neither worked, so we gave up. You must fully qualify the ref.\n" +
									"hint: The <src> part of the refspec is a commit object.\n" +
									"hint: Did you mean to create a new branch by pushing to\n" +
									"hint: 'HEAD:refs/heads/HEAD'?\n" +
									`error: failed to push some refs to '${config.url}'\n`,
								exitCode: 1,
							};
						}
					}

					const srcHash = await resolveRefForPush(gitCtx, spec.src);
					if (!srcHash) {
						return err(
							`error: src refspec ${spec.src} does not match any\n` +
								`error: failed to push some refs to '${config.url}'\n`,
						);
					}
					const dstRef = effectiveDst.startsWith("refs/")
						? effectiveDst
						: `refs/heads/${effectiveDst}`;
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
					return fatal(
						"You are not currently on a branch.\n" +
							"To push the history leading to the current (detached HEAD)\n" +
							"state now, use\n\n" +
							"    git push origin HEAD:<name-of-remote-branch>\n",
					);
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

			// Filter out no-op updates where local and remote are already in sync
			const effectiveUpdates = updates.filter((u) => u.oldHash !== u.newHash);

			if (effectiveUpdates.length === 0) {
				let stdout = "";
				if (args["set-upstream"]) {
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
						stdout = `branch '${branchName}' set up to track '${remoteName}/${branchName}'.\n`;
					}
				}
				return {
					stdout,
					stderr: "Everything up-to-date\n",
					exitCode: 0,
				};
			}

			// pre-push hook
			const prePushRej = await ext?.hooks?.prePush?.({
				repo: gitCtx,
				remote: remoteName,
				url: config.url,
				refs: effectiveUpdates.map((u) => ({
					srcRef: u.newHash === ZERO_HASH ? null : u.name,
					srcHash: u.newHash === ZERO_HASH ? null : u.newHash,
					dstRef: u.name,
					dstHash: u.oldHash,
					force: !!u.ok,
					delete: u.newHash === ZERO_HASH,
				})),
			});
			if (isRejection(prePushRej)) return err(prePushRej.message ?? "");

			// Track which refs were force-requested (ok=true in input means force)
			const forceRequested = new Set(effectiveUpdates.filter((u) => u.ok).map((u) => u.name));

			// Execute the push
			const result = await transport.push(effectiveUpdates);

			// Pre-compute ancestry for force-requested refs (parallel)
			const forceCandidates = result.updates.filter(
				(u) => u.ok && u.oldHash && u.newHash !== ZERO_HASH && forceRequested.has(u.name),
			);
			const ancestryResults = await Promise.all(
				forceCandidates.map((u) => isAncestor(gitCtx, u.oldHash!, u.newHash)),
			);
			const actuallyForced = new Set<string>();
			forceCandidates.forEach((u, i) => {
				if (!ancestryResults[i]) actuallyForced.add(u.name);
			});

			// Build output
			const pushLines: TransferRefLine[] = [];
			let hasError = false;

			for (const update of result.updates) {
				const isTag = update.name.startsWith("refs/tags/");
				const shortRef = shortenRef(update.name);

				if (!update.ok) {
					const reason = update.error?.includes("non-fast-forward")
						? "non-fast-forward"
						: (update.error ?? "failed");
					pushLines.push({
						prefix: " ! [rejected]",
						from: shortRef,
						to: shortRef,
						suffix: `(${reason})`,
					});
					hasError = true;
				} else if (!update.oldHash) {
					const label = isTag ? "[new tag]" : "[new branch]";
					pushLines.push({ prefix: ` * ${label}`, from: shortRef, to: shortRef });
				} else if (update.newHash === ZERO_HASH) {
					pushLines.push({ prefix: " - [deleted]", from: shortRef, to: "" });
				} else {
					const shortOld = abbreviateHash(update.oldHash);
					const shortNew = abbreviateHash(update.newHash);
					if (actuallyForced.has(update.name)) {
						pushLines.push({
							prefix: ` + ${shortOld}...${shortNew}`,
							from: shortRef,
							to: shortRef,
							suffix: "(forced update)",
						});
					} else {
						pushLines.push({
							prefix: `   ${shortOld}..${shortNew}`,
							from: shortRef,
							to: shortRef,
						});
					}
				}
			}

			pushLines.sort((a, b) => pushLineSortKey(a) - pushLineSortKey(b));

			const stderr: string[] = [];
			stderr.push(`To ${config.url}\n`);
			stderr.push(formatTransferRefLines(pushLines));

			if (hasError) {
				stderr.push(`error: failed to push some refs to '${config.url}'\n`);
				const hasNonFF = result.updates.some((u) => !u.ok && u.error?.includes("non-fast-forward"));
				if (hasNonFF) {
					stderr.push(
						"hint: Updates were rejected because the tip of your current branch is behind\n" +
							"hint: its remote counterpart. If you want to integrate the remote changes,\n" +
							"hint: use 'git pull' before pushing again.\n" +
							"hint: See the 'Note about fast-forwards' in 'git push --help' for details.\n",
					);
				}
			}

			// Update remote tracking refs for successful pushes (even if others failed)
			let stdout = "";
			for (const update of result.updates) {
				if (!update.ok) continue;
				if (!update.name.startsWith("refs/heads/")) continue;
				const trackingRef = `refs/remotes/${remoteName}/${update.name.slice("refs/heads/".length)}`;
				if (update.newHash === ZERO_HASH) {
					await deleteRef(gitCtx, trackingRef);
				} else {
					await updateRef(gitCtx, trackingRef, update.newHash);
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
					stdout = `branch '${branchName}' set up to track '${remoteName}/${branchName}'.\n`;
				}
			}

			const response = {
				stdout,
				stderr: stderr.join(""),
				exitCode: hasError ? 1 : 0,
			};
			if (!hasError) {
				await ext?.hooks?.postPush?.({
					repo: gitCtx,
					remote: remoteName,
					url: config.url,
					refs: effectiveUpdates.map((u) => ({
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
						`    git push ${remoteName} HEAD:${upstreamBranch}\n\n` +
						"To push to the branch of the same name on the remote, use\n\n" +
						`    git push ${remoteName} HEAD\n\n` +
						"To choose either option permanently, see push.default in 'git help config'.\n\n" +
						"To avoid automatically configuring an upstream branch when its name\n" +
						"won't match the local branch, see option 'simple' of branch.autoSetupMerge\n" +
						"in 'git help config'.\n",
				);
			}
			return {
				name: upstreamRef,
				oldHash: remoteRefMap.get(upstreamRef) ?? null,
				newHash: localHash,
				ok: force,
			};
		}
		// Tracked on a different remote (triangular workflow) — push like "current"
		return {
			name: branchRef,
			oldHash: remoteRefMap.get(branchRef) ?? null,
			newHash: localHash,
			ok: force,
		};
	}
	// No upstream configured — refuse
	return fatal(
		`The current branch ${branchName} has no upstream branch.\n` +
			"To push the current branch and set the remote as upstream, use\n\n" +
			`    git push --set-upstream ${remoteName} ${branchName}\n` +
			"\nTo have this happen automatically for branches without a tracking\n" +
			"upstream, see 'push.autoSetupRemote' in 'git help config'.\n",
	);
}

function pushLineSortKey(line: TransferRefLine): number {
	if (line.prefix.startsWith("   ") || line.prefix.startsWith(" + ")) return 0;
	if (line.prefix.includes("[new ")) return 1;
	if (line.prefix.includes("[deleted]")) return 2;
	if (line.prefix.includes("[rejected]")) return 3;
	return 4;
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
