import type { FileSystem } from "../fs.ts";
import type { CommandContext, GitExtensions } from "../git.ts";
import { guessRemoteBranch, maybeSetupTracking } from "../lib/checkout-utils.ts";
import {
	type CommandResult,
	fatal,
	hasStagedChanges,
	isCommandError,
	requireGitContext,
} from "../lib/command-utils.ts";
import { movePath } from "../lib/fs-utils.ts";
import { buildIndex, defaultStat, readIndex, writeIndex } from "../lib/index.ts";
import { readCommit } from "../lib/object-db.ts";
import { basename, dirname, join, resolve } from "../lib/path.ts";
import { logRef, ZERO_HASH } from "../lib/reflog.ts";
import { FileSystemRefStore, resolveHead, resolveRef, updateRef } from "../lib/refs.ts";
import { resolveRevision } from "../lib/rev-parse.ts";
import { flattenTree, flattenTreeToMap } from "../lib/tree-ops.ts";
import type { GitContext } from "../lib/types.ts";
import { checkoutEntry, diffIndexToWorkTree } from "../lib/worktree.ts";
import {
	branchCheckedOutAt,
	deriveWorktreeId,
	enumerateWorktrees,
	isWorktreeLocked,
	listWorktrees,
	lockWorktree,
	readLockReason,
	unlockWorktree,
	type WorktreeHead,
	type WorktreeInfo,
	writeGitFile,
	writeWorktreeAdmin,
} from "../lib/worktree-admin.ts";
import { a, type Command, f, o } from "../parse/index.ts";

const USAGE =
	"usage: git worktree add [<options>] <path> [<commit-ish>]\n" +
	"   or: git worktree list [<options>]\n" +
	"   or: git worktree lock [<options>] <worktree>\n" +
	"   or: git worktree move <worktree> <new-path>\n" +
	"   or: git worktree prune [<options>]\n" +
	"   or: git worktree remove [<options>] <worktree>\n" +
	"   or: git worktree repair [<path>...]\n" +
	"   or: git worktree unlock <worktree>\n";

export function registerWorktreeCommand(parent: Command, ext?: GitExtensions) {
	const worktree = parent.command("worktree", {
		description: "Manage multiple working trees",
		handler: async () => ({ stdout: "", stderr: USAGE, exitCode: 129 }),
	});

	worktree.command("add", {
		description: "Create a new working tree",
		args: [
			a.string().name("path").describe("Path for the new worktree"),
			a.string().name("commitish").describe("Commit-ish to check out").optional(),
		],
		options: {
			newBranch: o.string().alias("b").describe("Create a new branch"),
			forceNewBranch: o.string().alias("B").describe("Create or reset a branch"),
			detach: f().alias("d").describe("Detach HEAD in the new worktree"),
			force: f().alias("f").count().describe("Override safety checks"),
			lock: f().describe("Keep the worktree locked after creation"),
			reason: o.string().describe("Reason for locking"),
			noCheckout: f().describe("Do not populate the new worktree"),
			quiet: f().alias("q").describe("Suppress progress output"),
		},
		handler: async (args, ctx) => {
			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;
			return handleAdd(gitCtxOrError, ctx, args);
		},
	});

	worktree.command("list", {
		description: "List details of each working tree",
		options: {
			porcelain: f().describe("Machine-readable output"),
		},
		handler: async (args, ctx) => {
			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;
			return handleList(gitCtxOrError, !!args.porcelain);
		},
	});

	worktree.command("remove", {
		description: "Remove a working tree",
		args: [a.string().name("worktree").describe("Worktree to remove")],
		options: { force: f().alias("f").count().describe("Override safety checks") },
		handler: async (args, ctx) => {
			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;
			return handleRemove(gitCtxOrError, ctx, args.worktree as string, (args.force as number) ?? 0);
		},
	});

	worktree.command("prune", {
		description: "Prune working tree information",
		options: {
			dryRun: f().alias("n").describe("Do not remove, just report"),
			verbose: f().alias("v").describe("Report pruned worktrees"),
		},
		handler: async (args, ctx) => {
			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;
			return handlePrune(gitCtxOrError, !!args.dryRun, !!args.verbose);
		},
	});

	worktree.command("lock", {
		description: "Lock a working tree to prevent pruning",
		args: [a.string().name("worktree").describe("Worktree to lock")],
		options: { reason: o.string().describe("Reason for locking") },
		handler: async (args, ctx) => {
			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;
			return handleLock(
				gitCtxOrError,
				ctx,
				args.worktree as string,
				args.reason as string | undefined,
			);
		},
	});

	worktree.command("unlock", {
		description: "Unlock a working tree",
		args: [a.string().name("worktree").describe("Worktree to unlock")],
		handler: async (args, ctx) => {
			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;
			return handleUnlock(gitCtxOrError, ctx, args.worktree as string);
		},
	});

	worktree.command("move", {
		description: "Move a working tree to a new location",
		args: [
			a.string().name("worktree").describe("Worktree to move"),
			a.string().name("newPath").describe("New path for the worktree"),
		],
		options: {
			force: f().alias("f").count().describe("Override safety checks"),
		},
		handler: async (args, ctx) => {
			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;
			return handleMove(
				gitCtxOrError,
				ctx,
				args.worktree as string,
				args.newPath as string,
				(args.force as number) ?? 0,
			);
		},
	});

	worktree.command("repair", {
		description: "Repair worktree administrative files",
		args: [a.string().name("paths").variadic().optional().describe("Worktree paths to relink")],
		handler: async (args, ctx) => {
			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;
			return handleRepair(gitCtxOrError, ctx, (args.paths as string[]) ?? []);
		},
	});
}

