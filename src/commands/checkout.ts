import type { GitExtensions } from "../git.ts";
import { isRejection } from "../hooks.ts";
import {
	clearOperationState,
	detachHeadCore,
	findPreviousBranch,
	formatCheckoutSummary,
	guessRemoteBranch,
	requireResolvedIndex,
	restoreConflicted,
	restoreFiles,
	switchBranchCore,
} from "../lib/checkout-utils.ts";
import {
	err,
	fatal,
	getCwdPrefix,
	isCommandError,
	requireCommit,
	requireGitContext,
} from "../lib/command-utils.ts";
import { readConfig, writeConfig } from "../lib/config.ts";
import { findEntry, readIndex, writeIndex } from "../lib/index.ts";
import { peelToCommit, readCommit } from "../lib/object-db.ts";
import { clearDetachPoint } from "../lib/operation-state.ts";
import { logRef, ZERO_HASH } from "../lib/reflog.ts";
import {
	createSymbolicRef,
	isValidBranchName,
	readHead,
	resolveHead,
	resolveRef,
	updateRef,
} from "../lib/refs.ts";
import { resolveRevision } from "../lib/rev-parse.ts";
import { formatLongTrackingInfo, getTrackingInfo } from "../lib/status-format.ts";
import type { GitContext, ObjectId } from "../lib/types.ts";
import { applyWorktreeOps, checkoutTrees } from "../lib/unpack-trees.ts";
import { checkoutEntry } from "../lib/worktree.ts";
import { a, type Command, f, o } from "../parse/index.ts";

export function registerCheckoutCommand(parent: Command, ext?: GitExtensions) {
	parent.command("checkout", {
		description: "Switch branches or restore working tree files",
		args: [
			a
				.string()
				.name("target")
				.describe("Branch, commit, path, or start-point for -b/-B")
				.optional(),
		],
		options: {
			branch: o.string().alias("b").describe("Create and switch to a new branch"),
			forceBranch: o.string().alias("B").describe("Create/reset and switch to a new branch"),
			detach: f().alias("d").describe("Detach HEAD at named commit"),
			orphan: f().describe("Create a new orphan branch"),
			ours: f().describe("Checkout our version for unmerged files"),
			theirs: f().describe("Checkout their version for unmerged files"),
		},
		handler: async (args, ctx, meta) => {
			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;
			const gitCtx = gitCtxOrError;

			const target: string | undefined = args.target;

			if (args.ours && args.theirs) {
				return fatal("--ours and --theirs are incompatible");
			}

			if (args.detach && (args.branch || args.forceBranch || args.orphan)) {
				return fatal("'--detach' cannot be used with '-b/-B/--orphan'");
			}

			// ── Explicit `--` separator: everything after is paths ──────
			if (meta.passthrough.length > 0) {
				if (args.detach) {
					return fatal(
						`git checkout: --detach does not take a path argument '${meta.passthrough[0]}'`,
					);
				}
				const cwdPrefix = getCwdPrefix(gitCtx, ctx.cwd);

				const passthroughPaths = meta.passthrough;

				let sourceTree: ObjectId | null = null;
				if (target) {
					if (args.ours || args.theirs) {
						return fatal("cannot specify both a revision and --ours/--theirs");
					}
					const result = await requireCommit(gitCtx, target, `invalid reference: ${target}`);
					if (isCommandError(result)) return result;
					sourceTree = result.commit.tree;
				}

				if (args.ours || args.theirs) {
					return restoreConflicted(gitCtx, passthroughPaths, cwdPrefix, args.theirs ? 3 : 2);
				}

				return restoreFiles(gitCtx, passthroughPaths, cwdPrefix, sourceTree);
			}

			// ── Orphan branch (--orphan) ───────────────────────────────
			if (args.orphan) {
				if (args.branch) {
					return fatal("--orphan and -b are incompatible");
				}
				if (args.ours || args.theirs) {
					return fatal("--orphan and --ours/--theirs are incompatible");
				}
				if (!target) {
					return fatal("you must specify a branch to checkout");
				}
				return createOrphanBranch(gitCtx, target, ctx.env, ext);
			}

			// ── Detach HEAD (--detach) ─────────────────────────────────
			if (args.detach) {
				const rev = target ?? "HEAD";
				const result = await requireCommit(gitCtx, rev, `invalid reference: ${rev}`);
				if (isCommandError(result)) return result;
				return detachHead(gitCtx, rev, result.hash, ctx.env, ext);
			}

			// ── Create + switch (-b / -B) ───────────────────────────────
			if (args.branch || args.forceBranch) {
				const branchName = (args.branch || args.forceBranch) as string;
				return createAndSwitch(gitCtx, branchName, target, ctx.env, ext, !!args.forceBranch);
			}

			if (!target) {
				return fatal("you must specify a branch to checkout");
			}

			// ── "-" shorthand for previous branch ───────────────────────
			if (target === "-") {
				return checkoutPrevious(gitCtx, ctx.env, ext);
			}

			// ── Try as branch first ─────────────────────────────────────
			const refName = `refs/heads/${target}`;
			const branchHash = await resolveRef(gitCtx, refName);

			if (branchHash) {
				return switchBranch(gitCtx, target, refName, branchHash, ctx.env, ext);
			}

			// ── DWIM: guess from remote tracking refs ───────────────────
			const guessed = await guessRemoteBranch(gitCtx, target);
			if (guessed) {
				return createAndSwitchFromRemote(gitCtx, target, guessed.trackingRef, ctx.env, ext);
			}

			// ── Try as detached HEAD (commit hash, tag, etc.) ──────────
			const detachedHash = await resolveRevision(gitCtx, target);
			if (detachedHash) {
				const commitHash = await peelToCommit(gitCtx, detachedHash);
				return detachHead(gitCtx, target, commitHash, ctx.env, ext);
			}

			// ── Fall back to file restoration from index ────────────────
			if (gitCtx.workTree) {
				const index = await readIndex(gitCtx);
				const entry = findEntry(index, target);
				if (entry) {
					await checkoutEntry(gitCtx, {
						path: entry.path,
						hash: entry.hash,
						mode: entry.mode,
					});
					return { stdout: "", stderr: "", exitCode: 0 };
				}
			}

			return err(`error: pathspec '${target}' did not match any file(s) known to git\n`);
		},
	});
}

