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
import { isInsideWorkTree, verifyPath } from "../attributes/path-safety.ts";
import { splitLinesWithNL } from "../diff/algorithm.ts";
import { type BinaryHunk, inflateBinaryHunk } from "../diff/binary-patch.ts";
import { addEntry, defaultStat, findEntry, readIndex, removeEntry, writeIndex } from "../index.ts";
import { hashObject, objectExists, readBlobBytes, writeObject } from "../object-db.ts";
import { applyDelta } from "../pack/packfile.ts";
import { join } from "../path.ts";
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
	/** `--check` / info-only: run preconditions and build results, never write. */
	check: boolean;
}

/** Per-file outcome of an {@link applyPatches} run. */
export interface FileApplyResult {
	path: string;
	status: "applied" | "failed";
	rejected: PatchFragment[];
	whitespace: WhitespaceWarning[];
	/** Ordered per-fragment outcomes (for `--reject` hunk-number notices). */
	fragmentResults: FragmentResult[];
	error?: string;
}

/** Aggregate result of applying a patch set. */
export interface ApplyResult {
	ok: boolean;
	files: FileApplyResult[];
	/** git-style `error: …` lines to emit on stderr. */
	errors: string[];
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
}

async function readWorktree(ctx: GitContext, path: string): Promise<string | null> {
	if (!ctx.workTree) return null;
	const full = join(ctx.workTree, path);
	if (!(await ctx.fs.exists(full))) return null;
	return decoder.decode(await ctx.fs.readFileBuffer(full));
}

/** Resolve the preimage a patch applies to, per the target matrix. */
async function loadPreimage(
	ctx: GitContext,
	index: Index,
	patch: ParsedPatch,
	target: ApplyTarget,
): Promise<{ content: string } | { error: string }> {
	if (patch.kind === "new") return { content: "" };
	const src = patch.oldName;
	if (!src) return { error: "missing source path" };

	if (target === "cached") {
		const entry = findEntry(index, src);
		if (!entry) return { error: `${src}: does not exist in index` };
		return { content: decoder.decode(await readBlobBytes(ctx, entry.hash)) };
	}
	const content = await readWorktree(ctx, src);
	if (content === null) return { error: `${src}: No such file or directory` };
	return { content };
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

/** Build the write plan for one patch (no I/O beyond reading the preimage). */
async function planPatch(
	ctx: GitContext,
	index: Index,
	patch: ParsedPatch,
	opts: ApplyEngineOptions,
): Promise<FilePlan | { error: string; path: string; doesNotApply?: boolean }> {
	const path = (patch.kind === "delete" ? patch.oldName : patch.newName) ?? patch.oldName ?? "";

	if (patch.isBinary) {
		return planBinaryPatch(ctx, index, patch, opts);
	}

	const pre = await loadPreimage(ctx, index, patch, opts.target);
	if ("error" in pre) return { error: pre.error, path };

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
		return { error: `patch failed: ${path}:${line}`, path, doesNotApply: true };
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
	};
}

// ── Binary patches (git's apply_binary / apply_binary_fragment) ──────

async function readWorktreeBytes(ctx: GitContext, path: string): Promise<Uint8Array | null> {
	if (!ctx.workTree) return null;
	const full = join(ctx.workTree, path);
	if (!(await ctx.fs.exists(full))) return null;
	return ctx.fs.readFileBuffer(full);
}

/** Raw-byte preimage loader for binary patches (no lossy UTF-8 round-trip). */
async function loadPreimageBytes(
	ctx: GitContext,
	index: Index,
	patch: ParsedPatch,
	target: ApplyTarget,
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
	return { content };
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

	const pre = await loadPreimageBytes(ctx, index, patch, opts.target);
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

async function writeWorktreeFile(
	ctx: GitContext,
	path: string,
	content: Uint8Array,
): Promise<void> {
	if (!ctx.workTree) throw new Error("cannot write to worktree in a bare repository");
	if (!verifyPath(path)) throw new Error(`refusing to write unsafe path '${path}'`);
	const full = join(ctx.workTree, path);
	if (!isInsideWorkTree(ctx.workTree, full)) {
		throw new Error(`refusing to write path outside worktree: '${path}'`);
	}
	const slash = full.lastIndexOf("/");
	if (slash > 0) await ctx.fs.mkdir(full.slice(0, slash), { recursive: true });
	await ctx.fs.writeFile(full, content);
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
		if (touchesWorktree) await writeWorktreeFile(ctx, plan.newPath, plan.content);
		if (touchesIndex) {
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

	const touchesIndex = opts.target === "index" || opts.target === "cached";
	let index: Index = touchesIndex ? await readIndex(ctx) : { version: 2, entries: [] };

	// ── Pass 1: validate + build ─────────────────────────────────────
	const files: FileApplyResult[] = [];
	const errors: string[] = [];
	const plans: FilePlan[] = [];
	let ok = true;

	for (const patch of effective) {
		const planned = await planPatch(ctx, index, patch, opts);
		if ("error" in planned) {
			ok = false;
			errors.push(planned.error);
			if (planned.doesNotApply) errors.push(`${planned.path}: patch does not apply`);
			files.push({
				path: planned.path,
				status: "failed",
				rejected: [],
				whitespace: [],
				fragmentResults: [],
				error: planned.error,
			});
			continue;
		}
		plans.push(planned);
		files.push({
			path: planned.newPath ?? planned.oldPath ?? "",
			status: planned.rejected.length > 0 ? "failed" : "applied",
			rejected: planned.rejected,
			whitespace: planned.whitespace,
			fragmentResults: planned.fragmentResults,
		});
		if (planned.rejected.length > 0) ok = false;
	}

	// `--whitespace=error[-all]` refuses to write when any added line trips the
	// whitespace rule (git's `die_on_ws_error` → `state->apply = 0`).
	const wsErrorMode = opts.whitespace === "error" || opts.whitespace === "error-all";
	if (wsErrorMode && files.some((f) => f.whitespace.length > 0)) ok = false;

	if (!ok && !opts.reject) {
		return { ok: false, files, errors };
	}
	if (opts.check) {
		return { ok, files, errors };
	}

	// ── Pass 2: commit ───────────────────────────────────────────────
	for (const plan of plans) {
		index = await commitPlan(ctx, index, plan, opts.target);
		// git's write_out_one_reject: applied hunks are kept in the file above;
		// the rejected ones are dropped into `<new_name>.rej`.
		if (plan.rejected.length > 0 && plan.newPath) {
			await writeRejectFile(ctx, plan.newPath, plan.rejected);
		}
	}
	if (touchesIndex) {
		await writeIndex(ctx, index);
	}

	return { ok, files, errors };
}