// ── add ─────────────────────────────────────────────────────────────

async function handleAdd(
	gitCtx: GitContext,
	ctx: CommandContext,
	args: Record<string, unknown>,
): Promise<CommandResult> {
	const worktreePath = resolve(ctx.cwd, args.path as string);
	const force = ((args.force as number) ?? 0) > 0;

	const commitish = (args.commitish as string | undefined) ?? "HEAD";
	const baseCommit = await resolveRevision(gitCtx, commitish);

	const branchName = (args.newBranch ?? args.forceNewBranch) as string | undefined;
	const resetBranch = args.forceNewBranch !== undefined;

	const plan = await planHead(gitCtx, {
		worktreePath,
		commitish,
		baseCommit,
		detach: !!args.detach,
		branchName,
		resetBranch,
		explicitCommitish: args.commitish !== undefined,
	});
	if (isCommandError(plan)) return plan;

	// git emits the progress line before the steps that can fail, so a refused
	// add still shows it. Errors after this point are prefixed accordingly.
	const quiet = !!args.quiet;
	const orphanPrefix = plan.orphan ? "No possible source branch, inferring '--orphan'\n" : "";
	const preparing = quiet ? "" : `${orphanPrefix}Preparing worktree (${plan.summary})\n`;
	const fail = (msg: string, exitCode = 128): CommandResult => ({
		stdout: "",
		stderr: `${preparing}fatal: ${msg}\n`,
		exitCode,
	});

	// `git worktree add -b <name>` delegates branch creation; when the branch
	// already exists that sub-step dies and worktree add exits 255.
	if (plan.requireBranchAbsent && (await resolveRef(gitCtx, plan.requireBranchAbsent.ref))) {
		return fail(`a branch named '${plan.requireBranchAbsent.name}' already exists`, 255);
	}

	// The DWIM/`-b` branch is created before the destination is validated, so it
	// persists even when the add later aborts on an existing path (matches git).
	if (plan.createBranchRef && plan.checkoutCommit) {
		await updateRef(gitCtx, plan.createBranchRef, plan.checkoutCommit);
		await logRef(
			gitCtx,
			ctx.env,
			plan.createBranchRef,
			ZERO_HASH,
			plan.checkoutCommit,
			`branch: Created from ${commitish}`,
		);
		if (plan.trackingRef) {
			await maybeSetupTracking(gitCtx, basename(plan.createBranchRef), plan.trackingRef);
		}
	}

	// git validates the destination path before the cross-worktree claim check.
	if (!force && (await pathExistsNonEmpty(gitCtx, worktreePath))) {
		return fail(`'${args.path}' already exists`);
	}

	if (!force && plan.claimCheck) {
		const usedAt = await branchCheckedOutAt(gitCtx, plan.claimCheck.ref);
		if (usedAt) return fail(`'${plan.claimCheck.name}' is already used by worktree at '${usedAt}'`);
	}

	const id = await deriveWorktreeId(gitCtx, worktreePath);
	const adminDir = await writeWorktreeAdmin(gitCtx, id, worktreePath, plan.head);
	await writeGitFile(gitCtx, worktreePath, adminDir);

	const noCheckout = !!args.noCheckout;
	if (!noCheckout && plan.checkoutCommit) {
		await materializeWorktree(gitCtx, adminDir, worktreePath, plan.checkoutCommit);
	}

	await seedWorktreeReflog(gitCtx, ctx, adminDir, worktreePath, plan, noCheckout);

	if (args.lock) {
		await lockWorktree(gitCtx, adminDir, args.reason as string | undefined);
	}

	if (quiet) return { stdout: "", stderr: "", exitCode: 0 };

	let stdout = "";
	if (plan.checkoutCommit) {
		const subject = (await readCommit(gitCtx, plan.checkoutCommit)).message.split("\n", 1)[0];
		stdout = `HEAD is now at ${plan.checkoutCommit.slice(0, 7)} ${subject}\n`;
	}
	return { stdout, stderr: preparing, exitCode: 0 };
}

