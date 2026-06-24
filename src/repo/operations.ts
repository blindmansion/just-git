import { findBisectionCommit } from "../lib/bisect.ts";
import { isAncestor, type MergeConflict } from "../lib/merge.ts";
import { readCommit as _readCommit, writeObject } from "../lib/object-db.ts";
import { serializeTree } from "../lib/objects/tree.ts";
import { selectRebaseCommits } from "../lib/rebase.ts";
import type { Commit, GitRepo, Identity } from "../lib/types.ts";
import {
	type ConflictedPath,
	mergeTreesDetailed,
	type MergeTreesDetailedResult,
	mergeTreesDetailedFromTreeHashes,
	mergeTreesFromTreeHashes,
} from "./merging.ts";
import { fetch, type FetchResult } from "./network.ts";
import { readHead, revParse } from "./reading.ts";
import { createTreeAccessor, type TreeAccessor } from "./tree-accessor.ts";
import {
	createCommit,
	type CommitIdentity,
	toIdentity,
	type TreeUpdate,
	updateTree,
} from "./writing.ts";

/** The well-known hash of the empty tree object. */
const EMPTY_TREE_HASH = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

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

// ── Merge ────────────────────────────────────────────────────────────

export type { ConflictedPath, BlobSide } from "./merging.ts";

/**
 * How to resolve a single conflicted path in {@link MergeOptions.resolutions}.
 *
 * - `"ours"` — take our side (stage 2); if our side deleted the path, delete it.
 * - `"theirs"` — take their side (stage 3); if their side deleted the path, delete it.
 * - `null` — delete the path.
 * - `{ content, mode? }` — set the path to explicit merged content. `mode`
 *   defaults to ours' mode, else theirs', else `"100644"`.
 */
export type Resolution = "ours" | "theirs" | null | { content: string | Uint8Array; mode?: string };

/** Options for {@link merge}. */
export interface MergeOptions {
	/** Our side — the commit being merged into (hash, branch, tag, or rev-parse expression). */
	ours: string;
	/** Their side — the commit being merged in (hash, branch, tag, or rev-parse expression). */
	theirs: string;
	/**
	 * Author identity for the merge commit. Required only when a merge commit is
	 * actually created — an up-to-date or fast-forward result needs no author, so
	 * an "integrate the remote" caller can omit it and only supply one if the
	 * merge turns out to be non-trivial.
	 */
	author?: CommitIdentity;
	/** Committer identity. Defaults to `author`. */
	committer?: CommitIdentity;
	/** Merge commit message. Defaults to `Merge <theirs> into <ours>`. */
	message?: string;
	/** Branch to advance on a successful merge or fast-forward. No ref update when omitted. */
	branch?: string;
	/**
	 * Fast-forward policy when `ours` is an ancestor of `theirs`:
	 * - `"allow"` (default) — fast-forward (no merge commit).
	 * - `"only"` — fast-forward or throw if not possible.
	 * - `"never"` — always create a merge commit (`--no-ff`).
	 */
	fastForward?: "allow" | "only" | "never";
	/**
	 * Post-hoc resolutions, keyed by conflicted path. Derived from a prior
	 * probe call's `conflicts`. When every conflicted path is resolved, the
	 * merge commits; otherwise the unresolved paths are returned.
	 */
	resolutions?: Record<string, Resolution>;
	/** Conflict-marker labels for ours/theirs. */
	labels?: { ours?: string; theirs?: string };
	/**
	 * Optional CAS guard for the branch advance. When provided, the branch must
	 * currently equal this value (or `null` to require the branch not exist),
	 * else the advance throws. Use the resolved `ours` hash from a probe call to
	 * guard against the branch moving between probe and commit.
	 */
	expectedOldHash?: string | null;
}

/**
 * Result of {@link merge}. Every variant echoes the resolved `ours`/`theirs`
 * commit hashes so a probe call's caller can pass them back verbatim to a
 * commit call (guaranteeing the second merge is identical).
 */
export type MergeResult =
	| { status: "up-to-date"; ours: string; theirs: string; hash: string }
	| { status: "fast-forward"; ours: string; theirs: string; hash: string }
	| { status: "merged"; ours: string; theirs: string; hash: string; treeHash: string }
	| {
			status: "conflicts";
			ours: string;
			theirs: string;
			/** Conflicted result tree (marker blobs at conflicted paths). */
			treeHash: string;
			conflicts: ConflictedPath[];
			messages: string[];
			/** Conflicted paths with no resolution supplied. */
			unresolved: string[];
	  };

