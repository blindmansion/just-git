// Command-layer orchestration that speaks the CLI contract: helpers that
// assemble a `CommandResult` (stdout/stderr/exitCode) rather than gather data.
// They live above `lib` — the data core stays free of the CLI contract and
// surfaces data / typed failures instead (see `lib/command-utils.ts` for the
// pure data-gathering counterparts like `getSequencerDirtyState`).

import { type CommandResult, err, fatal } from "./command-result.ts";
import type { SequencerDirtyState } from "../../lib/command-utils.ts";
import { readConfigView } from "../../lib/config/view.ts";
import { readIndex, writeIndex } from "../../lib/index.ts";
import { readCommit } from "../../lib/object-db.ts";
import { logRef } from "../../lib/refs/reflog.ts";
import {
	advanceBranchRef,
	readHead,
	resolveHead,
	resolveRef,
	updateRef,
} from "../../lib/refs/refs.ts";
import { type Signer, resolveConfiguredSigner, SigningError } from "../../lib/signing.ts";
import type { ConfigView, GitContext, GitRepo } from "../../lib/types.ts";
import { applyWorktreeOps, mergeAbort } from "../../lib/worktree/unpack-trees.ts";
import { renderMergeAbortError } from "./format/unpack-trees.ts";

/**
 * Render the sequencer "dirty worktree" refusal for `rebase` / `pull --rebase`
 * from the {@link SequencerDirtyState} that `lib` gathered.
 */
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
	// abort target is the current HEAD. ORIG_HEAD is not used to pick the target
	// (an earlier, unrelated operation may have left it pointing elsewhere); git
	// resets to the recorded operation start, which for these conflicts is
	// exactly HEAD.
	const targetHead = await resolveHead(gitCtx);
	if (!targetHead) {
		return fatal(`There is no ${opts.operationName} to abort (HEAD missing).`);
	}

	const headBeforeAbort = targetHead;
	const targetCommit = await readCommit(gitCtx, targetHead);
	const currentIndex = await readIndex(gitCtx);

	const abortResult = await mergeAbort(gitCtx, targetCommit.tree, currentIndex);
	if (!abortResult.success) {
		const revName = opts.origHeadAsTargetRev ? targetHead : "HEAD";
		return {
			stdout: "",
			stderr: renderMergeAbortError(abortResult.errors, revName),
			exitCode: 128,
		};
	}

	await advanceBranchRef(gitCtx, targetHead);
	await writeIndex(gitCtx, { version: 2, entries: abortResult.newEntries });
	await applyWorktreeOps(gitCtx, abortResult.worktreeOps);

	// git's abort rewinds via an internal reset (`reset_merge` / sequencer
	// rollback), which — like any `git reset` — records the pre-abort HEAD in
	// `ORIG_HEAD`. For a conflicted merge / single pick this equals the current
	// HEAD; after partial picks in a multi-commit sequence it is the tip reached
	// so far. A later `am --abort` reads `ORIG_HEAD`, so keeping it current here
	// steers that rewind exactly as git does.
	await updateRef(gitCtx, "ORIG_HEAD", headBeforeAbort);

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
 * Resolve whether a write command should sign, and with what, mapping the
 * data-core signing policy to the CLI contract.
 *
 * Delegates the policy to `lib/signing#resolveConfiguredSigner` (flag over
 * config over default; binds the resolved `keyId`/`gpg.format` onto the signer)
 * and translates its {@link SigningError} — signing required but no signer
 * configured — into a {@link CommandResult} (`gpg failed to sign the data`)
 * rather than silently emitting an unsigned object, matching git.
 *
 * Returns:
 * - `undefined` — do not sign.
 * - a {@link Signer} — sign with it (pre-bound with the resolved key/format).
 * - a {@link CommandResult} — error (use `isCommandError` to detect).
 */
export function resolveCommandSignerFrom(
	repo: GitRepo,
	config: ConfigView,
	cliSign: boolean | undefined,
	configKey = "commit.gpgsign",
	opts?: { keyId?: string },
): Signer | CommandResult | undefined {
	try {
		return resolveConfiguredSigner(repo, config, cliSign, configKey, opts);
	} catch (e) {
		if (e instanceof SigningError) return err("error: gpg failed to sign the data\n", 128);
		throw e;
	}
}

export async function resolveCommandSigner(
	gitCtx: GitContext,
	cliSign: boolean | undefined,
	configKey = "commit.gpgsign",
	opts?: { keyId?: string },
): Promise<Signer | CommandResult | undefined> {
	return resolveCommandSignerFrom(gitCtx, await readConfigView(gitCtx), cliSign, configKey, opts);
}