/**
 * Switch to the previous branch by inspecting the HEAD reflog for
 * a "checkout: moving from X to Y" entry.
 */
async function checkoutPrevious(
	gitCtx: GitContext,
	env: Map<string, string>,
	ext?: GitExtensions,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const prev = await findPreviousBranch(gitCtx);
	if (!prev) return fatal("no previous branch");
	return switchBranch(gitCtx, prev.name, prev.refName, prev.hash, env, ext);
}

/**
 * Create a new orphan branch. HEAD becomes a symbolic ref to a branch
 * that does not exist yet, so the next commit will be a root commit
 * with no parents. Index and worktree are left intact.
 */
async function createOrphanBranch(
	gitCtx: GitContext,
	branchName: string,
	_env: Map<string, string>,
	ext?: GitExtensions,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	if (!isValidBranchName(branchName)) {
		return fatal(`'${branchName}' is not a valid branch name`);
	}

	const refName = `refs/heads/${branchName}`;
	const existing = await resolveRef(gitCtx, refName);
	if (existing) {
		return fatal(`a branch named '${branchName}' already exists`);
	}

	const currentIndex = await readIndex(gitCtx);
	const conflictErr = requireResolvedIndex(currentIndex);
	if (conflictErr) return conflictErr;

	const prevHead = await resolveHead(gitCtx);
	let prevTree: ObjectId | null = null;
	if (prevHead) {
		const prevCommit = await readCommit(gitCtx, prevHead);
		prevTree = prevCommit.tree;
	}

	await createSymbolicRef(gitCtx, "HEAD", refName);
	await clearDetachPoint(gitCtx);
	const opWarning = await clearOperationState(gitCtx);

	await ext?.hooks?.postCheckout?.({
		repo: gitCtx,
		prevHead,
		newHead: ZERO_HASH,
		isBranchCheckout: true,
	});

	let stdout = "";
	if (prevTree) {
		stdout = await formatCheckoutSummary(gitCtx, prevTree, currentIndex);
	}

	return {
		stdout,
		stderr: `Switched to a new branch '${branchName}'\n${opWarning}`,
		exitCode: 0,
	};
}

/**
 * Create a new branch and switch to it, optionally at a given start-point.
 */