/**
 * Three-way merge of two commits, operating purely on the object store.
 *
 * Mirrors a CLI merge's outcomes — up-to-date, fast-forward, a two-parent
 * merge commit, or conflicts — but with no index or worktree. Conflicts are
 * returned as data rather than persisted as in-progress state.
 *
 * Two-phase resolution: a first ("probe") call returns `status: "conflicts"`
 * with per-path stage blobs. The caller builds a `resolutions` map and calls
 * again with the same `ours`/`theirs` (ideally the resolved hashes from the
 * probe). Because merge-ort is deterministic, the second call recomputes the
 * identical conflict set, applies the resolutions, and commits once every
 * conflicted path is resolved — no state is persisted between calls.
 *
 * ```ts
 * let res = await merge(repo, { ours: "main", theirs: "feature", author, branch: "main" });
 * if (res.status === "conflicts") {
 *   const resolutions = Object.fromEntries(
 *     res.conflicts.map((c) => [c.path, "theirs" as const]),
 *   );
 *   res = await merge(repo, { ours: res.ours, theirs: res.theirs, author, branch: "main", resolutions });
 * }
 * ```
 */
export async function merge(repo: GitRepo, options: MergeOptions): Promise<MergeResult> {
	const ours = await resolveToHash(repo, options.ours);
	const theirs = await resolveToHash(repo, options.theirs);
	const ff = options.fastForward ?? "allow";

	// Already up to date: ours already contains theirs.
	if (ours === theirs || (await isAncestor(repo, theirs, ours))) {
		return { status: "up-to-date", ours, theirs, hash: ours };
	}

	// Fast-forward: ours is an ancestor of theirs.
	if (ff !== "never" && (await isAncestor(repo, ours, theirs))) {
		if (options.branch) {
			await advanceBranchTo(repo, options.branch, theirs, options.expectedOldHash);
		}
		return { status: "fast-forward", ours, theirs, hash: theirs };
	}
	if (ff === "only") {
		throw new Error(
			'merge: not a fast-forward (set fastForward to "allow" or "never" to create a merge commit)',
		);
	}

	const m = await mergeTreesDetailed(repo, ours, theirs, {
		ours: options.labels?.ours,
		theirs: options.labels?.theirs,
	});

	const applied = await applyResolutions(repo, m, options.resolutions ?? {}, "merge");
	if (applied.unresolved.length > 0) {
		return {
			status: "conflicts",
			ours,
			theirs,
			treeHash: m.treeHash,
			conflicts: m.conflicts,
			messages: m.messages,
			unresolved: applied.unresolved,
		};
	}
	const finalTree = applied.treeHash;

	const author = options.author ?? options.committer;
	if (!author) {
		throw new Error("merge: `author` is required to create a merge commit");
	}

	const hash = await createCommit(repo, {
		tree: finalTree,
		parents: [ours, theirs],
		author,
		committer: options.committer,
		message: options.message ?? `Merge ${options.theirs} into ${options.ours}`,
	});

	if (options.branch) {
		await advanceBranchTo(repo, options.branch, hash, options.expectedOldHash);
	}

	return { status: "merged", ours, theirs, hash, treeHash: finalTree };
}

/** Turn a {@link Resolution} into a tree update for the conflicted path. */
async function resolveConflict(
	repo: GitRepo,
	conflict: ConflictedPath,
	resolution: Resolution,
): Promise<TreeUpdate> {
	if (resolution === null) {
		return { path: conflict.path, hash: null };
	}
	if (resolution === "ours") {
		return conflict.ours
			? { path: conflict.path, hash: conflict.ours.hash, mode: conflict.ours.mode }
			: { path: conflict.path, hash: null };
	}
	if (resolution === "theirs") {
		return conflict.theirs
			? { path: conflict.path, hash: conflict.theirs.hash, mode: conflict.theirs.mode }
			: { path: conflict.path, hash: null };
	}
	const bytes =
		typeof resolution.content === "string"
			? new TextEncoder().encode(resolution.content)
			: resolution.content;
	const hash = await writeObject(repo, "blob", bytes);
	const mode = resolution.mode ?? conflict.ours?.mode ?? conflict.theirs?.mode ?? "100644";
	return { path: conflict.path, hash, mode };
}

