/**
 * Mbox reader — the inverse of `format-patch`'s message writer.
 *
 * Two pure, I/O-free stages that `git am` drives:
 *   1. {@link splitMailbox} breaks a concatenated mailbox into per-message raw
 *      texts on the `From <hex> Mon Sep 17...` record separator (git's
 *      `mailsplit`).
 *   2. {@link parseMail} turns one raw message into `{ author, subject, body,
 *      patchText, raw }` (git's `mailinfo` / `cleanup_subject`), splitting the
 *      commit message from the diff that trails it.
 *
 * The low-level RFC-2047 header codec lives in `./mbox.ts`
 * ({@link decodeHeaderWord}); the RFC-2822 date parser lives in `../date.ts`
 * ({@link parseRFC2822}). This module is the higher-level message parsing that
 * ties them together. Ported from git's `mailsplit.c` / `mailinfo.c` for
 * behavior only.
 */
import { parseRFC2822 } from "../date.ts";
import type { Identity } from "../types.ts";
import { decodeHeaderWord } from "./mbox.ts";

/** Options controlling `mailinfo`'s cleanup, mirroring `git am`'s flags. */
export interface MailInfoOptions {
	/** `-k/--keep`: keep the subject verbatim (don't strip `Re:` / `[PATCH]`). */
	keep?: boolean;
	/** `--scissors`: discard everything at or above a `-- >8 --` scissors line. */
	scissors?: boolean;
	/** `--keep-cr`: keep a trailing `\r` on body/patch lines (default strips). */
	keepCr?: boolean;
}

/** One parsed message: the pieces `git am` needs to write a commit. */
export interface ParsedMail {
	/** Author name/email/date, from the `From:`/`Date:` (or in-body) headers. */
	author: Identity;
	/** Cleaned subject (prefix-stripped unless `-k`); the commit's first line. */
	subject: string;
	/** Commit message body: the text between the subject and the diff / `---`. */
	body: string;
	/** Everything from the first diff header onward, for `parsePatch`. Empty ⇒
	 * git's "Patch is empty" case. */
	patchText: string;
	/** The original message text (for `--show-current-patch`). */
	raw: string;
}

