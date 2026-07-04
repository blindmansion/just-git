/**
 * Unified-diff / git-extended-diff parser — the inverse of `formatUnifiedDiff`.
 *
 * Turns patch text into a list of {@link ParsedPatch} records (one per file),
 * each carrying its extended-header metadata (mode / rename / copy / index OIDs
 * / binary marker) and its text fragments (hunks). The applier engine in
 * `./apply.ts` consumes these; this module is pure text → data with no I/O.
 *
 * Ported from git's `apply.c` (`find_header`, `parse_git_diff_header`, the
 * `gitdiff_*` handlers, `parse_fragment`, `parse_binary`). Kept idiomatic TS —
 * line-oriented rather than byte-offset — while matching git's field semantics
 * and error points. Binary blocks are handed to `parseBinaryPatch`
 * (`lib/diff/binary-patch.ts`).
 */
import { splitLinesWithNL } from "../diff/algorithm.ts";
import { type BinaryPatch, parseBinaryPatch } from "../diff/binary-patch.ts";

/** How a single file patch changes its target. */
export type PatchChangeKind = "modify" | "new" | "delete" | "rename" | "copy";

/** One body line of a text fragment (hunk). */
export interface ApplyHunkLine {
	kind: "context" | "insert" | "delete";
	/** Line content without the leading marker or trailing newline. */
	content: string;
	/** The line was followed by `\ No newline at end of file`. */
	noEOL: boolean;
	/** 1-based line number of this body line in the patch input (git's linenr). */
	srcLine: number;
}

/** A single text fragment (unified-diff hunk). */
export interface PatchFragment {
	/** `@@ -oldStart,oldCount +newStart,newCount @@` (1-based; 0 for creation). */
	oldStart: number;
	oldCount: number;
	newStart: number;
	newCount: number;
	/** Leading / trailing context line counts (git's `frag->leading/trailing`). */
	leading: number;
	trailing: number;
	lines: ApplyHunkLine[];
	/** Exact original bytes of this hunk (header + body) for `.rej` output. */
	raw: string;
	/** 1-based line number of the `@@` header, for error messages. */
	headerLine: number;
}

/** A parsed single-file patch. */
export interface ParsedPatch {
	oldName: string | null;
	newName: string | null;
	kind: PatchChangeKind;
	/** Parsed git file modes (octal numbers, e.g. `0o100644`). */
	oldMode?: number;
	newMode?: number;
	/** rename/copy similarity (or dissimilarity) score, 0–100. */
	score?: number;
	/** OID prefixes from the `index <old>..<new>` line (3-way base / binary). */
	oldOidPrefix?: string;
	newOidPrefix?: string;
	isBinary: boolean;
	binary?: BinaryPatch;
	fragments: PatchFragment[];
	/** 1-based line number of the `diff --git` (or `--- `) header. */
	headerLine: number;
	linesAdded: number;
	linesDeleted: number;
}

/** Thrown on malformed patch input; carries the 1-based line for the caller. */
export class ApplyParseError extends Error {
	readonly line: number;
	constructor(message: string, line: number) {
		super(message);
		this.name = "ApplyParseError";
		this.line = line;
	}
}

// ── File-mode canonicalization (git's canon_mode) ───────────────────

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;
const S_IFDIR = 0o040000;
const S_IFGITLINK = 0o160000;

function canonMode(mode: number): number {
	const type = mode & S_IFMT;
	if (type === S_IFREG || (type === 0 && mode)) {
		return S_IFREG | (mode & 0o111 ? 0o755 : 0o644);
	}
	if (type === S_IFLNK) return S_IFLNK;
	if (type === S_IFDIR) return S_IFDIR;
	if (type === S_IFGITLINK) return S_IFGITLINK;
	return mode;
}

// ── Path helpers ────────────────────────────────────────────────────

function isDevNull(name: string): boolean {
	return name === "/dev/null";
}

/**
 * Strip `p` leading path components (git's `skip_tree_prefix`). Returns null
 * for an absolute path when `p === 0`, or when there are fewer than `p`
 * components — matching git, which then falls back to the header's def name.
 */
