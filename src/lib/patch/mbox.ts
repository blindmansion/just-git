/**
 * Pure presentation for `git format-patch` — the mbox / RFC-2822 codec.
 *
 * Turns a commit's identity, message, diffstat, and unified diff into one
 * mbox-style message (the `From <sha> Mon Sep 17...` framing, the header
 * block, the `[PATCH n/m] <subject>` line, an optional in-body signoff, and
 * the `-- \n<signature>` footer). No I/O — the command layer gathers the diff
 * data and joins the messages. Kept separate so `git am` can reuse the same
 * mbox framing when it lands.
 */
import { formatRFC2822 } from "../date.ts";
import type { Identity } from "../types.ts";

/**
 * The fixed sentinel date git stamps on every mbox `From ` separator line. It
 * is NOT the commit date — it is a magic constant that marks the record
 * boundary so `git am` can split a concatenated mailbox.
 */
export const MBOX_SENTINEL_DATE = "Mon Sep 17 00:00:00 2001";

/** The diffstat column width git uses in the email/patch context. */
export const FORMAT_PATCH_STAT_WIDTH = 72;

/**
 * Split a commit message into a folded subject and a body.
 *
 * The subject is the first paragraph (everything up to the first blank line)
 * with line breaks folded into single spaces — git's `format_subject`. The
 * body is the remainder with leading blank lines and all trailing whitespace
 * stripped.
 */
export function splitMessage(message: string): { subject: string; body: string } {
	const normalized = message.replace(/\r\n/g, "\n");
	const lines = normalized.split("\n");

	let i = 0;
	const subjectLines: string[] = [];
	while (i < lines.length && (lines[i] as string).trim() !== "") {
		subjectLines.push((lines[i] as string).trim());
		i++;
	}
	const subject = subjectLines.join(" ");

	while (i < lines.length && (lines[i] as string).trim() === "") i++;
	const body = lines.slice(i).join("\n").replace(/\s+$/, "");

	return { subject, body };
}

function isAscii(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) > 0x7f) return false;
	}
	return true;
}

const utf8Encoder = new TextEncoder();

/**
 * RFC-2047 "Q" encode a header value the way git does: UTF-8 bytes, space as
 * `=20`, and `=`, `?`, `_` plus any control/high byte as `=XX`. Wrapped in a
 * single `=?UTF-8?q?...?=` encoded-word (no line folding).
 */
export function encodeHeaderWord(text: string): string {
	const bytes = utf8Encoder.encode(text);
	let out = "";
	for (const b of bytes) {
		if (b >= 0x21 && b <= 0x7e && b !== 0x3d && b !== 0x3f && b !== 0x5f) {
			out += String.fromCharCode(b);
		} else {
			out += `=${b.toString(16).toUpperCase().padStart(2, "0")}`;
		}
	}
	return `=?UTF-8?q?${out}?=`;
}

/** True when the header text is safe to emit verbatim (no encoding needed). */
export function headerNeedsEncoding(text: string): boolean {
	return !isAscii(text);
}

/** Decode the `q` (quoted-printable) segment of an RFC-2047 encoded-word. */
function decodeQSegment(text: string): Uint8Array {
	const out: number[] = [];
	for (let i = 0; i < text.length; i++) {
		const c = text[i] as string;
		if (c === "_") {
			// RFC-2047 "Q": underscore always means a space (0x20).
			out.push(0x20);
		} else if (c === "=" && i + 2 < text.length) {
			const byte = Number.parseInt(text.slice(i + 1, i + 3), 16);
			if (Number.isNaN(byte)) {
				out.push(c.charCodeAt(0));
			} else {
				out.push(byte);
				i += 2;
			}
		} else {
			out.push(c.charCodeAt(0));
		}
	}
	return Uint8Array.from(out);
}

/** Decode the `b` (base64) segment of an RFC-2047 encoded-word. */
function decodeBSegment(text: string): Uint8Array {
	try {
		const binary = atob(text.replace(/\s+/g, ""));
		const out = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
		return out;
	} catch {
		return new Uint8Array(0);
	}
}

/** Decode raw bytes with the named charset, falling back to UTF-8 on unknown. */
function decodeCharset(charset: string, bytes: Uint8Array): string {
	try {
		const label = charset.toLowerCase() as ConstructorParameters<typeof TextDecoder>[0];
		return new TextDecoder(label).decode(bytes);
	} catch {
		return utf8Decoder.decode(bytes);
	}
}

const utf8Decoder = new TextDecoder();

