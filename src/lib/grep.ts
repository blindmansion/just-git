/**
 * Core grep matching logic shared by the `git grep` command and the
 * repo-level `grep` helper.
 */

export interface GrepMatch {
	lineNo: number;
	line: string;
}

interface GrepFileResult {
	matches: GrepMatch[];
	binary: boolean;
}

const NULL_BYTE_THRESHOLD = 0.01;

function looksLikeBinary(text: string): boolean {
	const len = Math.min(text.length, 8000);
	let nulls = 0;
	for (let i = 0; i < len; i++) {
		if (text.charCodeAt(i) === 0) nulls++;
	}
	return nulls > len * NULL_BYTE_THRESHOLD;
}

/**
 * Run grep patterns against file content.
 *
 * - Multiple patterns are OR-matched (any pattern hits → line matches).
 * - With `allMatch`, ALL patterns must hit at least one line in the
 *   file for any results to be returned (per-line matching is still OR).
 */
export function grepContent(
	content: string,
	patterns: RegExp[],
	allMatch: boolean,
	invert: boolean,
): GrepFileResult {
	if (looksLikeBinary(content)) {
		const hasMatch = patterns.some((p) => p.test(content));
		return { matches: [], binary: hasMatch };
	}

	const lines = content.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

	if (allMatch && patterns.length > 1) {
		const allHit = patterns.every((p) => lines.some((l) => p.test(l)));
		if (!allHit) return { matches: [], binary: false };
	}

	const matches: GrepMatch[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const hit = patterns.some((p) => p.test(line));
		if (invert ? !hit : hit) {
			matches.push({ lineNo: i + 1, line });
		}
	}

	return { matches, binary: false };
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compile a raw pattern string into a RegExp.
 * Returns null when the pattern is invalid.
 */
export function compilePattern(
	raw: string,
	opts?: { fixed?: boolean; ignoreCase?: boolean; wordRegexp?: boolean },
): RegExp | null {
	let src = opts?.fixed ? escapeRegex(raw) : raw;
	if (opts?.wordRegexp) src = `\\b${src}\\b`;
	const flags = opts?.ignoreCase ? "i" : "";
	try {
		return new RegExp(src, flags);
	} catch {
		return null;
	}
}
