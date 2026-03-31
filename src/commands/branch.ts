import type { GitExtensions } from "../git.ts";
import { maybeSetupTracking } from "../lib/checkout-utils.ts";
import {
	abbreviateHash,
	err,
	fatal,
	firstLine,
	isCommandError,
	requireCommit,
	requireGitContext,
} from "../lib/command-utils.ts";
import { getConfigValue, readConfig, writeConfig } from "../lib/config.ts";
import { getReflogIdentity } from "../lib/identity.ts";
import { isAncestor } from "../lib/merge.ts";
import { readCommit } from "../lib/object-db.ts";
import { readDetachPoint } from "../lib/operation-state.ts";
import { isRebaseInProgress, readRebaseState } from "../lib/rebase.ts";
import { appendReflog, logRef, readReflog, writeReflog, ZERO_HASH } from "../lib/reflog.ts";
import {
	branchNameFromRef,
	createSymbolicRef,
	deleteRef,
	isValidBranchName,
	listRefs,
	readHead,
	resolveHead,
	resolveRef,
	updateRef,
} from "../lib/refs.ts";
import { formatBranchTrackingInfo, getTrackingInfo } from "../lib/status-format.ts";
import type { ObjectId } from "../lib/types.ts";
import { a, type Command, f, o } from "../parse/index.ts";

function formatSetUpstreamFailure(upstream: string) {
	return {
		stdout: "",
		stderr:
			`fatal: the requested upstream branch '${upstream}' does not exist\n` +
			"hint:\n" +
			"hint: If you are planning on basing your work on an upstream\n" +
			"hint: branch that already exists at the remote, you may need to\n" +
			'hint: run "git fetch" to retrieve it.\n' +
			"hint:\n" +
			"hint: If you are planning to push out a new local branch that\n" +
			"hint: will track its remote counterpart, you may want to use\n" +
			'hint: "git push -u" to set the upstream config as you push.\n' +
			'hint: Disable this message with "git config set advice.setUpstreamFailure false"\n',
		exitCode: 128,
	};
}

async function formatDeleteBranchNotFullyMerged(
	gitCtx: Parameters<typeof getConfigValue>[0],
	name: string,
	warning = "",
) {
	const adviceForceDelete = (
		await getConfigValue(gitCtx, "advice.forceDeleteBranch")
	)?.toLowerCase();
	if (adviceForceDelete === "false") {
		return err(`${warning}error: the branch '${name}' is not fully merged\n`);
	}
	if (adviceForceDelete === "true") {
		return err(
			`${warning}error: the branch '${name}' is not fully merged\n` +
				`hint: If you are sure you want to delete it, run 'git branch -D ${name}'\n`,
		);
	}
	return err(
		`${warning}error: the branch '${name}' is not fully merged\n` +
			`hint: If you are sure you want to delete it, run 'git branch -D ${name}'\n` +
			'hint: Disable this message with "git config set advice.forceDeleteBranch false"\n',
	);
}

