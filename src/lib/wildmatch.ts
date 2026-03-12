/**
 * Git-compatible wildmatch pattern matching.
 *
 * Port of git's wildmatch.c (originally from rsync, by Rich Salz / Wayne Davison).
 * Supports *, ?, [...] character classes, \-escaping, and ** for cross-directory
 * matching when WM_PATHNAME is set.
 */

export const WM_CASEFOLD = 1;
export const WM_PATHNAME = 2;

export const WM_MATCH = 0;
const WM_NOMATCH = 1;

const ABORT_ALL = -1;
const ABORT_TO_STARSTAR = -2;

const NEGATE_CLASS = "!";
const NEGATE_CLASS2 = "^";

function isAlnum(c: string): boolean {
	return /^[a-zA-Z0-9]$/.test(c);
}
function isAlpha(c: string): boolean {
	return /^[a-zA-Z]$/.test(c);
}
function isDigit(c: string): boolean {
	return c >= "0" && c <= "9";
}
function isUpper(c: string): boolean {
	return c >= "A" && c <= "Z";
}
function isLower(c: string): boolean {
	return c >= "a" && c <= "z";
}
function isSpace(c: string): boolean {
	return /^\s$/.test(c);
}
function isBlank(c: string): boolean {
	return c === " " || c === "\t";
}
function isPrint(c: string): boolean {
	const code = c.charCodeAt(0);
	return code >= 0x20 && code <= 0x7e;
}
function isGraph(c: string): boolean {
	return isPrint(c) && !isSpace(c);
}
function isPunct(c: string): boolean {
	return isPrint(c) && !isAlnum(c) && c !== " ";
}
function isCntrl(c: string): boolean {
	const code = c.charCodeAt(0);
	return code < 0x20 || code === 0x7f;
}
function isXdigit(c: string): boolean {
	return /^[0-9a-fA-F]$/.test(c);
}

function charEqual(a: string, b: string, casefold: boolean): boolean {
	if (casefold) return a.toLowerCase() === b.toLowerCase();
	return a === b;
}