/** Outcome of applying a resolution map to a detailed merge result. */
interface AppliedResolutions {
	/**
	 * Final tree hash. When every conflict is resolved (or the merge was clean),
	 * this is the resolved tree. When some conflicts remain unresolved, this is
	 * the conflicted result tree (with marker blobs) — i.e. `detailed.treeHash`.
	 */
	treeHash: string;
	/** Conflicted paths with no resolution supplied. Empty when fully resolved. */
	unresolved: string[];
}

/**
 * Apply a post-hoc `resolutions` map to a detailed three-way merge result.
 *
 * Shared by {@link merge} and {@link rebase}: a clean merge passes through
 * unchanged; for a conflicted merge, each resolved path is folded into the
 * result tree and any conflicted path lacking a resolution is reported in
 * `unresolved`. Throws when a resolution targets a path that isn't conflicted
 * (guards against stale/misapplied maps). `label` prefixes that error.
 */
async function applyResolutions(
	repo: GitRepo,
	detailed: MergeTreesDetailedResult,
	resolutions: Record<string, Resolution>,
	label: string,
): Promise<AppliedResolutions> {
	if (detailed.clean) {
		const stray = Object.keys(resolutions)[0];
		if (stray !== undefined) {
			throw new Error(
				`${label}: resolution provided for '${stray}', which is not a conflicted path`,
			);
		}
		return { treeHash: detailed.treeHash, unresolved: [] };
	}

	const conflictPaths = new Set(detailed.conflicts.map((c) => c.path));
	for (const path of Object.keys(resolutions)) {
		if (!conflictPaths.has(path)) {
			throw new Error(
				`${label}: resolution provided for '${path}', which is not a conflicted path`,
			);
		}
	}

	const updates: TreeUpdate[] = [];
	const unresolved: string[] = [];
	for (const c of detailed.conflicts) {
		if (!Object.hasOwn(resolutions, c.path)) {
			unresolved.push(c.path);
			continue;
		}
		updates.push(await resolveConflict(repo, c, resolutions[c.path] as Resolution));
	}

	if (unresolved.length > 0) {
		return { treeHash: detailed.treeHash, unresolved };
	}

	const finalTree = await updateTree(repo, detailed.treeHash, updates);
	return { treeHash: finalTree, unresolved: [] };
}

/** Advance `refs/heads/<branch>` to `hash`, optionally guarded by CAS. */
async function advanceBranchTo(
	repo: GitRepo,
	branch: string,
	hash: string,
	expectedOldHash?: string | null,
): Promise<void> {
	const branchRef = `refs/heads/${branch}`;
	if (expectedOldHash !== undefined) {
		const ok = await repo.refStore.compareAndSwapRef(branchRef, expectedOldHash, {
			type: "direct",
			hash,
		});
		if (!ok) {
			throw new Error(`branch '${branch}' moved during operation (CAS failed)`);
		}
	} else {
		await repo.refStore.writeRef(branchRef, { type: "direct", hash });
	}
	const head = await repo.refStore.readRef("HEAD");
	if (!head) {
		await repo.refStore.writeRef("HEAD", { type: "symbolic", target: branchRef });
	}
}

// ── Rebase ───────────────────────────────────────────────────────────

/**
 * Opaque, JSON-serializable continuation token returned with a conflicted
 * rebase. Pass it back (with `resolutions`) to resume. The rebase layer keeps
 * no on-repo state between calls — all replay progress lives in this token, so
 * a conflicted rebase can be paused, serialized, and resumed in a later
 * request/process.
 */
export interface RebaseContinuation {
	/** Rebased tip built so far — the next commit replays onto this. */
	head: string;
	/** Original commit hashes still to replay; `remaining[0]` is the conflicted one. */
	remaining: string[];
	/** New commit hashes created so far, oldest first. */
	rebased: string[];
	/** Original hashes not reapplied (became empty after replay). */
	dropped: string[];
	/** Original hashes skipped as cherry-pick-equivalent during planning. */
	skipped: string[];
	/** Committer for every replayed commit, resolved once at rebase start. */
	committer: Identity;
	/** Branch ref to advance to the final tip on success. */
	branch?: string;
	/** CAS guard for the final branch advance. */
	expectedOldHash?: string | null;
	/** Conflict-marker labels. */
	labels?: { ours?: string; theirs?: string };
}

