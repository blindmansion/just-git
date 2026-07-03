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
