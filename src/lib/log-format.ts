import { abbreviateHash, firstLine } from "./command-utils.ts";
import { formatDate } from "./date.ts";
import type { Commit, ObjectId } from "./types.ts";

export interface FormatContext {
	hash: ObjectId;
	commit: Commit;
	decorations?: (hash: ObjectId) => string;
	decorationsRaw?: (hash: ObjectId) => string;
}

/**
 * Expand a git log format string (`%H`, `%h`, `%s`, etc.) against a commit.
 *
 * Supports the commonly-used placeholders:
 *   Hash:       %H %h %T %t %P %p
 *   Author:     %an %ae %at %aI %ai %ad %aD
 *   Committer:  %cn %ce %ct %cI %ci %cd %cD
 *   Message:    %s %b %B
 *   Decoration: %d %D
 *   Misc:       %n %%
 *
 * Unknown `%x` sequences are left as-is (matches git behaviour).
 */
export function expandFormat(fmt: string, ctx: FormatContext): string {
	const { hash, commit } = ctx;
	let result = "";
	let i = 0;

	while (i < fmt.length) {
		if (fmt[i] === "%") {
			const next = fmt[i + 1];
			if (next === undefined) {
				result += "%";
				i++;
				continue;
			}

			// Two-char placeholders (author/committer date variants)
			if ((next === "a" || next === "c") && i + 2 < fmt.length) {
				const sub = fmt[i + 2];
				const id = next === "a" ? commit.author : commit.committer;

				switch (sub) {
					case "n":
						result += id.name;
						i += 3;
						continue;
					case "e":
					case "E":
						result += id.email;
						i += 3;
						continue;
					case "t":
						result += id.timestamp.toString();
						i += 3;
						continue;
					case "I":
						result += formatISO8601Strict(id.timestamp, id.timezone);
						i += 3;
						continue;
					case "i":
						result += formatISO8601(id.timestamp, id.timezone);
						i += 3;
						continue;
					case "d":
						result += formatDate(id.timestamp, id.timezone);
						i += 3;
						continue;
					case "D":
						result += formatRFC2822(id.timestamp, id.timezone);
						i += 3;
						continue;
					case "r":
						result += formatRelativeDate(id.timestamp);
						i += 3;
						continue;
				}
			}

			// Single-char placeholders
			switch (next) {
				case "H":
					result += hash;
					i += 2;
					continue;
				case "h":
					result += abbreviateHash(hash);
					i += 2;
					continue;
				case "T":
					result += commit.tree;
					i += 2;
					continue;
				case "t":
					result += abbreviateHash(commit.tree);
					i += 2;
					continue;
				case "P":
					result += commit.parents.join(" ");
					i += 2;
					continue;
				case "p":
					result += commit.parents.map(abbreviateHash).join(" ");
					i += 2;
					continue;
				case "s":
					result += subject(commit.message);
					i += 2;
					continue;
				case "b":
					result += body(commit.message);
					i += 2;
					continue;
				case "B":
					result += commit.message.replace(/\n$/, "");
					i += 2;
					continue;
				case "d":
					if (ctx.decorations) {
						const d = ctx.decorations(hash);
						result += d ? ` ${d}` : "";
					}
					i += 2;
					continue;
				case "D":
					if (ctx.decorationsRaw) {
						result += ctx.decorationsRaw(hash);
					}
					i += 2;
					continue;
				case "n":
					result += "\n";
					i += 2;
					continue;
				case "%":
					result += "%";
					i += 2;
					continue;
				default:
					result += `%${next}`;
					i += 2;
					continue;
			}
		}

		result += fmt[i];
		i++;
	}

	return result;
}

/** First line of the commit message (subject). */
const subject = firstLine;

/** Body: everything after the first blank line, trimmed of trailing newlines. */
function body(message: string): string {
	const idx = message.indexOf("\n\n");
	if (idx === -1) return "";
	return message.slice(idx + 2).replace(/\n$/, "");
}

// ── Preset formats ────────────────────────────────────────────────────

interface PresetFormatResult {
	formatStr: string | null;
	preset: string | null;
}

/**
 * Parse `--pretty` / `--format` value into a format string.
 * Returns `{ formatStr, preset }`.
 *
 * Examples:
 *   `"oneline"`          → preset "oneline"
 *   `"format:%H %s"`     → formatStr "%H %s"
 *   `"tformat:%H %s"`    → formatStr "%H %s"
 *   `"%H %s"`            → formatStr "%H %s"  (bare format string)
 */
export function parseFormatArg(value: string): PresetFormatResult {
	if (value.startsWith("format:")) {
		return { formatStr: value.slice(7), preset: null };
	}
	if (value.startsWith("tformat:")) {
		return { formatStr: value.slice(8), preset: null };
	}

	const presets = ["oneline", "short", "medium", "full", "fuller", "raw"];
	if (presets.includes(value)) {
		return { formatStr: null, preset: value };
	}

	// Bare format string (contains % or doesn't match a preset)
	return { formatStr: value, preset: null };
}

