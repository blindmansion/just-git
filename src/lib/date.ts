const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Format a Unix timestamp + timezone into Git's default date format. */
export function formatDate(timestamp: number, timezone: string): string {
	const offsetMinutes = parseTzOffset(timezone);
	const date = new Date((timestamp + offsetMinutes * 60) * 1000);
	const day = DAYS[date.getUTCDay()];
	const month = MONTHS[date.getUTCMonth()];
	const dayOfMonth = date.getUTCDate();
	const hours = date.getUTCHours().toString().padStart(2, "0");
	const minutes = date.getUTCMinutes().toString().padStart(2, "0");
	const seconds = date.getUTCSeconds().toString().padStart(2, "0");
	const year = date.getUTCFullYear();
	return `${day} ${month} ${dayOfMonth} ${hours}:${minutes}:${seconds} ${year} ${timezone}`;
}

/** Format a timestamp + tz as an RFC-2822 date: `Thu, 7 Apr 2005 15:13:13 -0700`. */
export function formatRFC2822(timestamp: number, timezone: string): string {
	const offsetMinutes = parseTzOffset(timezone);
	const d = new Date((timestamp + offsetMinutes * 60) * 1000);
	const dayName = DAYS[d.getUTCDay()];
	const month = MONTHS[d.getUTCMonth()];
	const dayOfMonth = d.getUTCDate();
	const h = String(d.getUTCHours()).padStart(2, "0");
	const mi = String(d.getUTCMinutes()).padStart(2, "0");
	const s = String(d.getUTCSeconds()).padStart(2, "0");
	const y = d.getUTCFullYear();
	return `${dayName}, ${dayOfMonth} ${month} ${y} ${h}:${mi}:${s} ${timezone}`;
}

const MONTH_INDEX: Record<string, number> = {
	Jan: 0,
	Feb: 1,
	Mar: 2,
	Apr: 3,
	May: 4,
	Jun: 5,
	Jul: 6,
	Aug: 7,
	Sep: 8,
	Oct: 9,
	Nov: 10,
	Dec: 11,
};

/**
 * Parse an RFC-2822 date (`Thu, 7 Apr 2005 15:13:13 -0700`) into a Unix
 * timestamp and the verbatim timezone offset — the inverse of
 * {@link formatRFC2822}. Unlike {@link parseDate}'s `Date.parse` fallback, this
 * preserves the `-0700` offset as a string (as {@link Identity.timezone}
 * requires) rather than collapsing to UTC.
 *
 * Tolerates the forms `git am` sees: an optional leading weekday, an optional
 * trailing parenthesized zone name (`(PDT)`), missing seconds, and a 2-digit
 * year (RFC-2822's 1969 pivot). Returns null when the string isn't a date.
 */
export function parseRFC2822(input: string): { timestamp: number; timezone: string } | null {
	let s = input.trim();
	// Drop an optional leading weekday token (`Thu,` / `Thu`).
	s = s.replace(/^[A-Za-z]{3,},?\s+/, "");
	// Drop a trailing parenthesized zone name (`(PDT)`), a comment git ignores.
	s = s.replace(/\s*\([^)]*\)\s*$/, "");

	const m =
		/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([+-]\d{4})?/.exec(
			s,
		);
	if (!m) return null;

	const day = Number.parseInt(m[1] as string, 10);
	const monthIdx = MONTH_INDEX[m[2] as string];
	if (monthIdx === undefined) return null;

	let year = Number.parseInt(m[3] as string, 10);
	if (year < 100) year += year < 69 ? 2000 : 1900;

	const hours = Number.parseInt(m[4] as string, 10);
	const minutes = Number.parseInt(m[5] as string, 10);
	const seconds = m[6] ? Number.parseInt(m[6], 10) : 0;
	const timezone = m[7] ?? "+0000";

	const utcMs = Date.UTC(year, monthIdx, day, hours, minutes, seconds);
	if (Number.isNaN(utcMs)) return null;

	const timestamp = Math.floor(utcMs / 1000) - parseTzOffset(timezone) * 60;
	return { timestamp, timezone };
}

/**
 * Parse a date string into a Unix timestamp (seconds).
 * Supports numeric timestamps, ISO 8601, and common date formats
 * via Date.parse() fallback. Returns null if unparseable.
 */
export function parseDate(input: string): number | null {
	const trimmed = input.trim();

	if (/^\d+$/.test(trimmed)) {
		return parseInt(trimmed, 10);
	}

	const ms = Date.parse(trimmed);
	if (!Number.isNaN(ms)) {
		return Math.floor(ms / 1000);
	}

	return null;
}

/** Parse a timezone string like "+0000" or "-0400" into offset in minutes. */
function parseTzOffset(tz: string): number {
	const sign = tz.startsWith("-") ? -1 : 1;
	const abs = tz.replace(/^[+-]/, "");
	const h = parseInt(abs.slice(0, 2), 10) || 0;
	const m = parseInt(abs.slice(2, 4), 10) || 0;
	return sign * (h * 60 + m);
}
