import type { GitExtensions } from "../git.ts";
import {
	buildDetachPreamble,
	clearOperationState,
	detachHeadCore,
	findPreviousBranch,
	formatCheckoutSummary,
	formatPrevHeadPosition,
	requireResolvedIndex,
	switchBranchCore,
} from "../lib/checkout-utils.ts";
import {
	err,
	fatal,
	isCommandError,
	requireCommit,
	requireGitContext,
} from "../lib/command-utils.ts";
import { readConfig, writeConfig } from "../lib/config.ts";
import { formatLongTrackingInfo, getTrackingInfo } from "../lib/status-format.ts";
import { clearIndex, readIndex, writeIndex } from "../lib/index.ts";
import { readCommit } from "../lib/object-db.ts";
import { clearDetachPoint, readStateFile } from "../lib/operation-state.ts";
import { isRebaseInProgress } from "../lib/rebase.ts";
import { logRef, ZERO_HASH } from "../lib/reflog.ts";
import {
	createSymbolicRef,
	deleteRef,
	listRefs,
	readHead,
	resolveHead,
	resolveRef,
	updateRef,
} from "../lib/refs.ts";
import { buildTreeFromIndex } from "../lib/tree-ops.ts";
import type { GitContext, ObjectId, Ref } from "../lib/types.ts";
import { applyWorktreeOps, checkoutTrees } from "../lib/unpack-trees.ts";
import { a, type Command, f, o } from "../parse/index.ts";

