import { type CommandResult, err, fatal } from "./command-errors.ts";
import { configBool, readConfigView } from "./config.ts";
import { readIndex, writeIndex } from "./index.ts";
import { readCommit } from "./object-db.ts";
import { relative } from "./path.ts";
import { advanceBranchRef, readHead, resolveHead, resolveRef } from "./refs.ts";
import { logRef } from "./reflog.ts";
import { type Signer, asSignatureFormat } from "./signing.ts";
import { flattenTreeToMap } from "./tree-ops.ts";
import type { ConfigView, GitContext, GitRepo, Index, ObjectId } from "./types.ts";
import { applyWorktreeOps, mergeAbort } from "./worktree/unpack-trees.ts";
import { diffIndexToWorkTree } from "./worktree/worktree.ts";

/**
 * Check whether the index has staged changes relative to a HEAD tree.
 * Compares stage-0 index entries against the tree map for modifications,
 * additions, and deletions.
 */
export function hasStagedChanges(index: Index, headMap: Map<string, { hash: string }>): boolean {
	const stage0 = new Map<string, { hash: string }>();
	for (const e of index.entries) {
		if (e.stage === 0) stage0.set(e.path, e);
	}
	for (const [path, entry] of stage0) {
		const headEntry = headMap.get(path);
		if (!headEntry || headEntry.hash !== entry.hash) return true;
	}
	for (const [path] of headMap) {
		if (!stage0.has(path)) return true;
	}
	return false;
}

interface SequencerDirtyState {
	hasStaged: boolean;
	hasUnstaged: boolean;
}

export async function getSequencerDirtyState(
	gitCtx: GitContext,
	headHash: ObjectId,
	index: Index,
): Promise<SequencerDirtyState | null> {
	if (!gitCtx.workTree) return null;

	const headCommit = await readCommit(gitCtx, headHash);
	const headMap = await flattenTreeToMap(gitCtx, headCommit.tree);
	const hasStaged = hasStagedChanges(index, headMap);
	const wtDiffs = await diffIndexToWorkTree(gitCtx, index);
	const hasUnstaged = wtDiffs.some((d) => d.status === "modified" || d.status === "deleted");

	if (!hasStaged && !hasUnstaged) return null;
	return { hasStaged, hasUnstaged };
}

export function sequencerDirtyWorktreeError(
	operation: "rebase" | "pull with rebase",
	state: SequencerDirtyState,
	exitCode = 1,
): CommandResult {
	const lines: string[] = [];
	if (state.hasUnstaged) {
		lines.push(`error: cannot ${operation}: You have unstaged changes.`);
	}
	if (state.hasStaged) {
		if (state.hasUnstaged) {
			lines.push("error: additionally, your index contains uncommitted changes.");
		} else {
			lines.push(`error: cannot ${operation}: Your index contains uncommitted changes.`);
		}
	}
	lines.push("error: Please commit or stash them.");
	return err(`${lines.join("\n")}\n`, exitCode);
}

/** Compute the working-directory-relative prefix for pathspec resolution. */
export function getCwdPrefix(gitCtx: GitContext, cwd: string): string {
	return gitCtx.workTree ? relative(gitCtx.workTree, cwd) : "";
}

/**
 * Shared abort logic for merge --abort and cherry-pick --abort.
 */
