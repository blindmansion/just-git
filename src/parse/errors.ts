import type { ParseError } from "./types.ts";

// ============================================================================
// Error formatting
// ============================================================================

/** Format a single parse error into a human-readable message */
function formatError(error: ParseError): string {
	switch (error.type) {
		case "unknown_option": {
			let msg = `Unknown option "${error.name}".`;
			if (error.suggestions.length > 0) {
				msg += ` Did you mean ${error.suggestions.map((s) => `"${s}"`).join(" or ")}?`;
			}
			return msg;
		}

		case "invalid_type":
			return `Invalid value for "${error.name}": expected ${error.expected}, got "${error.received}".`;

		case "missing_required":
			return error.kind === "option"
				? `Missing required option "--${error.name}".`
				: `Missing required argument <${error.name}>.`;

		case "unexpected_positional":
			return error.maxPositionals === 0
				? `Unexpected argument "${error.value}". This command takes no positional arguments.`
				: `Unexpected argument "${error.value}". Expected at most ${error.maxPositionals} positional argument${error.maxPositionals === 1 ? "" : "s"}.`;

		case "missing_value":
			return `Option "--${error.name}" requires a value.`;

		case "unknown_command": {
			let msg = `Unknown command "${error.path}".`;
			if (error.suggestions.length > 0) {
				msg += ` Did you mean ${error.suggestions.map((s) => `"${s}"`).join(" or ")}?`;
			}
			return msg;
		}
	}
}

/** Format multiple parse errors into a single string */
export function formatErrors(errors: ParseError[]): string {
	return errors.map(formatError).join("\n");
}

// ============================================================================
// Levenshtein distance (for "did you mean?" suggestions)
// ============================================================================

/** Compute Levenshtein distance between two strings */
function levenshtein(a: string, b: string): number {
	const m = a.length;
	const n = b.length;

	const dp: number[] = new Array((m + 1) * (n + 1));

	for (let i = 0; i <= m; i++) dp[i * (n + 1)] = i;
	for (let j = 0; j <= n; j++) dp[j] = j;

	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			dp[i * (n + 1) + j] = Math.min(
				dp[(i - 1) * (n + 1) + j]! + 1,
				dp[i * (n + 1) + (j - 1)]! + 1,
				dp[(i - 1) * (n + 1) + (j - 1)]! + cost,
			);
		}
	}

	return dp[m * (n + 1) + n]!;
}

/** Find suggestions from a list of candidates within a distance threshold */
export function findSuggestions(
	input: string,
	candidates: string[],
	maxDistance?: number,
): string[] {
	const limit = maxDistance ?? Math.min(Math.max(1, Math.floor(input.length / 2)), 3);
	const scored = candidates
		.map((c) => ({ candidate: c, distance: levenshtein(input, c) }))
		.filter((x) => x.distance <= limit && x.distance > 0)
		.sort((a, b) => a.distance - b.distance);

	return scored.slice(0, 2).map((x) => x.candidate);
}