function dowild(pattern: string, pi: number, text: string, ti: number, flags: number): number {
	const casefold = (flags & WM_CASEFOLD) !== 0;
	const pathname = (flags & WM_PATHNAME) !== 0;

	while (pi < pattern.length) {
		const pCh = pattern[pi]!;

		if (ti >= text.length && pCh !== "*") return ABORT_ALL;

		const tCh = ti < text.length ? text[ti]! : "";

		switch (pCh) {
			case "\\": {
				pi++;
				if (pi >= pattern.length) return ABORT_ALL;
				if (!charEqual(text[ti]!, pattern[pi]!, casefold)) return WM_NOMATCH;
				ti++;
				pi++;
				break;
			}

			case "?": {
				if (pathname && tCh === "/") return WM_NOMATCH;
				ti++;
				pi++;
				break;
			}

			case "*": {
				let matchSlash: boolean;
				pi++;

				if (pi < pattern.length && pattern[pi] === "*") {
					const prevPos = pi;
					while (pi < pattern.length && pattern[pi] === "*") pi++;

					if (!pathname) {
						matchSlash = true;
					} else if (
						(prevPos - 1 < 1 || pattern[prevPos - 2] === "/") &&
						(pi >= pattern.length ||
							pattern[pi] === "/" ||
							(pattern[pi] === "\\" && pi + 1 < pattern.length && pattern[pi + 1] === "/"))
					) {
						if (
							pi < pattern.length &&
							pattern[pi] === "/" &&
							dowild(pattern, pi + 1, text, ti, flags) === WM_MATCH
						) {
							return WM_MATCH;
						}
						matchSlash = true;
					} else {
						matchSlash = false;
					}
				} else {
					matchSlash = !pathname;
				}

				if (pi >= pattern.length) {
					if (!matchSlash) {
						if (text.indexOf("/", ti) !== -1) return ABORT_TO_STARSTAR;
					}
					return WM_MATCH;
				}

				if (!matchSlash && pattern[pi] === "/") {
					const slashIdx = text.indexOf("/", ti);
					if (slashIdx === -1) return ABORT_ALL;
					ti = slashIdx + 1;
					pi++;
					break;
				}

				while (true) {
					if (ti >= text.length) break;

					if (!isGlobSpecial(pattern[pi]!)) {
						const pLit = casefold ? pattern[pi]!.toLowerCase() : pattern[pi]!;
						while (ti < text.length && (matchSlash || text[ti]! !== "/")) {
							const tc = casefold ? text[ti]!.toLowerCase() : text[ti]!;
							if (tc === pLit) break;
							ti++;
						}
						if (ti >= text.length || (!matchSlash && text[ti] === "/")) {
							if (ti < text.length && !matchSlash && text[ti] === "/") {
								return ABORT_TO_STARSTAR;
							}
							return matchSlash ? ABORT_ALL : ABORT_TO_STARSTAR;
						}
					}

					const matched = dowild(pattern, pi, text, ti, flags);
					if (matched !== WM_NOMATCH) {
						if (!matchSlash || matched !== ABORT_TO_STARSTAR) return matched;
					} else if (!matchSlash && text[ti] === "/") {
						return ABORT_TO_STARSTAR;
					}
					ti++;
				}
				return ABORT_ALL;
			}

			case "[": {
				if (pathname && tCh === "/") return WM_NOMATCH;

				pi++;
				if (pi >= pattern.length) return ABORT_ALL;

				let negated = false;
				if (pattern[pi] === NEGATE_CLASS || pattern[pi] === NEGATE_CLASS2) {
					negated = true;
					pi++;
				}

				let matched = false;
				let prevCh = "";
				let first = true;

				while (pi < pattern.length && (first || pattern[pi]! !== "]")) {
					first = false;
					let classCh = pattern[pi]!;

					if (classCh === "\\") {
						pi++;
						if (pi >= pattern.length) return ABORT_ALL;
						classCh = pattern[pi]!;
						if (charEqual(tCh, classCh, casefold)) matched = true;
					} else if (
						classCh === "-" &&
						prevCh &&
						pi + 1 < pattern.length &&
						pattern[pi + 1] !== "]"
					) {
						pi++;
						classCh = pattern[pi]!;
						if (classCh === "\\") {
							pi++;
							if (pi >= pattern.length) return ABORT_ALL;
							classCh = pattern[pi]!;
						}
						const lo = prevCh;
						const hi = classCh;
						if (tCh >= lo && tCh <= hi) matched = true;
						if (casefold) {
							if (isLower(tCh)) {
								const upper = tCh.toUpperCase();
								if (upper >= lo && upper <= hi) matched = true;
							} else if (isUpper(tCh)) {
								const lower = tCh.toLowerCase();
								if (lower >= lo && lower <= hi) matched = true;
							}
						}
						classCh = "";
					} else if (classCh === "[" && pi + 1 < pattern.length && pattern[pi + 1] === ":") {
						pi += 2;
						const classStart = pi;
						while (pi < pattern.length && pattern[pi] !== "]") pi++;
						if (pi >= pattern.length) return ABORT_ALL;
						const classLen = pi - classStart - 1;
						if (classLen < 0 || pattern[pi - 1] !== ":") {
							pi = classStart - 2;
							classCh = "[";
							if (charEqual(tCh, classCh, casefold)) matched = true;
						} else {
							const className = pattern.slice(classStart, classStart + classLen);
							if (matchPosixClass(className, tCh, casefold)) matched = true;
							classCh = "";
						}
					} else {
						if (charEqual(tCh, classCh, casefold)) matched = true;
					}

					prevCh = classCh;
					pi++;
				}

				if (pi >= pattern.length) return ABORT_ALL;
				pi++; // skip ']'

				if (matched === negated) return WM_NOMATCH;
				ti++;
				break;
			}

			default: {
				if (!charEqual(tCh, pCh, casefold)) return WM_NOMATCH;
				ti++;
				pi++;
				break;
			}
		}
	}

	return ti >= text.length ? WM_MATCH : WM_NOMATCH;
}

function isGlobSpecial(ch: string): boolean {
	return ch === "*" || ch === "?" || ch === "[" || ch === "\\";
}

function matchPosixClass(className: string, ch: string, casefold: boolean): boolean {
	switch (className) {
		case "alnum":
			return isAlnum(ch);
		case "alpha":
			return isAlpha(ch);
		case "blank":
			return isBlank(ch);
		case "cntrl":
			return isCntrl(ch);
		case "digit":
			return isDigit(ch);
		case "graph":
			return isGraph(ch);
		case "lower":
			return isLower(ch) || (casefold && isUpper(ch));
		case "print":
			return isPrint(ch);
		case "punct":
			return isPunct(ch);
		case "space":
			return isSpace(ch);
		case "upper":
			return isUpper(ch) || (casefold && isLower(ch));
		case "xdigit":
			return isXdigit(ch);
		default:
			return false;
	}
}

/**
 * Match `pattern` against `text` using git's wildmatch rules.
 *
 * Flags:
 * - `WM_PATHNAME`: `*` and `?` do not match `/`. `**` matches across `/`.
 * - `WM_CASEFOLD`: case-insensitive matching.
 *
 * Returns `WM_MATCH` (0) on match, `WM_NOMATCH` (1) on no match.
 */
export function wildmatch(pattern: string, text: string, flags: number = 0): number {
	const res = dowild(pattern, 0, text, 0, flags);
	return res === WM_MATCH ? WM_MATCH : WM_NOMATCH;
}