/** Options for {@link rebase}. */
export interface RebaseOptions {
	/**
	 * The branch/commit whose commits are replayed (hash, branch, tag, or
	 * rev-parse expression). Required for a fresh rebase; ignored when resuming.
	 */
	rebase?: string;
	/** Replay the commits in `upstream..rebase`. Required for a fresh rebase. */
	upstream?: string;
	/** Base to replay onto. Defaults to `upstream`. */
	onto?: string;
	/**
	 * Committer for the replayed commits — the original author is preserved per
	 * commit. Resolved once at the start, so every replayed commit (across
	 * resumes) shares this committer. Required for a fresh rebase.
	 */
	committer?: CommitIdentity;
	/** Branch ref to advance to the final tip on success. No ref update when omitted. */
	branch?: string;
	/** Skip patch-id cherry-pick dedup and replay every commit in the range. */
	reapplyCherryPicks?: boolean;
	/** Conflict-marker labels for ours/theirs. */
	labels?: { ours?: string; theirs?: string };
	/** CAS guard for the final branch advance (see {@link MergeOptions.expectedOldHash}). */
	expectedOldHash?: string | null;
	/** Resume a conflicted rebase: the token from a prior `status: "conflicts"` result. */
	continue?: RebaseContinuation;
	/** Resolutions for the conflicted step, keyed by path. Only honored when resuming. */
	resolutions?: Record<string, Resolution>;
}

/**
 * Result of {@link rebase}.
 *
 * - `up-to-date` — nothing to replay and the branch already points at `onto`.
 * - `ok` — all commits replayed; `head` is the new tip.
 * - `conflicts` — a commit could not be applied cleanly; resolve and resume
 *   with the returned `continuation`.
 */
export type RebaseResult =
	| { status: "up-to-date"; head: string }
	| {
			status: "ok";
			/** The final rebased tip. */
			head: string;
			/** New commit hashes, oldest first. */
			rebased: string[];
			/** Original hashes skipped as cherry-pick-equivalent. */
			skipped: string[];
			/** Original hashes dropped because they became empty after replay. */
			dropped: string[];
	  }
	| {
			status: "conflicts";
			/** The original commit that conflicted. */
			commit: string;
			/** Conflicted result tree (marker blobs at conflicted paths). */
			treeHash: string;
			conflicts: ConflictedPath[];
			messages: string[];
			/** Conflicted paths with no resolution supplied. */
			unresolved: string[];
			/** Pass back (with `resolutions`) to resume. */
			continuation: RebaseContinuation;
	  };

/** Mutable replay progress, shared by the fresh-start and resume paths. */
interface RebaseReplayState {
	head: string;
	remaining: string[];
	rebased: string[];
	dropped: string[];
	skipped: string[];
	committer: Identity;
	branch?: string;
	expectedOldHash?: string | null;
	labels?: { ours?: string; theirs?: string };
}

/**
 * Replay a range of commits onto a new base, operating purely on the object
 * store — no index, worktree, or on-disk state files.
 *
 * Range semantics match `git rebase` exactly: the commits in `upstream..rebase`
 * are linearized oldest-first, merge commits are dropped, and commits already
 * present on `upstream` (by patch-id) are skipped unless `reapplyCherryPicks`
 * is set. Each commit is reapplied via a three-way merge (base = its parent,
 * ours = the current rebased tip, theirs = the commit), preserving the original
 * author. Commits that become empty after replay are dropped (unless they were
 * already empty in the original history).
 *
 * Conflicts stop the rebase and are returned as data with a serializable
 * `continuation`. Resolve them and call again with `{ continue, resolutions }`:
 *
 * ```ts
 * let res = await rebase(repo, {
 *   rebase: "feature", upstream: "main", branch: "feature",
 *   committer: { name: "Bot", email: "bot@x.dev" },
 * });
 * while (res.status === "conflicts") {
 *   const resolutions = Object.fromEntries(res.conflicts.map((c) => [c.path, "theirs" as const]));
 *   res = await rebase(repo, { continue: res.continuation, resolutions });
 * }
 * ```
 */
