import type { GitExtensions } from "../git.ts";
import { bindAttributes } from "../lib/attributes/bound-attributes.ts";
import { renderRebaseOutcome } from "./kit/rebase.ts";
import { handleAbort, handleContinue, handleSkip, performRebase } from "../lib/rebase-engine.ts";
import { isRebaseInProgress, rebaseMergeDir } from "../lib/rebase.ts";
import { readHead } from "../lib/refs/refs.ts";
import type { ObjectId } from "../lib/types.ts";
import { a, type Command, f, o } from "./kit/parse/index.ts";
import { fatal, isCommandError } from "./kit/command-errors.ts";
import { requireGitContext, requireHead, requireCommit } from "./kit/commit-requirements.ts";

export function registerRebaseCommand(parent: Command, ext?: GitExtensions) {
	parent.command("rebase", {
		description: "Reapply commits on top of another base tip",
		args: [a.string().name("upstream").describe("Upstream branch to rebase onto").optional()],
		options: {
			onto: o.string().describe("Starting point at which to create new commits"),
			abort: f().describe("Abort the current rebase operation"),
			continue: f().describe("Continue the rebase after conflict resolution"),
			skip: f().describe("Skip the current patch and continue"),
			"reapply-cherry-picks": f().describe("Do not skip commits that are cherry-pick equivalents"),
			"no-reapply-cherry-picks": f().describe(
				"Skip commits that are cherry-pick equivalents (default)",
			),
		},
		handler: async (args, ctx) => {
			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;
			const gitCtx = gitCtxOrError;

			// ── Resume operations ────────────────────────────────────
			if (args.abort) {
				return renderRebaseOutcome(await handleAbort(gitCtx, ctx.env));
			}
			if (args.continue) {
				return renderRebaseOutcome(
					await handleContinue(gitCtx, ctx.env, (await bindAttributes(gitCtx, "rebase"))?.merge),
				);
			}
			if (args.skip) {
				return renderRebaseOutcome(
					await handleSkip(gitCtx, ctx.env, (await bindAttributes(gitCtx, "rebase"))?.merge),
				);
			}

			// ── Starting a new rebase ────────────────────────────────

			const upstreamArg: string | undefined = args.upstream;
			if (!upstreamArg) {
				return fatal("no upstream configured and no upstream argument given");
			}

			// Block if concurrent operations are in progress. git names the
			// existing rebase-merge dir: a path relative to the worktree root
			// (`.git/rebase-merge`) in the main worktree, but the absolute admin
			// path for a linked worktree, whose state dir lives elsewhere.
			if (await isRebaseInProgress(gitCtx)) {
				const stateDir =
					gitCtx.gitDir === gitCtx.commonDir ? ".git/rebase-merge" : rebaseMergeDir(gitCtx);
				return fatal(
					`It seems that there is already a rebase-merge directory, and\nI wonder if you are in the middle of another rebase.  If that is the\ncase, please try\n\tgit rebase (--continue | --abort | --skip)\nIf that is not the case, please\n\trm -fr "${stateDir}"\nand run me again.  I am stopping in case you still have something\nvaluable there.\n`,
				);
			}

			// Resolve current HEAD
			const origHead = await requireHead(gitCtx);
			if (isCommandError(origHead)) return origHead;

			const head = await readHead(gitCtx);
			const headName = head?.type === "symbolic" ? head.target : "detached HEAD";

			// Resolve upstream (peel tags to commit)
			const upstreamResult = await requireCommit(
				gitCtx,
				upstreamArg,
				`invalid upstream '${upstreamArg}'`,
			);
			if (isCommandError(upstreamResult)) return upstreamResult;
			const upstreamHash = upstreamResult.hash;

			// Resolve onto (defaults to upstream)
			let ontoHash: ObjectId;
			const ontoArg: string | undefined = args.onto;
			if (ontoArg) {
				const ontoResult = await requireCommit(
					gitCtx,
					ontoArg,
					`Does not point to a valid commit: '${ontoArg}'`,
				);
				if (isCommandError(ontoResult)) return ontoResult;
				ontoHash = ontoResult.hash;
			} else {
				ontoHash = upstreamHash;
			}

			const reapplyCherryPicks = !!args["reapply-cherry-picks"];
			const ontoLabel = ontoArg ?? upstreamArg;

			return renderRebaseOutcome(
				await performRebase(
					gitCtx,
					ctx.env,
					origHead,
					headName,
					upstreamHash,
					ontoHash,
					upstreamArg,
					ontoLabel,
					ext,
					reapplyCherryPicks ? { reapplyCherryPicks: true } : undefined,
				),
			);
		},
	});
}
