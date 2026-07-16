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
 * This module is the imperative **shell** (matching `merge()` / `rebase()`):
 * it resolves `onto`, reads the needed blobs, drives the pure planners in
 * `lib/patch/tree-apply.ts`, and folds the resulting {@link BlobEffect}s into a
 * new tree via `updateTree` — all-or-nothing, exactly like git's
 * `check_patch_list` → `write_out_results`. The planning itself is pure and
 * lives in `lib`, alongside the other functional cores the shell drives.
 */
import { bindAttributes } from "../lib/attributes/bound-attributes.ts";
import type { MergeLabels } from "../lib/diff/diff3.ts";
import { defaultStat } from "../lib/index.ts";
import {
	findObjectsByPrefix,
	objectExists,
	readBlobBytes,
	readObject,
	writeObject,
} from "../lib/object-db.ts";
import { type ContentMergeFn, mergeOrtNonRecursive } from "../lib/merge-ort.ts";
import { comparePaths } from "../lib/path.ts";
import { buildAmMessage } from "../lib/patch/am-message.ts";
import { reversePatch, type WhitespaceAction } from "../lib/patch/apply.ts";
import { parseMail, splitMailbox } from "../lib/patch/mailinfo.ts";
import { ApplyParseError, parsePatch, type ParsedPatch } from "../lib/patch/parse-patch.ts";
import {
	type BlobEffect,
	type FileReject,
	planBinaryApply,
	planTextApply,
	type PreparedApply,
} from "../lib/patch/tree-apply.ts";
import { buildTreeFromIndex, type FlatTreeEntry, flattenTreeToMap } from "../lib/tree-ops.ts";
import type { GitRepo, Identity, IndexEntry } from "../lib/types.ts";
import {
	applyResolutions,
	type ConflictedPath,
	type Resolution,
	toDetailedMergeResult,
} from "./merging.ts";
import { readCommit, revParse } from "./reading.ts";
import { advanceBranchTo } from "./ref-advance.ts";
import {
	createCommit,
	type CommitIdentity,
	toIdentity,
	type TreeUpdate,
	updateTree,
} from "./writing.ts";

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

const decoder = new TextDecoder();

/** Resolve an `onto` tree-ish to a tree object hash (peels commits to their tree). */
async function resolveOntoTree(repo: GitRepo, onto: string): Promise<string> {
	const hash = await revParse(repo, onto);
	if (!hash) throw new Error(`cannot resolve '${onto}' to a tree or commit`);
	const obj = await readObject(repo, hash);
	if (obj.type === "tree") return hash;
	if (obj.type === "commit") return (await readCommit(repo, hash)).tree;
	throw new Error(`'${onto}' resolves to a ${obj.type}, expected a commit or tree`);
}

/** Result mode for a patch: explicit new/old mode, else the source tree mode. */
function resolveTreeMode(patch: ParsedPatch, entryMode: string | undefined): number {
	if (patch.newMode) return patch.newMode;
	if (patch.oldMode) return patch.oldMode;
	if (entryMode) return parseInt(entryMode, 8);
	return 0o100644;
}