export async function rebase(repo: GitRepo, options: RebaseOptions): Promise<RebaseResult> {
	if (options.continue) {
		const cont = options.continue;
		const state: RebaseReplayState = {
			head: cont.head,
			remaining: [...cont.remaining],
			rebased: [...cont.rebased],
			dropped: [...cont.dropped],
			skipped: [...cont.skipped],
			committer: cont.committer,
			branch: cont.branch,
			expectedOldHash: cont.expectedOldHash,
			labels: cont.labels,
		};
		return runRebaseReplay(repo, state, options.resolutions ?? {});
	}

	// ── Fresh rebase ─────────────────────────────────────────
	if (!options.rebase || !options.upstream) {
		throw new Error("rebase: `rebase` and `upstream` are required to start a rebase");
	}
	if (!options.committer) {
		throw new Error("rebase: `committer` is required to start a rebase");
	}

	const headHash = await resolveToHash(repo, options.rebase);
	const upstreamHash = await resolveToHash(repo, options.upstream);
	const ontoHash = options.onto ? await resolveToHash(repo, options.onto) : upstreamHash;

	const selection = await selectRebaseCommits(repo, upstreamHash, headHash, {
		reapplyCherryPicks: options.reapplyCherryPicks,
	});

	const state: RebaseReplayState = {
		head: ontoHash,
		remaining: selection.commits.map((c) => c.hash),
		rebased: [],
		dropped: [],
		skipped: selection.skipped,
		committer: toIdentity(options.committer),
		branch: options.branch,
		expectedOldHash: options.expectedOldHash,
		labels: options.labels,
	};

	if (state.remaining.length === 0) {
		// Genuinely up-to-date: nothing to replay and nothing skipped, with the
		// branch already at the target. Otherwise advance to `onto` (fast-forward).
		if (ontoHash === headHash && state.skipped.length === 0) {
			return { status: "up-to-date", head: headHash };
		}
		return finishRebaseReplay(repo, state);
	}

	return runRebaseReplay(repo, state, {});
}

/**
 * Drive the replay loop from `state`. `firstResolutions` apply to the head of
 * `remaining` (the conflicted commit when resuming); subsequent commits are
 * replayed with no preset resolutions.
 */
async function runRebaseReplay(
	repo: GitRepo,
	state: RebaseReplayState,
	firstResolutions: Record<string, Resolution>,
): Promise<RebaseResult> {
	let isFirst = true;

	while (state.remaining.length > 0) {
		const commitHash = state.remaining[0] as string;
		const commit = await _readCommit(repo, commitHash);
		const parentTree =
			commit.parents.length > 0
				? (await _readCommit(repo, commit.parents[0] as string)).tree
				: null;
		const headTree = (await _readCommit(repo, state.head)).tree;

		const detailed = await mergeTreesDetailedFromTreeHashes(
			repo,
			parentTree,
			headTree,
			commit.tree,
			{
				ours: state.labels?.ours,
				theirs: state.labels?.theirs,
			},
		);

		const resolutions = isFirst ? firstResolutions : {};
		const applied = await applyResolutions(repo, detailed, resolutions, "rebase");

		if (applied.unresolved.length > 0) {
			return {
				status: "conflicts",
				commit: commitHash,
				treeHash: detailed.treeHash,
				conflicts: detailed.conflicts,
				messages: detailed.messages,
				unresolved: applied.unresolved,
				continuation: snapshotContinuation(state),
			};
		}

		// Drop commits that become empty after replay, unless they were
		// already empty in the original history (those are preserved).
		const originallyEmpty = commit.tree === (parentTree ?? EMPTY_TREE_HASH);
		if (applied.treeHash === headTree && !originallyEmpty) {
			state.dropped.push(commitHash);
			state.remaining.shift();
			isFirst = false;
			continue;
		}

		const newHash = await createCommit(repo, {
			tree: applied.treeHash,
			parents: [state.head],
			author: commit.author,
			committer: state.committer,
			message: commit.message,
		});
		state.rebased.push(newHash);
		state.head = newHash;
		state.remaining.shift();
		isFirst = false;
	}

	return finishRebaseReplay(repo, state);
}

/** Advance the target branch (if any) to the final tip and return the result. */
async function finishRebaseReplay(repo: GitRepo, state: RebaseReplayState): Promise<RebaseResult> {
	if (state.branch) {
		await advanceBranchTo(repo, state.branch, state.head, state.expectedOldHash);
	}
	return {
		status: "ok",
		head: state.head,
		rebased: state.rebased,
		skipped: state.skipped,
		dropped: state.dropped,
	};
}