function skipTreePrefix(name: string, p: number): string | null {
	if (p === 0) return name.startsWith("/") ? null : name;
	let seen = 0;
	for (let i = 0; i < name.length; i++) {
		if (name[i] === "/" && ++seen >= p) {
			return i === 0 ? null : name.slice(i + 1);
		}
	}
	return null;
}

/** Decode a git C-quoted path (`"a\tb"`); returns the raw string when unquoted. */
function unquotePath(raw: string): string {
	if (!raw.startsWith('"')) return raw;
	let out = "";
	let i = 1;
	while (i < raw.length) {
		const c = raw[i] as string;
		if (c === '"') break;
		if (c === "\\") {
			const n = raw[i + 1] as string;
			if (n >= "0" && n <= "7") {
				// up to 3 octal digits
				let oct = "";
				let j = i + 1;
				let d = raw[j];
				while (j < raw.length && oct.length < 3 && d !== undefined && d >= "0" && d <= "7") {
					oct += d;
					j++;
					d = raw[j];
				}
				out += String.fromCharCode(Number.parseInt(oct, 8));
				i = j;
				continue;
			}
			const map: Record<string, string> = {
				n: "\n",
				t: "\t",
				r: "\r",
				'"': '"',
				"\\": "\\",
				a: "\x07",
				b: "\b",
				f: "\f",
				v: "\v",
			};
			out += map[n] ?? n;
			i += 2;
			continue;
		}
		out += c;
		i++;
	}
	return out;
}

/**
 * Extract a filename from a `--- ` / `+++ ` line's remainder (git's `find_name`
 * with `TERM_TAB`): honor C-quoting, terminate at the first tab, then strip
 * `p` leading components. Returns null on `/dev/null`.
 */
function findName(rest: string, p: number): string | null {
	if (rest.startsWith('"')) {
		const unq = unquotePath(rest);
		if (isDevNull(unq)) return null;
		return skipTreePrefix(unq, p);
	}
	// Terminate at the first tab (git TERM_TAB).
	const tab = rest.indexOf("\t");
	const name = tab >= 0 ? rest.slice(0, tab) : rest;
	if (isDevNull(name)) return null;
	return skipTreePrefix(name, p);
}

/** Extract a rename/copy from/to name (no `a/`,`b/` prefix ⇒ strip `p-1`). */
function findRenameName(rest: string, p: number): string | null {
	const strip = p > 0 ? p - 1 : 0;
	if (rest.startsWith('"')) return skipTreePrefix(unquotePath(rest), strip);
	return skipTreePrefix(rest, strip);
}

// ── Line utilities ──────────────────────────────────────────────────

/** Strip a single trailing `\n` (the line terminator kept by splitLinesWithNL). */
function chomp(line: string): string {
	return line.endsWith("\n") ? line.slice(0, -1) : line;
}

/** git's `git_header_name`: the shared name on the `diff --git a/x b/y` line. */
function gitHeaderName(headerRest: string, p: number): string | null {
	const rest = chomp(headerRest);
	// Quoted first name.
	if (rest.startsWith('"')) {
		// Find the closing quote (respecting escaped quotes).
		let i = 1;
		while (i < rest.length) {
			if (rest[i] === "\\") {
				i += 2;
				continue;
			}
			if (rest[i] === '"') break;
			i++;
		}
		const first = unquotePath(rest.slice(0, i + 1));
		return skipTreePrefix(first, p);
	}
	// Unquoted: names repeat, e.g. "a/foo b/foo". Take the first, strip prefix.
	// Find a split point: the two names are separated by a space; when the name
	// has no spaces this is unambiguous. We take everything up to the last
	// space that yields a matching pair, but the common case is a simple split.
	const stripped = skipTreePrefix(rest, p);
	if (stripped === null) return null;
	// stripped is "<name> b/<name>" style; recover <name> by splitting on the
	// first space and verifying the tail matches "b/<name>" after prefix strip.
	const sp = stripped.indexOf(" ");
	if (sp < 0) return null;
	const candidate = stripped.slice(0, sp);
	const secondRaw = stripped.slice(sp + 1);
	const second = skipTreePrefix(secondRaw, p);
	if (second === candidate) return candidate;
	// Fall back: paths with spaces are ambiguous without quoting; give up (git
	// would return NULL and rely on the ---/+++ lines instead).
	return null;
}

// ── Fragment (hunk) parsing ─────────────────────────────────────────

