// Formatting for user-facing ref output: the columnar fetch/push/pull
// transfer lines.

// ── Transfer output formatting (fetch / push / pull) ────────────────

export interface TransferRefLine {
	prefix: string;
	from: string;
	to: string;
	suffix?: string;
}

/**
 * Format aligned ref-update lines for fetch/push/pull output.
 * Matches real git's columnar alignment: fixed-width summary column,
 * right-padded "from" ref, ` -> to` with optional suffix.
 *
 * Fetch/pull pads the "from" column to align arrows; push does not.
 */
export function formatTransferRefLines(
	lines: TransferRefLine[],
	minRefCol = 0,
	padFrom = true,
): string {
	const SUMMARY_WIDTH = 21;
	const maxFromLen = padFrom ? Math.max(minRefCol, ...lines.map((l) => l.from.length)) : 0;
	return lines
		.map((l) => {
			const summary = l.prefix.padEnd(SUMMARY_WIDTH);
			if (!l.to) return `${summary}${l.from}\n`;
			const from = maxFromLen > 0 ? l.from.padEnd(maxFromLen) : l.from;
			const suffix = l.suffix ? ` ${l.suffix}` : "";
			return `${summary}${from} -> ${l.to}${suffix}\n`;
		})
		.join("");
}

/**
 * Build TransferRefLines from a set of ref updates (shared by fetch and pull).
 * Each update carries the remote ref, the local tracking ref, and the
 * old hash (null when the tracking ref didn't exist before).
 */
export function buildRefUpdateLines(
	updates: Array<{
		remote: { name: string; hash: string };
		localRef: string;
		oldHash: string | null;
	}>,
	shortenRef: (name: string) => string,
	abbreviateHashFn: (hash: string) => string,
): TransferRefLine[] {
	const lines: TransferRefLine[] = [];
	for (const u of updates) {
		const shortRemote = shortenRef(u.remote.name);
		const shortLocal = shortenRef(u.localRef);
		if (!u.oldHash) {
			const isTag = u.remote.name.startsWith("refs/tags/");
			const prefix = isTag ? " * [new tag]" : " * [new branch]";
			lines.push({ prefix, from: shortRemote, to: shortLocal });
		} else if (u.oldHash !== u.remote.hash) {
			const shortOld = abbreviateHashFn(u.oldHash);
			const shortNew = abbreviateHashFn(u.remote.hash);
			lines.push({ prefix: `   ${shortOld}..${shortNew}`, from: shortRemote, to: shortLocal });
		}
	}
	return lines;
}
