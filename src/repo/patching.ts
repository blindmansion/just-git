/**
 * Tree-level patch APIs on the `just-git/repo` surface.
 *
 * A worktree-free, index-free peer to the CLI `git apply` engine
 * (`src/lib/patch/apply.ts`): given a patch and an `onto` tree-ish, produce a
 * new tree hash — or, on failure, structured **rejects-as-data** rather than
 * `.rej` files or stderr. The reject payload carries each unplaced hunk with
 * its raw bytes plus the current file content, so a caller (e.g. an LLM agent)
 * can be re-prompted to fix and retry.
 *
 * This module is the public orchestration **shell** (matching `merge()` /
 * `rebase()`): it resolves `onto` and delegates the all-or-nothing tree
 * application mechanism to `lib/patch/tree-apply-repo.ts`. That mechanism and
 * the tree-level `am -3` fallback live below `repo/`, so the CLI and repo
 * drivers share them without depending on one another's orchestration.
 */
import { bindAttributes } from "../lib/attributes/bound-attributes.ts";
import type { MergeLabels } from "../lib/diff/diff3.ts";
import { readObject } from "../lib/object-db.ts";
import { fallBackThreeway } from "../lib/patch/am-threeway.ts";
import { prepareAmMessage, shouldSkipAmCommit } from "../lib/patch/am-message.ts";
import { reversePatch, type WhitespaceAction } from "../lib/patch/apply.ts";
import { splitMailbox } from "../lib/patch/mailinfo.ts";
import { parsePatch, type ParsedPatch } from "../lib/patch/parse-patch.ts";
import { applyPatchesToTree } from "../lib/patch/tree-apply-repo.ts";
import type { FileReject } from "../lib/patch/tree-apply.ts";
import type { GitRepo, Identity } from "../lib/types.ts";
import {
	applyResolutions,
	type ConflictedPath,
	type Resolution,
	toDetailedMergeResult,
} from "./merging.ts";
import { readCommit, revParse } from "./reading.ts";
import { advanceBranchTo } from "./ref-advance.ts";
import { createCommit, type CommitIdentity, toIdentity } from "./writing.ts";

// ── Re-exported patch primitives (promote lib → repo surface) ────────

export {
	ApplyParseError,
	parsePatch,
	type ApplyHunkLine,
	type ParsedPatch,
	type PatchChangeKind,
	type PatchFragment,
} from "../lib/patch/parse-patch.ts";
export { reversePatch, type WhitespaceAction } from "../lib/patch/apply.ts";
export {
	formatPatchSeries,
	FormatPatchError,
	type FormatPatchOptions,
	type FormatPatchResult,
	type PatchRecord,
} from "../lib/patch/format-patch.ts";
export type { BlobEffect, FileReject, HunkReject } from "../lib/patch/tree-apply.ts";
export {
	buildFakeAncestor,
	fallBackThreeway,
	type FallBackThreewayResult,
	type MergeOrtResultData,
} from "../lib/patch/am-threeway.ts";

// ── Public option / result types ────────────────────────────────────

/** Options for {@link applyPatch}. */
export interface ApplyPatchOptions {
	/** Patch text (unified / git-extended diff) or pre-parsed patches. */
	patch: string | ParsedPatch[];
	/** Tree-ish to apply onto: a commit-ish or a raw tree hash (rev-parse expr ok). */
	onto: string;
	/** `-R`: reverse the patch before applying. Default `false`. */
	reverse?: boolean;
	/** `-p<n>` path-strip when parsing `patch` text. Default `1`. Ignored for `ParsedPatch[]`. */
	strip?: number;
	/** Whitespace policy for added lines (git's `--whitespace`). Default `"nowarn"`. */
	whitespace?: WhitespaceAction;
}

/** Outcome of {@link applyPatch}. */
export type ApplyPatchResult =
	| { status: "applied"; treeHash: string }
	| { status: "rejected"; rejects: FileReject[] };