export async function handleOperationAbort(
	gitCtx: GitContext,
	env: Map<string, string>,
	opts: {
		operationRef: string;
		noOpError: CommandResult;
		operationName: string;
		clearState: (ctx: GitContext) => Promise<void>;
		origHeadAsTargetRev?: boolean;
	},
): Promise<CommandResult> {
	const opHead = await resolveRef(gitCtx, opts.operationRef);
	if (!opHead) return opts.noOpError;

	// A conflicted merge / cherry-pick / revert never advances HEAD, so the
	// abort target is the current HEAD. ORIG_HEAD is a shared pseudo-ref that an
	// earlier, unrelated operation may have left pointing elsewhere, so it can't
	// be trusted here (git resets to the recorded operation start, which for
	// these conflicts is exactly HEAD).
	const targetHead = await resolveHead(gitCtx);
	if (!targetHead) {
		return fatal(`There is no ${opts.operationName} to abort (HEAD missing).`);
	}

	const headBeforeAbort = targetHead;
	const targetCommit = await readCommit(gitCtx, targetHead);
	const currentIndex = await readIndex(gitCtx);

	const abortResult = await mergeAbort(
		gitCtx,
		targetCommit.tree,
		currentIndex,
		opts.origHeadAsTargetRev ? targetHead : undefined,
	);
	if (!abortResult.success) {
		return abortResult.errorOutput as CommandResult;
	}

	await advanceBranchRef(gitCtx, targetHead);
	await writeIndex(gitCtx, { version: 2, entries: abortResult.newEntries });
	await applyWorktreeOps(gitCtx, abortResult.worktreeOps);

	const head = await readHead(gitCtx);
	const isOnBranch = head?.type === "symbolic";
	if (isOnBranch) {
		const resetTarget = opts.origHeadAsTargetRev ? targetHead : "HEAD";
		await logRef(
			gitCtx,
			env,
			"HEAD",
			headBeforeAbort,
			targetHead,
			`reset: moving to ${resetTarget}`,
		);
	}

	await opts.clearState(gitCtx);

	return { stdout: "", stderr: "", exitCode: 0 };
}

/**
 * Resolve whether a write command should sign, and with what.
 *
 * Layers CLI flag over config over default (mirroring how `merge.ff` /
 * `pull.rebase` resolve): `cliSign ?? configBool(<configKey>) ?? false`.
 * When signing is required, resolves the operator-injected signer
 * (`gitCtx.capabilities.signing.signer`); if none is configured, returns a {@link CommandResult}
 * error (`gpg failed to sign the data`) rather than silently emitting an
 * unsigned object — matching git, and keeping a locked `commit.gpgsign=true`
 * sandbox honest.
 *
 * When signing is on, the key selection git would use is resolved (explicit
 * `keyId` — e.g. `tag -u <keyid>` — falling back to `user.signingkey`) along
 * with `gpg.format`, and both are bound onto the returned signer's `opts` so a
 * multi-key / multi-format backend can act on them. This is policy resolution
 * only: the secret never leaves the backend.
 *
 * Returns:
 * - `undefined` — do not sign.
 * - a {@link Signer} — sign with it (pre-bound with the resolved key/format).
 * - a {@link CommandResult} — error (use {@link isCommandError} to detect).
 */
/**
 * GitRepo-shaped core of {@link resolveCommandSigner}: resolve the signing
 * policy from a materialized {@link ConfigView} (one read instead of three).
 * Pure (no fs).
 */
export function resolveCommandSignerFrom(
	repo: GitRepo,
	config: ConfigView,
	cliSign: boolean | undefined,
	configKey = "commit.gpgsign",
	opts?: { keyId?: string },
): Signer | CommandResult | undefined {
	const shouldSign = cliSign ?? configBool(config.get(configKey)) ?? false;
	if (!shouldSign) return undefined;
	const signer = repo.capabilities?.signing?.signer;
	if (!signer) return err("error: gpg failed to sign the data\n", 128);

	const keyId = opts?.keyId ?? config.get("user.signingkey");
	const format = asSignatureFormat(config.get("gpg.format"));
	if (keyId === undefined && format === undefined) return signer;

	// Bind the resolved selection as defaults so every existing call site
	// (`commit`, `tag`, and the `writeCommitAndAdvance` callers) forwards it
	// without threading extra arguments through each one.
	return (payload, callOpts) => signer(payload, { keyId, format, ...callOpts });
}

export async function resolveCommandSigner(
	gitCtx: GitContext,
	cliSign: boolean | undefined,
	configKey = "commit.gpgsign",
	opts?: { keyId?: string },
): Promise<Signer | CommandResult | undefined> {
	return resolveCommandSignerFrom(gitCtx, await readConfigView(gitCtx), cliSign, configKey, opts);
}

// ── Transfer output formatting (fetch / push / pull) ────────────────