interface HeadPlan {
	head: WorktreeHead;
	/** Branch ref to create at baseCommit, if any. */
	createBranchRef: string | null;
	/** Commit to materialise into the working tree. */
	checkoutCommit: string | null;
	summary: string;
	/** A new branch on an unborn HEAD — nothing to check out, ref stays unborn. */
	orphan?: boolean;
	/** Remote-tracking ref to set as upstream for a DWIM'd local branch. */
	trackingRef?: string;
	/** Plain `-b <name>`: error (exit 255) if this branch already exists. */
	requireBranchAbsent?: { name: string; ref: string };
	/** Existing branch being checked out: refuse if claimed by another worktree. */
	claimCheck?: { name: string; ref: string };
}

/** Plan for a new branch on an unborn HEAD: no checkout, no ref yet. */
function orphanPlan(ref: string, name: string): HeadPlan {
	return {
		head: { type: "branch", ref },
		createBranchRef: null,
		checkoutCommit: null,
		summary: `new branch '${name}'`,
		orphan: true,
	};
}

async function planHead(
	gitCtx: GitContext,
	opts: {
		worktreePath: string;
		commitish: string;
		baseCommit: string | null;
		detach: boolean;
		branchName: string | undefined;
		resetBranch: boolean;
		explicitCommitish: boolean;
	},
): Promise<HeadPlan | CommandResult> {
	const { baseCommit, detach, branchName, resetBranch, explicitCommitish } = opts;

	if (detach) {
		if (!baseCommit) return fatal(`invalid reference: ${opts.commitish}`);
		return {
			head: { type: "detached", hash: baseCommit },
			createBranchRef: null,
			checkoutCommit: baseCommit,
			summary: `detached HEAD ${baseCommit.slice(0, 7)}`,
		};
	}

	if (branchName) {
		const ref = `refs/heads/${branchName}`;
		if (!baseCommit) {
			if (explicitCommitish) return fatal(`invalid reference: ${opts.commitish}`);
			return orphanPlan(ref, branchName);
		}
		return {
			head: { type: "branch", ref },
			createBranchRef: ref,
			checkoutCommit: baseCommit,
			summary: `new branch '${branchName}'`,
			// Plain -b must not clobber an existing branch; -B (reset) may.
			requireBranchAbsent: resetBranch ? undefined : { name: branchName, ref },
			claimCheck: { name: branchName, ref },
		};
	}

	// A bare name that is an existing branch is checked out; otherwise it
	// detaches. With no commit-ish, DWIM a new branch named after the path.
	const dwimName = explicitCommitish ? opts.commitish : basename(opts.worktreePath);
	const ref = `refs/heads/${dwimName}`;
	const branchTip = await resolveRef(gitCtx, ref);

	if (branchTip) {
		return {
			head: { type: "branch", ref },
			createBranchRef: null,
			checkoutCommit: branchTip,
			summary: `checking out '${dwimName}'`,
			claimCheck: { name: dwimName, ref },
		};
	}

	if (explicitCommitish) {
		// A bare name matching a unique remote branch DWIMs a tracking branch.
		const guessed = await guessRemoteBranch(gitCtx, dwimName);
		if (guessed) {
			const tip = await resolveRevision(gitCtx, guessed.startPoint);
			if (tip) {
				return {
					head: { type: "branch", ref },
					createBranchRef: ref,
					checkoutCommit: tip,
					summary: `new branch '${dwimName}'`,
					trackingRef: guessed.trackingRef,
				};
			}
		}
		if (!baseCommit) return fatal(`invalid reference: ${opts.commitish}`);
		return {
			head: { type: "detached", hash: baseCommit },
			createBranchRef: null,
			checkoutCommit: baseCommit,
			summary: `detached HEAD ${baseCommit.slice(0, 7)}`,
		};
	}

	if (!baseCommit) return orphanPlan(ref, dwimName);
	return {
		head: { type: "branch", ref },
		createBranchRef: ref,
		checkoutCommit: baseCommit,
		summary: `new branch '${dwimName}'`,
	};
}

