import type { BisectResult, BisectState } from "../lib/bisect.ts";

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
