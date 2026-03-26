import type { GitExtensions } from "../git.ts";
import { isRejection } from "../hooks.ts";
import {
	abbreviateHash,
	buildRefUpdateLines,
	fatal,
	formatTransferRefLines,
	isCommandError,
	requireAuthor,
	requireCommitter,
	requireGitContext,
	requireHead,
	writeCommitAndAdvance,
} from "../lib/command-utils.ts";
import { formatDiffStat } from "../lib/commit-summary.ts";
import { getConfigValue, readConfig } from "../lib/config.ts";
import { getReflogIdentity } from "../lib/identity.ts";
import { getConflictedPaths, hasConflicts, readIndex } from "../lib/index.ts";
import { buildMergeMessage, findAllMergeBases, handleFastForward } from "../lib/merge.ts";
import { applyMergeResult, mergeOrtRecursive } from "../lib/merge-ort.ts";
import { readCommit } from "../lib/object-db.ts";
import { deleteStateFile, writeStateFile } from "../lib/operation-state.ts";
import { join } from "../lib/path.ts";
import { ZERO_HASH } from "../lib/hex.ts";
import { appendReflog } from "../lib/reflog.ts";
import {
	branchNameFromRef,
	ensureRemoteHead,
	listRefs,
	readHead,
	resolveHead,
	resolveRef,
	shortenRef,
	updateRef,
} from "../lib/refs.ts";
import {
	applyShallowUpdates,
	INFINITE_DEPTH,
	isShallowRepo,
	readShallowCommits,
} from "../lib/shallow.ts";
import { mapRefspec, parseRefspec } from "../lib/transport/refspec.ts";
import { resolveRemoteTransport } from "../lib/transport/remote.ts";
import type { RemoteRef, ShallowFetchOptions } from "../lib/transport/transport.ts";
import type { GitContext, ObjectId, Ref } from "../lib/types.ts";
import { a, type Command, f, o } from "../parse/index.ts";
import { performRebase } from "./rebase.ts";

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
			depth: o.number().describe("Limit fetching to the specified number of commits"),
			unshallow: f().describe("Convert a shallow repository to a complete one"),
		},
		handler: async (args, ctx) => {
			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;
			const gitCtx = gitCtxOrError;

			if (args.depth !== undefined && args.unshallow) {
				return fatal("--depth and --unshallow cannot be used together");
			}
			if (args.unshallow && !(await isShallowRepo(gitCtx))) {
				return fatal("--unshallow on a complete repository does not make sense");
			}

			let fetchDepth: number | undefined = args.depth;
			if (args.unshallow) {
				fetchDepth = INFINITE_DEPTH;
			}

			const headHash = await requireHead(gitCtx);
			if (isCommandError(headHash)) return headHash;
			const head = await readHead(gitCtx);

			// Check for unmerged index entries
			const currentIndex = await readIndex(gitCtx);
			if (hasConflicts(currentIndex)) {
				return {
					stdout: "",
					stderr:
						"error: Pulling is not possible because you have unmerged files.\n" +
						"hint: Fix them up in the work tree, and then use 'git add/rm <file>'\n" +
						"hint: as appropriate to mark resolution and make a commit.\n" +
						"fatal: Exiting because of an unresolved conflict.\n",
					exitCode: 128,
				};
			}

			// Determine remote and branch from args or tracking config
			let remoteName = args.remote;
			let remoteBranch = args.branch;
			let noTrackingBranch: string | null = null;

			if (!remoteName) {
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
					} else if (!remoteBranch) {
						noTrackingBranch = branchName;
					}
				} else if (!remoteBranch) {
					// Defer — real git fetches first, then checks merge target.
					// If the fetch fails (bad URL), the fetch error is reported instead.
				}
			}
			remoteName = remoteName || "origin";

			const pullMode = await resolvePullMode(gitCtx, args, head);

			let resolved;
			try {
				resolved = await resolveRemoteTransport(gitCtx, remoteName, ctx.env);
			} catch (e) {
				const msg = e instanceof Error ? e.message : "";
				if (msg.startsWith("network"))
					return { stdout: "", stderr: `fatal: ${msg}\n`, exitCode: 1 };
				throw e;
			}
			if (!resolved) {
				return {
					stdout: "",
					stderr: `fatal: '${remoteName}' does not appear to be a git repository\n`,
					exitCode: 1,
				};
			}

			const { transport, config } = resolved;
			const pullBranch = remoteBranch ?? null;
			const prePullRej = await ext?.hooks?.prePull?.({
				repo: gitCtx,
				remote: remoteName,
				branch: pullBranch,
			});
			if (isRejection(prePullRej)) {
				return { stdout: "", stderr: prePullRej.message ?? "", exitCode: 1 };
			}

			// ── Fetch phase ──────────────────────────────────────────
			const fetchSpec = parseRefspec(config.fetchRefspec);
			const remoteRefs = await transport.advertiseRefs();

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

			let shallowOpts: ShallowFetchOptions | undefined;
			const existingShallows =
				fetchDepth !== undefined ? await readShallowCommits(gitCtx) : undefined;
			if (fetchDepth !== undefined) {
				shallowOpts = { depth: fetchDepth, existingShallows };
			}

			const effectiveWants = filteredWants.length > 0 ? filteredWants : shallowOpts ? wants : [];

			if (effectiveWants.length > 0) {
				const fetchResult = await transport.fetch(effectiveWants, haves, shallowOpts);

				if (fetchResult.shallowUpdates) {
					await applyShallowUpdates(gitCtx, fetchResult.shallowUpdates, existingShallows);
				}
			}

			// Update remote tracking refs (with reflog) and build fetch-phase output
			const ident = await getReflogIdentity(gitCtx, ctx.env);
			const resolvedOldHashes: Array<string | null> = [];
			for (const update of refUpdates) {
				const oldRefHash = await resolveRef(gitCtx, update.localRef);
				resolvedOldHashes.push(oldRefHash);
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
			const fetchRefLines = buildRefUpdateLines(
				refUpdates.map((u, i) => ({ ...u, oldHash: resolvedOldHashes[i]! })),
				shortenRef,
				abbreviateHash,
			);
			const fetchOutput =
				fetchRefLines.length > 0
					? `From ${config.url}\n${formatTransferRefLines(fetchRefLines, 10)}`
					: "";

			await ensureRemoteHead(gitCtx, remoteName, remoteRefs, transport.headTarget);

			// After fetch: check if we can determine the merge target
			if (head?.type !== "symbolic" && !remoteBranch) {
				return {
					stdout: "",
					stderr:
						fetchOutput +
						"You are not currently on a branch.\n" +
						"Please specify which branch you want to merge with.\n" +
						"See git-pull(1) for details.\n\n" +
						"    git pull <remote> <branch>\n\n",
					exitCode: 1,
				};
			}

			if (noTrackingBranch) {
				const cfg = await readConfig(gitCtx);
				const remoteNames: string[] = [];
				for (const section of Object.keys(cfg)) {
					const m = section.match(/^remote "(.+)"$/);
					if (m?.[1]) remoteNames.push(m[1]);
				}
				const hintRemote = remoteNames.length === 1 ? remoteNames[0] : "<remote>";
				return {
					stdout: "",
					stderr:
						fetchOutput +
						`There is no tracking information for the current branch.\n` +
						`Please specify which branch you want to merge with.\n` +
						`See git-pull(1) for details.\n\n` +
						`    git pull <remote> <branch>\n\n` +
						`If you wish to set tracking information for this branch you can do so with:\n\n` +
						`    git branch --set-upstream-to=${hintRemote}/<branch> ${noTrackingBranch}\n\n`,
					exitCode: 1,
				};
			}

			// Write FETCH_HEAD
			let fetchHeadHash: ObjectId | null = null;

			if (remoteBranch) {
				const targetRef = remoteRefs.find((r) => r.name === `refs/heads/${remoteBranch}`);
				if (targetRef) {
					fetchHeadHash = targetRef.hash;
				} else {
					return {
						stdout: "",
						stderr:
							fetchOutput +
							`Your configuration specifies to merge with the ref 'refs/heads/${remoteBranch}'\n` +
							`from the remote, but no such ref was fetched.\n`,
						exitCode: 1,
					};
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

			// ── Integration phase ────────────────────────────────────
			const theirsHash = fetchHeadHash;

			// Real git's merge deletes MERGE_MSG at the start of cmd_merge(),
			// before any outcome check. This matters when a revert/cherry-pick
			// left MERGE_MSG behind — the merge phase always clears it.
			await deleteStateFile(gitCtx, "MERGE_MSG");

			if (headHash === theirsHash) {
				await ext?.hooks?.postPull?.({
					repo: gitCtx,
					remote: remoteName,
					branch: pullBranch,
					strategy: "up-to-date",
					commitHash: null,
				});
				return {
					stdout: "Already up to date.\n",
					stderr: fetchOutput,
					exitCode: 0,
				};
			}

			// ── Rebase path ─────────────────────────────────────────
			if (pullMode.useRebase) {
				const headName = head?.type === "symbolic" ? head.target : "detached HEAD";
				const upstreamLabel = remoteBranch ? `${remoteName}/${remoteBranch}` : remoteName;

				const result = await performRebase(
					gitCtx,
					ctx.env,
					headHash,
					headName,
					theirsHash,
					theirsHash,
					upstreamLabel,
					ext,
				);

				if (result.exitCode === 0) {
					const rebasedHead = await resolveHead(gitCtx);
					await ext?.hooks?.postPull?.({
						repo: gitCtx,
						remote: remoteName,
						branch: pullBranch,
						strategy: "rebase",
						commitHash: rebasedHead,
					});
				}

				return {
					...result,
					stderr: fetchOutput + result.stderr,
				};
			}

			// ── Merge path ──────────────────────────────────────────
			const bases = await findAllMergeBases(gitCtx, headHash, theirsHash);
			const baseCommit = bases[0] ?? null;

			if (baseCommit === theirsHash) {
				await ext?.hooks?.postPull?.({
					repo: gitCtx,
					remote: remoteName,
					branch: pullBranch,
					strategy: "up-to-date",
					commitHash: null,
				});
				return {
					stdout: "Already up to date.\n",
					stderr: fetchOutput,
					exitCode: 0,
				};
			}

			const { noFf, ffOnly, configured: hasReconciliationStrategy } = pullMode;
			const isFastForward = baseCommit === headHash;

			if (ffOnly && !isFastForward) {
				return {
					stdout: "",
					stderr:
						fetchOutput +
						"hint: Diverging branches can't be fast-forwarded, you need to either:\n" +
						"hint:\n" +
						"hint: \tgit merge --no-ff\n" +
						"hint:\n" +
						"hint: or:\n" +
						"hint:\n" +
						"hint: \tgit rebase\n" +
						"hint:\n" +
						'hint: Disable this message with "git config set advice.diverging false"\n' +
						"fatal: Not possible to fast-forward, aborting.\n",
					exitCode: 128,
				};
			}

			if (!isFastForward && !hasReconciliationStrategy) {
				return {
					stdout: "",
					stderr:
						fetchOutput +
						"hint: You have divergent branches and need to specify how to reconcile them.\n" +
						"hint: You can do so by running one of the following commands sometime before\n" +
						"hint: your next pull:\n" +
						"hint:\n" +
						"hint:   git config pull.rebase false  # merge\n" +
						"hint:   git config pull.rebase true   # rebase\n" +
						"hint:   git config pull.ff only       # fast-forward only\n" +
						"hint:\n" +
						'hint: You can replace "git config" with "git config --global" to set a default\n' +
						"hint: preference for all repositories. You can also pass --rebase, --no-rebase,\n" +
						"hint: or --ff-only on the command line to override the configured default per\n" +
						"hint: invocation.\n" +
						"fatal: Need to specify how to reconcile divergent branches.\n",
					exitCode: 128,
				};
			}

			if (bases.length === 0) {
				return fatal("refusing to merge unrelated histories");
			}

			if (isFastForward && !noFf) {
				const ffResult = await handleFastForward(gitCtx, headHash, theirsHash);
				if (ffResult.exitCode === 0) {
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
					await ext?.hooks?.postMerge?.({
						repo: gitCtx,
						headHash,
						theirsHash,
						strategy: "fast-forward",
						commitHash: null,
					});
					await ext?.hooks?.postPull?.({
						repo: gitCtx,
						remote: remoteName,
						branch: pullBranch,
						strategy: "fast-forward",
						commitHash: theirsHash,
					});
				}
				return {
					...ffResult,
					stderr: fetchOutput + ffResult.stderr,
				};
			}

			// Three-way merge
			const currentBranch = head?.type === "symbolic" ? branchNameFromRef(head.target) : "HEAD";

			const branchLabel = theirsHash;
			const mergeMsgBranch = remoteBranch || "HEAD";
			const conflictStyle = ((await getConfigValue(gitCtx, "merge.conflictstyle")) ?? "merge") as
				| "merge"
				| "diff3";
			const labels = { a: "HEAD", b: branchLabel, conflictStyle };

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

				let mergeMsg = await buildMergeMessage(gitCtx, mergeMsgBranch, currentBranch, config.url);
				const conflictPaths = getConflictedPaths({
					version: 2,
					entries: mergeResult.entries,
				}).sort();
				mergeMsg += `\n# Conflicts:\n${conflictPaths.map((p) => `#\t${p}`).join("\n")}\n`;
				await writeStateFile(gitCtx, "MERGE_MSG", mergeMsg);
				await writeStateFile(gitCtx, "MERGE_MODE", noFf ? "no-ff" : "");

				return {
					stdout: `${[...mergeResult.messages, "Automatic merge failed; fix conflicts and then commit the result."].join("\n")}\n`,
					stderr: fetchOutput,
					exitCode: 1,
				};
			}

			// Clean merge — create merge commit
			const treeHash = applyResult.mergedTreeHash;
			const author = await requireAuthor(gitCtx, ctx.env);
			if (isCommandError(author)) return author;
			const committer = await requireCommitter(gitCtx, ctx.env);
			if (isCommandError(committer)) return committer;

			let mergeMsg = await buildMergeMessage(gitCtx, mergeMsgBranch, currentBranch, config.url);
			const msgEvent = {
				repo: gitCtx,
				message: mergeMsg,
				treeHash,
				headHash,
				theirsHash,
			};
			const mergeMsgRej = await ext?.hooks?.mergeMsg?.(msgEvent);
			if (isRejection(mergeMsgRej)) {
				return { stdout: "", stderr: mergeMsgRej.message ?? "", exitCode: 1 };
			}
			mergeMsg = msgEvent.message;
			const preMergeCommitRej = await ext?.hooks?.preMergeCommit?.({
				repo: gitCtx,
				message: mergeMsg,
				treeHash,
				headHash,
				theirsHash,
			});
			if (isRejection(preMergeCommitRej)) {
				return { stdout: "", stderr: preMergeCommitRej.message ?? "", exitCode: 1 };
			}
			const commitHash = await writeCommitAndAdvance(
				gitCtx,
				treeHash,
				[headHash, theirsHash],
				author,
				committer,
				mergeMsg,
			);

			await ext?.hooks?.postMerge?.({
				repo: gitCtx,
				headHash,
				theirsHash,
				strategy: "three-way",
				commitHash,
			});
			await ext?.hooks?.postPull?.({
				repo: gitCtx,
				remote: remoteName,
				branch: pullBranch,
				strategy: "three-way",
				commitHash,
			});

			// Reflog for the merge commit
			const mergeRefName = head?.type === "symbolic" ? head.target : "HEAD";
			const pullFlagStr = noFf ? " --no-ff" : "";
			const pullMergeMsg = `pull${pullFlagStr}: Merge made by the 'ort' strategy.`;
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
				stderr: fetchOutput,
				exitCode: 0,
			};
		},
	});
}