/** Options that start a fresh {@link am} replay. */
export interface AmStartOptions {
	/** Mailbox text or already-split raw messages. */
	mbox: string | string[];
	/** Commit-ish on top of which the mailbox is replayed. */
	onto: string;
	/** Committer for every new commit; each mail supplies its own author. */
	committer: CommitIdentity;
	/** Branch advanced once, after every message succeeds. */
	branch?: string;
	/** Optional compare-and-swap guard for the final branch advance. */
	expectedOldHash?: string | null;
	/** Fall back to git `am -3`'s tree-level merge when plain apply rejects. */
	threeWay?: boolean;
	/** Keep subject prefixes such as `[PATCH]`. */
	keep?: boolean;
	/** Discard mail content above a scissors line. */
	scissors?: boolean;
	/** Preserve carriage returns in the body and patch. */
	keepCr?: boolean;
	/** Append the committer's Signed-off-by trailer. */
	signoff?: boolean;
	continue?: never;
	resolutions?: never;
	replacementMessage?: never;
}

/** Options that resume a stopped {@link am} replay. */
export interface AmContinueOptions {
	/** Serializable token returned by a previous conflict or rejection. */
	continue: AmContinuation;
	/** Merge resolutions for a `status: "conflicts"` stop. */
	resolutions?: Record<string, Resolution>;
	/** Repaired raw mailbox message for a `status: "rejected"` stop. */
	replacementMessage?: string;
	mbox?: never;
	onto?: never;
	committer?: never;
	branch?: never;
	expectedOldHash?: never;
	threeWay?: never;
	keep?: never;
	scissors?: never;
	keepCr?: never;
	signoff?: never;
}

/** Fresh-start or resume inputs for {@link am}. */
export type AmOptions = AmStartOptions | AmContinueOptions;

/**
 * Complete, JSON-serializable replay state. No `.git/rebase-apply` state or
 * other on-repo session metadata is written.
 */
export interface AmContinuation {
	head: string;
	/** Raw messages still to process; index zero is the stopped message. */
	remaining: string[];
	/** Original zero-based index of `remaining[0]`. */
	nextIndex: number;
	/** Commit hashes created so far, oldest first. */
	commits: string[];
	/** Committer resolved once at fresh-start time. */
	committer: Identity;
	branch?: string;
	expectedOldHash?: string | null;
	threeWay: boolean;
	keep: boolean;
	scissors: boolean;
	keepCr: boolean;
	signoff: boolean;
	/** Determines which resume input is valid. */
	stopped: "conflicts" | "rejected";
}

/** A patch/mail failure that needs a repaired current message rather than merge resolutions. */
export type AmRejection =
	| { kind: "empty-patch" }
	| { kind: "parse-error"; line: number; message: string }
	| { kind: "apply-rejected"; rejects: FileReject[] }
	| {
			kind: "three-way-unavailable";
			path: string;
			reason: "missing-oid" | "missing-mode-source";
	  }
	| { kind: "three-way-apply-failed" };

/** Result of replaying a mailbox with {@link am}. */
export type AmResult =
	| { status: "applied"; head: string; commits: string[] }
	| {
			status: "conflicts";
			failedIndex: number;
			subject: string;
			applied: string[];
			treeHash: string;
			conflicts: ConflictedPath[];
			unresolved: string[];
			continuation: AmContinuation;
	  }
	| {
			status: "rejected";
			failedIndex: number;
			subject: string;
			applied: string[];
			rejection: AmRejection;
			continuation: AmContinuation;
	  };

// ── Shell (GitRepo) ─────────────────────────────────────────────────

/** Resolve an `onto` tree-ish to a tree object hash (peels commits to their tree). */
async function resolveOntoTree(repo: GitRepo, onto: string): Promise<string> {
	const hash = await revParse(repo, onto);
	if (!hash) throw new Error(`cannot resolve '${onto}' to a tree or commit`);
	const obj = await readObject(repo, hash);
	if (obj.type === "tree") return hash;
	if (obj.type === "commit") return (await readCommit(repo, hash)).tree;
	throw new Error(`'${onto}' resolves to a ${obj.type}, expected a commit or tree`);
}

/**
 * Apply a patch to a tree, returning a new tree hash on success or structured
 * {@link FileReject}s on failure — never touching a worktree, index, or `.rej`
 * file. All-or-nothing: if any file rejects, no blobs or trees are folded into
 * a result (only the reject data comes back).
 *
 * ```ts
 * const res = await applyPatch(repo, { patch: diffText, onto: "main" });
 * if (res.status === "applied") {
 *   // res.treeHash is the new tree
 * } else {
 *   // res.rejects[i] carries the unplaced hunks + current file content
 * }
 * ```
 */
