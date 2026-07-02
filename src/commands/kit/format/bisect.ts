import type { BisectResult, BisectState } from "../../../lib/bisect.ts";

export interface FirstBadCommitInfo {
	hash: string;
	subject: string;
	authorName: string;
	authorEmail: string;
	/** Author timestamp in seconds since the epoch. */
	authorTimestamp: number;
}

/**
 * Render git's "first bad commit found" summary block.
 * The caller supplies the commit fields; this stays a pure renderer.
 */
export function renderFirstBadCommit(info: FirstBadCommitInfo): string {
	const dateStr = new Date(info.authorTimestamp * 1000).toUTCString().replace("GMT", "+0000");
	return (
		`${info.hash} is the first bad commit\n` +
		`commit ${info.hash}\n` +
		`Author: ${info.authorName} <${info.authorEmail}>\n` +
		`Date:   ${dateStr}\n` +
		`\n` +
		`    ${info.subject}\n` +
		`\n`
	);
}

export function formatBisectStatus(state: BisectState): string {
	const hasBad = state.badHash != null;
	const goodCount = state.goodHashes.length;

	if (!hasBad && goodCount === 0) {
		return `status: waiting for both ${state.termGood} and ${state.termBad} commits\n`;
	}
	if (!hasBad) {
		return `status: waiting for ${state.termBad} commit, ${goodCount} ${state.termGood} commit(s) known\n`;
	}
	if (goodCount === 0) {
		return `status: waiting for ${state.termGood} commit(s), ${state.termBad} commit known\n`;
	}
	return "";
}

/**
 * Format the bisecting progress line:
 * "Bisecting: N revisions left to test after this (roughly M steps)"
 */
export function formatBisectingLine(result: BisectResult): string {
	return (
		`Bisecting: ${result.remaining} revision${result.remaining === 1 ? "" : "s"} left to test after this (roughly ${result.steps} step${result.steps === 1 ? "" : "s"})\n` +
		`[${result.hash}] ${result.subject}\n`
	);
}