/**
 * Decode a single RFC-2047 encoded-word (`=?charset?enc?text?=`) back to plain
 * text — the inverse of {@link encodeHeaderWord}. Handles both the `q`
 * (quoted-printable) and `b` (base64) encodings and any charset `TextDecoder`
 * knows (UTF-8, latin1, …), falling back to UTF-8 for unknown labels. Returns
 * null when the input is not a well-formed encoded-word, so the caller can keep
 * the original text verbatim. (git mailinfo's `decode_header` /
 * `decode_q_segment` / `decode_b_segment`.)
 */
export function decodeHeaderWord(word: string): string | null {
	const m = /^=\?([^?]+)\?([bBqQ])\?([^?]*)\?=$/.exec(word);
	if (!m) return null;
	const charset = m[1] as string;
	const encoding = (m[2] as string).toLowerCase();
	const encoded = m[3] as string;
	const bytes = encoding === "b" ? decodeBSegment(encoded) : decodeQSegment(encoded);
	return decodeCharset(charset, bytes);
}

export interface FormatPatchMessageInput {
	/** Full commit sha for the magic `From ` separator line. */
	sha: string;
	/** Author identity (drives the `From:` and `Date:` headers). */
	author: Identity;
	/**
	 * Bracketed subject prefix without the brackets or number, e.g. `PATCH`,
	 * `PATCH v3`, `RFC PATCH`, or a custom `--subject-prefix`.
	 */
	prefix: string;
	/** Patch number within the series, or null to omit the `n/m` suffix. */
	number: number | null;
	/** Total number of patches in the series (used with `number`). */
	total: number;
	/** Folded subject line (see {@link splitMessage}). */
	subject: string;
	/** Message body (may be empty), already including any signoff trailer. */
	body: string;
	/** Rendered diffstat block ending in a newline, or "" for no stat. */
	diffStat: string;
	/** Unified diff text ending in a newline, or "" for no diff. */
	diff: string;
	/** Signature footer text (the `-- \n<signature>` value). */
	signature: string;
}

/**
 * Render one mbox message. The returned text ends at `<signature>\n`; callers
 * append the trailing blank line that separates records (one for a file, one
 * between concatenated `--stdout` messages).
 */
export function formatPatchMessage(input: FormatPatchMessageInput): string {
	const { sha, author, prefix, number, total, subject, body, diffStat, diff, signature } = input;

	// git zero-pads the sequence number to the width of the total, e.g.
	// `[PATCH 01/10]` … `[PATCH 10/10]` (see `fmt_patch_suffix` / `nr` width).
	const numberSuffix =
		number !== null ? ` ${String(number).padStart(String(total).length, "0")}/${total}` : "";
	const bracket = `[${prefix}${numberSuffix}]`;
	const subjectValue = headerNeedsEncoding(subject) ? encodeHeaderWord(subject) : subject;

	const fromName = headerNeedsEncoding(author.name) ? encodeHeaderWord(author.name) : author.name;

	const needsMime =
		headerNeedsEncoding(subject) || headerNeedsEncoding(author.name) || headerNeedsEncoding(body);

	let out = "";
	out += `From ${sha} ${MBOX_SENTINEL_DATE}\n`;
	out += `From: ${fromName} <${author.email}>\n`;
	out += `Date: ${formatRFC2822(author.timestamp, author.timezone)}\n`;
	out += `Subject: ${bracket} ${subjectValue}\n`;
	if (needsMime) {
		out += "MIME-Version: 1.0\n";
		out += "Content-Type: text/plain; charset=UTF-8\n";
		out += "Content-Transfer-Encoding: 8bit\n";
	}
	out += "\n";
	if (body !== "") {
		out += `${body}\n`;
	}
	// An empty commit (no diffstat and no diff) has no patch section at all:
	// git goes straight from the message to the `-- ` signature, omitting the
	// `---` separator. Only emit the section when there's something to show.
	if (diffStat !== "" || diff !== "") {
		out += "---\n";
		out += diffStat;
		out += "\n";
		out += diff;
	}
	out += "-- \n";
	out += `${signature}\n`;
	return out;
}

/** git's default `comment_line_char`. */
const COMMENT_CHAR = "#";

/**
 * git's `git_generated_prefixes` (trailer.c): line prefixes always recognized as
 * trailers even without a `key: value` separator.
 */
const GIT_GENERATED_PREFIXES = ["Signed-off-by: ", "(cherry picked from commit "];

/** A line that is empty or only whitespace (git's `is_blank_line`). */
function isBlankLine(line: string): boolean {
	return line.trim() === "";
}

/**
 * Port of git's `find_separator(line, ":")`: the offset of the `:` that closes a
 * trailer token, or -1. The token may only contain alnum / `-`, with whitespace
 * tolerated between the token and the separator.
 */
