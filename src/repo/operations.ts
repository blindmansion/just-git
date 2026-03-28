import { findBisectionCommit } from "../lib/bisect.ts";
import type { MergeConflict } from "../lib/merge.ts";
import type { MergeDriver } from "../lib/merge-ort.ts";
import { readCommit as _readCommit, writeObject } from "../lib/object-db.ts";
import { serializeTree } from "../lib/objects/tree.ts";
import type { Commit, GitRepo, Identity } from "../lib/types.ts";
import { mergeTreesFromTreeHashes } from "./merging.ts";
import { revParse } from "./reading.ts";
import { createTreeAccessor, type TreeAccessor } from "./tree-accessor.ts";
import { createCommit, type CommitIdentity } from "./writing.ts";

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
	const resolved = await revParse(repo, rev);
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

// ── Cherry-pick ─────────────────────────────────────────────────────

/** Options for {@link cherryPick}. */
export interface CherryPickOptions {
	/** The commit to cherry-pick (hash, branch, tag, or any rev-parse expression). */
	commit: string;
	/** The commit to apply on top of (hash, branch, tag, or any rev-parse expression). */
	onto: string;
	/** Branch to advance on clean result. No ref update when omitted. Ignored when `noCommit` is true. */
	branch?: string;
	/** Committer identity. Defaults to the original commit's author when omitted, so both author and committer will reflect the original — pass explicitly to record who performed the cherry-pick. */
	committer?: CommitIdentity;
	/** Parent number for merge commits (1-based). Required when cherry-picking a merge. */
	mainline?: number;
	/** Append "(cherry picked from commit ...)" trailer to the message. */
	recordOrigin?: boolean;
	/** Override the commit message. Defaults to the original commit's message. */
	message?: string;
	/** When true, perform the merge but don't create a commit. `hash` will be `null` in the result. */
	noCommit?: boolean;
	/** Custom merge driver for content conflicts. */
	mergeDriver?: MergeDriver;
}

/** Clean result when a commit was created. */
export interface CleanPickCommitted {
	clean: true;
	hash: string;
	treeHash: string;
}

/** Clean result when `noCommit` was set — no commit created. */
export interface CleanPickNoCommit {
	clean: true;
	treeHash: string;
}

/** Conflict result — no commit was created. */
export interface PickConflict {
	clean: false;
	treeHash: string;
	conflicts: MergeConflict[];
	messages: string[];
}

/**
 * Result of {@link cherryPick} or {@link revert}.
 *
 * - `clean: true` with `hash` — commit was created.
 * - `clean: true` without `hash` — `noCommit` was set, merge succeeded
 *   but no commit was created.
 * - `clean: false` — conflicts were found, no commit was created.
 */
export type CherryPickResult = CleanPickCommitted | PickConflict;

/** Result of {@link cherryPick} or {@link revert} when `noCommit` is true. */
export type NoCommitPickResult = CleanPickNoCommit | PickConflict;

/**
 * Cherry-pick a commit onto another commit.
 *
 * Applies the changes introduced by `commit` on top of `onto` using a
 * three-way merge (base = parent of `commit`, ours = `onto`, theirs = `commit`).
 * Operates purely on the object store — no filesystem, index, or working tree.
 *
 * On a clean result, creates a new commit preserving the original author.
 * When `branch` is provided, the branch ref is advanced to the new commit.
 *
 * ```ts
 * const result = await cherryPick(repo, {
 *   commit: "feature~2",
 *   onto: "main",
 *   branch: "main",
 *   committer: { name: "Bot", email: "bot@example.com" },
 * });
 * if (result.clean) {
 *   console.log(`Cherry-picked as ${result.hash}`);
 * } else {
 *   console.log(`Conflicts: ${result.conflicts.length}`);
 * }
 * ```
 */
