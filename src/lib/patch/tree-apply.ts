/**
 * Pure, I/O-free tree-apply core — the functional kernel behind the repo
 * surface's `applyPatch` (`src/repo/patching.ts`). Given a patch and the
 * *current content* of its target path (loaded by the caller from a tree), it
 * emits either a list of {@link BlobEffect}s for the shell to fold into a new
 * tree, or a structured {@link FileReject} carrying the unplaced hunks verbatim.
 *
 * Mirrors git's per-file planning (see the `GitContext`-coupled engine in
 * `./apply.ts` — `planPatch` / `apply_binary`) but takes no `GitContext` /
 * `GitRepo` and touches no object store, worktree, or index: the caller loads
 * the preimage and decides how to persist the result. Reuses the shared pure
 * kernels — the text applier (`applyTextPatch`) and the binary math
 * (`inflateBinaryHunk` / `applyDelta`) — rather than re-implementing them.
 */
import { inflateBinaryHunk } from "../diff/binary-patch.ts";
import { hashObject } from "../object-db.ts";
import { applyDelta } from "../pack/packfile.ts";
import { applyTextPatch, type TextApplyResult, type WhitespaceAction } from "./apply.ts";
import type { ParsedPatch, PatchFragment } from "./parse-patch.ts";

const encoder = new TextEncoder();

// ── Value types (pure data) ─────────────────────────────────────────

/** A single hunk that could not be placed, with everything needed to retry. */
export interface HunkReject {
	/** The `@@ -a,b +c,d @@` header line text. */
	header: string;
	/** The raw hunk bytes (header + body), verbatim. */
	raw: string;
	oldStart: number;
	oldCount: number;
	newStart: number;
	newCount: number;
	/** Why the hunk failed to place. */
	reason: "context-mismatch" | "already-applied" | "overlap";
}

/** Per-file failure record — the machine-consumable "this didn't apply" data. */
export interface FileReject {
	/** The patch's target path (new name, or old name for a deletion). */
	path: string;
	/**
	 * The file's *current* full content (the "here's what it looks like now"
	 * context for reconstruction), or `null` when the file is absent or its
	 * bytes are not UTF-8 text.
	 */
	currentContent: string | null;
	/** How many of the patch's hunks did apply before the rejection. */
	appliedHunks: number;
	/** Hunks that did NOT apply, each with its raw bytes + position. */
	rejectedHunks: HunkReject[];
	/** Non-hunk failure (missing source, binary OID mismatch, already exists, …). */
	error?: string;
}

/**
 * A pure tree effect emitted by the core: write/overwrite a blob at `path`, or
 * remove `path`. The caller hashes `content` and folds these into a tree.
 */
export type BlobEffect =
	| { path: string; content: Uint8Array; mode: string }
	| { path: string; delete: true };

/** A patch plus its resolved preimage, prepared by the caller for the core. */
export interface PreparedApply {
	/** Effective patch (reverse already folded in when reversing). */
	patch: ParsedPatch;
	/** Target path for messages (new name, or old name for a deletion). */
	path: string;
	/** Decoded preimage text (empty string for a creation; `null` if unknown). */
	preimageText: string | null;
	/** Raw preimage bytes (empty for a creation), for the binary path. */
	preimageBytes: Uint8Array;
	/** Resolved result file mode (git octal, e.g. `0o100644`). */
	mode: number;
}

/** Outcome of planning one patch: tree effects, or a structured reject. */
export type PlanOutcome = { effects: BlobEffect[] } | { reject: FileReject };

// ── Helpers ─────────────────────────────────────────────────────────

/** Render a git octal mode number to the `TreeUpdate` string form. */
function modeStr(mode: number): string {
	return mode.toString(8);
}

/** Project a rejected {@link PatchFragment} into a {@link HunkReject}. */
function toHunkReject(frag: PatchFragment): HunkReject {
	const nl = frag.raw.indexOf("\n");
	return {
		header: nl === -1 ? frag.raw : frag.raw.slice(0, nl),
		raw: frag.raw,
		oldStart: frag.oldStart,
		oldCount: frag.oldCount,
		newStart: frag.newStart,
		newCount: frag.newCount,
		// The core matcher only reports "could not locate the context"; the
		// finer already-applied / overlap distinction is left for a later pass.
		reason: "context-mismatch",
	};
}

