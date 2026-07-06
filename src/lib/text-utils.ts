// Small, dependency-free string helpers for commit-message / text handling.

/** Extract the first line (subject) of a commit message. */
export function firstLine(message: string): string {
	const idx = message.indexOf("\n");
	return idx === -1 ? message : message.slice(0, idx);
}

/** Ensure a commit message ends with exactly one newline. */
export function ensureTrailingNewline(msg: string): string {
	return msg.endsWith("\n") ? msg : `${msg}\n`;
}

/**
 * git's `strbuf_stripspace` *without* comment removal (the `skip_comments=0`
 * call `mailinfo` makes on a parsed commit message): trim trailing whitespace
 * from each line, drop leading and trailing blank lines, and collapse
 * consecutive blank lines into one. Two deliberate departures from a literal
 * port, both driven by `git am`'s needs:
 * - `#` lines are preserved (unlike {@link stripCommentLines}) — `am` must
 *   reproduce commit messages verbatim, and a body can legitimately start `#`.
 * - only spaces and tabs are trimmed *per interior line*, not `\r`: an interior
 *   CR is governed by `--keep-cr` upstream (the default already chomps it), so
 *   trimming it here would defeat that flag. The message's overall trailing
 *   whitespace (including a final `\r`) is still stripped.
 * No trailing newline is added.
 */
export function stripSpace(text: string): string {
	const lines = text.split("\n").map((line) => line.replace(/[ \t]+$/, ""));

	while (lines.length > 0 && lines[0] === "") lines.shift();
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

	const result: string[] = [];
	let prevBlank = false;
	for (const line of lines) {
		if (line === "") {
			if (!prevBlank) result.push(line);
			prevBlank = true;
		} else {
			result.push(line);
			prevBlank = false;
		}
	}

	return result.join("\n").replace(/\s+$/, "");
}

/**
 * Clean up a commit message matching git's `strbuf_stripspace` with
 * comment stripping (the default `--cleanup=strip` mode):
 * - Remove lines starting with `#`
 * - Trim trailing whitespace from each line
 * - Strip leading and trailing blank lines
 * - Collapse consecutive blank lines into one
 *
 * Returns `""` when the cleaned message is empty.
 */
export function stripCommentLines(text: string): string {
	const lines = text
		.split("\n")
		.filter((line) => !line.startsWith("#"))
		.map((line) => line.trimEnd());

	while (lines.length > 0 && lines[0] === "") lines.shift();
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

	if (lines.length === 0) return "";

	const result: string[] = [];
	let prevBlank = false;
	for (const line of lines) {
		if (line === "") {
			if (!prevBlank) result.push(line);
			prevBlank = true;
		} else {
			result.push(line);
			prevBlank = false;
		}
	}

	return result.join("\n") + "\n";
}