function findSeparator(line: string): number {
	let whitespaceFound = false;
	for (let i = 0; i < line.length; i++) {
		const c = line[i] as string;
		if (c === ":") return i;
		if (!whitespaceFound && (/[A-Za-z0-9]/.test(c) || c === "-")) continue;
		if (i !== 0 && (c === " " || c === "\t")) {
			whitespaceFound = true;
			continue;
		}
		break;
	}
	return -1;
}

/**
 * Port of git's `find_trailer_block_start` (trailer.c): does `message` end in a
 * recognized trailer block?
 *
 * `message` must include the subject as its first paragraph — git excludes the
 * first paragraph as the title, so the body's own first paragraph stays
 * trailer-eligible. A block is recognized when, reading up from the end to the
 * nearest blank line, the lines are either all trailers, or contain a
 * git-generated trailer and are at least 25% trailers.
 */
function endsWithTrailerBlock(message: string): boolean {
	const lines = message.split("\n");

	// The first paragraph is the title and cannot be trailers.
	let endOfTitle = -1;
	for (let i = 0; i < lines.length; i++) {
		const s = lines[i] as string;
		if (s.startsWith(COMMENT_CHAR)) continue;
		if (isBlankLine(s)) {
			endOfTitle = i;
			break;
		}
	}
	if (endOfTitle === -1) return false; // no blank line: the whole buffer is title

	let onlySpaces = true;
	let recognizedPrefix = false;
	let trailerLines = 0;
	let nonTrailerLines = 0;
	let possibleContinuationLines = 0;

	for (let l = lines.length - 1; l >= endOfTitle; l--) {
		const bol = lines[l] as string;

		if (bol.startsWith(COMMENT_CHAR)) {
			nonTrailerLines += possibleContinuationLines;
			possibleContinuationLines = 0;
			continue;
		}
		if (isBlankLine(bol)) {
			if (onlySpaces) continue;
			nonTrailerLines += possibleContinuationLines;
			if (recognizedPrefix && trailerLines * 3 >= nonTrailerLines) return true;
			if (trailerLines > 0 && nonTrailerLines === 0) return true;
			return false;
		}
		onlySpaces = false;

		let matchedPrefix = false;
		for (const p of GIT_GENERATED_PREFIXES) {
			if (bol.startsWith(p)) {
				trailerLines++;
				possibleContinuationLines = 0;
				recognizedPrefix = true;
				matchedPrefix = true;
				break;
			}
		}
		if (matchedPrefix) continue;

		const firstIsSpace = bol[0] === " " || bol[0] === "\t";
		if (findSeparator(bol) >= 1 && !firstIsSpace) {
			// A `key: value` line. git only sets `recognized_prefix` here when
			// the token matches a configured trailer; format-patch runs with no
			// such config, so we never do.
			trailerLines++;
			possibleContinuationLines = 0;
		} else if (firstIsSpace) {
			possibleContinuationLines++;
		} else {
			nonTrailerLines++;
			nonTrailerLines += possibleContinuationLines;
			possibleContinuationLines = 0;
		}
	}

	return false;
}

/**
 * Append a `Signed-off-by` trailer the way `git format-patch --signoff` does
 * (git's `append_signoff`): the signoff becomes the whole body when empty; it
 * joins an existing trailer block directly; otherwise it is separated from the
 * body by a blank line. The blank-line decision mirrors git's trailer-block
 * detection, so it is driven by the full message (`subject` + `body`), since git
 * excludes the subject as the title before scanning for trailers.
 */
export function appendSignoff(subject: string, body: string, signoffLine: string): string {
	if (body === "") return signoffLine;
	const hasTrailerBlock = endsWithTrailerBlock(`${subject}\n\n${body}`);
	return hasTrailerBlock ? `${body}\n${signoffLine}` : `${body}\n\n${signoffLine}`;
}

/**
 * Sanitize a commit subject into a patch filename slug, matching git's
 * `format_sanitized_subject`: keep alnum / `.` / `_`, collapse every other run
 * into a single `-`, drop runs of `.`, trim trailing `.`/`-`, and cap length.
 */
export function sanitizeSubjectForFilename(subject: string, maxLen = 52): string {
	let out = "";
	// 2 = at start (suppress leading dash), 1 = gap seen, 0 = last char was kept
	let space = 2;
	for (let i = 0; i < subject.length && out.length < maxLen; i++) {
		const ch = subject[i] as string;
		if (/[A-Za-z0-9._]/.test(ch)) {
			if (space === 1) out += "-";
			space = 0;
			out += ch;
			if (ch === ".") {
				while (subject[i + 1] === ".") i++;
			}
		} else {
			space |= 1;
		}
	}
	out = out.slice(0, maxLen);
	return out.replace(/[.-]+$/, "");
}
