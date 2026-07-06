import { inConflict, pickOtherBranch } from "../pickers";
import type { Action } from "../types";

// ── git am oracle coverage ───────────────────────────────────────────
//
// Like `apply`, `am` has no natural patch source in a random walk, so each
// action *composes* `format-patch` with `am`. Composing keeps the patch text
// off any compared stdout — only the resulting tree / index / refs / HEAD /
// operation-state are state-compared against real git — so a cosmetic
// mbox-formatting difference can't fail a step; a genuine parse/apply/commit
// bug can. (`format-patch`'s own stdout is covered by the diagnostic actions.)
//
// Two things set `am` apart from `apply`:
//
//   1. `am` creates commits. Author identity/date come from the patch, but the
//      committer date is wall-clock unless pinned, so `am` is wired into the
//      commit-command detector (oracle/fileops.ts isCommitCommand + the mirror
//      in random/harness.ts) that stamps the deterministic incrementing
//      GIT_COMMITTER_DATE. `apply` needs none of this.
//   2. `am` is resumable (owns `.git/rebase-apply/`, distinguished from a
//      `rebase --apply` by the `applying` marker). A stopped `am` surfaces as
//      QueryState.inAmConflict, which gates the resume-verb actions and — via
//      pickers.inConflict — keeps ordinary actions suppressed mid-session.
//
// `amCrossBranch` pipes `format-patch --stdout … | git am`, so the mbox never
// touches the filesystem. `amRebuildSuffix` can't pipe (a checkout sits between
// the two commands), so it stages the mbox at a *sibling* path (`../am-….mbox`)
// and feeds it back via a stdin redirect. Sibling paths sit outside the repo
// root the worktree hash walks, so the mbox bytes (which differ between real
// git and just-git) stay out of the compared state on both sides.

/** A per-invocation mbox path outside the worktree (see header note). */
function siblingMbox(suffix: string): string {
	return `../am-${suffix}.mbox`;
}

/**
 * Happy path, guaranteed clean: format-patch the current branch's top N
 * commits, detach onto their base, and re-apply. It's the same tree lineage,
 * so the patches always apply — reliably exercising the mailbox split → apply
 * → commit-write → advance loop (including the multi-patch series path). Both
 * real git and just-git reconstruct the same commits from their own mbox, so
 * refs/tree/index/HEAD all match.
 */
const amRebuildSuffix: Action = {
	name: "amRebuildSuffix",
	category: "am",
	canRun: (state) => state.hasCommits,
	precondition: (state) => !inConflict(state),
	weight: () => 2,
	async execute(harness, rng) {
		// Need at least two commits so HEAD~N (the base to detach onto) resolves.
		// `log --format=%H` (not `rev-list`, which just-git doesn't implement) is
		// deterministic, so this probe matches real git; `-n 4` bounds it since we
		// never rebuild more than the top 3 commits.
		const logResult = await harness.git("log --format=%H -n 4");
		const depth = logResult.stdout.trim().split("\n").filter(Boolean).length;
		if (depth < 2) {
			return { description: "amRebuildSuffix: history too shallow", result: null };
		}
		const n = rng.int(1, Math.min(depth - 1, 3));
		const mbox = siblingMbox(rng.alphanumeric(8));
		await harness.git(`format-patch --stdout -${n} > ${mbox}`);
		await harness.git(`checkout HEAD~${n}`);
		const result = await harness.git(`am < ${mbox}`);
		return {
			description: `git format-patch --stdout -${n} > ${mbox}; git checkout HEAD~${n}; git am < ${mbox}`,
			result,
		};
	},
};

/**
 * Apply another branch's unique commits onto the current HEAD — a natural `am`
 * use (a patch series from elsewhere). The primary generator of `am` *conflict*
 * stops (default mode) and *3-way merges* (`-3`), which in turn feed the resume
 * actions; a clean apply just creates the commits. Piped so the mbox never
 * hits the filesystem, mirroring the apply actions' `git diff | git apply`.
 */
const amCrossBranch: Action = {
	name: "amCrossBranch",
	category: "am",
	canRun: (state) => state.hasCommits && state.branches.length >= 2,
	precondition: (state) => !inConflict(state),
	weight: () => 2,
	async execute(harness, rng, state, fuzz?) {
		const other = pickOtherBranch(rng, state, { fuzzRate: fuzz?.branchRate });
		if (other === null) {
			return { description: "amCrossBranch: no other branch", result: null };
		}
		// Commits reachable from <other> but not the current HEAD. Probe first so
		// an empty range (nothing to apply) is skipped rather than fed to `am` as
		// empty input, where the no-patch message could differ.
		const range = `HEAD..${other}`;
		const probe = await harness.git(`format-patch --stdout ${range}`);
		if (probe.stdout.trim() === "") {
			return { description: `amCrossBranch: ${range} is empty`, result: null };
		}
		const threeway = rng.bool(0.3) ? " -3" : "";
		const result = await harness.git(`format-patch --stdout ${range} | git am${threeway}`);
		return { description: `git format-patch --stdout ${range} | git am${threeway}`, result };
	},
};

/** Abort a stopped `am`, restoring the pre-`am` HEAD (orig-head). */
const amAbort: Action = {
	name: "amAbort",
	category: "am",
	canRun: () => true,
	precondition: (state) => state.inAmConflict,
	weight: () => 8,
	async execute(harness) {
		const result = await harness.git("am --abort");
		return { description: "git am --abort", result };
	},
};

/** Quit a stopped `am`: clear the session but leave HEAD where it stopped. */
const amQuit: Action = {
	name: "amQuit",
	category: "am",
	canRun: () => true,
	precondition: (state) => state.inAmConflict,
	weight: () => 2,
	async execute(harness) {
		const result = await harness.git("am --quit");
		return { description: "git am --quit", result };
	},
};

/** Skip the current patch and continue the series (may finish or stop again). */
const amSkip: Action = {
	name: "amSkip",
	category: "am",
	canRun: () => true,
	precondition: (state) => state.inAmConflict,
	weight: () => 4,
	async execute(harness) {
		const result = await harness.git("am --skip");
		return { description: "git am --skip", result };
	},
};

/**
 * Resolve the stopped patch's files and continue (mirrors rebaseContinue):
 * deterministically rewrite every worktree file, stage them, then
 * `am --continue`, which commits the resolved tree under the stored
 * author/message and advances the series.
 */
const amContinue: Action = {
	name: "amContinue",
	category: "am",
	canRun: (state) => state.inAmConflict && state.files.length > 0,
	precondition: () => true,
	weight: () => 8,
	async execute(harness, rng) {
		const seed = rng.int(0, 2 ** 31 - 1);
		await harness.resolveFiles(seed);
		await harness.git("add .");
		const result = await harness.git("am --continue");
		return {
			description: `amContinue: resolve files (seed=${seed}), git am --continue`,
			result,
		};
	},
};

export const AM_ACTIONS: readonly Action[] = [
	amRebuildSuffix,
	amCrossBranch,
	amAbort,
	amQuit,
	amSkip,
	amContinue,
];