const FRAGMENT_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

interface FragmentParse {
	fragment: PatchFragment;
	/** Index of the first line after this fragment. */
	next: number;
}

/**
 * Parse one `@@` fragment starting at `lines[start]`. `recount` recomputes the
 * old/new line counts from the body instead of trusting the header.
 */
function parseFragment(lines: string[], start: number, recount: boolean): FragmentParse {
	const headerLine = start + 1;
	const header = lines[start] as string;
	const m = FRAGMENT_HEADER.exec(header);
	if (!m) throw new ApplyParseError(`corrupt patch at line ${headerLine}`, headerLine);

	const oldStart = Number.parseInt(m[1] as string, 10);
	let oldCount = m[2] !== undefined ? Number.parseInt(m[2], 10) : 1;
	const newStart = Number.parseInt(m[3] as string, 10);
	let newCount = m[4] !== undefined ? Number.parseInt(m[4], 10) : 1;

	const body: ApplyHunkLine[] = [];
	let leading = 0;
	let trailing = 0;
	let added = 0;
	let deleted = 0;
	let oldRemaining = oldCount;
	let newRemaining = newCount;

	let i = start + 1;
	while (i < lines.length && (oldRemaining > 0 || newRemaining > 0)) {
		const raw = lines[i] as string;
		const srcLine = i + 1;
		const first = raw[0];
		let kind: ApplyHunkLine["kind"];
		let content: string;

		if (first === " " || first === "\n") {
			kind = "context";
			content = first === "\n" ? "" : chomp(raw.slice(1));
			oldRemaining--;
			newRemaining--;
			if (!added && !deleted) leading++;
			trailing++;
		} else if (first === "-") {
			kind = "delete";
			content = chomp(raw.slice(1));
			oldRemaining--;
			deleted++;
			trailing = 0;
		} else if (first === "+") {
			kind = "insert";
			content = chomp(raw.slice(1));
			newRemaining--;
			added++;
			trailing = 0;
		} else {
			throw new ApplyParseError(`corrupt patch at line ${i + 1}`, i + 1);
		}

		const line: ApplyHunkLine = { kind, content, noEOL: false, srcLine };
		i++;
		// A following "\ No newline at end of file" drops this line's newline.
		if (i < lines.length && (lines[i] as string).startsWith("\\")) {
			line.noEOL = true;
			i++;
		}
		body.push(line);
	}

	if (recount) {
		oldCount = body.filter((l) => l.kind !== "insert").length;
		newCount = body.filter((l) => l.kind !== "delete").length;
	} else if (oldRemaining !== 0 || newRemaining !== 0) {
		throw new ApplyParseError(`corrupt patch at line ${headerLine}`, headerLine);
	}

	if (!recount && added === 0 && deleted === 0) {
		throw new ApplyParseError(`corrupt patch at line ${headerLine}`, headerLine);
	}

	const raw = lines.slice(start, i).join("");
	return {
		fragment: {
			oldStart,
			oldCount,
			newStart,
			newCount,
			leading,
			trailing,
			lines: body,
			raw,
			headerLine,
		},
		next: i,
	};
}

// ── Git extended-header parsing ─────────────────────────────────────

interface HeaderState {
	oldName: string | null;
	newName: string | null;
	oldMode?: number;
	newMode?: number;
	isNew: boolean;
	isDelete: boolean;
	isRename: boolean;
	isCopy: boolean;
	score?: number;
	oldOidPrefix?: string;
	newOidPrefix?: string;
	defName: string | null;
}

/** Parse `index <old>..<new>[ <mode>]` (git's `gitdiff_index`). */
function parseIndexLine(rest: string, h: HeaderState): void {
	const dot = rest.indexOf("..");
	if (dot < 0) return;
	h.oldOidPrefix = rest.slice(0, dot);
	const after = chomp(rest.slice(dot + 2));
	const sp = after.indexOf(" ");
	if (sp < 0) {
		h.newOidPrefix = after;
	} else {
		h.newOidPrefix = after.slice(0, sp);
		const mode = Number.parseInt(after.slice(sp + 1), 8);
		if (!Number.isNaN(mode)) h.oldMode = canonMode(mode);
	}
}

