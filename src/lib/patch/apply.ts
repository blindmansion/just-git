/**
 * Applier core — applies a {@link ParsedPatch}'s text fragments to an in-memory
 * image, with git's offset search (`find_pos`), no-fuzz exact matching
 * (`match_fragment`), splice (`update_image`), reverse (`-R`), and whitespace
 * handling. Pure and I/O-free: callers feed the current file content and get
 * back the result (or the rejected fragments); worktree / index writes live in
 * the CLI layer.
 *
 * Ported from git's `apply.c` (`apply_one_fragment`, `find_pos`,
 * `match_fragment`, `update_image`, `reverse_patches`). The image is modeled
 * idiomatically as an array of lines that each retain their trailing newline
 * (the final line may lack one, mirroring a missing-EOL file), so git's
 * byte-`memcmp` becomes line-string equality — equivalent under the no-fuzz
 * default (`p_context = UINT_MAX`, so git never reduces context or drops the
 * begin/end anchors without an explicit `-C<n>`, which is out of scope).
 */
import { type BoundAttributes, resolveAttributes } from "../attributes/bound-attributes.ts";
import { isInsideWorkTree, verifyPath } from "../attributes/path-safety.ts";
import { splitLinesWithNL } from "../diff/algorithm.ts";
import { type BinaryHunk, inflateBinaryHunk } from "../diff/binary-patch.ts";
import { merge, splitLinesWithSentinel, stripSentinel } from "../diff/diff3.ts";
import { addEntry, defaultStat, findEntry, readIndex, removeEntry, writeIndex } from "../index.ts";
import {
	findObjectsByPrefix,
	hashObject,
	objectExists,
	readBlobBytes,
	writeObject,
} from "../object-db.ts";
import { applyDelta } from "../pack/packfile.ts";
import { join } from "../path.ts";
import { lstatSafe } from "../symlink.ts";
import type { GitContext, Index, IndexEntry } from "../types.ts";
import type { ApplyHunkLine, ParsedPatch, PatchFragment } from "./parse-patch.ts";

/** `--whitespace=<action>` selector (git's `ws_error_action`). */
export type WhitespaceAction = "warn" | "nowarn" | "error" | "error-all" | "fix";

/** A whitespace problem git would report / fix on an added line. */
export interface WhitespaceWarning {
	/** Offending added-line content (without leading `+` or trailing newline). */
	content: string;
	/** 1-based line number of the offending line in the patch input (git's linenr). */
	patchLine: number;
	/** git's `whitespace_error_string` message, e.g. `trailing whitespace`. */
	message: string;
}

/** Outcome of applying a single fragment. */
export interface FragmentResult {
	fragment: PatchFragment;
	applied: boolean;
	/** 0-based image line where the fragment applied, or -1 on failure. */
	appliedPos: number;
	/** `appliedPos - expectedPos` (git's reported offset; 0 when exact). */
	offset: number;
}

/** Result of applying all text fragments of one patch to a preimage. */
export interface TextApplyResult {
	/** Whether every fragment applied. */
	ok: boolean;
	/** Resulting content (undefined when a fragment was rejected and !reject). */
	result?: string;
	fragments: FragmentResult[];
	rejected: PatchFragment[];
	whitespace: WhitespaceWarning[];
	/** First failing fragment's stated old line (git's `patch failed: f:line`). */
	failedAtLine?: number;
}

export interface TextApplyOptions {
	reverse: boolean;
	unidiffZero: boolean;
	whitespace: WhitespaceAction;
	/** Keep applied fragments and collect rejects instead of failing fast. */
	reject: boolean;
}

// ── Whitespace (default rule: blank-at-eol + space-before-tab) ──────

/**
 * git's `whitespace_error_string` for the default rule set (blank-at-eol +
 * space-before-tab): return the comma-joined message, or null when clean. The
 * ordering matches git (trailing whitespace first, then space-before-tab).
 */
function whitespaceErrorMessage(content: string): string | null {
	const msgs: string[] = [];
	// blank-at-eol: trailing space/tab.
	if (/[ \t]+$/.test(content)) msgs.push("trailing whitespace");
	// space-before-tab in the leading indent.
	const indent = content.match(/^[ \t]*/)?.[0] ?? "";
	if (/ \t/.test(indent)) msgs.push("space before tab in indent");
	return msgs.length > 0 ? msgs.join(", ") : null;
}

/** Fix an added line's whitespace (git's `ws_fix_copy`, default rule). */
function fixWhitespace(content: string): string {
	// Strip trailing whitespace, then remove spaces that precede a tab in the
	// leading indent (space-before-tab).
	let fixed = content.replace(/[ \t]+$/, "");
	const m = fixed.match(/^([ \t]*)(.*)$/s);
	if (m) {
		const indent = (m[1] as string).replace(/ +\t/g, "\t");
		fixed = indent + (m[2] as string);
	}
	return fixed;
}

// ── Reverse (git's reverse_patches + per-line +/- flip) ─────────────

function flipKind(kind: ApplyHunkLine["kind"]): ApplyHunkLine["kind"] {
	if (kind === "insert") return "delete";
	if (kind === "delete") return "insert";
	return "context";
}

/**
 * Produce the `-R` transform of a patch (git's `reverse_patches`): swap the
 * old/new positions, counts, names, modes, and OID prefixes, and flip each
 * fragment line's insert/delete role so the normal apply path reconstructs the
 * preimage from the postimage.
 */