export async function applyPatch(
	repo: GitRepo,
	opts: ApplyPatchOptions,
): Promise<ApplyPatchResult> {
	const parsed =
		typeof opts.patch === "string" ? parsePatch(opts.patch, opts.strip ?? 1) : opts.patch;
	const reverse = opts.reverse ?? false;
	const effective = reverse ? parsed.map((p) => reversePatch(p)) : parsed;
	const whitespace = opts.whitespace ?? "nowarn";
	const ontoTree = await resolveOntoTree(repo, opts.onto);
	return applyPatchesToTree(repo, effective, ontoTree, { reverse, whitespace });
}

// ── Mailbox → commits ───────────────────────────────────────────────

interface AmReplayState {
	head: string;
	remaining: string[];
	nextIndex: number;
	commits: string[];
	committer: Identity;
	branch?: string;
	expectedOldHash?: string | null;
	threeWay: boolean;
	keep: boolean;
	scissors: boolean;
	keepCr: boolean;
	signoff: boolean;
}

function snapshotAmContinuation(
	state: AmReplayState,
	stopped: AmContinuation["stopped"],
): AmContinuation {
	return {
		head: state.head,
		remaining: [...state.remaining],
		nextIndex: state.nextIndex,
		commits: [...state.commits],
		committer: state.committer,
		branch: state.branch,
		expectedOldHash: state.expectedOldHash,
		threeWay: state.threeWay,
		keep: state.keep,
		scissors: state.scissors,
		keepCr: state.keepCr,
		signoff: state.signoff,
		stopped,
	};
}

function rejectedAmResult(state: AmReplayState, subject: string, rejection: AmRejection): AmResult {
	return {
		status: "rejected",
		failedIndex: state.nextIndex,
		subject,
		applied: [...state.commits],
		rejection,
		continuation: snapshotAmContinuation(state, "rejected"),
	};
}

async function resolveAmStart(repo: GitRepo, options: AmStartOptions): Promise<AmReplayState> {
	const messages = Array.isArray(options.mbox) ? [...options.mbox] : splitMailbox(options.mbox);
	if (messages.length === 0) throw new Error("am: mailbox is empty");

	const head = await revParse(repo, options.onto);
	if (!head) throw new Error(`am: revision '${options.onto}' not found`);
	const object = await readObject(repo, head);
	if (object.type !== "commit") {
		throw new Error(`am: '${options.onto}' resolves to a ${object.type}, expected a commit`);
	}

	return {
		head,
		remaining: messages,
		nextIndex: 0,
		commits: [],
		committer: toIdentity(options.committer, repo.capabilities?.now),
		branch: options.branch,
		expectedOldHash: options.expectedOldHash,
		threeWay: options.threeWay ?? false,
		keep: options.keep ?? false,
		scissors: options.scissors ?? false,
		keepCr: options.keepCr ?? false,
		signoff: options.signoff ?? false,
	};
}

function restoreAmState(continuation: AmContinuation): AmReplayState {
	if (continuation.remaining.length === 0) {
		throw new Error("am: continuation has no remaining message");
	}
	return {
		head: continuation.head,
		remaining: [...continuation.remaining],
		nextIndex: continuation.nextIndex,
		commits: [...continuation.commits],
		committer: continuation.committer,
		branch: continuation.branch,
		expectedOldHash: continuation.expectedOldHash,
		threeWay: continuation.threeWay,
		keep: continuation.keep,
		scissors: continuation.scissors,
		keepCr: continuation.keepCr,
		signoff: continuation.signoff,
	};
}

async function finishAm(repo: GitRepo, state: AmReplayState): Promise<AmResult> {
	if (state.branch) {
		await advanceBranchTo(repo, state.branch, state.head, state.expectedOldHash);
	}
	return { status: "applied", head: state.head, commits: [...state.commits] };
}