export function registerBranchCommand(parent: Command, ext?: GitExtensions) {
	parent.command("branch", {
		description: "List, create, or delete branches",
		args: [
			a.string().name("name").describe("Branch name").optional(),
			a
				.string()
				.name("newName")
				.describe("New branch name (for -m) or start-point (for create)")
				.optional(),
		],
		options: {
			delete: f().alias("d").describe("Delete a branch"),
			forceDelete: f().alias("D").describe("Force delete a branch"),
			move: f().alias("m").describe("Rename a branch"),
			forceMove: f().alias("M").describe("Force rename a branch"),
			remotes: f().alias("r").describe("List remote-tracking branches"),
			all: f().alias("a").describe("List all branches"),
			showCurrent: f().describe("Print the current branch name"),
			setUpstreamTo: o.string().alias("u").describe("Set upstream tracking branch"),
			verbose: f().alias("v").count().describe("Show hash and subject"),
		},
		handler: async (args, ctx) => {
			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;
			const gitCtx = gitCtxOrError;

			const head = await readHead(gitCtx);
			const currentBranch = head?.type === "symbolic" ? branchNameFromRef(head.target) : null;

			// ── Show current branch ────────────────────────────────────
			if (args.showCurrent) {
				return {
					stdout: currentBranch ? `${currentBranch}\n` : "",
					stderr: "",
					exitCode: 0,
				};
			}

			// ── Rename branch ───────────────────────────────────────────
			const forceRename = !!args.forceMove;
			if (args.move || forceRename) {
				let oldName: string;
				let newName: string;

				if (args.newName) {
					oldName = args.name as string;
					newName = args.newName as string;
				} else if (args.name) {
					if (!currentBranch) {
						return fatal("not on any branch");
					}
					oldName = currentBranch;
					newName = args.name as string;
				} else {
					return fatal("branch name required");
				}

				if (!isValidBranchName(newName)) {
					return fatal(`'${newName}' is not a valid branch name`);
				}

				const oldRef = `refs/heads/${oldName}`;
				const newRef = `refs/heads/${newName}`;

				const hash = await resolveRef(gitCtx, oldRef);
				if (!hash) {
					return fatal(`no branch named '${oldName}'`);
				}

				if (await isRebaseInProgress(gitCtx)) {
					const state = await readRebaseState(gitCtx);
					if (state?.headName === oldRef) {
						return fatal(`branch ${oldRef} is being rebased at ${gitCtx.workTree}`);
					}
				}

				const existingNewRef = await resolveRef(gitCtx, newRef);
				if (existingNewRef && !forceRename) {
					return fatal(`a branch named '${newName}' already exists`);
				}
				if (existingNewRef) {
					await deleteRef(gitCtx, newRef);
				}

				const oldEntries = await readReflog(gitCtx, oldRef);
				await updateRef(gitCtx, newRef, hash);
				await deleteRef(gitCtx, oldRef);

				if (oldName === currentBranch) {
					await createSymbolicRef(gitCtx, "HEAD", newRef);
				}

				if (oldEntries.length > 0) {
					await writeReflog(gitCtx, newRef, oldEntries);
				}
				const renameMsg = `Branch: renamed ${oldRef} to ${newRef}`;
				await logRef(gitCtx, ctx.env, newRef, hash, hash, renameMsg);
				if (oldName === currentBranch) {
					const ident = await getReflogIdentity(gitCtx, ctx.env);
					await appendReflog(gitCtx, "HEAD", {
						oldHash: hash,
						newHash: ZERO_HASH,
						...ident,
						message: renameMsg,
					});
					await appendReflog(gitCtx, "HEAD", {
						oldHash: ZERO_HASH,
						newHash: hash,
						...ident,
						message: renameMsg,
					});
				}

				const config = await readConfig(gitCtx);
				const oldSection = `branch "${oldName}"`;
				if (config[oldSection]) {
					config[`branch "${newName}"`] = config[oldSection];
					delete config[oldSection];
					await writeConfig(gitCtx, config);
				}

				return { stdout: "", stderr: "", exitCode: 0 };
			}

			// ── Delete branch ───────────────────────────────────────────
			const forceDelete = args.forceDelete;
			if (args.delete || forceDelete) {
				if (!args.name) {
					return fatal("branch name required");
				}

				let branchInUse = args.name === currentBranch;
				if (!branchInUse && !currentBranch) {
					const rebasing = await isRebaseInProgress(gitCtx);
					if (rebasing) {
						const state = await readRebaseState(gitCtx);
						if (state?.headName === `refs/heads/${args.name}`) {
							branchInUse = true;
						}
					}
				}
				if (branchInUse) {
					return err(
						`error: cannot delete branch '${args.name}' used by worktree at '${gitCtx.workTree}'\n`,
					);
				}

				const refName = `refs/heads/${args.name}`;
				const hash = await resolveRef(gitCtx, refName);
				if (!hash) {
					return err(`error: branch '${args.name}' not found\n`);
				}

				let deleteWarning = "";
				if (!forceDelete) {
					const headHash = await resolveHead(gitCtx);

					const config = await readConfig(gitCtx);
					const branchSection = config[`branch "${args.name}"`];
					const remote = branchSection?.remote;
					const merge = branchSection?.merge;

					let upstreamRef: string | null = null;
					let upstreamHash: string | null = null;
					if (remote && merge) {
						upstreamRef = merge.replace(/^refs\/heads\//, `refs/remotes/${remote}/`);
						upstreamHash = await resolveRef(gitCtx, upstreamRef);
					}

					if (upstreamHash && upstreamRef) {
						const mergedToUpstream =
							hash === upstreamHash || (await isAncestor(gitCtx, hash, upstreamHash));
						if (!mergedToUpstream) {
							const mergedToHead =
								headHash != null &&
								(hash === headHash || (await isAncestor(gitCtx, hash, headHash)));
							const warning = mergedToHead
								? `warning: not deleting branch '${args.name}' that is not yet merged to\n         '${upstreamRef}', even though it is merged to HEAD\n`
								: "";
							return formatDeleteBranchNotFullyMerged(gitCtx, args.name, warning);
						}
						const mergedToHead =
							headHash != null && (hash === headHash || (await isAncestor(gitCtx, hash, headHash)));
						if (!mergedToHead) {
							deleteWarning = `warning: deleting branch '${args.name}' that has been merged to\n         '${upstreamRef}', but not yet merged to HEAD\n`;
						}
					} else {
						if (headHash && hash !== headHash) {
							const merged = await isAncestor(gitCtx, hash, headHash);
							if (!merged) {
								return formatDeleteBranchNotFullyMerged(gitCtx, args.name);
							}
						}
					}
				}

				await deleteRef(gitCtx, refName);
				return {
					stdout: `Deleted branch ${args.name} (was ${abbreviateHash(hash)}).\n`,
					stderr: deleteWarning,
					exitCode: 0,
				};
			}

			// ── Set upstream ────────────────────────────────────────────
			if (args.setUpstreamTo) {
				const upstream = args.setUpstreamTo;
				const branchName = args.name || currentBranch;

				if (!branchName) {
					return fatal("could not set upstream of HEAD when it does not point to any branch.");
				}

				const branchHash = await resolveRef(gitCtx, `refs/heads/${branchName}`);
				if (!branchHash) {
					return fatal(`branch '${branchName}' does not exist`);
				}

				const slashIdx = upstream.indexOf("/");
				if (slashIdx < 0) {
					return formatSetUpstreamFailure(upstream);
				}

				const remoteName = upstream.slice(0, slashIdx);
				const remoteBranch = upstream.slice(slashIdx + 1);

				const upstreamHash = await resolveRef(gitCtx, `refs/remotes/${upstream}`);
				if (!upstreamHash) {
					return formatSetUpstreamFailure(upstream);
				}

				const config = await readConfig(gitCtx);
				const section = `branch "${branchName}"`;
				if (!config[section]) config[section] = {};
				config[section].remote = remoteName;
				config[section].merge = `refs/heads/${remoteBranch}`;
				await writeConfig(gitCtx, config);

				return {
					stdout: `branch '${branchName}' set up to track '${upstream}'.\n`,
					stderr: "",
					exitCode: 0,
				};
			}

			// ── Create branch ───────────────────────────────────────────
			if (args.name && !args.remotes && !args.all) {
				if (!isValidBranchName(args.name)) {
					return fatal(`'${args.name}' is not a valid branch name`);
				}

				const startPoint = args.newName;
				let targetHash: ObjectId | null;

				if (startPoint) {
					const result = await requireCommit(
						gitCtx,
						startPoint,
						`not a valid object name: '${startPoint}'`,
					);
					if (isCommandError(result)) return result;
					targetHash = result.hash;
				} else {
					targetHash = await resolveHead(gitCtx);
					if (!targetHash) {
						return fatal("Not a valid object name: 'HEAD'.");
					}
				}

				const refName = `refs/heads/${args.name}`;
				const existing = await resolveRef(gitCtx, refName);
				if (existing) {
					return fatal(`a branch named '${args.name}' already exists`);
				}

				await updateRef(gitCtx, refName, targetHash);
				const startLabel = startPoint ?? "HEAD";
				await logRef(
					gitCtx,
					ctx.env,
					refName,
					null,
					targetHash,
					`branch: Created from ${startLabel}`,
				);

				let trackingMsg = "";
				if (startPoint) {
					trackingMsg = await maybeSetupTracking(gitCtx, args.name, startPoint);
				}
				return { stdout: "", stderr: trackingMsg, exitCode: 0 };
			}

			// ── List branches ───────────────────────────────────────────
			const verboseLevel = (args.verbose as number) || 0;
			const showLocal = !args.remotes || args.all;
			const showRemotes = args.remotes || args.all;

			const entries: {
				displayName: string;
				hash: ObjectId;
				isCurrent: boolean;
				branchName: string | null;
			}[] = [];

			// Detached HEAD indicator
			if (showLocal && !currentBranch) {
				const headHash = await resolveHead(gitCtx);
				if (headHash) {
					const rebasing = await isRebaseInProgress(gitCtx);
					let detachedName: string;

					if (rebasing) {
						const state = await readRebaseState(gitCtx);
						if (state?.headName) {
							const branch = branchNameFromRef(state.headName);
							if (branch === "detached HEAD") {
								const detachPoint = await readDetachPoint(gitCtx);
								const short = detachPoint ? abbreviateHash(detachPoint) : "(null)";
								detachedName = `(no branch, rebasing detached HEAD ${short})`;
							} else {
								detachedName = `(no branch, rebasing ${branch})`;
							}
						} else {
							detachedName = "(no branch)";
						}
					} else {
						const detachPoint = await readDetachPoint(gitCtx);
						if (detachPoint) {
							const atOrFrom = headHash === detachPoint ? "at" : "from";
							detachedName = `(HEAD detached ${atOrFrom} ${abbreviateHash(detachPoint)})`;
						} else {
							detachedName = "(no branch)";
						}
					}

					entries.push({
						displayName: detachedName,
						hash: headHash,
						isCurrent: true,
						branchName: null,
					});
				}
			}

			// Local branches
			if (showLocal) {
				const localRefs = await listRefs(gitCtx, "refs/heads");
				for (const ref of localRefs) {
					const name = branchNameFromRef(ref.name);
					entries.push({
						displayName: name,
						hash: ref.hash,
						isCurrent: name === currentBranch,
						branchName: name,
					});
				}
			}

			// Remote branches
			if (showRemotes) {
				const remoteRefs = await listRefs(gitCtx, "refs/remotes");
				for (const ref of remoteRefs) {
					const name = ref.name.replace("refs/remotes/", "");
					let symrefTarget: string | null = null;
					const rawRef = await gitCtx.refStore.readRef(ref.name);
					if (rawRef?.type === "symbolic") {
						symrefTarget = rawRef.target.replace("refs/remotes/", "");
					}
					const display = symrefTarget
						? args.all
							? `remotes/${name} -> ${symrefTarget}`
							: `${name} -> ${symrefTarget}`
						: args.all
							? `remotes/${name}`
							: name;
					entries.push({
						displayName: display,
						hash: ref.hash,
						isCurrent: false,
						branchName: null,
					});
				}
			}

			if (entries.length === 0) {
				return { stdout: "", stderr: "", exitCode: 0 };
			}

			// Non-verbose: simple listing
			if (verboseLevel === 0) {
				const lines = entries.map((e) =>
					e.isCurrent ? `* ${e.displayName}` : `  ${e.displayName}`,
				);
				return {
					stdout: `${lines.join("\n")}\n`,
					stderr: "",
					exitCode: 0,
				};
			}

			// Verbose listing
			const config = verboseLevel >= 1 ? await readConfig(gitCtx) : null;
			const maxNameLen = Math.max(...entries.map((e) => e.displayName.length));

			const lines: string[] = [];
			for (const entry of entries) {
				const marker = entry.isCurrent ? "* " : "  ";
				const paddedName = entry.displayName.padEnd(maxNameLen);
				const shortHash = abbreviateHash(entry.hash);

				let subject = "";
				try {
					const commit = await readCommit(gitCtx, entry.hash);
					subject = firstLine(commit.message);
				} catch {
					// fallback for non-commit objects
				}

				let trackingStr = "";
				if (config && entry.branchName) {
					const info = await getTrackingInfo(gitCtx, config, entry.branchName);
					if (info) {
						const formatted = formatBranchTrackingInfo(info, verboseLevel >= 2);
						if (formatted) trackingStr = ` ${formatted}`;
					}
				}

				lines.push(`${marker}${paddedName} ${shortHash}${trackingStr} ${subject}`);
			}

			return {
				stdout: `${lines.join("\n")}\n`,
				stderr: "",
				exitCode: 0,
			};
		},
	});
}
