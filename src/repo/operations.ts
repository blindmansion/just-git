import { findBisectionCommit } from "../lib/bisect.ts";
import { isAncestor, type MergeConflict } from "../lib/merge.ts";
import type { MergeDriver } from "../lib/merge-ort.ts";
import { readCommit as _readCommit, writeObject } from "../lib/object-db.ts";
import { serializeTree } from "../lib/objects/tree.ts";
import type { Commit, GitRepo, Identity } from "../lib/types.ts";
import {
	type ConflictedPath,
	mergeTreesDetailed,
	mergeTreesFromTreeHashes,
} from "./merging.ts";
import { revParse } from "./reading.ts";
import { createTreeAccessor, type TreeAccessor } from "./tree-accessor.ts";
import { createCommit, type CommitIdentity, type TreeUpdate, updateTree } from "./writing.ts";

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
export type Resolution =
	| "ours"
	| "theirs"
	| null
	| { content: string | Uint8Array; mode?: string };

/** Options for {@link merge}. */
export interface MergeOptions {
	/** Our side — the commit being merged into (hash, branch, tag, or rev-parse expression). */
	ours: string;
	/** Their side — the commit being merged in (hash, branch, tag, or rev-parse expression). */
	theirs: string;
	/** Author identity for the merge commit. */
	author: CommitIdentity;
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
	/** Inline content-merge driver, applied during the merge (auto-resolution). */
	mergeDriver?: MergeDriver;
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
		mergeDriver: options.mergeDriver,
	});

	let finalTree = m.treeHash;

	if (!m.clean) {
		const resolutions = options.resolutions ?? {};
		const conflictPaths = new Set(m.conflicts.map((c) => c.path));

		// Guard against stale or misapplied resolution maps.
		for (const path of Object.keys(resolutions)) {
			if (!conflictPaths.has(path)) {
				throw new Error(
					`merge: resolution provided for '${path}', which is not a conflicted path`,
				);
			}
		}

		const updates: TreeUpdate[] = [];
		const unresolved: string[] = [];
		for (const c of m.conflicts) {
			if (!Object.hasOwn(resolutions, c.path)) {
				unresolved.push(c.path);
				continue;
			}
			updates.push(await resolveConflict(repo, c, resolutions[c.path] as Resolution));
		}

		if (unresolved.length > 0) {
			return {
				status: "conflicts",
				ours,
				theirs,
				treeHash: m.treeHash,
				conflicts: m.conflicts,
				messages: m.messages,
				unresolved,
			};
		}

		finalTree = await updateTree(repo, m.treeHash, updates);
	}

	const hash = await createCommit(repo, {
		tree: finalTree,
		parents: [ours, theirs],
		author: options.author,
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
			throw new Error(`merge: branch '${branch}' moved during merge (CAS failed)`);
		}
	} else {
		await repo.refStore.writeRef(branchRef, { type: "direct", hash });
	}
	const head = await repo.refStore.readRef("HEAD");
	if (!head) {
		await repo.refStore.writeRef("HEAD", { type: "symbolic", target: branchRef });
	}
}