async function materializeWorktree(
	gitCtx: GitContext,
	adminDir: string,
	worktreePath: string,
	commitHash: string,
): Promise<void> {
	const wtCtx: GitContext = {
		...gitCtx,
		gitDir: adminDir,
		workTree: worktreePath,
		refStore: new FileSystemRefStore(gitCtx.fs, adminDir, gitCtx.commonDir),
	};

	const commit = await readCommit(wtCtx, commitHash);
	const entries = await flattenTree(wtCtx, commit.tree);
	for (const entry of entries) {
		await checkoutEntry(wtCtx, entry);
	}
	await writeIndex(
		wtCtx,
		buildIndex(
			entries.map((e) => ({
				path: e.path,
				mode: parseInt(e.mode, 8),
				hash: e.hash,
				stage: 0,
				stat: defaultStat(),
			})),
		),
	);
}

/**
 * Seed the new worktree's HEAD reflog the way real git does on `worktree add`.
 *
 * git writes the new checkout's `logs/HEAD` before any in-worktree command runs:
 *   - an initial entry creating HEAD (`0…0 → <commit>`) with an empty message,
 *     written whenever HEAD lands on a real commit (skipped for an orphan/unborn
 *     HEAD), and
 *   - a `reset: moving to HEAD` entry from populating the checkout, written only
 *     when HEAD is attached to a branch *and* the tree is actually checked out
 *     (a detached add or `--no-checkout` gets just the creation entry).
 *
 * Reflogs are per-worktree, so this must target the new worktree's admin dir,
 * not the context the command was invoked from.
 */
async function seedWorktreeReflog(
	gitCtx: GitContext,
	ctx: CommandContext,
	adminDir: string,
	worktreePath: string,
	plan: HeadPlan,
	noCheckout: boolean,
): Promise<void> {
	if (!plan.checkoutCommit) return;

	const wtCtx: GitContext = {
		...gitCtx,
		gitDir: adminDir,
		workTree: worktreePath,
		refStore: new FileSystemRefStore(gitCtx.fs, adminDir, gitCtx.commonDir),
	};

	await logRef(wtCtx, ctx.env, "HEAD", ZERO_HASH, plan.checkoutCommit, "");
	if (!noCheckout && plan.head.type === "branch") {
		await logRef(
			wtCtx,
			ctx.env,
			"HEAD",
			plan.checkoutCommit,
			plan.checkoutCommit,
			"reset: moving to HEAD",
		);
	}
}

async function pathExistsNonEmpty(gitCtx: GitContext, path: string): Promise<boolean> {
	if (!(await gitCtx.fs.exists(path))) return false;
	const stat = await gitCtx.fs.stat(path);
	if (!stat.isDirectory) return true;
	return (await gitCtx.fs.readdir(path)).length > 0;
}

// ── list ────────────────────────────────────────────────────────────

async function handleList(gitCtx: GitContext, porcelain: boolean): Promise<CommandResult> {
	const worktrees = await listWorktrees(gitCtx);

	if (porcelain) {
		const blocks = worktrees.map((wt) => {
			const lines = [`worktree ${wt.path}`];
			if (wt.bare) {
				lines.push("bare");
			} else {
				if (wt.head) lines.push(`HEAD ${wt.head}`);
				lines.push(wt.branch ? `branch ${wt.branch}` : "detached");
			}
			if (wt.locked) lines.push(wt.lockReason ? `locked ${wt.lockReason}` : "locked");
			if (wt.prunable) lines.push(`prunable ${wt.prunable}`);
			return `${lines.join("\n")}\n`;
		});
		// Every block, including the last, is terminated by a blank line.
		return { stdout: blocks.map((b) => `${b}\n`).join(""), stderr: "", exitCode: 0 };
	}

	const pad = Math.max(0, ...worktrees.map((wt) => wt.path.length));
	const lines = worktrees.map((wt) => {
		if (wt.bare) return `${wt.path.padEnd(pad)} (bare)`;
		const sha = wt.head ? wt.head.slice(0, 7) : "0000000";
		const label = wt.branch ? `[${wt.branch.replace("refs/heads/", "")}]` : "(detached HEAD)";
		const annotation = wt.locked ? " locked" : wt.prunable ? " prunable" : "";
		return `${wt.path.padEnd(pad)} ${sha} ${label}${annotation}`;
	});
	return { stdout: `${lines.join("\n")}\n`, stderr: "", exitCode: 0 };
}