function parseModeLine(rest: string, line: number): number {
	const mode = Number.parseInt(rest, 8);
	if (Number.isNaN(mode)) throw new ApplyParseError(`invalid mode on line ${line}`, line);
	return canonMode(mode);
}

/**
 * Parse the git extended headers that follow a `diff --git` line. Returns the
 * index of the first line that is not a recognized header (the first `@@`, the
 * `GIT binary patch` marker, or the start of the next patch).
 */
function parseGitHeader(lines: string[], start: number, p: number, h: HeaderState): number {
	let i = start + 1;
	for (; i < lines.length; i++) {
		const raw = lines[i] as string;
		const linenr = i + 1;
		if (raw.startsWith("@@ -")) break; // gitdiff_hdrend
		if (raw.startsWith("--- ")) {
			const name = findName(chomp(raw.slice(4)), p);
			if (name !== null && !h.isNew) h.oldName ??= name;
			continue;
		}
		if (raw.startsWith("+++ ")) {
			const name = findName(chomp(raw.slice(4)), p);
			if (name !== null && !h.isDelete) h.newName ??= name;
			continue;
		}
		if (raw.startsWith("old mode ")) {
			h.oldMode = parseModeLine(raw.slice(9), linenr);
			continue;
		}
		if (raw.startsWith("new mode ")) {
			h.newMode = parseModeLine(raw.slice(9), linenr);
			continue;
		}
		if (raw.startsWith("deleted file mode ")) {
			h.isDelete = true;
			h.oldName = h.defName;
			h.oldMode = parseModeLine(raw.slice(18), linenr);
			continue;
		}
		if (raw.startsWith("new file mode ")) {
			h.isNew = true;
			h.newName = h.defName;
			h.newMode = parseModeLine(raw.slice(14), linenr);
			continue;
		}
		if (raw.startsWith("copy from ")) {
			h.isCopy = true;
			h.oldName = findRenameName(chomp(raw.slice(10)), p);
			continue;
		}
		if (raw.startsWith("copy to ")) {
			h.isCopy = true;
			h.newName = findRenameName(chomp(raw.slice(8)), p);
			continue;
		}
		if (raw.startsWith("rename from ")) {
			h.isRename = true;
			h.oldName = findRenameName(chomp(raw.slice(12)), p);
			continue;
		}
		if (raw.startsWith("rename to ")) {
			h.isRename = true;
			h.newName = findRenameName(chomp(raw.slice(10)), p);
			continue;
		}
		if (raw.startsWith("rename old ")) {
			h.isRename = true;
			h.oldName = findRenameName(chomp(raw.slice(11)), p);
			continue;
		}
		if (raw.startsWith("rename new ")) {
			h.isRename = true;
			h.newName = findRenameName(chomp(raw.slice(11)), p);
			continue;
		}
		if (raw.startsWith("similarity index ")) {
			const v = Number.parseInt(raw.slice(17), 10);
			if (v <= 100) h.score = v;
			continue;
		}
		if (raw.startsWith("dissimilarity index ")) {
			const v = Number.parseInt(raw.slice(20), 10);
			if (v <= 100) h.score = v;
			continue;
		}
		if (raw.startsWith("index ")) {
			parseIndexLine(raw.slice(6), h);
			continue;
		}
		// Unrecognized header line ends the header block.
		break;
	}
	return i;
}

// ── Top-level scan ──────────────────────────────────────────────────

function deriveKind(h: HeaderState): PatchChangeKind {
	if (h.isDelete) return "delete";
	if (h.isNew) return "new";
	if (h.isRename) return "rename";
	if (h.isCopy) return "copy";
	return "modify";
}

/**
 * Parse patch text into per-file {@link ParsedPatch} records.
 *
 * @param text    Raw patch bytes as a UTF-8 string.
 * @param pValue  `-p<n>` path-strip count (default 1, git's behavior).
 * @param recount `--recount`: recompute hunk line counts from bodies.
 */
