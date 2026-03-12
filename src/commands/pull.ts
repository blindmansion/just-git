import type { GitExtensions } from "../git.ts";
import {
	err,
	fatal,
	isCommandError,
	requireAuthor,
	requireCommitter,
	requireGitContext,
	requireHead,
	writeCommitAndAdvance,
} from "../lib/command-utils.ts";
import { formatDiffStat } from "../lib/commit-summary.ts";
import { readConfig } from "../lib/config.ts";
import { getReflogIdentity } from "../lib/identity.ts";
import { getConflictedPaths, hasConflicts, readIndex } from "../lib/index.ts";
import { buildMergeMessage, findAllMergeBases, handleFastForward } from "../lib/merge.ts";
import { applyMergeResult, mergeOrtRecursive } from "../lib/merge-ort.ts";
import { readCommit } from "../lib/object-db.ts";
import { writeStateFile } from "../lib/operation-state.ts";
import { join } from "../lib/path.ts";
import { ZERO_HASH } from "../lib/hex.ts";
import { appendReflog } from "../lib/reflog.ts";
import { branchNameFromRef, listRefs, readHead, resolveRef, updateRef } from "../lib/refs.ts";
import { mapRefspec, parseRefspec } from "../lib/transport/refspec.ts";
import { resolveRemoteTransport } from "../lib/transport/remote.ts";
import type { RemoteRef } from "../lib/transport/transport.ts";
import type { ObjectId } from "../lib/types.ts";
import { a, type Command, f } from "../parse/index.ts";

