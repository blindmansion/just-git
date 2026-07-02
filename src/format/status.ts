import type { TrackingInfo } from "../lib/status-format.ts";
/**
 * Format tracking info for `git branch -v`/`-vv` display.
 * Returns bracketed format like `[origin/main: ahead 2, behind 1]`.
 */
export function formatBranchTrackingInfo(info: TrackingInfo, showUpstream: boolean): string {
	if (showUpstream) {
		if (info.gone) return `[${info.upstream}: gone]`;
		if (info.ahead === 0 && info.behind === 0) return `[${info.upstream}]`;
		const parts: string[] = [];
		if (info.ahead > 0) parts.push(`ahead ${info.ahead}`);
		if (info.behind > 0) parts.push(`behind ${info.behind}`);
		return `[${info.upstream}: ${parts.join(", ")}]`;
	}
	if (info.gone) return `[gone]`;
	if (info.ahead === 0 && info.behind === 0) return "";
	const parts: string[] = [];
	if (info.ahead > 0) parts.push(`ahead ${info.ahead}`);
	if (info.behind > 0) parts.push(`behind ${info.behind}`);
	return `[${parts.join(", ")}]`;
}