export function reversePatch(patch: ParsedPatch): ParsedPatch {
	const kind = patch.kind === "new" ? "delete" : patch.kind === "delete" ? "new" : patch.kind;
	return {
		...patch,
		oldName: patch.newName,
		newName: patch.oldName,
		kind,
		oldMode: patch.newMode,
		newMode: patch.oldMode,
		oldOidPrefix: patch.newOidPrefix,
		newOidPrefix: patch.oldOidPrefix,
		linesAdded: patch.linesDeleted,
		linesDeleted: patch.linesAdded,
		fragments: patch.fragments.map((f) => ({
			...f,
			oldStart: f.newStart,
			oldCount: f.newCount,
			newStart: f.oldStart,
			newCount: f.oldCount,
			lines: f.lines.map((l) => ({ ...l, kind: flipKind(l.kind) })),
		})),
	};
}

// ── Image helpers ───────────────────────────────────────────────────

/** Render a hunk body line back to its image form (content + optional newline). */
function lineText(l: ApplyHunkLine, content = l.content): string {
	return l.noEOL ? content : `${content}\n`;
}

interface FragmentImages {
	pre: string[];
	post: string[];
	whitespace: WhitespaceWarning[];
	wsErrors: number;
}

/**
 * Build the preimage (context + deletes) and postimage (context + inserts) line
 * arrays for a fragment, applying the whitespace policy to added lines.
 */
function buildImages(frag: PatchFragment, ws: WhitespaceAction): FragmentImages {
	const pre: string[] = [];
	const post: string[] = [];
	const whitespace: WhitespaceWarning[] = [];
	let wsErrors = 0;

	for (const l of frag.lines) {
		if (l.kind === "context") {
			const t = lineText(l);
			pre.push(t);
			post.push(t);
		} else if (l.kind === "delete") {
			pre.push(lineText(l));
		} else {
			// insert
			let content = l.content;
			if (ws !== "nowarn") {
				const message = whitespaceErrorMessage(content);
				if (message !== null) {
					if (ws === "fix") {
						content = fixWhitespace(content);
					} else {
						whitespace.push({ content: l.content, patchLine: l.srcLine, message });
						if (ws === "error" || ws === "error-all") wsErrors++;
					}
				}
			}
			post.push(lineText(l, content));
		}
	}
	return { pre, post, whitespace, wsErrors };
}

// ── match_fragment / find_pos / update_image ────────────────────────

/**
 * git's `match_fragment` under the no-fuzz, no-ignore-ws default: the preimage
 * must lie fully within the image and every line must match exactly (and not
 * overlap an already-patched region). Honors the begin/end anchors.
 */
function matchFragment(
	img: string[],
	patched: boolean[],
	pre: string[],
	currentLno: number,
	matchBeginning: boolean,
	matchEnd: boolean,
): boolean {
	const imgN = img.length;
	const preN = pre.length;
	// The preimage must fall within the image (git's blank-at-eof correct_ws
	// extension is deferred).
	if (preN + currentLno > imgN) return false;
	if (matchEnd && preN + currentLno !== imgN) return false;
	if (matchBeginning && currentLno !== 0) return false;
	for (let i = 0; i < preN; i++) {
		if (patched[currentLno + i]) return false;
		if (pre[i] !== img[currentLno + i]) return false;
	}
	return true;
}

/**
 * git's `find_pos`: begin at the fragment's stated line and probe alternately
 * backward / forward at increasing distance, returning the first matching line
 * (0-based) or -1. Begin/end anchors pin the start line as git does.
 */
function findPos(
	img: string[],
	patched: boolean[],
	pre: string[],
	line: number,
	matchBeginning: boolean,
	matchEnd: boolean,
): number {
	const imgN = img.length;
	const preN = pre.length;

	if (matchBeginning) line = 0;
	else if (matchEnd) line = imgN - preN;
	// Unsigned comparison in git folds negatives (match_end underflow) to imgN.
	if (line < 0 || line > imgN) line = imgN;

	let backwardsLno = line;
	let forwardsLno = line;
	let currentLno = line;

	for (let i = 0; ; i++) {
		if (matchFragment(img, patched, pre, currentLno, matchBeginning, matchEnd)) {
			return currentLno;
		}
		// git's `again:` loop — advance the search cursor, flipping direction.
		for (;;) {
			if (backwardsLno === 0 && forwardsLno === imgN) return -1;
			if (i & 1) {
				if (backwardsLno === 0) {
					i++;
					continue;
				}
				backwardsLno--;
				currentLno = backwardsLno;
				break;
			}
			if (forwardsLno === imgN) {
				i++;
				continue;
			}
			forwardsLno++;
			currentLno = forwardsLno;
			break;
		}
	}
}

// ── Fragment application ────────────────────────────────────────────

/** Apply one fragment to `img`/`patched` in place; returns the outcome. */
function applyOneFragment(
	img: string[],
	patched: boolean[],
	frag: PatchFragment,
	opts: TextApplyOptions,
): { result: FragmentResult; whitespace: WhitespaceWarning[]; wsErrors: number } {
	const { pre, post, whitespace, wsErrors } = buildImages(frag, opts.whitespace);

	const matchBeginning = frag.oldStart === 0 || (frag.oldStart === 1 && !opts.unidiffZero);
	const matchEnd = !opts.unidiffZero && frag.trailing === 0;
	const expectedPos = frag.newStart ? frag.newStart - 1 : 0;

	const appliedPos = findPos(img, patched, pre, expectedPos, matchBeginning, matchEnd);
	if (appliedPos < 0) {
		return {
			result: { fragment: frag, applied: false, appliedPos: -1, offset: 0 },
			whitespace: [],
			wsErrors: 0,
		};
	}

	// update_image: splice postimage in for the matched preimage and mark the
	// inserted region patched so later fragments cannot reuse it.
	img.splice(appliedPos, pre.length, ...post);
	patched.splice(appliedPos, pre.length, ...post.map(() => true));

	return {
		result: {
			fragment: frag,
			applied: true,
			appliedPos,
			offset: appliedPos - expectedPos,
		},
		whitespace,
		wsErrors,
	};
}