/**
 * Format a commit entry using a preset name.
 * Returns the formatted string (without trailing newline — caller adds that).
 *
 * `abbrevCommit` controls whether `oneline` uses abbreviated hashes (true for
 * `--oneline` flag, false for `--pretty=oneline`).
 */
export function formatPreset(
	preset: string,
	ctx: FormatContext,
	isFirst: boolean,
	abbrevCommit = false,
): string {
	const { hash, commit } = ctx;
	const decoStr = ctx.decorations ? ctx.decorations(hash) : "";

	switch (preset) {
		case "oneline": {
			const displayHash = abbrevCommit ? abbreviateHash(hash) : hash;
			const sub = subject(commit.message);
			return decoStr ? `${displayHash} ${decoStr} ${sub}` : `${displayHash} ${sub}`;
		}
		case "short": {
			const lines: string[] = [];
			if (!isFirst) lines.push("");
			lines.push(decoStr ? `commit ${hash} ${decoStr}` : `commit ${hash}`);
			if (commit.parents.length >= 2) {
				lines.push(`Merge: ${commit.parents.map(abbreviateHash).join(" ")}`);
			}
			lines.push(`Author: ${commit.author.name} <${commit.author.email}>`);
			lines.push("");
			lines.push(`    ${subject(commit.message)}`);
			return lines.join("\n");
		}
		case "full": {
			const lines: string[] = [];
			if (!isFirst) lines.push("");
			lines.push(decoStr ? `commit ${hash} ${decoStr}` : `commit ${hash}`);
			if (commit.parents.length >= 2) {
				lines.push(`Merge: ${commit.parents.map(abbreviateHash).join(" ")}`);
			}
			lines.push(`Author: ${commit.author.name} <${commit.author.email}>`);
			lines.push(`Commit: ${commit.committer.name} <${commit.committer.email}>`);
			lines.push("");
			const msg = commit.message.replace(/\n$/, "");
			for (const line of msg.split("\n")) {
				lines.push(`    ${line}`);
			}
			return lines.join("\n");
		}
		case "fuller": {
			const lines: string[] = [];
			if (!isFirst) lines.push("");
			lines.push(decoStr ? `commit ${hash} ${decoStr}` : `commit ${hash}`);
			if (commit.parents.length >= 2) {
				lines.push(`Merge: ${commit.parents.map(abbreviateHash).join(" ")}`);
			}
			lines.push(`Author:     ${commit.author.name} <${commit.author.email}>`);
			lines.push(`AuthorDate: ${formatDate(commit.author.timestamp, commit.author.timezone)}`);
			lines.push(`Commit:     ${commit.committer.name} <${commit.committer.email}>`);
			lines.push(
				`CommitDate: ${formatDate(commit.committer.timestamp, commit.committer.timezone)}`,
			);
			lines.push("");
			const msg = commit.message.replace(/\n$/, "");
			for (const line of msg.split("\n")) {
				lines.push(`    ${line}`);
			}
			return lines.join("\n");
		}
		case "raw":
			return formatRaw(ctx, isFirst);
		default:
			// "medium" — the default format (same as no --format)
			return formatMedium(ctx, isFirst);
	}
}

/** The "raw" format — tree, parent lines, raw author/committer identity strings. */
function formatRaw(ctx: FormatContext, isFirst: boolean): string {
	const { hash, commit } = ctx;
	const lines: string[] = [];

	if (!isFirst) lines.push("");

	lines.push(`commit ${hash}`);
	lines.push(`tree ${commit.tree}`);
	for (const parent of commit.parents) {
		lines.push(`parent ${parent}`);
	}
	lines.push(
		`author ${commit.author.name} <${commit.author.email}> ${commit.author.timestamp} ${commit.author.timezone}`,
	);
	lines.push(
		`committer ${commit.committer.name} <${commit.committer.email}> ${commit.committer.timestamp} ${commit.committer.timezone}`,
	);
	lines.push("");
	const msg = commit.message.replace(/\n$/, "");
	for (const line of msg.split("\n")) {
		lines.push(`    ${line}`);
	}

	return lines.join("\n");
}

/** The default "medium" format — matches `git log` default output. */
function formatMedium(ctx: FormatContext, isFirst: boolean): string {
	const { hash, commit } = ctx;
	const decoStr = ctx.decorations ? ctx.decorations(hash) : "";
	const lines: string[] = [];

	if (!isFirst) lines.push("");

	lines.push(decoStr ? `commit ${hash} ${decoStr}` : `commit ${hash}`);
	if (commit.parents.length >= 2) {
		lines.push(`Merge: ${commit.parents.map(abbreviateHash).join(" ")}`);
	}
	lines.push(`Author: ${commit.author.name} <${commit.author.email}>`);
	lines.push(`Date:   ${formatDate(commit.author.timestamp, commit.author.timezone)}`);
	lines.push("");
	const msg = commit.message.replace(/\n$/, "");
	for (const line of msg.split("\n")) {
		lines.push(`    ${line}`);
	}

	return lines.join("\n");
}

