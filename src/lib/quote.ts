const encoder = new TextEncoder();

const C_ESCAPES: Record<number, string> = {
	0x07: "\\a",
	0x08: "\\b",
	0x09: "\\t",
	0x0a: "\\n",
	0x0b: "\\v",
	0x0c: "\\f",
	0x0d: "\\r",
	0x22: '\\"',
	0x5c: "\\\\",
};

/** Whether a UTF-16 code unit needs quoting: a control character, `"`, `\`, DEL or non-ASCII. */
function needsQuote(code: number): boolean {
	return code < 0x20 || code >= 0x7f || code === 0x22 || code === 0x5c;
}

/**
 * Quote a path the way git's `quote_c_style` does with `core.quotePath` on:
 * paths with control characters, `"`, `\` or non-ASCII bytes are wrapped in
 * double quotes, with C escapes for the usual control characters and octal
 * escapes for every other such byte. Other paths are returned unchanged.
 */
export function quoteCPath(path: string): string {
	let i = 0;
	while (i < path.length && !needsQuote(path.charCodeAt(i))) i++;
	if (i === path.length) return path;

	let out = path.slice(0, i);
	for (const byte of encoder.encode(path.slice(i))) {
		const escape = C_ESCAPES[byte];
		if (escape) out += escape;
		else if (byte < 0x20 || byte >= 0x7f) out += `\\${byte.toString(8).padStart(3, "0")}`;
		else out += String.fromCharCode(byte);
	}
	return `"${out}"`;
}
