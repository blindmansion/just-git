import { findBisectionCommit } from "../lib/bisect.ts";
import { readCommit as _readCommit } from "../lib/object-db.ts";
import { resolveRevisionRepo } from "../lib/rev-parse.ts";
import type { GitRepo } from "../lib/types.ts";
import { createTreeAccessor, type TreeAccessor } from "./tree-accessor.ts";

// ── Bisect ──────────────────────────────────────────────────────────

/** Options for {@link bisect}. */
export interface BisectOptions {
	/** Known bad commit (hash, branch, tag, or any rev-parse expression). */
	bad: string;
	/** One or more known good commits. */
	good: string | string[];
	/**
	 * Test a candidate commit. Return:
	 * - `true` — commit is good (bug not present)
	 * - `false` — commit is bad (bug present)
	 * - `"skip"` — commit is untestable
	 *
	 * The `tree` parameter provides lazy access to the worktree contents
	 * at the candidate commit — read individual files, list paths, or
	 * get a full `FileSystem` for build/test scenarios.
	 */
	test: (hash: string, tree: TreeAccessor) => boolean | "skip" | Promise<boolean | "skip">;
	/** Follow only first parent at merge commits (default false). */
	firstParent?: boolean;
	/** Called after each step with progress info. */
	onStep?: (info: BisectStepInfo) => void;
}

/** Progress info passed to {@link BisectOptions.onStep}. */
export interface BisectStepInfo {
	hash: string;
	subject: string;
	verdict: "good" | "bad" | "skip";
	remaining: number;
	estimatedSteps: number;
	stepNumber: number;
}

/**
 * Result of {@link bisect}.
 *
 * - `found: true` — the first bad commit was identified.
 * - `found: false, reason: "all-skipped"` — only skipped commits remain;
 *   `candidates` lists them (plus the current bad).
 * - `found: false, reason: "no-testable-commits"` — no commits exist
 *   between the good and bad boundaries.
 */
export type BisectSearchResult =
	| { found: true; hash: string; stepsTaken: number }
	| { found: false; reason: "all-skipped"; candidates: string[] }
	| { found: false; reason: "no-testable-commits" };

async function resolveToHash(repo: GitRepo, rev: string): Promise<string> {
	const resolved = await resolveRevisionRepo(repo, rev);
	if (!resolved) throw new Error(`revision '${rev}' not found`);
	return resolved;
}

/**
 * Binary-search the commit graph to find the first bad commit.
 *
 * Operates purely on the object store — no filesystem, index, working
 * tree, or state files. The caller provides a `test` callback that
 * inspects each candidate commit and returns whether it is good, bad,
 * or should be skipped.
 *
 * Uses the same weighted-midpoint algorithm as `git bisect`: each step
 * picks the commit that maximizes information gain (closest to
 * eliminating half the remaining candidates).
 *
 * ```ts
 * const result = await bisect(repo, {
 *   bad: "main",
 *   good: "v1.0.0",
 *   test: async (hash, tree) => {
 *     const content = await tree.readFile("src/config.ts");
 *     return content !== null && !content.includes("broken_call");
 *   },
 * });
 * if (result.found) {
 *   console.log(`First bad commit: ${result.hash}`);
 * }
 * ```
 */
export async function bisect(repo: GitRepo, options: BisectOptions): Promise<BisectSearchResult> {
	let currentBad = await resolveToHash(repo, options.bad);
	const goodInput = Array.isArray(options.good) ? options.good : [options.good];
	const currentGoods: string[] = [];
	for (const g of goodInput) {
		currentGoods.push(await resolveToHash(repo, g));
	}
	const skipped = new Set<string>();
	const firstParent = options.firstParent ?? false;

	let stepNumber = 0;

	for (;;) {
		const result = await findBisectionCommit(repo, currentBad, currentGoods, skipped, firstParent);

		if (!result) {
			return { found: false, reason: "no-testable-commits" };
		}

		if (result.found) {
			return { found: true, hash: result.hash, stepsTaken: stepNumber };
		}

		if (result.onlySkippedLeft) {
			return {
				found: false,
				reason: "all-skipped",
				candidates: [...skipped, currentBad],
			};
		}

		const commit = await _readCommit(repo, result.hash);
		const accessor = createTreeAccessor(repo, commit.tree);
		const verdict = await options.test(result.hash, accessor);
		stepNumber++;

		let verdictLabel: "good" | "bad" | "skip";
		if (verdict === "skip") {
			verdictLabel = "skip";
			skipped.add(result.hash);
		} else if (verdict === true) {
			verdictLabel = "good";
			currentGoods.push(result.hash);
		} else {
			verdictLabel = "bad";
			currentBad = result.hash;
		}

		options.onStep?.({
			hash: result.hash,
			subject: result.subject,
			verdict: verdictLabel,
			remaining: result.remaining,
			estimatedSteps: result.steps,
			stepNumber,
		});
	}
}