/**
 * Apply a text patch's fragments to `preimage`, returning the new content and
 * per-fragment outcomes. With `reject: false` a single failure aborts (leaving
 * `result` undefined); with `reject: true` the fitting fragments are applied
 * and the rest collected in `rejected`.
 *
 * Binary patches are handled elsewhere (`applyBinaryPatch`); pass only text
 * patches here.
 */
export function applyTextPatch(
	preimage: string,
	patch: ParsedPatch,
	opts: TextApplyOptions,
): TextApplyResult {
	const effective = opts.reverse ? reversePatch(patch) : patch;
	const img = splitLinesWithNL(preimage);
	const patched: boolean[] = new Array(img.length).fill(false);

	const fragments: FragmentResult[] = [];
	const rejected: PatchFragment[] = [];
	const whitespace: WhitespaceWarning[] = [];
	let failedAtLine: number | undefined;
	let anyFailure = false;

	for (const frag of effective.fragments) {
		const { result, whitespace: ws } = applyOneFragment(img, patched, frag, opts);
		fragments.push(result);
		if (result.applied) {
			whitespace.push(...ws);
		} else {
			anyFailure = true;
			if (failedAtLine === undefined) failedAtLine = frag.oldStart;
			if (opts.reject) {
				rejected.push(frag);
			} else {
				return { ok: false, fragments, rejected, whitespace, failedAtLine };
			}
		}
	}

	const wsErrorTotal =
		whitespace.length > 0 && (opts.whitespace === "error" || opts.whitespace === "error-all");
	const ok = !anyFailure && !wsErrorTotal;
	const result = anyFailure && !opts.reject ? undefined : img.join("");
	return { ok, result, fragments, rejected, whitespace, failedAtLine };
}

// ── Write orchestration (git's check_patch_list + write_out_results) ─

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** Where a patch is applied — git's `cached` / `update_index` matrix. */
export type ApplyTarget = "worktree" | "index" | "cached";

export interface ApplyEngineOptions {
	reverse: boolean;
	target: ApplyTarget;
	whitespace: WhitespaceAction;
	unidiffZero: boolean;
	reject: boolean;
	/** `-3` / `--3way`: reconstruct the base from index OIDs and 3-way merge. */
	threeway: boolean;
	/** `--check` / info-only: run preconditions and build results, never write. */
	check: boolean;
}

/** How a file went through the `-3` path (git's try_threeway outcome). */
export type ThreewayOutcome =
	| { kind: "clean" }
	| { kind: "conflict" }
	| { kind: "fallback"; note?: string };

/** Per-file outcome of an {@link applyPatches} run. */
export interface FileApplyResult {
	path: string;
	status: "applied" | "failed";
	rejected: PatchFragment[];
	whitespace: WhitespaceWarning[];
	/** Ordered per-fragment outcomes (for `--reject` hunk-number notices). */
	fragmentResults: FragmentResult[];
	/** git's `-3` disposition, when `--3way` was in effect for this file. */
	threeway?: ThreewayOutcome;
	error?: string;
}

/** Aggregate result of applying a patch set. */
export interface ApplyResult {
	ok: boolean;
	files: FileApplyResult[];
	/** git-style `error: …` lines to emit on stderr. */
	errors: string[];
	/**
	 * Missing-but-tracked preimage files this apply checked out to the worktree
	 * (git's `checkout_target`). They are written even when the apply then hard-
	 * fails, so callers that fall back to another strategy (e.g. `am -3`) can
	 * tell they were not up-to-date beforehand. Empty under `--check`.
	 */
	restored: string[];
}

/** A conflicted `-3` stage entry to record in the index (git's stages 1/2/3). */
interface ConflictStage {
	stage: 1 | 2 | 3;
	oid: string;
	content: Uint8Array;
}

/** An intended filesystem/index mutation, computed before any write happens. */
interface FilePlan {
	patch: ParsedPatch;
	/** Target path for the result (null only for a pure deletion). */
	newPath: string | null;
	/** Source path whose content/entry is removed (rename / delete). */
	oldPath: string | null;
	/** Result content, or undefined for a deletion. */
	content?: Uint8Array;
	mode: number;
	rejected: PatchFragment[];
	whitespace: WhitespaceWarning[];
	/** Ordered per-fragment outcomes (empty for binary / pure-metadata patches). */
	fragmentResults: FragmentResult[];
	/** `-3` disposition (git's try_threeway); absent when `--3way` was off. */
	threeway?: ThreewayOutcome;
	/** Stages 1/2/3 to record on a conflicted `-3` merge (git's threeway_stage). */
	conflictStages?: ConflictStage[];
	/** A missing worktree file restored from the index (git's checkout_target). */
	restore?: Restore;
}

/**
 * git's `checkout_target` side effect: a missing worktree file that exists in
 * the index is materialized from the index during the check phase, so it
 * persists on disk even when the overall apply later fails and stops.
 */
interface Restore {
	path: string;
	content: Uint8Array;
	mode: number;
}

/**
 * Resolve the preimage a patch applies to, per the target matrix. Patch hunks
 * are expressed in the index (post-`clean`) representation, so worktree-sourced
 * bytes are run through the `clean` filter before matching — git's
 * `read_old_data` → `convert_to_git`. Index/`--cached` blobs are already clean,
 * so they pass through untouched.
 */
