import type { GitExtensions } from "../git.ts";
import { isCommandError, requireGitContext } from "../lib/command-utils.ts";
import { collectAllRoots } from "../lib/gc-roots.ts";
import { clearDetachPoint } from "../lib/operation-state.ts";
import { join } from "../lib/path.ts";
import { isPerWorktreeRef } from "../lib/ref-classify.ts";
import { readReflogAt, writeReflogAt } from "../lib/reflog.ts";
import { writePackedRefs } from "../lib/refs.ts";
import type { GitContext, ObjectId } from "../lib/types.ts";
import { type Command, f } from "../parse/index.ts";
import { formatRepackStderr, repackFromTips } from "../lib/repack.ts";

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

			// Step 2: Expire reflogs + collect all roots in a single pass
			await clearDetachPoint(gitCtx);
			const tips = await collectRootsAndExpireReflogs(gitCtx);

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

const REFLOG_EXPIRE_SECONDS = 90 * 24 * 60 * 60; // 90 days

/**
 * Expire old reflog entries for the current worktree and the shared refs, then
 * collect the reachability roots across every worktree. Matches real git's
 * ordering (expire before the reachability walk).
 */
async function collectRootsAndExpireReflogs(gitCtx: GitContext): Promise<ObjectId[]> {
	await expireReflogs(gitCtx);
	return collectAllRoots(gitCtx);
}

/**
 * Trim reflog entries older than the cutoff, confined to this worktree's
 * private logs and the shared `logs/refs/*`. Another worktree's private logs
 * (its `logs/HEAD`) are never rewritten, and the stash reflog never expires.
 */
export async function expireReflogs(gitCtx: GitContext): Promise<void> {
	const cutoff = Math.floor(Date.now() / 1000) - REFLOG_EXPIRE_SECONDS;
	const sharedOwnsPrivate = gitCtx.gitDir === gitCtx.commonDir;

	if (!sharedOwnsPrivate) {
		await expireLogsDir(gitCtx, join(gitCtx.gitDir, "logs"), cutoff, () => true);
	}

	await expireLogsDir(gitCtx, join(gitCtx.commonDir, "logs"), cutoff, (refName) => {
		if (refName === "refs/stash") return false;
		// In a linked worktree the common dir also holds the main worktree's
		// private logs; leave those for the main worktree to expire.
		if (!sharedOwnsPrivate && isPerWorktreeRef(refName)) return false;
		return true;
	});
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