function fromNameOf(head: Ref | null, hash: ObjectId | null): string {
	return head?.type === "symbolic"
		? head.target.replace(/^refs\/heads\//, "")
		: (hash ?? ZERO_HASH);
}

export function registerSwitchCommand(parent: Command, ext?: GitExtensions) {
	parent.command("switch", {
		description: "Switch branches",
		args: [
			a
				.string()
				.name("branch-or-start-point")
				.describe("Branch to switch to, or start-point for -c/-C")
				.optional(),
		],
		options: {
			create: o.string().alias("c").describe("Create and switch to a new branch"),
			forceCreate: o.string().alias("C").describe("Create/reset and switch to a branch"),
			detach: f().alias("d").describe("Detach HEAD at named commit"),
			orphan: o.string().describe("Create a new orphan branch"),
			guess: f().default(true).describe("Guess branch from remote tracking"),
		},
		handler: async (args, ctx, meta) => {
			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;
			const gitCtx = gitCtxOrError;

			const positional: string | undefined = args["branch-or-start-point"];

			// ── Orphan branch ─────────────────────────────────────
			if (args.orphan) {
				if (args.create || args.forceCreate) {
					return fatal("--orphan and -c/-C are incompatible");
				}
				if (args.detach) {
					return fatal("--orphan and --detach are incompatible");
				}
				return switchOrphanBranch(gitCtx, args.orphan, ctx.env, ext);
			}

			// ── Detach ────────────────────────────────────────────
			if (args.detach) {
				if (args.create || args.forceCreate) {
					return fatal("--detach and -c/-C are incompatible");
				}
				const rev = positional ?? "HEAD";
				const result = await requireCommit(gitCtx, rev, `invalid reference: ${rev}`);
				if (isCommandError(result)) return result;
				return switchDetachHead(gitCtx, rev, result.hash, ctx.env, ext);
			}

			// ── Create (-c / -C) ─────────────────────────────────
			if (args.create || args.forceCreate) {
				const branchName = (args.create || args.forceCreate) as string;
				const startPoint =
					positional ?? (meta.passthrough.length > 0 ? meta.passthrough[0] : undefined);
				return switchCreateBranch(gitCtx, branchName, !!args.forceCreate, startPoint, ctx.env, ext);
			}

			// ── No target ────────────────────────────────────────
			if (!positional) {
				return fatal("missing branch or commit argument");
			}

			// ── "-" shorthand for previous branch ─────────────────
			if (positional === "-") {
				return switchToPrevious(gitCtx, ctx.env, ext);
			}

			// ── Try as existing branch ────────────────────────────
			const refName = `refs/heads/${positional}`;
			const branchHash = await resolveRef(gitCtx, refName);
			if (branchHash) {
				return switchToBranch(gitCtx, positional, refName, branchHash, ctx.env, ext);
			}

			// ── Guess from remote tracking refs ───────────────────
			if (args.guess !== false) {
				const guessed = await guessRemoteBranch(gitCtx, positional);
				if (guessed) {
					return switchCreateBranch(
						gitCtx,
						positional,
						false,
						guessed.startPoint,
						ctx.env,
						ext,
						guessed.trackingRef,
					);
				}
			}

			return fatal(`invalid reference: ${positional}`);
		},
	});
}

// ── Active operation check (git switch blocks unlike checkout) ────────

async function checkActiveOperation(
	gitCtx: GitContext,
): Promise<{ stdout: string; stderr: string; exitCode: number } | null> {
	const cpHead = await readStateFile(gitCtx, "CHERRY_PICK_HEAD");
	if (cpHead) {
		return fatal(
			'cannot switch branch while cherry-picking\nConsider "git cherry-pick --quit" or "git worktree add".',
		);
	}
	const mergeHead = await readStateFile(gitCtx, "MERGE_HEAD");
	if (mergeHead) {
		return fatal(
			'cannot switch branch while merging\nConsider "git merge --quit" or "git worktree add".',
		);
	}
	const revertHead = await readStateFile(gitCtx, "REVERT_HEAD");
	if (revertHead) {
		return fatal(
			'cannot switch branch while reverting\nConsider "git revert --quit" or "git worktree add".',
		);
	}
	if (await isRebaseInProgress(gitCtx)) {
		return fatal(
			'cannot switch branch while rebasing\nConsider "git rebase --quit" or "git worktree add".',
		);
	}
	return null;
}

// ── Switch to previous branch via HEAD reflog ────────────────────────

async function switchToPrevious(
	gitCtx: GitContext,
	env: Map<string, string>,
	ext?: GitExtensions,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const opBlock = await checkActiveOperation(gitCtx);
	if (opBlock) return opBlock;

	const prev = await findPreviousBranch(gitCtx);
	if (!prev) return fatal("no previous branch");
	return switchToBranch(gitCtx, prev.name, prev.refName, prev.hash, env, ext);
}

// ── Guess remote tracking branch ─────────────────────────────────────

async function guessRemoteBranch(
	gitCtx: GitContext,
	name: string,
): Promise<{ startPoint: string; trackingRef: string } | null> {
	const allRefs = await listRefs(gitCtx, "refs/remotes");
	const candidates: { remote: string; ref: string }[] = [];

	for (const ref of allRefs) {
		const parts = ref.name.replace(/^refs\/remotes\//, "").split("/");
		const remote = parts[0];
		if (parts.length >= 2 && remote) {
			const branch = parts.slice(1).join("/");
			if (branch === name) {
				candidates.push({ remote, ref: ref.name });
			}
		}
	}

	const c = candidates.length === 1 ? candidates[0] : undefined;
	if (c) {
		return { startPoint: c.ref, trackingRef: c.ref };
	}
	return null;
}

// ── Create and switch to a new branch ────────────────────────────────

async function switchCreateBranch(
	gitCtx: GitContext,
	branchName: string,
	force: boolean,
	startPoint: string | undefined,
	env: Map<string, string>,
	ext?: GitExtensions,
	trackingRef?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const refName = `refs/heads/${branchName}`;
	const existing = await resolveRef(gitCtx, refName);

	if (existing && !force) {
		return fatal(`a branch named '${branchName}' already exists`);
	}

	let targetHash: ObjectId;
	if (startPoint) {
		const result = await requireCommit(gitCtx, startPoint, `invalid reference: ${startPoint}`);
		if (isCommandError(result)) return result;
		targetHash = result.hash;
	} else {
		const headHash = await resolveHead(gitCtx);
		if (!headHash) {
			// Empty repo: just point HEAD at the new branch
			const prevHead = await readHead(gitCtx);
			const fromName =
				prevHead?.type === "symbolic" ? prevHead.target.replace(/^refs\/heads\//, "") : "";
			if (force && existing) {
				await deleteRef(gitCtx, refName);
			}
			await createSymbolicRef(gitCtx, "HEAD", refName);
			await clearDetachPoint(gitCtx);
			const opWarning = await clearOperationState(gitCtx);
			await logRef(
				gitCtx,
				env,
				"HEAD",
				null,
				ZERO_HASH,
				`checkout: moving from ${fromName} to ${branchName}`,
			);
			return {
				stdout: "",
				stderr: `Switched to a new branch '${branchName}'\n${opWarning}`,
				exitCode: 0,
			};
		}
		targetHash = headHash;
	}

	// Check operation state after reference validation
	const opBlock = await checkActiveOperation(gitCtx);
	if (opBlock) return opBlock;

	const currentHash = await resolveHead(gitCtx);
	let currentIndex = await readIndex(gitCtx);

	if (startPoint) {
		const conflictErr = requireResolvedIndex(currentIndex);
		if (conflictErr) return conflictErr;
	}

	const targetCommit = await readCommit(gitCtx, targetHash);

	// Switch worktree/index if target differs from current HEAD
	if (currentHash && currentHash !== targetHash) {
		const currentCommit = await readCommit(gitCtx, currentHash);

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

	const head = await readHead(gitCtx);
	let detachPreamble = "";
	if (head?.type === "direct" && currentHash) {
		detachPreamble = await buildDetachPreamble(gitCtx, currentHash, targetHash);
	}

	const fromName = fromNameOf(head, currentHash);
	await updateRef(gitCtx, refName, targetHash);
	await createSymbolicRef(gitCtx, "HEAD", refName);
	await clearDetachPoint(gitCtx);
	const opWarning = await clearOperationState(gitCtx);

	const startLabel = startPoint ?? "HEAD";

	if (force && existing) {
		if (existing !== targetHash) {
			await logRef(gitCtx, env, refName, existing, targetHash, `branch: Reset to ${startLabel}`);
		}
	} else {
		await logRef(gitCtx, env, refName, null, targetHash, `branch: Created from ${startLabel}`);
	}
	await logRef(
		gitCtx,
		env,
		"HEAD",
		currentHash,
		targetHash,
		`checkout: moving from ${fromName} to ${branchName}`,
	);

	const trackingParts = trackingRef?.replace(/^refs\/remotes\//, "").split("/");
	if (trackingParts) {
		const remote = trackingParts[0] ?? "";
		const merge = `refs/heads/${trackingParts.slice(1).join("/")}`;
		const config = await readConfig(gitCtx);
		config[`branch "${branchName}"`] = {
			...config[`branch "${branchName}"`],
			remote,
			merge,
		};
		await writeConfig(gitCtx, config);
	}

	await ext?.hooks?.postCheckout?.({
		repo: gitCtx,
		prevHead: currentHash,
		newHead: targetHash,
		isBranchCheckout: true,
	});

	const label =
		force && existing
			? `Switched to and reset branch '${branchName}'\n`
			: `Switched to a new branch '${branchName}'\n`;

	let stderr = detachPreamble + label + opWarning;

	if (trackingParts) {
		const trackBranch = trackingParts.slice(1).join("/");
		stderr += `branch '${branchName}' set up to track '${trackingParts[0]}/${trackBranch}'.\n`;
	}

	let stdout = "";
	if (startPoint) {
		stdout = await formatCheckoutSummary(gitCtx, targetCommit.tree, currentIndex);
	}

	const config = await readConfig(gitCtx);
	const trackingInfo = await getTrackingInfo(gitCtx, config, branchName);
	if (trackingInfo) {
		stdout += formatLongTrackingInfo(trackingInfo);
	}

	return { stdout, stderr, exitCode: 0 };
}

// ── Switch to an existing branch ─────────────────────────────────────

async function switchToBranch(
	gitCtx: GitContext,
	branchName: string,
	refName: string,
	targetHash: ObjectId,
	env: Map<string, string>,
	ext?: GitExtensions,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const opBlock = await checkActiveOperation(gitCtx);
	if (opBlock) return opBlock;
	return switchBranchCore(gitCtx, branchName, refName, targetHash, env, ext);
}

// ── Detach HEAD at a commit ──────────────────────────────────────────

async function switchDetachHead(
	gitCtx: GitContext,
	_target: string,
	targetHash: ObjectId,
	env: Map<string, string>,
	ext?: GitExtensions,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const opBlock = await checkActiveOperation(gitCtx);
	if (opBlock) return opBlock;
	return detachHeadCore(gitCtx, targetHash, env, ext);
}

// ── Orphan branch (switch --orphan clears index and tracked files) ───

async function switchOrphanBranch(
	gitCtx: GitContext,
	branchName: string,
	_env: Map<string, string>,
	ext?: GitExtensions,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const opBlock = await checkActiveOperation(gitCtx);
	if (opBlock) return opBlock;

	const refName = `refs/heads/${branchName}`;
	const existing = await resolveRef(gitCtx, refName);
	if (existing) {
		return fatal(`a branch named '${branchName}' already exists`);
	}

	const currentIndex = await readIndex(gitCtx);
	const conflictErr = requireResolvedIndex(currentIndex);
	if (conflictErr) return conflictErr;

	const prevHead = await resolveHead(gitCtx);
	const head = await readHead(gitCtx);

	// Build "Previous HEAD position was ..." preamble when leaving detached HEAD
	let detachPreamble = "";
	if (head?.type === "direct" && prevHead) {
		detachPreamble = await formatPrevHeadPosition(gitCtx, prevHead);
	}

	// Unlike checkout --orphan, switch --orphan clears tracked files from
	// the index and worktree but preserves newly-staged entries (files
	// added to the index that aren't in the current commit tree).
	// checkoutTrees (two-way merge to empty tree) handles this: case 4/5
	// in twowayMerge KEEPs entries where old=null, new=null (staged adds).
	if (gitCtx.workTree) {
		const currentTree = prevHead ? (await readCommit(gitCtx, prevHead)).tree : null;
		const emptyTree = await buildTreeFromIndex(gitCtx, []);
		const result = await checkoutTrees(gitCtx, currentTree, emptyTree, currentIndex);
		if (!result.success) {
			return result.errorOutput ?? err("error: checkout would overwrite local changes");
		}
		await applyWorktreeOps(gitCtx, result.worktreeOps);
		await writeIndex(gitCtx, { version: 2, entries: result.newEntries });
	} else {
		await writeIndex(gitCtx, clearIndex());
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

	return {
		stdout: "",
		stderr: `${detachPreamble}Switched to a new branch '${branchName}'\n${opWarning}`,
		exitCode: 0,
	};
}