async function loadPreimage(
	ctx: GitContext,
	index: Index,
	patch: ParsedPatch,
	target: ApplyTarget,
	bound: BoundAttributes | undefined,
): Promise<{ content: string; restore?: Restore } | { error: string }> {
	if (patch.kind === "new") return { content: "" };
	const src = patch.oldName;
	if (!src) return { error: "missing source path" };

	if (target === "cached") {
		const entry = findEntry(index, src);
		if (!entry) return { error: `${src}: does not exist in index` };
		return { content: decoder.decode(await readBlobBytes(ctx, entry.hash)) };
	}

	if (target === "index") {
		// git's `check_preimage` with `check_index` (am's `git apply --index`):
		// the index is the source of truth. A path missing from the index is
		// rejected up front; a present path whose worktree copy is missing is
		// checked out from the index (`checkout_target`) and the patch applies
		// to *that*; a worktree copy that disagrees with the index is rejected
		// as "does not match index" before the hunks are ever tried.
		const entry = findEntry(index, src);
		if (!entry) return { error: `${src}: does not exist in index` };
		const bytes = await readWorktreeBytes(ctx, src);
		if (bytes === null) {
			const indexBytes = await readBlobBytes(ctx, entry.hash);
			return {
				content: decoder.decode(indexBytes),
				restore: { path: src, content: indexBytes, mode: entry.mode },
			};
		}
		const cleaned = bound ? await bound.clean(src, bytes) : bytes;
		if ((await hashObject("blob", cleaned)) !== entry.hash) {
			return { error: `${src}: does not match index` };
		}
		return { content: decoder.decode(cleaned) };
	}

	// Plain worktree apply (`check_index` off): only the worktree matters.
	const bytes = await readWorktreeBytes(ctx, src);
	if (bytes === null) return { error: `${src}: No such file or directory` };
	const cleaned = bound ? await bound.clean(src, bytes) : bytes;
	return { content: decoder.decode(cleaned) };
}

/** Choose the resulting file mode for a plan. */
function resolveMode(patch: ParsedPatch, index: Index, target: ApplyTarget): number {
	if (patch.newMode) return patch.newMode;
	if (patch.oldMode) return patch.oldMode;
	if (target !== "worktree" && patch.oldName) {
		const entry = findEntry(index, patch.oldName);
		if (entry) return entry.mode;
	}
	return 0o100644;
}

/** A planning failure git renders as `error: <error>` (+ `does not apply`). */
interface PlanError {
	error: string;
	path: string;
	doesNotApply?: boolean;
	/** `-3` fell back to direct application before this hard failure. */
	threewayFallback?: { note?: string };
	/** A missing worktree file restored from the index (git's checkout_target). */
	restore?: Restore;
}

/**
 * git's `has_symlink_leading_path`: true when any leading directory component
 * of `path` is itself a symlink in the worktree. git lets a creation through in
 * that case (the symlink, not a real dir, "owns" the location).
 */
async function hasSymlinkLeadingPath(ctx: GitContext, path: string): Promise<boolean> {
	if (!ctx.workTree) return false;
	const parts = path.split("/");
	let prefix = "";
	for (let i = 0; i < parts.length - 1; i++) {
		prefix = prefix ? `${prefix}/${parts[i]}` : (parts[i] as string);
		try {
			const st = await lstatSafe(ctx.fs, join(ctx.workTree, prefix));
			if (st.isSymbolicLink) return true;
		} catch {
			return false;
		}
	}
	return false;
}

/**
 * git's `check_to_create` worktree half: a creation / rename-dest / copy-dest
 * whose path already exists on disk is refused (git's `EXISTS_IN_WORKTREE`).
 * git tolerates an existing *directory* at the path and a symlinked leading
 * path; a missing file (or one behind such a symlink) leaves the slot free.
 */
async function worktreePathTaken(ctx: GitContext, path: string): Promise<boolean> {
	if (!ctx.workTree) return false;
	let st: Awaited<ReturnType<typeof lstatSafe>>;
	try {
		st = await lstatSafe(ctx.fs, join(ctx.workTree, path));
	} catch {
		return false;
	}
	if (st.isDirectory) return false;
	if (await hasSymlinkLeadingPath(ctx, path)) return false;
	return true;
}