// ── remove / prune / lock / unlock ──────────────────────────────────

async function resolveWorktreeArg(
	gitCtx: GitContext,
	ctx: CommandContext,
	arg: string,
): Promise<WorktreeInfo | null> {
	const target = resolve(ctx.cwd, arg);
	const worktrees = await listWorktrees(gitCtx);
	return (
		worktrees.find(
			(wt) => wt.path === target || wt.path === arg || basename(wt.adminDir) === arg,
		) ?? null
	);
}

async function handleRemove(
	gitCtx: GitContext,
	ctx: CommandContext,
	arg: string,
	force: number,
): Promise<CommandResult> {
	const wt = await resolveWorktreeArg(gitCtx, ctx, arg);
	if (!wt) return fatal(`'${arg}' is not a working tree`);
	if (wt.isMain) return fatal(`'${arg}' is a main working tree`);
	if (wt.locked && force < 2) {
		const reason = await readLockReason(gitCtx, wt.adminDir);
		const firstLine = reason
			? `cannot remove a locked working tree, lock reason: ${reason}`
			: "cannot remove a locked working tree;";
		return fatal(`${firstLine}\nuse 'remove -f -f' to override or unlock first`);
	}
	if (force < 1 && (await worktreeIsDirty(gitCtx, wt))) {
		return fatal(`'${arg}' contains modified or untracked files, use --force to delete it`);
	}

	await gitCtx.fs.rm(wt.path, { recursive: true, force: true });
	await gitCtx.fs.rm(wt.adminDir, { recursive: true, force: true });
	return { stdout: "", stderr: "", exitCode: 0 };
}

/** Whether a worktree has staged or unstaged changes (or untracked files). */
async function worktreeIsDirty(gitCtx: GitContext, wt: WorktreeInfo): Promise<boolean> {
	const wtCtx: GitContext = {
		...gitCtx,
		gitDir: wt.adminDir,
		workTree: wt.path,
		refStore: new FileSystemRefStore(gitCtx.fs, wt.adminDir, gitCtx.commonDir),
	};

	const index = await readIndex(wtCtx);
	if ((await diffIndexToWorkTree(wtCtx, index)).length > 0) return true;

	const headHash = await resolveHead(wtCtx);
	if (!headHash) return index.entries.length > 0;

	const headMap = await flattenTreeToMap(wtCtx, (await readCommit(wtCtx, headHash)).tree);
	return hasStagedChanges(index, headMap);
}

async function handleMove(
	gitCtx: GitContext,
	ctx: CommandContext,
	arg: string,
	newPathArg: string,
	force: number,
): Promise<CommandResult> {
	const wt = await resolveWorktreeArg(gitCtx, ctx, arg);
	if (!wt) return fatal(`'${arg}' is not a working tree`);
	if (wt.isMain) return fatal(`'${arg}' is a main working tree`);
	if (wt.locked && force < 2) {
		const reason = await readLockReason(gitCtx, wt.adminDir);
		const firstLine = reason
			? `cannot move a locked working tree, lock reason: ${reason}`
			: "cannot move a locked working tree;";
		return fatal(`${firstLine}\nuse 'move -f -f' to override or unlock first`);
	}

	// Resolve the destination like mv(1): an existing directory means "move
	// into it" (append the source basename); anything else is used verbatim.
	const destAbs = resolve(ctx.cwd, newPathArg);
	const intoDir = (await gitCtx.fs.exists(destAbs)) && (await gitCtx.fs.stat(destAbs)).isDirectory;
	const base = basename(wt.path);
	const finalAbs = intoDir ? join(destAbs, base) : destAbs;
	const finalDisplay = intoDir ? `${newPathArg.replace(/\/+$/, "")}/${base}` : newPathArg;

	if (await gitCtx.fs.exists(finalAbs)) {
		return fatal(`'${finalDisplay}' already exists`);
	}

	// Moving a worktree into itself (`move wt wt`) is rejected by git's rename.
	if (finalAbs === wt.path || finalAbs.startsWith(`${wt.path}/`)) {
		return fatal(`failed to move '${wt.path}' to '${newPathArg}': Invalid argument`);
	}

	// git relies on rename(2) reporting ENOENT for a missing parent, but our fs
	// backends auto-create the parent — so check it ourselves to surface git's
	// exact message instead of silently creating the directory.
	if (!(await gitCtx.fs.exists(dirname(finalAbs)))) {
		return fatal(`failed to move '${wt.path}' to '${newPathArg}': No such file or directory`);
	}

	await movePath(gitCtx.fs, wt.path, finalAbs);

	// The worktree's own `.git` gitlink moved with the directory and still
	// references the (unchanged) admin id; only the admin `gitdir` back-pointer
	// needs rewriting to the new checkout location.
	await gitCtx.fs.writeFile(join(wt.adminDir, "gitdir"), `${join(finalAbs, ".git")}\n`);
	return { stdout: "", stderr: "", exitCode: 0 };
}