// ── Date format helpers ───────────────────────────────────────────────

const DAYS_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS_SHORT = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
];

function parseTzOffset(tz: string): number {
	const sign = tz.startsWith("-") ? -1 : 1;
	const abs = tz.replace(/^[+-]/, "");
	const h = parseInt(abs.slice(0, 2), 10) || 0;
	const m = parseInt(abs.slice(2, 4), 10) || 0;
	return sign * (h * 60 + m);
}

function applyTz(timestamp: number, timezone: string): Date {
	const offsetMinutes = parseTzOffset(timezone);
	return new Date((timestamp + offsetMinutes * 60) * 1000);
}

function tzColonFormat(tz: string): string {
	// "+0000" → "+00:00"
	return `${tz.slice(0, 3)}:${tz.slice(3)}`;
}

/** ISO 8601 strict: `2001-09-09T01:46:40+00:00` */
function formatISO8601Strict(timestamp: number, timezone: string): string {
	const d = applyTz(timestamp, timezone);
	const y = d.getUTCFullYear();
	const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
	const day = String(d.getUTCDate()).padStart(2, "0");
	const h = String(d.getUTCHours()).padStart(2, "0");
	const mi = String(d.getUTCMinutes()).padStart(2, "0");
	const s = String(d.getUTCSeconds()).padStart(2, "0");
	return `${y}-${mo}-${day}T${h}:${mi}:${s}${tzColonFormat(timezone)}`;
}

/** ISO 8601 like: `2001-09-09 01:46:40 +0000` */
function formatISO8601(timestamp: number, timezone: string): string {
	const d = applyTz(timestamp, timezone);
	const y = d.getUTCFullYear();
	const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
	const day = String(d.getUTCDate()).padStart(2, "0");
	const h = String(d.getUTCHours()).padStart(2, "0");
	const mi = String(d.getUTCMinutes()).padStart(2, "0");
	const s = String(d.getUTCSeconds()).padStart(2, "0");
	return `${y}-${mo}-${day} ${h}:${mi}:${s} ${timezone}`;
}

/**
 * Relative date: "5 minutes ago", "3 hours ago", etc.
 * Matches git's `show_date_relative` thresholds.
 */
function formatRelativeDate(timestamp: number): string {
	const nowSec = Math.floor(Date.now() / 1000);
	let diff = nowSec - timestamp;
	if (diff < 0) diff = 0;

	if (diff < 90) {
		return diff === 1 ? "1 second ago" : `${diff} seconds ago`;
	}
	diff = Math.round(diff / 60);
	if (diff < 90) {
		return diff === 1 ? "1 minute ago" : `${diff} minutes ago`;
	}
	diff = Math.round(diff / 60);
	if (diff < 36) {
		return diff === 1 ? "1 hour ago" : `${diff} hours ago`;
	}
	diff = Math.round(diff / 24);
	if (diff < 14) {
		return diff === 1 ? "1 day ago" : `${diff} days ago`;
	}
	if (diff < 70) {
		const weeks = Math.round(diff / 7);
		return weeks === 1 ? "1 week ago" : `${weeks} weeks ago`;
	}
	if (diff < 365) {
		const months = Math.round(diff / 30);
		return months === 1 ? "1 month ago" : `${months} months ago`;
	}
	const years = Math.floor(diff / 365);
	const remainingMonths = Math.round((diff - years * 365) / 30);
	if (remainingMonths > 0) {
		const yLabel = years === 1 ? "1 year" : `${years} years`;
		const mLabel = remainingMonths === 1 ? "1 month" : `${remainingMonths} months`;
		return `${yLabel}, ${mLabel} ago`;
	}
	return years === 1 ? "1 year ago" : `${years} years ago`;
}

/** RFC 2822: `Thu, 1 Jan 1970 00:00:00 +0000` */
function formatRFC2822(timestamp: number, timezone: string): string {
	const d = applyTz(timestamp, timezone);
	const dayName = DAYS_FULL[d.getUTCDay()]?.slice(0, 3);
	const month = MONTHS_SHORT[d.getUTCMonth()];
	const dayOfMonth = d.getUTCDate();
	const h = String(d.getUTCHours()).padStart(2, "0");
	const mi = String(d.getUTCMinutes()).padStart(2, "0");
	const s = String(d.getUTCSeconds()).padStart(2, "0");
	const y = d.getUTCFullYear();
	return `${dayName}, ${dayOfMonth} ${month} ${y} ${h}:${mi}:${s} ${timezone}`;
}