/** Build the write plan for one patch (no I/O beyond reading the preimage). */
async function planPatch(
	ctx: GitContext,
	index: Index,
	patch: ParsedPatch,
	opts: ApplyEngineOptions,
	toBeDeleted: ReadonlySet<string>,
	bound: BoundAttributes | undefined,
): Promise<FilePlan | PlanError> {
	const path = (patch.kind === "delete" ? patch.oldName : patch.newName) ?? patch.oldName ?? "";

	// git's `check_to_create` for a creation (git's `ok_if_exists` — the
	// fn_table `PATH_TO_BE_DELETED` marker — suppresses it when an earlier patch
	// in the same series deleted/renamed that path away). Rename/copy
	// destinations are checked below, after their source preimage: git reports
	// a missing or dirty source before an occupied destination.
	if (patch.kind === "new" && !toBeDeleted.has(path)) {
		// Index half (apply `--index`/`--cached`): a creation whose path already
		// exists in the index is rejected up front, before any hunk work, with
		// "already exists in index" (and no "patch does not apply" trailer — it
		// never reaches the hunk-apply stage).
		if ((opts.target === "index" || opts.target === "cached") && findEntry(index, path)) {
			return { error: `${path}: already exists in index`, path };
		}
		// Worktree half: an occupied destination is rejected with "already
		// exists in working directory". `--cached` touches only the index, so it
		// skips this check; under `-3` git defers the collision to the 3-way path
		// (`direct_to_threeway`) rather than failing.
		if (opts.target !== "cached" && !opts.threeway && (await worktreePathTaken(ctx, path))) {
			return { error: `${path}: already exists in working directory`, path };
		}
	}

	if (patch.isBinary) {
		return planBinaryPatch(ctx, index, patch, opts, bound);
	}

	const pre = await loadPreimage(ctx, index, patch, opts.target, bound);
	if ("error" in pre) return { error: pre.error, path };

	const createsRenameDestination =
		patch.kind === "copy" || (patch.kind === "rename" && patch.oldName !== patch.newName);
	if (createsRenameDestination && !toBeDeleted.has(path)) {
		if ((opts.target === "index" || opts.target === "cached") && findEntry(index, path)) {
			return { error: `${path}: already exists in index`, path, restore: pre.restore };
		}
		if (opts.target !== "cached" && !opts.threeway && (await worktreePathTaken(ctx, path))) {
			return {
				error: `${path}: already exists in working directory`,
				path,
				restore: pre.restore,
			};
		}
	}

	// `-3` / `--3way`: git tries the 3-way merge first and only falls back to
	// direct application when the base blob is unavailable (git's apply_data).
	let threewayFallback: { note?: string } | undefined;
	if (opts.threeway) {
		const tw = await planThreeway(ctx, index, patch, opts, pre.content, bound);
		if (!("fallback" in tw)) return tw;
		threewayFallback = { note: tw.note };
	}

	const applied = applyTextPatch(pre.content, patch, {
		reverse: false, // reverse already folded in by applyPatches
		unidiffZero: opts.unidiffZero,
		whitespace: opts.whitespace,
		reject: opts.reject,
	});

	// A hunk that could not be located is a hard failure; whitespace errors are
	// surfaced separately (git keeps applying and reports them at the end).
	if (applied.failedAtLine !== undefined && !opts.reject) {
		const line = applied.failedAtLine;
		// Hunks apply against the preimage, so git names the source path in
		// failure diagnostics for renames rather than the destination path.
		const failurePath = patch.oldName ?? path;
		return {
			error: `patch failed: ${failurePath}:${line}`,
			path: failurePath,
			doesNotApply: true,
			threewayFallback,
			restore: pre.restore,
		};
	}

	const mode = resolveMode(patch, index, opts.target);
	const isDelete = patch.kind === "delete";
	return {
		patch,
		newPath: isDelete ? null : (patch.newName ?? path),
		oldPath: patch.kind === "rename" || isDelete || patch.kind === "modify" ? patch.oldName : null,
		content: isDelete ? undefined : encoder.encode(applied.result ?? ""),
		mode,
		rejected: applied.rejected,
		whitespace: applied.whitespace,
		fragmentResults: applied.fragments,
		threeway: threewayFallback ? { kind: "fallback", note: threewayFallback.note } : undefined,
		restore: pre.restore,
	};
}

// ── 3-way merge (git's try_threeway / three_way_merge) ───────────────

/** git's blob-missing message when `-3` cannot reconstruct the base. */
const THREEWAY_NO_BLOB = "repository lacks the necessary blob to perform 3-way merge.";

/**
 * In-core 3-way merge mirroring git's `three_way_merge` conflict rendering:
 * `ll_merge` with `ours`/`theirs` labels, reusing the shared diff3 renderer and
 * its trailing-newline handling (see `renderConflictMarkers`).
 */
function threeWayMergeText(
	oursText: string,
	baseText: string,
	theirsText: string,
): { conflict: boolean; text: string } {
	const merged = merge(
		splitLinesWithSentinel(oursText),
		splitLinesWithSentinel(baseText),
		splitLinesWithSentinel(theirsText),
		{ a: "ours", b: "theirs" },
	);
	const lastRaw = merged.result[merged.result.length - 1] ?? "";
	const noTrailingNl = lastRaw.endsWith("\u0000");
	const lines = merged.result.map(stripSentinel);
	const last = lines[lines.length - 1] ?? "";
	const endsWithMarker = last.startsWith(">>>>>>>");
	const needsNl = endsWithMarker || !noTrailingNl;
	return { conflict: merged.conflict, text: needsNl ? `${lines.join("\n")}\n` : lines.join("\n") };
}

/** Resolve the patch's `index <old>..` prefix to a present base blob OID. */
async function resolveBaseBlob(
	ctx: GitContext,
	prefix: string | undefined,
): Promise<string | null> {
	if (!prefix || prefix.length < 4 || /^0+$/.test(prefix)) return null;
	const matches = await findObjectsByPrefix(ctx, prefix);
	if (matches.length !== 1) return null;
	const oid = matches[0] as string;
	return (await objectExists(ctx, oid)) ? oid : null;
}

/**
 * git's `try_threeway`: reconstruct the base the patch was prepared against
 * (from the `index <old>..` OID), apply the patch to it to get "theirs", read
 * the current file as "ours", and 3-way merge with the base. Returns a
 * {@link FilePlan} on success (clean or conflicted) or a `fallback` signal so
 * the caller can fall back to direct application (git's apply_data).
 */