export async function cherryPick(
	repo: GitRepo,
	options: CherryPickOptions & { noCommit: true },
): Promise<NoCommitPickResult>;
export async function cherryPick(
	repo: GitRepo,
	options: CherryPickOptions,
): Promise<CherryPickResult>;
export async function cherryPick(
	repo: GitRepo,
	options: CherryPickOptions,
): Promise<CherryPickResult | NoCommitPickResult> {
	const theirsHash = await resolveToHash(repo, options.commit);
	const ontoHash = await resolveToHash(repo, options.onto);
	const theirsCommit = await _readCommit(repo, theirsHash);
	const ontoCommit = await _readCommit(repo, ontoHash);

	const baseTree = await resolveBaseTree(repo, theirsCommit, theirsHash, options.mainline);

	let message = options.message ?? theirsCommit.message;
	if (options.recordOrigin) {
		message = appendCherryPickedFrom(message, theirsHash);
	}

	return applyPick(repo, {
		baseTree,
		oursTree: ontoCommit.tree,
		theirsTree: theirsCommit.tree,
		ontoHash,
		author: theirsCommit.author,
		committer: options.committer,
		message,
		noCommit: options.noCommit,
		branch: options.branch,
		mergeDriver: options.mergeDriver,
	});
}

// ── Revert ──────────────────────────────────────────────────────────

/** Options for {@link revert}. */
export interface RevertOptions {
	/** The commit to revert (hash, branch, tag, or any rev-parse expression). */
	commit: string;
	/** The commit to apply the revert on top of (hash, branch, tag, or any rev-parse expression). */
	onto: string;
	/** Branch to advance on clean result. No ref update when omitted. Ignored when `noCommit` is true. */
	branch?: string;
	/** Committer identity. Defaults to the caller's identity. When omitted, uses `author` as both author and committer. */
	committer?: CommitIdentity;
	/** Author identity for the revert commit. When omitted, uses `committer`. At least one of `author` or `committer` must be provided (unless `noCommit` is true). */
	author?: CommitIdentity;
	/** Parent number for merge commits (1-based). Required when reverting a merge. */
	mainline?: number;
	/** Override the commit message. Defaults to the auto-generated "Revert ..." message. */
	message?: string;
	/** When true, perform the merge but don't create a commit. `hash` will be `null` in the result. */
	noCommit?: boolean;
	/** Custom merge driver for content conflicts. */
	mergeDriver?: MergeDriver;
}

/** Result of {@link revert}. Same shape as {@link CherryPickResult}. */
export type RevertResult = CherryPickResult;

/** Result of {@link revert} when `noCommit` is true. */
export type NoCommitRevertResult = NoCommitPickResult;

/**
 * Revert a commit on top of another commit.
 *
 * Applies the inverse of the changes introduced by `commit` on top of
 * `onto` using a three-way merge (base = `commit`, ours = `onto`,
 * theirs = parent of `commit`). Operates purely on the object store.
 *
 * On a clean result, creates a new commit with a "Revert ..." message.
 * When `branch` is provided, the branch ref is advanced.
 *
 * ```ts
 * const result = await revert(repo, {
 *   commit: "abc1234",
 *   onto: "main",
 *   branch: "main",
 *   committer: { name: "Bot", email: "bot@example.com" },
 * });
 * if (result.clean) {
 *   console.log(`Reverted as ${result.hash}`);
 * }
 * ```
 */