/** Strip a single trailing `\r` (mbox lines split on `\n` keep a lone CR). */
function chompCr(line: string): string {
	return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/**
 * Recognize an mbox record separator (git's `mailsplit` `is_from_line`): a line
 * of the form `From <ident> <date>` whose date carries a `HH:MM:SS` time and a
 * 4-digit year. Strict enough to avoid matching a literal `From ` line inside a
 * patch body, which a unified diff always prefixes with a space or `+`.
 */
function isMboxFromLine(line: string): boolean {
	return /^From \S.*\b\d{2}:\d{2}:\d{2}\b.*\b\d{4}\b/.test(line);
}

/**
 * Split a concatenated mailbox into per-message raw texts. Each element keeps
 * its verbatim text (the leading `From ` separator included) so it can be
 * stored as `0001`, `0002`, … for `--show-current-patch`. A single patch with
 * no `From ` line is returned as one message.
 */
export function splitMailbox(text: string): string[] {
	if (text.trim() === "") return [];

	const messages: string[] = [];
	let current: string[] | null = null;
	for (const line of text.split("\n")) {
		if (isMboxFromLine(chompCr(line))) {
			if (current) messages.push(current.join("\n"));
			current = [line];
		} else if (current) {
			current.push(line);
		} else {
			// Content before any `From ` line: a bare, header-less patch.
			current = [line];
		}
	}
	if (current) messages.push(current.join("\n"));
	return messages;
}

/** A decoded email header value, RFC-2047 encoded-words resolved. */
interface HeaderBlock {
	from: string | null;
	subject: string | null;
	date: string | null;
	/** Index of the first body line (past the blank line closing the block). */
	bodyStart: number;
}

/**
 * Resolve RFC-2047 encoded-words in a header value. Whitespace separating two
 * adjacent encoded-words is dropped per RFC-2047 §6.2; other text is kept.
 */
function decodeHeaderValue(value: string): string {
	const tokenRe = /=\?[^?]+\?[bBqQ]\?[^?]*\?=/g;
	let out = "";
	let lastIndex = 0;
	let prevWasEncoded = false;
	let m: RegExpExecArray | null;
	while ((m = tokenRe.exec(value)) !== null) {
		const between = value.slice(lastIndex, m.index);
		const decoded = decodeHeaderWord(m[0]);
		if (decoded === null) {
			out += between + m[0];
			prevWasEncoded = false;
		} else {
			if (!(prevWasEncoded && between.trim() === "")) out += between;
			out += decoded;
			prevWasEncoded = true;
		}
		lastIndex = tokenRe.lastIndex;
	}
	out += value.slice(lastIndex);
	return out;
}

/**
 * Read the leading header block (up to the first blank line), unfolding
 * continuation lines (leading whitespace) and RFC-2047 decoding the values we
 * care about. A leading mbox `From ` separator is skipped first.
 */
function parseHeaderBlock(lines: string[]): HeaderBlock {
	let i = 0;
	if (i < lines.length && isMboxFromLine(lines[i] as string)) i++;

	const raw = new Map<string, string>();
	let lastKey: string | null = null;
	for (; i < lines.length; i++) {
		const line = lines[i] as string;
		if (line === "") {
			i++;
			break;
		}
		if ((line.startsWith(" ") || line.startsWith("\t")) && lastKey) {
			// Folded continuation: unfolding keeps the leading whitespace.
			raw.set(lastKey, `${raw.get(lastKey) ?? ""}${line}`);
			continue;
		}
		const sep = line.indexOf(":");
		if (sep <= 0) {
			// Not a header line — treat the block as ended.
			break;
		}
		const key = line.slice(0, sep).toLowerCase();
		const val = line.slice(sep + 1).replace(/^\s+/, "");
		if (!raw.has(key)) raw.set(key, val);
		lastKey = key;
	}

	const decode = (key: string): string | null => {
		const v = raw.get(key);
		return v === undefined ? null : decodeHeaderValue(v);
	};

	return { from: decode("from"), subject: decode("subject"), date: decode("date"), bodyStart: i };
}

/** Split a `From:` header value into a name + email (git's `handle_from`). */
function parseFromHeader(value: string): { name: string; email: string } {
	const angle = /^\s*(.*?)\s*<([^>]*)>\s*$/.exec(value);
	if (angle) {
		let name = (angle[1] as string).trim();
		name = name.replace(/^"(.*)"$/, "$1").trim();
		return { name, email: (angle[2] as string).trim() };
	}
	const trimmed = value.trim();
	const comment = /^(\S+)\s*\(([^)]*)\)\s*$/.exec(trimmed);
	if (comment) return { name: (comment[2] as string).trim(), email: (comment[1] as string).trim() };
	return { name: "", email: trimmed };
}

/**
 * Clean a subject the way `cleanup_subject` does: strip leading `Re:` and one
 * or more `[...]` bracket prefixes (`[PATCH]`, `[RFC PATCH v2]`, …), then
 * collapse whitespace. With `keep`, only the whitespace collapse runs.
 */
function cleanupSubject(subject: string, keep: boolean): string {
	if (keep) return subject.replace(/\s+/g, " ").trim();
	let s = subject;
	for (;;) {
		const trimmed = s.replace(/^\s+/, "");
		const re = /^re\s*:\s*/i.exec(trimmed);
		if (re) {
			s = trimmed.slice(re[0].length);
			continue;
		}
		if (trimmed.startsWith("[")) {
			const close = trimmed.indexOf("]");
			if (close !== -1) {
				s = trimmed.slice(close + 1);
				continue;
			}
		}
		s = trimmed;
		break;
	}
	return s.replace(/\s+/g, " ").trim();
}