async function planThreeway(
	ctx: GitContext,
	index: Index,
	patch: ParsedPatch,
	opts: ApplyEngineOptions,
	oursText: string,
	bound: BoundAttributes | undefined,
): Promise<FilePlan | { fallback: true; note?: string }> {
	// git skips 3-way for deletions, no-fragment renames, and (for now) pure
	// creations — the add/add `direct_to_threeway` path is deferred.
	if (patch.kind === "delete" || patch.kind === "new") return { fallback: true };
	if (patch.fragments.length === 0) return { fallback: true };

	const baseOid = await resolveBaseBlob(ctx, patch.oldOidPrefix);
	if (!baseOid) return { fallback: true, note: THREEWAY_NO_BLOB };
	const baseBytes = await readBlobBytes(ctx, baseOid);
	const baseText = decoder.decode(baseBytes);

	// "theirs" — the patch applied to its own recorded preimage.
	const theirs = applyTextPatch(baseText, patch, {
		reverse: false,
		unidiffZero: opts.unidiffZero,
		whitespace: opts.whitespace,
		reject: false,
	});
	if (!theirs.ok || theirs.result === undefined) return { fallback: true };
	const theirsText = theirs.result;

	const oursBytes = encoder.encode(oursText);
	const theirsBytes = encoder.encode(theirsText);
	const oursOid = await hashObject("blob", oursBytes);
	const theirsOid = await hashObject("blob", theirsBytes);

	// three_way_merge's trivial resolves keep clean applies byte-identical to git.
	let mergedText: string;
	let conflict: boolean;
	if (oursOid === baseOid) {
		mergedText = theirsText;
		conflict = false;
	} else if (theirsOid === baseOid || theirsOid === oursOid) {
		mergedText = oursText;
		conflict = false;
	} else {
		// git's `three_way_merge` → `ll_merge` consults the path's `merge=<driver>`
		// attribute; a driver (e.g. `union`, `binary`) overrides the diff3 fallback.
		const driven = bound?.merge
			? await bound.merge({
					path: patch.newName ?? patch.oldName ?? "",
					base: baseBytes,
					ours: oursBytes,
					theirs: theirsBytes,
				})
			: null;
		if (driven) {
			mergedText = decoder.decode(driven.content);
			conflict = driven.conflict;
		} else {
			const m = threeWayMergeText(oursText, baseText, theirsText);
			mergedText = m.text;
			conflict = m.conflict;
		}
	}

	const mode = resolveMode(patch, index, opts.target);
	const plan: FilePlan = {
		patch,
		newPath: patch.newName ?? patch.oldName ?? "",
		oldPath: patch.kind === "rename" || patch.kind === "modify" ? patch.oldName : null,
		content: encoder.encode(mergedText),
		mode,
		rejected: [],
		whitespace: theirs.whitespace,
		fragmentResults: theirs.fragments,
		threeway: { kind: conflict ? "conflict" : "clean" },
	};
	if (conflict) {
		plan.conflictStages = [
			{ stage: 1, oid: baseOid, content: baseBytes },
			{ stage: 2, oid: oursOid, content: oursBytes },
			{ stage: 3, oid: theirsOid, content: theirsBytes },
		];
	}
	return plan;
}

// ── Binary patches (git's apply_binary / apply_binary_fragment) ──────

async function readWorktreeBytes(ctx: GitContext, path: string): Promise<Uint8Array | null> {
	if (!ctx.workTree) return null;
	const full = join(ctx.workTree, path);
	if (!(await ctx.fs.exists(full))) return null;
	return ctx.fs.readFileBuffer(full);
}

/**
 * Raw-byte preimage loader for binary patches (no lossy UTF-8 round-trip).
 * Worktree bytes are `clean`ed to the index representation before use, matching
 * the text path; `--cached` reads the already-clean index blob.
 */
async function loadPreimageBytes(
	ctx: GitContext,
	index: Index,
	patch: ParsedPatch,
	target: ApplyTarget,
	bound: BoundAttributes | undefined,
): Promise<{ content: Uint8Array } | { error: string }> {
	if (patch.kind === "new") return { content: new Uint8Array(0) };
	const src = patch.oldName;
	if (!src) return { error: "missing source path" };

	if (target === "cached") {
		const entry = findEntry(index, src);
		if (!entry) return { error: `${src}: does not exist in index` };
		return { content: await readBlobBytes(ctx, entry.hash) };
	}
	const content = await readWorktreeBytes(ctx, src);
	if (content === null) return { error: `${src}: No such file or directory` };
	return { content: bound ? await bound.clean(src, content) : content };
}

/** Reconstruct a postimage from a decoded binary hunk (`apply_binary_fragment`). */
async function applyBinaryHunk(hunk: BinaryHunk, preimage: Uint8Array): Promise<Uint8Array> {
	const raw = await inflateBinaryHunk(hunk);
	if (hunk.method === "literal") return raw;
	return applyDelta(preimage, raw);
}

/**
 * Plan a `GIT binary patch` (git's `apply_binary`). Requires a full index line,
 * verifies the preimage hashes to the recorded old OID, then produces the
 * postimage — reusing the stored object if present, else decoding the
 * literal/delta hunk — and verifies the result hashes to the new OID.
 */
