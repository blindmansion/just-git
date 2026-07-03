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
function headerNeedsEncoding(text: string): boolean {
	return !isAscii(text);
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

	const numberSuffix = number !== null ? ` ${number}/${total}` : "";
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
	out += "---\n";
	out += diffStat;
	out += "\n";
	out += diff;
	out += "-- \n";
	out += `${signature}\n`;
	return out;
}

/**
 * Append a `Signed-off-by` trailer to a body the way `git format-patch
 * --signoff` does: it becomes the whole body when empty, joins an existing
 * trailer block directly, and is otherwise separated by a blank line.
 */
export function appendSignoff(body: string, signoffLine: string): string {
	if (body === "") return signoffLine;
	const lines = body.split("\n");
	const lastLine = lines[lines.length - 1] ?? "";
	const isTrailerBlock = /^[A-Za-z][A-Za-z-]*: /.test(lastLine);
	return isTrailerBlock ? `${body}\n${signoffLine}` : `${body}\n\n${signoffLine}`;
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
