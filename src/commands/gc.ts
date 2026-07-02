import type { GitExtensions } from "../git.ts";
import { collectAllRoots } from "../lib/gc-roots.ts";
import { clearDetachPoint } from "../lib/operation-state.ts";
import { join } from "../lib/path.ts";
import { readReflogAt, writeReflogAt } from "../lib/refs/reflog.ts";
import { writePackedRefs } from "../lib/refs/refs.ts";
import { enumerateWorktrees } from "../lib/worktree-admin.ts";
import type { GitContext, ObjectId } from "../lib/types.ts";
import { type Command, f } from "./kit/parse/index.ts";
import { repackFromTips } from "../lib/repack.ts";
import { isCommandError } from "./kit/command-result.ts";
import { requireGitContext } from "./kit/commit-requirements.ts";
import { readConfig } from "../lib/config/store.ts";
import type { GitConfig } from "../lib/config/parse.ts";
import { formatRepackStderr } from "./kit/format/repack.ts";

export function registerGcCommand(parent: Command, ext?: GitExtensions) {
	parent.command("gc", {
		description: "Cleanup unnecessary files and optimize the local repository",
		options: {
			aggressive: f().describe("More aggressively optimize the repository"),
		},
		handler: async (args, ctx) => {
			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;
			const gitCtx = gitCtxOrError;

			// Step 1: Pack refs
			await writePackedRefs(gitCtx);

			// Step 2: Expire reflogs + collect all roots in a single pass.
			// Honor gc.reflogExpire: "never" disables expiry entirely, in which
			// case the reflog (and thus the detached-HEAD "checkout: moving from"
			// entry) is preserved, so the DETACH_POINT side-file must stay too.
			const config = await readConfig(gitCtx);
			const expireAge = parseReflogExpireAge(config);
			if (expireAge !== null) {
				await clearDetachPoint(gitCtx);
			}
			const tips = await collectRootsAndExpireReflogs(gitCtx, expireAge);

			if (tips.length > 0) {
				const window = args.aggressive ? 250 : 10;
				const depth = args.aggressive ? 250 : 50;

				const result = await repackFromTips({
					gitCtx,
					fs: ctx.fs,
					tips,
					window,
					depth,
					cleanup: true,
					all: true,
				});

				if (result) {
					const stderr = formatRepackStderr(result.totalCount, result.deltaCount, true);
					return { stdout: "", stderr: `${stderr}\n`, exitCode: 0 };
				}
			}

			return { stdout: "", stderr: "", exitCode: 0 };
		},
	});
}

// ── Combined reflog expiry + root collection ────────────────────────

const DAY_SECONDS = 24 * 60 * 60;
const DEFAULT_REFLOG_EXPIRE_SECONDS = 90 * DAY_SECONDS; // git default: 90 days

/**
 * Resolve the `gc.reflogExpire` age (in seconds) from config, or `null` when
 * expiry is disabled ("never"). Mirrors git's default of 90 days when unset.
 * Only a subset of git's approxidate grammar is recognized; unparseable values
 * fall back to the default rather than throwing.
 */
function parseReflogExpireAge(config: GitConfig): number | null {
	const raw = config.gc?.reflogexpire?.trim().toLowerCase();
	if (!raw) return DEFAULT_REFLOG_EXPIRE_SECONDS;
	if (raw === "never") return null;
	if (raw === "now") return 0;

	// Forms like "90.days.ago", "90 days", "2.weeks", "30.days".
	const m = raw.match(/^(\d+)[.\s]*(second|minute|hour|day|week|month|year)s?/);
	if (!m?.[1] || !m[2]) return DEFAULT_REFLOG_EXPIRE_SECONDS;
	const n = parseInt(m[1], 10);
	const unit: Record<string, number> = {
		second: 1,
		minute: 60,
		hour: 60 * 60,
		day: DAY_SECONDS,
		week: 7 * DAY_SECONDS,
		month: 30 * DAY_SECONDS,
		year: 365 * DAY_SECONDS,
	};
	return n * (unit[m[2]] ?? DAY_SECONDS);
}

/**
 * Expire old reflog entries for the current worktree and the shared refs, then
 * collect the reachability roots across every worktree. Matches real git's
 * ordering (expire before the reachability walk). When `expireAge` is `null`
 * (gc.reflogExpire=never), expiry is skipped entirely.
 */
async function collectRootsAndExpireReflogs(
	gitCtx: GitContext,
	expireAge: number | null,
): Promise<ObjectId[]> {
	if (expireAge !== null) {
		await expireReflogs(gitCtx, expireAge);
	}
	return collectAllRoots(gitCtx);
}

/**
 * Trim reflog entries older than the cutoff across the whole repository. Like
 * git's `reflog expire` during gc, this processes every worktree regardless of
 * where gc was invoked: the common dir holds the shared `logs/refs/*` plus the
 * main worktree's private logs (`logs/HEAD`, …), and each linked worktree keeps
 * its private logs under `worktrees/<id>/logs`. The stash reflog never expires.
 */
export async function expireReflogs(
	gitCtx: GitContext,
	expireAge: number = DEFAULT_REFLOG_EXPIRE_SECONDS,
): Promise<void> {
	const cutoff = Math.floor(Date.now() / 1000) - expireAge;

	await expireLogsDir(
		gitCtx,
		join(gitCtx.commonDir, "logs"),
		cutoff,
		(refName) => refName !== "refs/stash",
	);

	for (const wt of await enumerateWorktrees(gitCtx)) {
		await expireLogsDir(gitCtx, join(wt.privateDir, "logs"), cutoff, () => true);
	}
}

async function expireLogsDir(
	gitCtx: GitContext,
	logsDir: string,
	cutoff: number,
	shouldExpire: (refName: string) => boolean,
	baseLogsDir: string = logsDir,
): Promise<void> {
	if (!(await gitCtx.fs.exists(logsDir))) return;

	for (const entry of await gitCtx.fs.readdir(logsDir)) {
		const fullPath = join(logsDir, entry);
		const stat = await gitCtx.fs.stat(fullPath);
		if (stat.isDirectory) {
			await expireLogsDir(gitCtx, fullPath, cutoff, shouldExpire, baseLogsDir);
			try {
				const remaining = await gitCtx.fs.readdir(fullPath);
				if (remaining.length === 0) await gitCtx.fs.rm(fullPath, { recursive: true });
			} catch {
				// ignore
			}
			continue;
		}
		if (!stat.isFile) continue;

		const refName = fullPath.slice(baseLogsDir.length + 1);
		if (!shouldExpire(refName)) continue;

		// Read and write the file we found, not a path re-derived from refName.
		const entries = await readReflogAt(gitCtx.fs, fullPath);
		const kept = entries.filter((e) => e.timestamp >= cutoff);
		if (kept.length !== entries.length) {
			await writeReflogAt(gitCtx.fs, fullPath, kept);
		}
	}
}