async function planBinaryPatch(
	ctx: GitContext,
	index: Index,
	patch: ParsedPatch,
	opts: ApplyEngineOptions,
	bound: BoundAttributes | undefined,
): Promise<FilePlan | { error: string; path: string; doesNotApply?: boolean }> {
	const path = (patch.kind === "delete" ? patch.oldName : patch.newName) ?? patch.oldName ?? "";
	const name = patch.oldName ?? patch.newName ?? path;
	const binary = patch.binary;
	if (!binary) {
		return { error: `missing binary patch data for '${name}'`, path, doesNotApply: true };
	}

	const oldOid = patch.oldOidPrefix ?? "";
	const newOid = patch.newOidPrefix ?? "";
	if (!/^[0-9a-f]{40}$/.test(oldOid) || !/^[0-9a-f]{40}$/.test(newOid)) {
		return {
			error: `cannot apply binary patch to '${name}' without full index line`,
			path,
			doesNotApply: true,
		};
	}

	const pre = await loadPreimageBytes(ctx, index, patch, opts.target, bound);
	if ("error" in pre) return { error: pre.error, path };

	// Verify the preimage matches what the patch expects (creation ⇒ empty).
	if (patch.oldName) {
		const actual = await hashObject("blob", pre.content);
		if (actual !== oldOid) {
			return {
				error: `the patch applies to '${name}' (${actual}), which does not match the current contents.`,
				path,
				doesNotApply: true,
			};
		}
	} else if (pre.content.byteLength !== 0) {
		return {
			error: `the patch applies to an empty '${name}' but it is not empty`,
			path,
			doesNotApply: true,
		};
	}

	const mode = resolveMode(patch, index, opts.target);

	// A null new OID is a deletion.
	if (/^0{40}$/.test(newOid)) {
		return {
			patch,
			newPath: null,
			oldPath: patch.oldName,
			content: undefined,
			mode,
			rejected: [],
			whitespace: [],
			fragmentResults: [],
		};
	}

	let result: Uint8Array;
	if (await objectExists(ctx, newOid)) {
		// We already have the postimage blob — use it directly (git's fast path).
		result = await readBlobBytes(ctx, newOid);
	} else {
		// Binary patches are reversible only when the reverse hunk is present.
		const hunk = opts.reverse ? binary.reverse : binary.forward;
		if (!hunk) {
			return {
				error: `cannot reverse-apply a binary patch without the reverse hunk to '${name}'`,
				path,
				doesNotApply: true,
			};
		}
		try {
			result = await applyBinaryHunk(hunk, pre.content);
		} catch {
			return { error: `binary patch does not apply to '${name}'`, path, doesNotApply: true };
		}
		const actual = await hashObject("blob", result);
		if (actual !== newOid) {
			return {
				error: `binary patch to '${name}' creates incorrect result (expecting ${newOid}, got ${actual})`,
				path,
				doesNotApply: true,
			};
		}
	}

	const isDelete = patch.kind === "delete";
	return {
		patch,
		newPath: isDelete ? null : (patch.newName ?? path),
		oldPath: patch.kind === "rename" || isDelete || patch.kind === "modify" ? patch.oldName : null,
		content: result,
		mode,
		rejected: [],
		whitespace: [],
		fragmentResults: [],
	};
}

/**
 * Write a result to the worktree, running the path's `smudge` filter first —
 * git's `create_file` → `convert_to_working_tree`. `content` is always the
 * index (post-`clean`) representation (an applied hunk result, a binary
 * postimage, or a restored index blob), so `smudge` is passthrough for any
 * path with no `filter=` driver. `blobOid` is the stored blob id when known
 * (a smudge cache hint for pointer-style filters); undefined for worktree-only
 * results that were never written to the object store.
 */
async function writeWorktreeFile(
	ctx: GitContext,
	path: string,
	content: Uint8Array,
	mode: number,
	bound: BoundAttributes | undefined,
	blobOid?: string,
): Promise<void> {
	if (!ctx.workTree) throw new Error("cannot write to worktree in a bare repository");
	if (!verifyPath(path)) throw new Error(`refusing to write unsafe path '${path}'`);
	const full = join(ctx.workTree, path);
	if (!isInsideWorkTree(ctx.workTree, full)) {
		throw new Error(`refusing to write path outside worktree: '${path}'`);
	}
	const smudged = bound ? await bound.smudge(path, content, blobOid) : content;
	const slash = full.lastIndexOf("/");
	if (slash > 0) await ctx.fs.mkdir(full.slice(0, slash), { recursive: true });
	await ctx.fs.writeFile(full, smudged);
	// Reflect the git mode's executable bit on disk (git's `create_file` honors
	// 100755 vs 100644). Only regular-file blobs come through here; symlinks
	// ride the content path per the plan's deferral.
	if (ctx.fs.chmod) {
		await ctx.fs.chmod(full, mode & 0o111 ? 0o755 : 0o644);
	}
}

async function removeWorktreeFile(ctx: GitContext, path: string): Promise<void> {
	if (!ctx.workTree) return;
	const full = join(ctx.workTree, path);
	if (await ctx.fs.exists(full)) await ctx.fs.rm(full, { force: true });
}

/**
 * Write a `<path>.rej` file for the rejected fragments (git's
 * `write_out_one_reject`). The header deliberately omits git-extended markers
 * (`Normal git tools never deal with .rej`), and each rejected hunk's raw bytes
 * are copied verbatim with a guaranteed trailing newline.
 */
async function writeRejectFile(
	ctx: GitContext,
	path: string,
	rejected: PatchFragment[],
): Promise<void> {
	if (!ctx.workTree || rejected.length === 0) return;
	let text = `diff a/${path} b/${path}\t(rejected hunks)\n`;
	for (const frag of rejected) {
		text += frag.raw.endsWith("\n") ? frag.raw : `${frag.raw}\n`;
	}
	const full = join(ctx.workTree, `${path}.rej`);
	const slash = full.lastIndexOf("/");
	if (slash > 0) await ctx.fs.mkdir(full.slice(0, slash), { recursive: true });
	await ctx.fs.writeFile(full, encoder.encode(text));
}

/** Commit one plan's writes; returns the (possibly updated) index. */
async function commitPlan(
	ctx: GitContext,
	index: Index,
	plan: FilePlan,
	target: ApplyTarget,
	bound: BoundAttributes | undefined,
): Promise<Index> {
	let next = index;
	const touchesIndex = target === "index" || target === "cached";
	const touchesWorktree = target === "worktree" || target === "index";

	// Deletion removes the old path and writes nothing.
	if (plan.content === undefined && plan.oldPath) {
		if (touchesWorktree) await removeWorktreeFile(ctx, plan.oldPath);
		if (touchesIndex) next = removeEntry(next, plan.oldPath);
		return next;
	}

	// Rename drops the source once the destination is written below.
	if (plan.patch.kind === "rename" && plan.oldPath && plan.oldPath !== plan.newPath) {
		if (touchesWorktree) await removeWorktreeFile(ctx, plan.oldPath);
		if (touchesIndex) next = removeEntry(next, plan.oldPath);
	}

	if (plan.newPath && plan.content !== undefined) {
		if (touchesWorktree) await writeWorktreeFile(ctx, plan.newPath, plan.content, plan.mode, bound);
		if (touchesIndex) {
			// A conflicted `-3` merge records stages 1/2/3 instead of a resolved
			// stage-0 entry (git's add_conflicted_stages_file).
			if (plan.conflictStages) {
				next = removeEntry(next, plan.newPath);
				for (const s of plan.conflictStages) {
					const hash = await writeObject(ctx, "blob", s.content);
					const entry: IndexEntry = {
						path: plan.newPath,
						mode: plan.mode,
						hash,
						stage: s.stage,
						stat: { ...defaultStat(), size: s.content.byteLength },
					};
					next = addEntry(next, entry);
				}
			} else {
				const hash = await writeObject(ctx, "blob", plan.content);
				const entry: IndexEntry = {
					path: plan.newPath,
					mode: plan.mode,
					hash,
					stage: 0,
					stat: { ...defaultStat(), size: plan.content.byteLength },
				};
				next = addEntry(next, entry);
			}
		}
	}
	return next;
}