interface PullMode {
	useRebase: boolean;
	noFf: boolean;
	ffOnly: boolean;
	configured: boolean;
}

/**
 * Resolve the full pull strategy from CLI flags and git config.
 * Centralises the rebase-vs-merge decision and FF mode so the handler
 * doesn't have to track `hasReconciliationStrategy` across scattered branches.
 */
async function resolvePullMode(
	gitCtx: GitContext,
	args: { rebase?: boolean; noRebase?: boolean; noFf?: boolean; ffOnly?: boolean },
	head: Ref | null,
): Promise<PullMode> {
	let noFf = !!args.noFf;
	let ffOnly = !!args.ffOnly;
	let configured = !!args.rebase || !!args.noRebase || !!args.noFf || !!args.ffOnly;
	let useRebase = false;

	// Rebase mode: CLI flags override config
	if (args.rebase) {
		useRebase = true;
	} else if (!args.noRebase) {
		if (head?.type === "symbolic") {
			const bn = head.target.startsWith("refs/heads/")
				? head.target.slice("refs/heads/".length)
				: head.target;
			const branchRebase = await getConfigValue(gitCtx, `branch.${bn}.rebase`);
			if (branchRebase === "true") {
				useRebase = true;
				configured = true;
			} else if (branchRebase === "false") {
				configured = true;
			} else {
				const pullRebase = await getConfigValue(gitCtx, "pull.rebase");
				if (pullRebase === "true") {
					useRebase = true;
					configured = true;
				}
			}
		} else {
			const pullRebase = await getConfigValue(gitCtx, "pull.rebase");
			if (pullRebase === "true") {
				useRebase = true;
				configured = true;
			}
		}
	}

	// FF mode: CLI flags override pull.ff config
	if (!args.noFf && !args.ffOnly) {
		const pullFFConfig = await getConfigValue(gitCtx, "pull.ff");
		if (pullFFConfig === "false") {
			noFf = true;
			configured = true;
		} else if (pullFFConfig === "only") {
			ffOnly = true;
			configured = true;
		}
	}

	return { useRebase, noFf, ffOnly, configured };
}