/**
 * Recognize a scissors ("cut here") line (git's `is_scissors_line`): a run of
 * perforation characters with a `>8` or `8<` gap marker and nothing else.
 */
function isScissorsLine(line: string): boolean {
	const trimmed = line.trim();
	if (trimmed === "") return false;
	if (!trimmed.includes(">8") && !trimmed.includes("8<")) return false;
	return /^[-=_*\\/>8<\s]+$/.test(trimmed) && /[-=_*]/.test(trimmed);
}

/** Does a line begin the diff (git-extended or traditional)? */
function isDiffHeaderLine(line: string): boolean {
	return line.startsWith("diff --git ") || line.startsWith("--- ");
}

/**
 * Parse one raw mbox message into its author / subject / body / patch. Mirrors
 * `mailinfo.c`: header block, subject cleanup, `--scissors`, an in-body `From:`
 * override, then the commit-message / diff split.
 */
export function parseMail(raw: string, opts: MailInfoOptions = {}): ParsedMail {
	const keepCr = opts.keepCr ?? false;
	const rawLines = raw.split("\n");
	const strip = (line: string): string => (keepCr ? line : chompCr(line));
	const headerLines = rawLines.map(chompCr);

	const header = parseHeaderBlock(headerLines);

	let name = "";
	let email = "";
	if (header.from !== null) ({ name, email } = parseFromHeader(header.from));
	let subject = header.subject ?? "";
	let dateStr = header.date;

	// Body region (lines after the header block), CR-normalized per keepCr.
	let bodyLines = rawLines.slice(header.bodyStart).map(strip);

	// `--scissors`: drop everything at or above the cut line, then re-read
	// in-body headers from what remains.
	if (opts.scissors) {
		const cut = bodyLines.findIndex((l) => isScissorsLine(chompCr(l)));
		if (cut !== -1) bodyLines = bodyLines.slice(cut + 1);
	}

	// In-body headers (git's `From:`/`Subject:`/`Date:` recovery): consume any
	// leading blank lines, then header-like lines, overriding the email headers.
	let b = 0;
	while (b < bodyLines.length && chompCr(bodyLines[b] as string).trim() === "") b++;
	while (b < bodyLines.length) {
		const line = chompCr(bodyLines[b] as string);
		const m = /^(From|Subject|Date):\s*(.*)$/i.exec(line);
		if (!m) break;
		const key = (m[1] as string).toLowerCase();
		const value = decodeHeaderValue(m[2] as string);
		if (key === "from") ({ name, email } = parseFromHeader(value));
		else if (key === "subject") subject = value;
		else dateStr = value;
		b++;
	}
	// Skip a single blank line separating recovered headers from the body.
	if (b < bodyLines.length && chompCr(bodyLines[b] as string).trim() === "") b++;
	bodyLines = bodyLines.slice(b);

	// Split the commit message from the diff: the body runs up to the `---`
	// separator or the first diff header; the patch is the diff itself.
	let boundary = bodyLines.length;
	for (let i = 0; i < bodyLines.length; i++) {
		const l = chompCr(bodyLines[i] as string);
		if (l === "---" || isDiffHeaderLine(l)) {
			boundary = i;
			break;
		}
	}
	let diffStart = -1;
	for (let i = boundary; i < bodyLines.length; i++) {
		if (isDiffHeaderLine(chompCr(bodyLines[i] as string))) {
			diffStart = i;
			break;
		}
	}

	const body = bodyLines.slice(0, boundary).join("\n").replace(/^\n+/, "").replace(/\s+$/, "");
	const patchText = diffStart === -1 ? "" : bodyLines.slice(diffStart).join("\n");

	const parsedDate = dateStr ? parseRFC2822(dateStr) : null;
	const author: Identity = {
		name,
		email,
		timestamp: parsedDate?.timestamp ?? 0,
		timezone: parsedDate?.timezone ?? "+0000",
	};

	return {
		author,
		subject: cleanupSubject(subject, opts.keep ?? false),
		body,
		patchText,
		raw,
	};
}