function snapshotContinuation(state: RebaseReplayState): RebaseContinuation {
	return {
		head: state.head,
		remaining: [...state.remaining],
		rebased: [...state.rebased],
		dropped: [...state.dropped],
		skipped: [...state.skipped],
		committer: state.committer,
		branch: state.branch,
		expectedOldHash: state.expectedOldHash,
		labels: state.labels,
	};
}

// ── Pull ─────────────────────────────────────────────────────────────

/** Options for {@link pull}. */
export interface PullOptions {
	/** Remote URL (or custom scheme resolved via `repo.capabilities.resolveRemote`). */
	url: string;
	/** Remote short name driving the tracking namespace. Default `"origin"`. */
	remote?: string;
	/** Local branch to update. Defaults to the current HEAD branch. */
	branch?: string;
	/** Remote branch to integrate. Defaults to `branch`. */
	remoteBranch?: string;
	/** Integration strategy. Default `"merge"`. */
	strategy?: "merge" | "rebase";
	/**
	 * Author for a merge commit (merge strategy). Required only if a merge commit
	 * is actually created; falls back to `committer`. Unused by the rebase
	 * strategy, which preserves each replayed commit's original author.
	 */
	author?: CommitIdentity;
	/** Committer for merge/rebase commits. Required for the rebase strategy. */
	committer?: CommitIdentity;
	/** Merge commit message (merge strategy). */
	message?: string;
	/** Fast-forward policy (merge strategy). Default `"allow"`. */
	fastForward?: "allow" | "only" | "never";
	/** Conflict-marker labels for ours/theirs. */
	labels?: { ours?: string; theirs?: string };
	/** Skip patch-id cherry-pick dedup and replay every commit (rebase strategy). */
	reapplyCherryPicks?: boolean;
}

/** Result of {@link pull}. */
export interface PullResult {
	/** The fetch that ran first, including which tracking refs moved. */
	fetched: FetchResult;
	/**
	 * Integration outcome — switch on `integration.status`. A conflict result
	 * carries the handles to resolve and complete the integration directly via
	 * {@link merge} (its `ours`/`theirs`) or {@link rebase} (its `continuation`).
	 */
	integration: MergeResult | RebaseResult;
}

/**
 * Fetch a remote branch and integrate it into a local branch in one call —
 * the programmatic counterpart to `git pull` (or `git pull --rebase`).
 *
 * Fetches into the remote-tracking namespace, then runs the chosen strategy
 * against the just-fetched tip: `merge` collapses up-to-date / fast-forward /
 * merge-commit / conflict into one result; `rebase` replays the local-only
 * commits onto the fetched tip. No state is persisted — a conflict is returned
 * as data, not left in an in-progress state on the repo. To resolve, call
 * {@link merge}/{@link rebase} directly with the handles the conflict result
 * carries (`ours`/`theirs`, or `continuation`).
 *
 * ```ts
 * const { integration } = await pull(repo, { url, branch: "main", author });
 * if (integration.status === "conflicts") {
 *   // resolve via merge() with integration.ours / integration.theirs
 * }
 * ```
 */
export async function pull(repo: GitRepo, options: PullOptions): Promise<PullResult> {
	const remote = options.remote ?? "origin";
	const branch = options.branch ?? (await readHead(repo)).branch;
	if (!branch) {
		throw new Error("pull: HEAD is detached or unborn — pass `branch` explicitly");
	}
	const remoteBranch = options.remoteBranch ?? branch;
	const theirs = `${remote}/${remoteBranch}`;

	const fetched = await fetch(repo, { url: options.url, name: remote });

	if ((options.strategy ?? "merge") === "rebase") {
		const integration = await rebase(repo, {
			rebase: branch,
			upstream: theirs,
			onto: theirs,
			branch,
			committer: options.committer,
			reapplyCherryPicks: options.reapplyCherryPicks,
			labels: options.labels,
		});
		return { fetched, integration };
	}

	const integration = await merge(repo, {
		ours: branch,
		theirs,
		branch,
		author: options.author,
		committer: options.committer,
		message: options.message,
		fastForward: options.fastForward,
		labels: options.labels,
	});
	return { fetched, integration };
}