async function handleRepair(
	gitCtx: GitContext,
	ctx: CommandContext,
	paths: string[],
): Promise<CommandResult> {
	const fs = gitCtx.fs;
	const lines: string[] = [];
	let exitCode = 0;

	// Direction 2 (per explicit path arg): read each named worktree's `.git`
	// gitlink to (re)discover its admin dir and fix both that admin's stale
	// `gitdir` back-pointer and the gitlink itself. This runs before the admin
	// scan below so that a garbage gitlink is still reported broken even though
	// the scan repairs it.
	for (const p of paths) {
		const abs = resolve(ctx.cwd, p);

		// The main worktree's `.git` is a directory, not a gitlink, so there is
		// nothing to repair — git skips it silently rather than erroring.
		if (stripDotGit(abs) === stripDotGit(gitCtx.commonDir)) continue;

		if (!(await fs.exists(abs))) {
			lines.push(`error: not a valid path: ${p}\n`);
			exitCode = 1;
			continue;
		}

		const gitlink = join(abs, ".git");
		const recorded = await readGitlinkTarget(fs, gitlink);

		// When both the repo and the worktree have moved, the gitlink points at
		// a now-vanished admin dir. Recover it by matching the id the gitlink
		// records against `<commonDir>/worktrees/<id>` in *this* repository.
		const inferred = await inferBacklink(fs, gitCtx.commonDir, gitlink);

		let backlink: string;
		if (recorded !== null && (await isWorktreeAdminDir(fs, recorded))) {
			backlink = recorded;
		} else if (recorded !== null && inferred) {
			backlink = inferred;
		} else if (recorded !== null) {
			lines.push(
				`error: unable to locate repository; .git file does not reference a repository: ${gitlink}\n`,
			);
			exitCode = 1;
			continue;
		} else {
			lines.push(`error: unable to locate repository; .git file broken: ${gitlink}\n`);
			exitCode = 1;
			continue;
		}

		// A non-null inferred dir that differs means the worktree was *copied*
		// (its gitlink still names the source repo's admin dir); point it here.
		if (inferred && backlink !== inferred) backlink = inferred;

		const gitdirFile = join(backlink, "gitdir");
		const current = (await fs.exists(gitdirFile)) ? (await fs.readFile(gitdirFile)).trim() : null;
		if (current !== gitlink) {
			await fs.writeFile(gitdirFile, `${gitlink}\n`);
			await writeGitFile(gitCtx, abs, backlink);
			lines.push(`repair: gitdir incorrect: ${gitdirFile}\n`);
		}
	}

	// Direction 1 (admin scan, always): rewrite any worktree `.git` gitlink that
	// no longer points at its admin dir — e.g. after the main repo was moved,
	// every gitlink still names the old admin location.
	for (const { privateDir } of await enumerateWorktrees(gitCtx)) {
		const gitdirFile = join(privateDir, "gitdir");
		if (!(await fs.exists(gitdirFile))) continue;
		const recordedGitlink = (await fs.readFile(gitdirFile)).trim();
		if (!recordedGitlink) continue;
		const worktreePath = dirname(recordedGitlink);
		// Only the worktree's own location can be repaired here; a worktree that
		// itself moved away is undiscoverable without an explicit path arg.
		if (!(await fs.exists(worktreePath))) continue;
		const want = `gitdir: ${privateDir}`;
		const have = (await fs.exists(recordedGitlink))
			? (await fs.readFile(recordedGitlink)).trim()
			: null;
		if (have !== want) {
			await writeGitFile(gitCtx, worktreePath, privateDir);
			lines.push(`repair: .git file broken: ${worktreePath}\n`);
		}
	}

	return { stdout: "", stderr: lines.join(""), exitCode };
}