/** Load a patch's preimage from the `onto` tree, or report a whole-file reject. */
async function preparePatch(
	repo: GitRepo,
	entries: Map<string, FlatTreeEntry>,
	patch: ParsedPatch,
): Promise<PreparedApply | { reject: FileReject }> {
	const path = (patch.kind === "delete" ? patch.oldName : patch.newName) ?? patch.oldName ?? "";

	if (patch.kind === "new") {
		const newPath = patch.newName ?? path;
		const existing = entries.get(newPath);
		if (existing) {
			const current = decoder.decode(await readBlobBytes(repo, existing.hash));
			return {
				reject: {
					path: newPath,
					currentContent: current,
					appliedHunks: 0,
					rejectedHunks: [],
					error: `${newPath}: already exists in onto`,
				},
			};
		}
		return {
			patch,
			path,
			preimageText: "",
			preimageBytes: new Uint8Array(0),
			mode: resolveTreeMode(patch, undefined),
		};
	}

	const src = patch.oldName;
	if (!src) {
		return {
			reject: {
				path,
				currentContent: null,
				appliedHunks: 0,
				rejectedHunks: [],
				error: "missing source path",
			},
		};
	}
	const entry = entries.get(src);
	if (!entry) {
		return {
			reject: {
				path,
				currentContent: null,
				appliedHunks: 0,
				rejectedHunks: [],
				error: `${src}: does not exist in onto`,
			},
		};
	}
	const bytes = await readBlobBytes(repo, entry.hash);
	return {
		patch,
		path,
		preimageText: decoder.decode(bytes),
		preimageBytes: bytes,
		mode: resolveTreeMode(patch, entry.mode),
	};
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
	const entries = await flattenTreeToMap(repo, ontoTree);

	const effects: BlobEffect[] = [];
	const rejects: FileReject[] = [];

	for (const patch of effective) {
		const prepared = await preparePatch(repo, entries, patch);
		if ("reject" in prepared) {
			rejects.push(prepared.reject);
			continue;
		}
		const res = patch.isBinary
			? await planBinaryApply(prepared, reverse)
			: planTextApply(prepared, whitespace);
		if ("reject" in res) rejects.push(res.reject);
		else effects.push(...res.effects);
	}

	// Two-pass, all-or-nothing (git's check_patch_list → write_out_results): a
	// single reject blocks every write, so a failed apply leaves the store
	// untouched and hands back only the reject data.
	if (rejects.length > 0) return { status: "rejected", rejects };

	const updates: TreeUpdate[] = [];
	for (const e of effects) {
		if ("delete" in e) {
			updates.push({ path: e.path, hash: null });
		} else {
			updates.push({
				path: e.path,
				hash: await writeObject(repo, "blob", e.content),
				mode: e.mode,
			});
		}
	}
	const treeHash = await updateTree(repo, ontoTree, updates);
	return { status: "applied", treeHash };
}

// ── Tree-level three-way (git's `am -3` fall_back_threeway) ──────────

/** The `MergeOrtResult` shape returned by `mergeOrtNonRecursive` (not exported). */
export type MergeOrtResultData = Awaited<ReturnType<typeof mergeOrtNonRecursive>>;

/**
 * Outcome of {@link fallBackThreeway} — git's `fall_back_threeway`.
 *
 * - `no-base`: `build_fake_ancestor` could not resolve some file's recorded
 *   base blob (git's `sha1 information is lacking or useless (<path>).`).
 * - `apply-failed`: the series would not apply to its own reconstructed base
 *   (git's `Did you hand edit your patch?`).
 * - `merged`: the tree merge ran. `merge` carries the (possibly conflicted)
 *   result; the caller writes it out (worktree guard + index) via
 *   `applyMergeResult`. `statusLines` is the `M`/`A` name-status block git
 *   prints between "Using index info…" and "Falling back…".
 */
export type FallBackThreewayResult =
	| { status: "no-base"; missingPath: string; reason: "missing-oid" | "missing-mode-source" }
	| { status: "apply-failed" }
	| {
			status: "merged";
			baseTree: string;
			theirsTree: string;
			statusLines: string[];
			merge: MergeOrtResultData;
	  };

/** Resolve a patch's `index <old>..` OID prefix to a present base blob. */
async function resolveBaseBlob(repo: GitRepo, prefix: string | undefined): Promise<string | null> {
	if (!prefix || prefix.length < 4 || /^0+$/.test(prefix)) return null;
	const matches = await findObjectsByPrefix(repo, prefix);
	if (matches.length !== 1) return null;
	const oid = matches[0] as string;
	return (await objectExists(repo, oid)) ? oid : null;
}

/**
 * git's `build_fake_ancestor`: assemble a synthetic base tree from every
 * (non-creation) patch's recorded old blob OID, so a tree merge has the exact
 * preimage the series was cut against. Creations contribute no base entry (they
 * become add/add at merge time). Returns the first unresolved path and whether
 * it lacked a recorded OID or a current-HEAD source for a metadata-only patch.
 */
export async function buildFakeAncestor(
	repo: GitRepo,
	patches: ParsedPatch[],
	fallbackEntries?: ReadonlyMap<string, FlatTreeEntry>,
): Promise<
	| { tree: string; entries: IndexEntry[] }
	| { missingPath: string; reason: "missing-oid" | "missing-mode-source" }
