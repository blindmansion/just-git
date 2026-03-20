import { getConfigValue } from "./config.ts";
import type { GitContext, Identity } from "./types.ts";

// ── Env var keys per role ───────────────────────────────────────────

const ROLE_ENV = {
	author: { name: "GIT_AUTHOR_NAME", email: "GIT_AUTHOR_EMAIL", date: "GIT_AUTHOR_DATE" },
	committer: {
		name: "GIT_COMMITTER_NAME",
		email: "GIT_COMMITTER_EMAIL",
		date: "GIT_COMMITTER_DATE",
	},
} as const;

type IdentityRole = keyof typeof ROLE_ENV;

// ── Public API ──────────────────────────────────────────────────────

/**
 * Resolve the author identity for a commit.
 *
 * Precedence:
 *   1. Locked identity override (operator-level, if set)
 *   2. GIT_AUTHOR_NAME / GIT_AUTHOR_EMAIL env vars
 *   3. user.name / user.email in .git/config
 *   4. Unlocked identity override (fallback)
 */
export function getAuthor(ctx: GitContext, env: Map<string, string>): Promise<Identity> {
	return resolveIdentity(ctx, env, "author");
}

/**
 * Resolve the committer identity for a commit.
 *
 * Precedence:
 *   1. Locked identity override (operator-level, if set)
 *   2. GIT_COMMITTER_NAME / GIT_COMMITTER_EMAIL env vars
 *   3. user.name / user.email in .git/config
 *   4. Unlocked identity override (fallback)
 */
export function getCommitter(ctx: GitContext, env: Map<string, string>): Promise<Identity> {
	return resolveIdentity(ctx, env, "committer");
}

async function resolveIdentity(
	ctx: GitContext,
	env: Map<string, string>,
	role: IdentityRole,
): Promise<Identity> {
	const keys = ROLE_ENV[role];
	const override = ctx.identityOverride;

	const { timestamp, timezone } = parseDateEnv(env.get(keys.date));

	if (override?.locked) {
		return {
			name: override.name,
			email: override.email,
			timestamp,
			timezone,
		};
	}

	const name = env.get(keys.name) ?? (await getConfigValue(ctx, "user.name")) ?? override?.name;
	const email = env.get(keys.email) ?? (await getConfigValue(ctx, "user.email")) ?? override?.email;

	if (!name || !email) {
		throw new Error(
			`${role.charAt(0).toUpperCase()}${role.slice(1)} identity unknown\n\n` +
				"*** Please tell me who you are.\n\n" +
				"Run\n\n" +
				'  git config user.email "you@example.com"\n' +
				'  git config user.name "Your Name"\n',
		);
	}

	return {
		name,
		email,
		timestamp,
		timezone,
	};
}

/**
 * Get identity for reflog entries. Unlike getCommitter, this never throws --
 * it falls back to empty strings if identity isn't configured, since reflog
 * entries should still be written even without user config.
 */
export async function getReflogIdentity(
	ctx: GitContext,
	env: Map<string, string>,
): Promise<{ name: string; email: string; timestamp: number; tz: string }> {
	try {
		const c = await getCommitter(ctx, env);
		return {
			name: c.name,
			email: c.email,
			timestamp: c.timestamp,
			tz: c.timezone,
		};
	} catch {
		return {
			name: env.get("GIT_COMMITTER_NAME") ?? "",
			email: env.get("GIT_COMMITTER_EMAIL") ?? "",
			timestamp: Math.floor(Date.now() / 1000),
			tz: "+0000",
		};
	}
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Parse a GIT_AUTHOR_DATE / GIT_COMMITTER_DATE value into a Unix
 * timestamp and timezone string.
 *
 * Supported formats (matching real git):
 *   - Pure digits: raw epoch seconds, e.g. "1718454600"
 *   - @-prefixed epoch: "@1718454600"
 *   - Git internal: "<epoch> <tz>", e.g. "1718454600 +0200"
 *   - ISO 8601: "2024-06-15T14:30:00+0200" or "+02:00" or "Z"
 *   - Anything Date.parse understands (RFC 2822, etc.)
 *
 * Falls back to current time with +0000 when undefined or unparseable.
 */
function parseDateEnv(dateStr: string | undefined): { timestamp: number; timezone: string } {
	const fallback = { timestamp: Math.floor(Date.now() / 1000), timezone: "+0000" };
	if (!dateStr) return fallback;

	const s = dateStr.trim();
	if (!s) return fallback;

	// @<epoch> — raw epoch with @ prefix
	if (s.startsWith("@")) {
		const rest = s.slice(1).trim();
		const epoch = parseInt(rest, 10);
		if (!Number.isNaN(epoch)) return { timestamp: epoch, timezone: "+0000" };
	}

	// Pure digits — raw epoch seconds
	if (/^\d+$/.test(s)) {
		return { timestamp: parseInt(s, 10), timezone: "+0000" };
	}

	// Git internal format: <epoch> <+/-HHMM>
	const internal = s.match(/^(\d+)\s+([+-]\d{4})$/);
	if (internal) {
		return { timestamp: parseInt(internal[1]!, 10), timezone: internal[2]! };
	}

	// ISO 8601 / RFC 2822 / other Date.parse-able strings — parse with
	// timezone extraction.
	const ms = Date.parse(s);
	if (!Number.isNaN(ms)) {
		return { timestamp: Math.floor(ms / 1000), timezone: extractTimezone(s) };
	}

	return fallback;
}

/** Extract a timezone offset string from a date string. */
function extractTimezone(s: string): string {
	// Trailing Z → UTC
	if (/Z$/i.test(s)) return "+0000";

	// +HH:MM or -HH:MM (ISO 8601 with colon)
	const colonMatch = s.match(/([+-])(\d{2}):(\d{2})$/);
	if (colonMatch) return `${colonMatch[1]}${colonMatch[2]}${colonMatch[3]}`;

	// +HHMM or -HHMM (compact offset)
	const compactMatch = s.match(/([+-]\d{4})$/);
	if (compactMatch) return compactMatch[1]!;

	return "+0000";
}