export async function revert(
	repo: GitRepo,
	options: RevertOptions & { noCommit: true },
): Promise<NoCommitRevertResult>;
export async function revert(repo: GitRepo, options: RevertOptions): Promise<RevertResult>;
export async function revert(
	repo: GitRepo,
	options: RevertOptions,
): Promise<RevertResult | NoCommitRevertResult> {
	const commitHash = await resolveToHash(repo, options.commit);
	const ontoHash = await resolveToHash(repo, options.onto);
	const targetCommit = await _readCommit(repo, commitHash);
	const ontoCommit = await _readCommit(repo, ontoHash);

	const parentTree = await resolveBaseTree(repo, targetCommit, commitHash, options.mainline);

	const subject = targetCommit.message.split("\n")[0] ?? "";
	const message = options.message ?? `Revert "${subject}"\n\nThis reverts commit ${commitHash}.\n`;

	const author = options.author ?? options.committer;
	if (!author && !options.noCommit) {
		throw new Error("revert requires at least one of `author` or `committer`");
	}

	// For root commit reverts, parentTree is null — use an empty tree
	const theirsTree = parentTree ?? (await writeEmptyTree(repo));

	return applyPick(repo, {
		baseTree: targetCommit.tree,
		oursTree: ontoCommit.tree,
		theirsTree,
		ontoHash,
		author,
		committer: options.committer ?? options.author,
		message,
		noCommit: options.noCommit,
		branch: options.branch,
		mergeDriver: options.mergeDriver,
	});
}

// ── Shared cherry-pick / revert internals ───────────────────────────

/**
 * Resolve the base tree for a cherry-pick or revert. For merge commits,
 * `mainline` selects the parent. For root commits, returns `null`
 * (treated as an empty tree by the merge engine).
 */
async function resolveBaseTree(
	repo: GitRepo,
	commit: Commit,
	commitHash: string,
	mainline: number | undefined,
): Promise<string | null> {
	if (commit.parents.length > 1) {
		if (mainline == null) {
			throw new Error(`commit ${commitHash} is a merge but no mainline option was given`);
		}
		const parentIdx = mainline - 1;
		if (parentIdx < 0 || parentIdx >= commit.parents.length) {
			throw new Error(`commit ${commitHash} does not have parent ${mainline}`);
		}
		const parent = await _readCommit(repo, commit.parents[parentIdx]!);
		return parent.tree;
	}

	if (mainline != null) {
		throw new Error("mainline was specified but commit is not a merge");
	}

	if (commit.parents.length === 0) {
		return null;
	}

	const parent = await _readCommit(repo, commit.parents[0]!);
	return parent.tree;
}

async function writeEmptyTree(repo: GitRepo): Promise<string> {
	return writeObject(repo, "tree", serializeTree({ type: "tree", entries: [] }));
}

interface ApplyPickInput {
	baseTree: string | null;
	oursTree: string;
	theirsTree: string;
	ontoHash: string;
	author?: CommitIdentity | Identity;
	committer?: CommitIdentity;
	message: string;
	noCommit?: boolean;
	branch?: string;
	mergeDriver?: MergeDriver;
}

async function applyPick(
	repo: GitRepo,
	input: ApplyPickInput,
): Promise<CherryPickResult | NoCommitPickResult> {
	const result = await mergeTreesFromTreeHashes(
		repo,
		input.baseTree,
		input.oursTree,
		input.theirsTree,
		{ mergeDriver: input.mergeDriver },
	);

	if (!result.clean) {
		return {
			clean: false,
			treeHash: result.treeHash,
			conflicts: result.conflicts,
			messages: result.messages,
		};
	}

	if (input.noCommit) {
		return { clean: true, treeHash: result.treeHash };
	}

	if (!input.author) {
		throw new Error("author is required when creating a commit");
	}

	const hash = await createCommit(repo, {
		tree: result.treeHash,
		parents: [input.ontoHash],
		author: input.author,
		committer: input.committer,
		message: input.message,
		branch: input.branch,
	});

	return { clean: true, hash, treeHash: result.treeHash };
}

function appendCherryPickedFrom(message: string, hash: string): string {
	const trailer = `(cherry picked from commit ${hash})`;
	const trimmed = message.replace(/\n+$/, "");
	const lastNl = trimmed.lastIndexOf("\n");
	const lastLine = lastNl === -1 ? trimmed : trimmed.slice(lastNl + 1);
	const hasTrailer = /^\(cherry picked from commit [0-9a-f]+\)$/.test(lastLine);
	return hasTrailer ? `${trimmed}\n${trailer}\n` : `${trimmed}\n\n${trailer}\n`;
}