> {
	const entries: IndexEntry[] = [];
	for (const p of patches) {
		if (p.kind === "new") continue;
		const name = p.oldName ?? p.newName;
		if (!name) continue;
		let oid = await resolveBaseBlob(repo, p.oldOidPrefix);
		let fallback: FlatTreeEntry | undefined;
		const usesModeFallback = !p.oldOidPrefix && p.fragments.length === 0 && !p.isBinary;
		// Pure metadata patches (notably 100% renames) have no `index
		// <old>..<new>` line. git's build-fake-ancestor reads their preimage
		// from the current index instead of treating the absent OID as a missing
		// object. The caller supplies the stage-0/index tree for that fallback.
		if (!oid && usesModeFallback) {
			fallback = fallbackEntries?.get(name);
			oid = fallback?.hash ?? null;
		}
		if (!oid) {
			return {
				missingPath: name,
				reason: usesModeFallback ? "missing-mode-source" : "missing-oid",
			};
		}
		entries.push({
			path: name,
			mode: p.oldMode ?? p.newMode ?? (fallback ? parseInt(fallback.mode, 8) : 0o100644),
			hash: oid,
			stage: 0,
			stat: defaultStat(),
		});
	}
	const tree = await buildTreeFromIndex(repo, entries);
	return { tree, entries };
}

/**
 * The `M`/`A` name-status block git prints while reconstructing the base
 * (`run_diff_index` over the fake-ancestor entries: old = ours/HEAD, new = fake
 * ancestor). Only the paths carried by the fake ancestor are considered, so a
 * path present only in the fake ancestor is `A` and a differing one is `M`.
 */
function fakeAncestorStatus(entries: IndexEntry[], oursMap: Map<string, FlatTreeEntry>): string[] {
	const lines: string[] = [];
	for (const e of [...entries].sort((a, b) => comparePaths(a.path, b.path))) {
		const head = oursMap.get(e.path);
		if (!head) lines.push(`A\t${e.path}`);
		else if (head.hash !== e.hash || head.mode !== e.mode.toString(8)) lines.push(`M\t${e.path}`);
	}
	return lines;
}

/**
 * git's `fall_back_threeway` (the substance of `git am -3`): reconstruct a fake
 * ancestor from the series' recorded base OIDs, apply the series onto it to get
 * a "theirs" tree, and run a real tree merge against `oursTree` (HEAD). This is
 * a tree-level merge — with the add/add, modify/delete, and rename handling of
 * `merge-ort` — not the per-file approximation of `apply --3way`.
 *
 * Pure over {@link GitRepo}: it produces the merge result but does not touch a
 * worktree or index. The caller writes the result out (with the
 * dirty-worktree overwrite guard) via `applyMergeResult`.
 */
export async function fallBackThreeway(
	repo: GitRepo,
	patches: ParsedPatch[],
	oursTree: string,
	labels?: MergeLabels,
	mergeDriver?: ContentMergeFn,
): Promise<FallBackThreewayResult> {
	const oursMap = await flattenTreeToMap(repo, oursTree);
	const fake = await buildFakeAncestor(repo, patches, oursMap);
	if ("missingPath" in fake) {
		return { status: "no-base", missingPath: fake.missingPath, reason: fake.reason };
	}

	const statusLines = fakeAncestorStatus(fake.entries, oursMap);

	// "theirs" — the series applied to its own recorded preimage.
	const theirs = await applyPatch(repo, { patch: patches, onto: fake.tree });
	if (theirs.status === "rejected") return { status: "apply-failed" };

	const merge = await mergeOrtNonRecursive(
		repo,
		fake.tree,
		oursTree,
		theirs.treeHash,
		labels,
		mergeDriver,
	);
	return { status: "merged", baseTree: fake.tree, theirsTree: theirs.treeHash, statusLines, merge };
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
		const mail = parseMail(raw, {
			keep: state.keep,
			scissors: state.scissors,
			keepCr: state.keepCr,
			now: repo.capabilities?.now,
		});
		const signoffLine = state.signoff
			? `Signed-off-by: ${state.committer.name} <${state.committer.email}>`
			: null;
		const message = buildAmMessage(mail.subject, mail.body, signoffLine);

		if (mail.patchText.trim() === "") {
			return rejectedAmResult(state, mail.subject, { kind: "empty-patch" });
		}

		let patches: ParsedPatch[];
		try {
			patches = parsePatch(mail.patchText);
		} catch (error) {
			if (error instanceof ApplyParseError) {
				return rejectedAmResult(state, mail.subject, {
					kind: "parse-error",
					line: error.line,
					message: error.message,
				});
			}
			throw error;
		}

		const headCommit = await readCommit(repo, state.head);
		const plain = await applyPatch(repo, {
			patch: patches,
			onto: headCommit.tree,
			whitespace: "warn",
		});
		let treeHash: string;

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
		if (treeHash !== headCommit.tree) {
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
