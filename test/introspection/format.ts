// Presentation helpers for ad-hoc introspection scripts. Kept separate from
// `query.ts` (which stays analysis-only) — these just turn query results into
// readable console output.

/**
 * Render a square count matrix (as produced by `groupMatrix` /
 * `directoryMatrix`) as a fixed-width ASCII table where rows import columns.
 *
 * @example
 * console.log(formatMatrix(directoryMatrix(graph, { depth: 1 })));
 */
export function formatMatrix(
	matrix: Map<string, Map<string, number>>,
	opts: { empty?: string; labelWidth?: number; colWidth?: number; truncate?: number } = {},
): string {
	const empty = opts.empty ?? "·";
	const groups = new Set<string>();
	for (const [from, row] of matrix) {
		groups.add(from);
		for (const to of row.keys()) groups.add(to);
	}
	const keys = [...groups].sort();
	const trunc = opts.truncate ?? 9;
	const short = (s: string) => (s.length > trunc ? s.slice(0, trunc) : s);
	const labelWidth = opts.labelWidth ?? Math.max(8, ...keys.map((k) => k.length));
	const colWidth = opts.colWidth ?? Math.max(7, ...keys.map((k) => short(k).length + 1));

	const lines: string[] = [];
	lines.push(" ".repeat(labelWidth) + keys.map((k) => short(k).padStart(colWidth)).join(""));
	for (const from of keys) {
		const row = matrix.get(from);
		let line = from.padEnd(labelWidth);
		for (const to of keys) {
			const v = row?.get(to);
			line += (v === undefined ? empty : String(v)).padStart(colWidth);
		}
		lines.push(line);
	}
	return lines.join("\n");
}

/** Render a `name -> count` map as a sorted (descending) aligned list. */
export function formatCounts(
	counts: Map<string, number>,
	opts: { labelWidth?: number; limit?: number } = {},
): string {
	const entries = [...counts.entries()].sort((a, b) => b[1] - a[1]);
	const shown = opts.limit ? entries.slice(0, opts.limit) : entries;
	const labelWidth = opts.labelWidth ?? Math.max(8, ...shown.map(([k]) => k.length));
	return shown.map(([k, v]) => `  ${k.padEnd(labelWidth)} ${v}`).join("\n");
}