export function parsePatch(text: string, pValue = 1, recount = false): ParsedPatch[] {
	const lines = splitLinesWithNL(text);
	const patches: ParsedPatch[] = [];
	let i = 0;

	while (i < lines.length) {
		const raw = lines[i] as string;

		// ── git-style header ────────────────────────────────────
		if (raw.startsWith("diff --git ")) {
			const headerLine = i + 1;
			const h: HeaderState = {
				oldName: null,
				newName: null,
				isNew: false,
				isDelete: false,
				isRename: false,
				isCopy: false,
				defName: gitHeaderName(raw.slice("diff --git ".length), pValue),
			};
			let j = parseGitHeader(lines, i, pValue, h);

			if (!h.oldName && !h.newName) {
				if (!h.defName) {
					throw new ApplyParseError(
						`git diff header lacks filename information (line ${headerLine})`,
						headerLine,
					);
				}
				h.oldName = h.defName;
				h.newName = h.defName;
			}

			const patch: ParsedPatch = {
				oldName: h.isNew ? null : h.oldName,
				newName: h.isDelete ? null : h.newName,
				kind: deriveKind(h),
				oldMode: h.oldMode,
				newMode: h.newMode,
				score: h.score,
				oldOidPrefix: h.oldOidPrefix,
				newOidPrefix: h.newOidPrefix,
				isBinary: false,
				fragments: [],
				headerLine,
				linesAdded: 0,
				linesDeleted: 0,
			};

			// ── Fragments or binary ──────────────────────────
			if (j < lines.length && (lines[j] as string) === "GIT binary patch\n") {
				const { binary, next } = readBinary(lines, j + 1);
				patch.isBinary = true;
				patch.binary = binary;
				j = next;
			} else {
				j = readFragments(lines, j, patch, recount);
			}

			patches.push(patch);
			i = j;
			continue;
		}

		// ── traditional (non-git) header: `--- ` then `+++ ` ────
		if (
			raw.startsWith("--- ") &&
			i + 1 < lines.length &&
			(lines[i + 1] as string).startsWith("+++ ") &&
			i + 2 < lines.length &&
			(lines[i + 2] as string).startsWith("@@ -")
		) {
			const headerLine = i + 1;
			const oldRaw = chomp(raw.slice(4));
			const newRaw = chomp((lines[i + 1] as string).slice(4));
			const oldName = findName(oldRaw, pValue);
			const newName = findName(newRaw, pValue);
			const isNew = isDevNull(oldRaw);
			const isDelete = isDevNull(newRaw);
			const patch: ParsedPatch = {
				oldName: isNew ? null : oldName,
				newName: isDelete ? null : newName,
				kind: isNew ? "new" : isDelete ? "delete" : "modify",
				isBinary: false,
				fragments: [],
				headerLine,
				linesAdded: 0,
				linesDeleted: 0,
			};
			const j = readFragments(lines, i + 2, patch, recount);
			patches.push(patch);
			i = j;
			continue;
		}

		i++;
	}

	return patches;
}

/** Read consecutive `@@` fragments into `patch`; returns the next line index. */
function readFragments(
	lines: string[],
	start: number,
	patch: ParsedPatch,
	recount: boolean,
): number {
	let i = start;
	while (i < lines.length && (lines[i] as string).startsWith("@@ -")) {
		const { fragment, next } = parseFragment(lines, i, recount);
		patch.fragments.push(fragment);
		for (const l of fragment.lines) {
			if (l.kind === "insert") patch.linesAdded++;
			else if (l.kind === "delete") patch.linesDeleted++;
		}
		i = next;
	}
	return i;
}

/** Read the two `GIT binary patch` blocks; returns the next line index. */
function readBinary(lines: string[], start: number): { binary: BinaryPatch; next: number } {
	// Collect until the blank line that closes the reverse block. git's format
	// is: <method> line, base85 lines, blank line, [reverse method + lines,
	// blank line]. parseBinaryPatch does the decoding; here we just find where
	// the binary section ends.
	let i = start;
	let blanks = 0;
	while (i < lines.length) {
		const l = lines[i] as string;
		i++;
		if (l === "\n") {
			blanks++;
			if (blanks === 2) break;
			// A single blank closing the forward block; keep going for reverse.
			// But if the next line isn't a method line, the reverse block is
			// absent — stop.
			if (i >= lines.length) break;
			const n = lines[i] as string;
			if (!n.startsWith("literal ") && !n.startsWith("delta ")) break;
		}
	}
	const blockText = lines.slice(start, i).join("");
	const binary = parseBinaryPatch(blockText);
	return { binary, next: i };
}