export function registerPullCommand(parent: Command, ext?: GitExtensions) {
	parent.command("pull", {
		description: "Fetch from and integrate with another repository",
		args: [
			a.string().name("remote").describe("Remote to pull from").optional(),
			a.string().name("branch").describe("Remote branch").optional(),
		],
		options: {
			rebase: f().alias("r").describe("Rebase instead of merge"),
			noRebase: f().describe("Merge instead of rebase"),
			ffOnly: f().describe("Only fast-forward"),
			noFf: f().describe("Create a merge commit even for fast-forwards"),
		},
		handler: async (args, ctx) => {
			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;
			const gitCtx = gitCtxOrError;

			const headHash = await requireHead(gitCtx);
			if (isCommandError(headHash)) return headHash;

			// Check for unmerged index entries
			const currentIndex = await readIndex(gitCtx);
			if (hasConflicts(currentIndex)) {
				return err("error: Pulling is not possible because you have unmerged files.\n", 128);
			}

			// Determine remote and branch from args or tracking config
			let remoteName = args.remote;
			let remoteBranch = args.branch;

			if (!remoteName) {
				const head = await readHead(gitCtx);
				if (head?.type === "symbolic") {
					const branchName = head.target.startsWith("refs/heads/")
						? head.target.slice("refs/heads/".length)
						: head.target;
					const cfg = await readConfig(gitCtx);
					const branchCfg = cfg[`branch "${branchName}"`];
					if (branchCfg) {
						remoteName = branchCfg.remote || "origin";
						if (!remoteBranch && branchCfg.merge) {
							remoteBranch = branchCfg.merge.startsWith("refs/heads/")
								? branchCfg.merge.slice("refs/heads/".length)
								: branchCfg.merge;
						}
					}
				}
			}
			remoteName = remoteName || "origin";

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
			const pullBranch = remoteBranch ?? null;
			if (ext?.hooks) {
				const abort = await ext.hooks.emitPre("pre-pull", {
					remote: remoteName,
					branch: pullBranch,
				});
				if (abort) {
					return { stdout: "", stderr: abort.message ?? "", exitCode: 1 };
				}
			}

			// ── Fetch phase ──────────────────────────────────────────
			const fetchSpec = parseRefspec(config.fetchRefspec);
			const remoteRefs = await transport.advertiseRefs();

			if (remoteRefs.length === 0) {
				return fatal("Couldn't find remote ref HEAD");
			}

			// Compute wants/haves
			const localRefs = await listRefs(gitCtx);
			const haves: ObjectId[] = localRefs.map((r) => r.hash);
			const localHead = await resolveRef(gitCtx, "HEAD");
			if (localHead) haves.push(localHead);

			const wants: ObjectId[] = [];
			const seen = new Set<ObjectId>();
			const refUpdates: Array<{
				remote: RemoteRef;
				localRef: string;
			}> = [];

			for (const ref of remoteRefs) {
				if (ref.name === "HEAD") continue;
				const dst = mapRefspec(fetchSpec, ref.name);
				if (dst !== null) {
					refUpdates.push({ remote: ref, localRef: dst });
					if (!seen.has(ref.hash)) {
						seen.add(ref.hash);
						wants.push(ref.hash);
					}
				}
			}

			const haveSet = new Set(haves);
			const filteredWants = wants.filter((w) => !haveSet.has(w));

			if (filteredWants.length > 0) {
				await transport.fetch(filteredWants, haves);
			}

			// Update remote tracking refs (with reflog)
			const ident = await getReflogIdentity(gitCtx, ctx.env);
			for (const update of refUpdates) {
				const oldRefHash = await resolveRef(gitCtx, update.localRef);
				await updateRef(gitCtx, update.localRef, update.remote.hash);
				await appendReflog(gitCtx, update.localRef, {
					oldHash: oldRefHash ?? ZERO_HASH,
					newHash: update.remote.hash,
					name: ident.name,
					email: ident.email,
					timestamp: ident.timestamp,
					tz: ident.tz,
					message: oldRefHash ? "pull" : "pull: storing head",
				});
			}

			// Write FETCH_HEAD
			let fetchHeadHash: ObjectId | null = null;

			if (remoteBranch) {
				const targetRef = remoteRefs.find((r) => r.name === `refs/heads/${remoteBranch}`);
				if (targetRef) {
					fetchHeadHash = targetRef.hash;
				} else {
					return fatal(`Couldn't find remote ref refs/heads/${remoteBranch}`);
				}
			} else {
				const headRef = remoteRefs.find((r) => r.name === "HEAD");
				if (headRef) {
					fetchHeadHash = headRef.hash;
				}
			}

			if (fetchHeadHash) {
				await ctx.fs.writeFile(
					join(gitCtx.gitDir, "FETCH_HEAD"),
					`${fetchHeadHash}\t\t${config.url}\n`,
				);
			}

			if (!fetchHeadHash) {
				return fatal("Could not determine remote HEAD");
			}

			// ── Merge phase ──────────────────────────────────────────
			const theirsHash = fetchHeadHash;

			if (headHash === theirsHash) {
				await ext?.hooks?.emitPost("post-pull", {
					remote: remoteName,
					branch: pullBranch,
					strategy: "up-to-date",
					commitHash: null,
				});
				return {
					stdout: "Already up to date.\n",
					stderr: "",
					exitCode: 0,
				};
			}

			const bases = await findAllMergeBases(gitCtx, headHash, theirsHash);
			const baseCommit = bases[0] ?? null;

			if (bases.length === 0) {
				return fatal("refusing to merge unrelated histories");
			}

			if (baseCommit === theirsHash) {
				await ext?.hooks?.emitPost("post-pull", {
					remote: remoteName,
					branch: pullBranch,
					strategy: "up-to-date",
					commitHash: null,
				});
				return {
					stdout: "Already up to date.\n",
					stderr: "",
					exitCode: 0,
				};
			}

			const isFastForward = baseCommit === headHash;

			if (args.ffOnly && !isFastForward) {
				return fatal("Not possible to fast-forward, aborting.");
			}

			if (isFastForward && !args.noFf) {
				const ffResult = await handleFastForward(gitCtx, headHash, theirsHash);
				// Write reflog for the branch update
				const head = await readHead(gitCtx);
				const refName = head?.type === "symbolic" ? head.target : "HEAD";
				await appendReflog(gitCtx, refName, {
					oldHash: headHash,
					newHash: theirsHash,
					name: ident.name,
					email: ident.email,
					timestamp: ident.timestamp,
					tz: ident.tz,
					message: "pull: Fast-forward",
				});
				if (head?.type === "symbolic") {
					await appendReflog(gitCtx, "HEAD", {
						oldHash: headHash,
						newHash: theirsHash,
						name: ident.name,
						email: ident.email,
						timestamp: ident.timestamp,
						tz: ident.tz,
						message: "pull: Fast-forward",
					});
				}
				if (ffResult.exitCode === 0) {
					await ext?.hooks?.emitPost("post-merge", {
						headHash,
						theirsHash,
						strategy: "fast-forward",
						commitHash: null,
					});
					await ext?.hooks?.emitPost("post-pull", {
						remote: remoteName,
						branch: pullBranch,
						strategy: "fast-forward",
						commitHash: null,
					});
				}
				return ffResult;
			}

			// Three-way merge
			const head = await readHead(gitCtx);
			const currentBranch = head?.type === "symbolic" ? branchNameFromRef(head.target) : "HEAD";

			const branchLabel = remoteBranch || remoteName || "FETCH_HEAD";
			const labels = { a: "HEAD", b: branchLabel };

			const mergeResult = await mergeOrtRecursive(gitCtx, headHash, theirsHash, labels);

			const headCommit = await readCommit(gitCtx, headHash);
			const applyResult = await applyMergeResult(gitCtx, mergeResult, headCommit.tree, {
				labels,
				errorExitCode: 2,
				operationName: "merge",
			});

			if (!applyResult.ok) {
				return applyResult as {
					stdout: string;
					stderr: string;
					exitCode: number;
				};
			}

			if (mergeResult.conflicts.length > 0) {
				await updateRef(gitCtx, "MERGE_HEAD", theirsHash);
				await updateRef(gitCtx, "ORIG_HEAD", headHash);

				let mergeMsg = await buildMergeMessage(gitCtx, branchLabel, currentBranch);
				const conflictPaths = getConflictedPaths({
					version: 2,
					entries: mergeResult.entries,
				}).sort();
				mergeMsg += `\n# Conflicts:\n${conflictPaths.map((p) => `#\t${p}`).join("\n")}\n`;
				await writeStateFile(gitCtx, "MERGE_MSG", mergeMsg);

				return {
					stdout: `${[...mergeResult.messages, "Automatic merge failed; fix conflicts and then commit the result."].join("\n")}\n`,
					stderr: "",
					exitCode: 1,
				};
			}

			// Clean merge — create merge commit
			const treeHash = applyResult.mergedTreeHash;
			const author = await requireAuthor(gitCtx, ctx.env);
			if (isCommandError(author)) return author;
			const committer = await requireCommitter(gitCtx, ctx.env);
			if (isCommandError(committer)) return committer;

			let mergeMsg = await buildMergeMessage(gitCtx, branchLabel, currentBranch);
			if (ext?.hooks) {
				const msgEvent = {
					message: mergeMsg,
					treeHash,
					headHash,
					theirsHash,
				};
				const abort = await ext.hooks.emitPre("merge-msg", msgEvent);
				if (abort) {
					return { stdout: "", stderr: abort.message ?? "", exitCode: 1 };
				}
				mergeMsg = msgEvent.message;
				const mergeAbort = await ext.hooks.emitPre("pre-merge-commit", {
					mergeMessage: mergeMsg,
					treeHash,
					headHash,
					theirsHash,
				});
				if (mergeAbort) {
					return { stdout: "", stderr: mergeAbort.message ?? "", exitCode: 1 };
				}
			}
			const commitHash = await writeCommitAndAdvance(
				gitCtx,
				treeHash,
				[headHash, theirsHash],
				author,
				committer,
				mergeMsg,
			);

			await ext?.hooks?.emitPost("post-merge", {
				headHash,
				theirsHash,
				strategy: "three-way",
				commitHash,
			});
			await ext?.hooks?.emitPost("post-pull", {
				remote: remoteName,
				branch: pullBranch,
				strategy: "three-way",
				commitHash,
			});

			// Reflog for the merge commit
			const mergeRefName = head?.type === "symbolic" ? head.target : "HEAD";
			const pullMergeMsg = "pull: Merge made by the 'ort' strategy.";
			await appendReflog(gitCtx, mergeRefName, {
				oldHash: headHash,
				newHash: commitHash,
				name: ident.name,
				email: ident.email,
				timestamp: ident.timestamp,
				tz: ident.tz,
				message: pullMergeMsg,
			});
			if (head?.type === "symbolic") {
				await appendReflog(gitCtx, "HEAD", {
					oldHash: headHash,
					newHash: commitHash,
					name: ident.name,
					email: ident.email,
					timestamp: ident.timestamp,
					tz: ident.tz,
					message: pullMergeMsg,
				});
			}

			const diffstat = await formatDiffStat(gitCtx, headCommit.tree, treeHash);
			const mergeMessages =
				mergeResult.messages.length > 0 ? `${mergeResult.messages.join("\n")}\n` : "";
			return {
				stdout: `${mergeMessages}Merge made by the 'ort' strategy.\n${diffstat}`,
				stderr: "",
				exitCode: 0,
			};
		},
	});
}