/** Build a {@link FileReject} from a partially-applied text result. */
function toFileReject(path: string, currentContent: string | null, r: TextApplyResult): FileReject {
	return {
		path,
		currentContent,
		appliedHunks: r.fragments.filter((f) => f.applied).length,
		rejectedHunks: r.rejected.map(toHunkReject),
	};
}

/** A non-hunk (whole-file) failure. */
function errorReject(path: string, currentContent: string | null, error: string): PlanOutcome {
	return { reject: { path, currentContent, appliedHunks: 0, rejectedHunks: [], error } };
}

// ── Core planners ───────────────────────────────────────────────────

/**
 * Apply one text patch to its preimage, emitting tree effects on success or a
 * {@link FileReject} carrying the unplaced hunks. Deletions and renames apply
 * their fragments to validate the preimage, then remove the source path.
 */
export function planTextApply(input: PreparedApply, whitespace: WhitespaceAction): PlanOutcome {
	const { patch, path } = input;
	const preimage = input.preimageText ?? "";
	const applied = applyTextPatch(preimage, patch, {
		reverse: false, // reverse already folded in by the shell
		unidiffZero: false,
		whitespace,
		reject: true,
	});

	if (applied.rejected.length > 0) {
		return { reject: toFileReject(path, input.preimageText, applied) };
	}

	const effects: BlobEffect[] = [];
	if (patch.kind === "delete") {
		if (patch.oldName) effects.push({ path: patch.oldName, delete: true });
		return { effects };
	}

	const newPath = patch.newName ?? path;
	effects.push({
		path: newPath,
		content: encoder.encode(applied.result ?? ""),
		mode: modeStr(input.mode),
	});
	if (patch.kind === "rename" && patch.oldName && patch.oldName !== newPath) {
		effects.push({ path: patch.oldName, delete: true });
	}
	return { effects };
}

/**
 * Apply one `GIT binary patch` (git's `apply_binary`): require full index
 * lines, verify the preimage hashes to the recorded old OID, decode the
 * literal/delta hunk, and verify the postimage hashes to the new OID. Any
 * mismatch is a whole-file {@link FileReject}.
 */
export async function planBinaryApply(
	input: PreparedApply,
	reverse: boolean,
): Promise<PlanOutcome> {
	const { patch, path } = input;
	const name = patch.oldName ?? patch.newName ?? path;
	const binary = patch.binary;
	if (!binary) return errorReject(path, null, `missing binary patch data for '${name}'`);

	const oldOid = patch.oldOidPrefix ?? "";
	const newOid = patch.newOidPrefix ?? "";
	if (!/^[0-9a-f]{40}$/.test(oldOid) || !/^[0-9a-f]{40}$/.test(newOid)) {
		return errorReject(
			path,
			null,
			`cannot apply binary patch to '${name}' without full index line`,
		);
	}

	const pre = input.preimageBytes;
	if (patch.oldName) {
		const actual = await hashObject("blob", pre);
		if (actual !== oldOid) {
			return errorReject(
				path,
				null,
				`the patch applies to '${name}' (${actual}), which does not match the current contents.`,
			);
		}
	} else if (pre.byteLength !== 0) {
		return errorReject(path, null, `the patch applies to an empty '${name}' but it is not empty`);
	}

	// A null new OID is a deletion.
	if (/^0{40}$/.test(newOid)) {
		const effects: BlobEffect[] = [];
		if (patch.oldName) effects.push({ path: patch.oldName, delete: true });
		return { effects };
	}

	const hunk = reverse ? binary.reverse : binary.forward;
	if (!hunk) {
		return errorReject(
			path,
			null,
			`cannot reverse-apply a binary patch without the reverse hunk to '${name}'`,
		);
	}

	let result: Uint8Array;
	try {
		const raw = await inflateBinaryHunk(hunk);
		result = hunk.method === "literal" ? raw : applyDelta(pre, raw);
	} catch {
		return errorReject(path, null, `binary patch does not apply to '${name}'`);
	}
	const actual = await hashObject("blob", result);
	if (actual !== newOid) {
		return errorReject(
			path,
			null,
			`binary patch to '${name}' creates incorrect result (expecting ${newOid}, got ${actual})`,
		);
	}

	const effects: BlobEffect[] = [];
	const newPath = patch.newName ?? path;
	effects.push({ path: newPath, content: result, mode: modeStr(input.mode) });
	if (patch.kind === "rename" && patch.oldName && patch.oldName !== newPath) {
		effects.push({ path: patch.oldName, delete: true });
	}
	return { effects };
}