async function createAndSwitch(
	gitCtx: GitContext,
	branchName: string,
	startPoint: string | undefined,
	env: Map<string, string>,
	ext?: GitExtensions,
	force = false,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	if (!isValidBranchName(branchName)) {
		return fatal(`'${branchName}' is not a valid branch name`);
	}

	const rej = await ext?.hooks?.preCheckout?.({
		repo: gitCtx,
		target: branchName,
		mode: "create-branch",
	});
	if (isRejection(rej)) return err(rej.message ?? "");
	const head = await readHead(gitCtx);
	const headHash = await resolveHead(gitCtx);

	const refName = `refs/heads/${branchName}`;
	const existing = await resolveRef(gitCtx, refName);
	if (existing && !force) {
		return fatal(`a branch named '${branchName}' already exists`);
	}

	let targetHash: ObjectId | null;
	if (startPoint) {
		const result = await requireCommit(gitCtx, startPoint, `invalid reference: ${startPoint}`);
		if (isCommandError(result)) return result;
		targetHash = result.hash;
	} else {
		targetHash = headHash;
	}

	if (force || startPoint) {
		const currentIndex = await readIndex(gitCtx);
		const conflictErr = requireResolvedIndex(currentIndex);
		if (conflictErr) return conflictErr;
	}

	if (targetHash) {
		await updateRef(gitCtx, refName, targetHash);
	}

	let currentIndex = await readIndex(gitCtx);

	// Update worktree/index when target differs from current HEAD
	if (targetHash && headHash && targetHash !== headHash) {
		const currentCommit = await readCommit(gitCtx, headHash);
		const targetCommit = await readCommit(gitCtx, targetHash);
		if (currentCommit.tree !== targetCommit.tree) {
			const result = await checkoutTrees(
				gitCtx,
				currentCommit.tree,
				targetCommit.tree,
				currentIndex,
			);
			if (!result.success) {
				return result.errorOutput ?? err("error: checkout would overwrite local changes");
			}
			currentIndex = { version: 2, entries: result.newEntries };
			await writeIndex(gitCtx, currentIndex);
			await applyWorktreeOps(gitCtx, result.worktreeOps);
		}
	}

	await createSymbolicRef(gitCtx, "HEAD", refName);
	await clearDetachPoint(gitCtx);
	const opWarning = await clearOperationState(gitCtx);

	const fromName =
		head?.type === "symbolic" ? head.target.replace(/^refs\/heads\//, "") : (headHash ?? ZERO_HASH);
	const startLabel = startPoint ?? "HEAD";
	if (targetHash) {
		if (existing) {
			if (existing !== targetHash) {
				await logRef(gitCtx, env, refName, existing, targetHash, `branch: Reset to ${startLabel}`);
			}
		} else {
			await logRef(gitCtx, env, refName, null, targetHash, `branch: Created from ${startLabel}`);
		}
	}
	await logRef(
		gitCtx,
		env,
		"HEAD",
		headHash,
		targetHash ?? ZERO_HASH,
		`checkout: moving from ${fromName} to ${branchName}`,
	);

	await ext?.hooks?.postCheckout?.({
		repo: gitCtx,
		prevHead: headHash,
		newHead: targetHash ?? ZERO_HASH,
		isBranchCheckout: true,
	});

	let stdout = "";
	if ((force || startPoint) && targetHash) {
		const targetCommit = await readCommit(gitCtx, targetHash);
		stdout = await formatCheckoutSummary(gitCtx, targetCommit.tree, currentIndex);
	}

	const config = await readConfig(gitCtx);
	const trackingInfo = await getTrackingInfo(gitCtx, config, branchName);
	if (trackingInfo) {
		stdout += formatLongTrackingInfo(trackingInfo);
	}

	const alreadyOnBranch = head?.type === "symbolic" && head.target === refName;
	const stderrMsg = existing
		? alreadyOnBranch
			? `Reset branch '${branchName}'\n`
			: `Switched to and reset branch '${branchName}'\n`
		: `Switched to a new branch '${branchName}'\n`;

	return {
		stdout,
		stderr: `${stderrMsg}${opWarning}`,
		exitCode: 0,
	};
}

/**
 * Switch to an existing branch, updating HEAD, the index, and the working tree.
 */
async function switchBranch(
	gitCtx: GitContext,
	branchName: string,
	refName: string,
	targetHash: ObjectId,
	env: Map<string, string>,
	ext?: GitExtensions,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const rej = await ext?.hooks?.preCheckout?.({
		repo: gitCtx,
		target: branchName,
		mode: "switch",
	});
	if (isRejection(rej)) return err(rej.message ?? "");
	return switchBranchCore(gitCtx, branchName, refName, targetHash, env, ext);
}

/**
 * DWIM: create a local branch from a remote tracking ref and switch to it.
 */
async function createAndSwitchFromRemote(
	gitCtx: GitContext,
	branchName: string,
	trackingRef: string,
	env: Map<string, string>,
	ext?: GitExtensions,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const rej = await ext?.hooks?.preCheckout?.({
		repo: gitCtx,
		target: branchName,
		mode: "create-branch",
	});
	if (isRejection(rej)) return err(rej.message ?? "");

	const targetHash = await resolveRef(gitCtx, trackingRef);
	if (!targetHash) {
		return fatal(`invalid reference: ${trackingRef}`);
	}

	const refName = `refs/heads/${branchName}`;
	await updateRef(gitCtx, refName, targetHash);

	// Set up tracking config
	const trackingParts = trackingRef.replace(/^refs\/remotes\//, "").split("/");
	const remote = trackingParts[0] ?? "";
	const merge = `refs/heads/${trackingParts.slice(1).join("/")}`;
	const config = await readConfig(gitCtx);
	config[`branch "${branchName}"`] = {
		...config[`branch "${branchName}"`],
		remote,
		merge,
	};
	await writeConfig(gitCtx, config);

	await logRef(gitCtx, env, refName, null, targetHash, `branch: Created from ${trackingRef}`);

	const result = await switchBranchCore(gitCtx, branchName, refName, targetHash, env, ext, {
		isNew: true,
	});

	const trackBranch = trackingParts.slice(1).join("/");
	result.stdout = `branch '${branchName}' set up to track '${remote}/${trackBranch}'.\n`;

	return result;
}

/**
 * Detach HEAD at a specific commit, updating the index and working tree.
 */
async function detachHead(
	gitCtx: GitContext,
	target: string,
	targetHash: ObjectId,
	env: Map<string, string>,
	ext?: GitExtensions,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const rej = await ext?.hooks?.preCheckout?.({
		repo: gitCtx,
		target,
		mode: "detach",
	});
	if (isRejection(rej)) return err(rej.message ?? "");
	return detachHeadCore(gitCtx, targetHash, env, ext, {
		detachAdviceTarget: target,
	});
}