async function runAmReplay(
	repo: GitRepo,
	state: AmReplayState,
	firstResolutions: Record<string, Resolution>,
): Promise<AmResult> {
	let first = true;

	while (state.remaining.length > 0) {
		const raw = state.remaining[0] as string;
		const signoffLine = state.signoff
			? `Signed-off-by: ${state.committer.name} <${state.committer.email}>`
			: null;
		const prepared = prepareAmMessage(raw, {
			keep: state.keep,
			scissors: state.scissors,
			keepCr: state.keepCr,
			now: repo.capabilities?.now,
			signoffLine,
		});
		if (prepared.status === "empty") {
			return rejectedAmResult(state, prepared.mail.subject, { kind: "empty-patch" });
		}
		if (prepared.status === "parse-error") {
			return rejectedAmResult(state, prepared.mail.subject, {
				kind: "parse-error",
				line: prepared.line,
				message: prepared.errorMessage,
			});
		}
		const { mail, message, patches } = prepared.prepared;

		const headCommit = await readCommit(repo, state.head);
		const plain = await applyPatch(repo, {
			patch: patches,
			onto: headCommit.tree,
			whitespace: "warn",
		});
		let treeHash: string;
		let usedThreeWay = false;

		if (plain.status === "applied") {
			if (first && Object.keys(firstResolutions).length > 0) {
				throw new Error("am: resolutions supplied but the current message has no conflicts");
			}
			treeHash = plain.treeHash;
		} else {
			if (!state.threeWay) {
				return rejectedAmResult(state, mail.subject, {
					kind: "apply-rejected",
					rejects: plain.rejects,
				});
			}

			const attributes = await bindAttributes(repo, "am");
			const labels: MergeLabels = { a: "HEAD", b: mail.subject };
			const fallback = await fallBackThreeway(
				repo,
				patches,
				headCommit.tree,
				labels,
				attributes?.merge,
			);
			if (fallback.status === "no-base") {
				return rejectedAmResult(state, mail.subject, {
					kind: "three-way-unavailable",
					path: fallback.missingPath,
					reason: fallback.reason,
				});
			}
			if (fallback.status === "apply-failed") {
				return rejectedAmResult(state, mail.subject, { kind: "three-way-apply-failed" });
			}
			usedThreeWay = true;

			const detailed = toDetailedMergeResult(fallback.merge);
			const resolutions = first ? firstResolutions : {};
			const applied = await applyResolutions(repo, detailed, resolutions, "am");
			if (applied.unresolved.length > 0) {
				return {
					status: "conflicts",
					failedIndex: state.nextIndex,
					subject: mail.subject,
					applied: [...state.commits],
					treeHash: detailed.treeHash,
					conflicts: detailed.conflicts,
					unresolved: applied.unresolved,
					continuation: snapshotAmContinuation(state, "conflicts"),
				};
			}
			treeHash = applied.treeHash;
		}

		// A successful three-way can determine that this patch is already in
		// HEAD. Match git am by consuming it without creating an empty commit.
		if (!shouldSkipAmCommit(usedThreeWay, treeHash === headCommit.tree)) {
			const hash = await createCommit(repo, {
				tree: treeHash,
				parents: [state.head],
				author: mail.author,
				committer: state.committer,
				message,
			});
			state.head = hash;
			state.commits.push(hash);
		}

		state.remaining.shift();
		state.nextIndex++;
		first = false;
	}

	return finishAm(repo, state);
}

/**
 * Apply a mailbox as a sequence of commits without a worktree, index, or
 * persisted operation state.
 *
 * Merge conflicts and patch rejections are returned as distinct typed stops.
 * Resume a conflict with `resolutions`, or a rejection with a repaired
 * `replacementMessage`; progress is carried entirely by the continuation.
 */
export async function am(repo: GitRepo, options: AmOptions): Promise<AmResult> {
	if ("continue" in options && options.continue) {
		const continuation = options.continue;
		const state = restoreAmState(continuation);
		if (continuation.stopped === "conflicts") {
			if (options.replacementMessage !== undefined) {
				throw new Error("am: replacementMessage is only valid after a rejected result");
			}
			return runAmReplay(repo, state, options.resolutions ?? {});
		}

		if (options.resolutions !== undefined) {
			throw new Error("am: resolutions are only valid after a conflicts result");
		}
		if (options.replacementMessage === undefined) {
			throw new Error("am: replacementMessage is required to resume a rejected result");
		}
		state.remaining[0] = options.replacementMessage;
		return runAmReplay(repo, state, {});
	}

	return runAmReplay(repo, await resolveAmStart(repo, options), {});
}