/** Strip a trailing `/.git` so a worktree dir and its gitlink compare equal. */
function stripDotGit(path: string): string {
	return path.endsWith("/.git") ? path.slice(0, -"/.git".length) : path;
}

/**
 * Infer a worktree's admin dir when its gitlink points at a vanished location
 * (both the repo and the worktree were moved). The gitlink still records the
 * worktree id as its last path component, so match that against
 * `<commonDir>/worktrees/<id>` in this repository. Returns null when the id
 * names no such admin dir.
 */
async function inferBacklink(
	fs: FileSystem,
	commonDir: string,
	gitlinkPath: string,
): Promise<string | null> {
	const pointer = await readGitlinkTarget(fs, gitlinkPath);
	if (!pointer) return null;
	const id = basename(pointer);
	if (!id) return null;
	const inferred = join(commonDir, "worktrees", id);
	if (!(await fs.exists(inferred))) return null;
	return (await fs.stat(inferred)).isDirectory ? inferred : null;
}

/** The admin dir a worktree's `.git` gitlink points at, or null if unreadable. */
async function readGitlinkTarget(fs: FileSystem, gitlinkPath: string): Promise<string | null> {
	if (!(await fs.exists(gitlinkPath))) return null;
	let content: string;
	try {
		content = await fs.readFile(gitlinkPath);
	} catch {
		return null;
	}
	const trimmed = content.trim();
	if (!trimmed.startsWith("gitdir:")) return null;
	return trimmed.slice("gitdir:".length).trim() || null;
}

/** Whether `dir` looks like a linked-worktree admin dir (has a `gitdir` file). */
async function isWorktreeAdminDir(fs: FileSystem, dir: string): Promise<boolean> {
	if (!(await fs.exists(dir))) return false;
	if (!(await fs.stat(dir)).isDirectory) return false;
	return fs.exists(join(dir, "gitdir"));
}

async function handlePrune(
	gitCtx: GitContext,
	dryRun: boolean,
	verbose: boolean,
): Promise<CommandResult> {
	const out: string[] = [];
	for (const wt of await listWorktrees(gitCtx)) {
		if (wt.isMain || wt.locked || !wt.prunable) continue;

		if (verbose || dryRun) out.push(`Removing worktrees/${basename(wt.adminDir)}: ${wt.prunable}`);
		if (!dryRun) await gitCtx.fs.rm(wt.adminDir, { recursive: true, force: true });
	}
	return { stdout: out.length ? `${out.join("\n")}\n` : "", stderr: "", exitCode: 0 };
}

async function handleLock(
	gitCtx: GitContext,
	ctx: CommandContext,
	arg: string,
	reason: string | undefined,
): Promise<CommandResult> {
	const wt = await resolveWorktreeArg(gitCtx, ctx, arg);
	if (!wt) return fatal(`'${arg}' is not a working tree`);
	if (wt.isMain) return fatal("The main working tree cannot be locked or unlocked");
	if (await isWorktreeLocked(gitCtx, wt.adminDir)) {
		return fatal(`'${arg}' is already locked`);
	}
	await lockWorktree(gitCtx, wt.adminDir, reason);
	return { stdout: "", stderr: "", exitCode: 0 };
}

async function handleUnlock(
	gitCtx: GitContext,
	ctx: CommandContext,
	arg: string,
): Promise<CommandResult> {
	const wt = await resolveWorktreeArg(gitCtx, ctx, arg);
	if (!wt) return fatal(`'${arg}' is not a working tree`);
	if (wt.isMain) return fatal("The main working tree cannot be locked or unlocked");
	if (!(await isWorktreeLocked(gitCtx, wt.adminDir))) {
		return fatal(`'${arg}' is not locked`);
	}
	await unlockWorktree(gitCtx, wt.adminDir);
	return { stdout: "", stderr: "", exitCode: 0 };
}
