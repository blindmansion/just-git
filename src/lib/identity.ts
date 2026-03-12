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
 *   3. Unlocked identity override (fallback)
 *   4. user.name / user.email in .git/config
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
 *   3. Unlocked identity override (fallback)
 *   4. user.name / user.email in .git/config
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

	if (override?.locked) {
		return {
			name: override.name,
			email: override.email,
			timestamp: getTimestamp(env.get(keys.date)),
			timezone: "+0000",
		};
	}

	const name = env.get(keys.name) ?? override?.name ?? (await getConfigValue(ctx, "user.name"));
	const email = env.get(keys.email) ?? override?.email ?? (await getConfigValue(ctx, "user.email"));

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
		timestamp: getTimestamp(env.get(keys.date)),
		timezone: "+0000",
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
 * Parse a date string to a Unix timestamp.
 * Supports raw epoch seconds or any string parseable by Date.parse.
 * Falls back to the current time.
 */
function getTimestamp(dateStr: string | undefined): number {
	if (dateStr) {
		const asInt = parseInt(dateStr, 10);
		if (!Number.isNaN(asInt)) return asInt;
		const asDate = Date.parse(dateStr);
		if (!Number.isNaN(asDate)) return Math.floor(asDate / 1000);
	}
	return Math.floor(Date.now() / 1000);
}