/**
 * Apply a set of parsed patches to the worktree and/or index, all-or-nothing.
 *
 * Two passes mirror git's `check_patch_list` → `write_out_results`: every patch
 * is validated and its result built in memory first; only if all succeed (or
 * `--reject` is set) are the writes committed. `--check` stops after the first
 * pass. Reverse is folded into the patches up front (git's `reverse_patches`).
 */
export async function applyPatches(
	ctx: GitContext,
	patches: ParsedPatch[],
	opts: ApplyEngineOptions,
): Promise<ApplyResult> {
	const effective = opts.reverse ? patches.map((p) => reversePatch(p)) : patches;

	// Bind the `.gitattributes` accessor once per run: worktree preimages are
	// `clean`ed to the index representation before matching, worktree results are
	// `smudge`d on write, and `-3` honors the path's `merge=<driver>`. `undefined`
	// (no attributes capability) keeps the whole engine byte-for-byte as before.
	const bound = await resolveAttributes(ctx, "apply");

	const touchesIndex = opts.target === "index" || opts.target === "cached";
	let index: Index = touchesIndex ? await readIndex(ctx) : { version: 2, entries: [] };

	// ── Pass 1: validate + build ─────────────────────────────────────
	const files: FileApplyResult[] = [];
	const errors: string[] = [];
	const plans: FilePlan[] = [];
	// git's `checkout_target`: files restored from the index during checking,
	// written before pass 2 so they survive a hard failure (e.g. am stopping).
	const restorations: Restore[] = [];
	let ok = true;
	// A hard failure (hunk mismatch / precondition) blocks all writes unless
	// `--reject`; `-3` conflicts and rejects still write their results (exit 1).
	let hardError = false;
	// git's `fn_table` `PATH_TO_BE_DELETED`: paths an earlier patch in the
	// series deletes or renames away, so a later add of the same path is
	// allowed to overwrite (`ok_if_exists`).
	const toBeDeleted = new Set<string>();

	for (const patch of effective) {
		const planned = await planPatch(ctx, index, patch, opts, toBeDeleted, bound);
		if ((patch.kind === "delete" || patch.kind === "rename") && patch.oldName) {
			toBeDeleted.add(patch.oldName);
		}
		if ("error" in planned) {
			ok = false;
			hardError = true;
			if (planned.restore) restorations.push(planned.restore);
			errors.push(planned.error);
			if (planned.doesNotApply) errors.push(`${planned.path}: patch does not apply`);
			files.push({
				path: planned.path,
				status: "failed",
				rejected: [],
				whitespace: [],
				fragmentResults: [],
				threeway: planned.threewayFallback
					? { kind: "fallback", note: planned.threewayFallback.note }
					: undefined,
				error: planned.error,
			});
			continue;
		}
		if (planned.restore) restorations.push(planned.restore);
		plans.push(planned);
		const conflicted = planned.threeway?.kind === "conflict";
		files.push({
			path: planned.newPath ?? planned.oldPath ?? "",
			status: planned.rejected.length > 0 || conflicted ? "failed" : "applied",
			rejected: planned.rejected,
			whitespace: planned.whitespace,
			fragmentResults: planned.fragmentResults,
			threeway: planned.threeway,
		});
		if (planned.rejected.length > 0 || conflicted) ok = false;
	}

	// `--whitespace=error[-all]` refuses to write when any added line trips the
	// whitespace rule (git's `die_on_ws_error` → `state->apply = 0`).
	const wsErrorMode = opts.whitespace === "error" || opts.whitespace === "error-all";
	if (wsErrorMode && files.some((f) => f.whitespace.length > 0)) {
		ok = false;
		hardError = true;
	}

	// git checks out missing-but-tracked files during the check phase (before
	// any hunk is applied), so they land on disk even when the apply then fails
	// and stops. `--check` inspects without touching the worktree.
	const restored: string[] = [];
	if (!opts.check) {
		for (const r of restorations) {
			await writeWorktreeFile(ctx, r.path, r.content, r.mode, bound);
			restored.push(r.path);
		}
	}

	if (hardError && !opts.reject) {
		return { ok: false, files, errors, restored };
	}
	if (opts.check) {
		return { ok, files, errors, restored };
	}

	// ── Pass 2: commit ───────────────────────────────────────────────
	for (const plan of plans) {
		index = await commitPlan(ctx, index, plan, opts.target, bound);
		// git's write_out_one_reject: applied hunks are kept in the file above;
		// the rejected ones are dropped into `<new_name>.rej`.
		if (plan.rejected.length > 0 && plan.newPath) {
			await writeRejectFile(ctx, plan.newPath, plan.rejected);
		}
	}
	if (touchesIndex) {
		await writeIndex(ctx, index);
	}

	return { ok, files, errors, restored };
}
