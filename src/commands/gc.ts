import type { FileSystem } from "../fs.ts";
import type { GitExtensions } from "../git.ts";
import { isCommandError, requireGitContext } from "../lib/command-utils.ts";
import { readIndex } from "../lib/index.ts";
import { objectExists } from "../lib/object-db.ts";
import { clearDetachPoint } from "../lib/operation-state.ts";
import { join } from "../lib/path.ts";
import { readReflog, writeReflog, ZERO_HASH } from "../lib/reflog.ts";
import { listRefs, resolveHead, resolveRef, writePackedRefs } from "../lib/refs.ts";
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

				await pruneAllLoose(gitCtx.gitDir, ctx.fs);

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
 * Single-pass: expire old reflog entries, then collect all root object
 * IDs (HEAD, refs, surviving reflog entries, index, op-state).
 * Matches real git's ordering (expire before reachability walk).
 */
async function collectRootsAndExpireReflogs(gitCtx: GitContext): Promise<ObjectId[]> {
	const roots = new Set<ObjectId>();

	const head = await resolveHead(gitCtx);
	if (head) roots.add(head);

	const refs = await listRefs(gitCtx, "refs");
	for (const ref of refs) {
		roots.add(ref.hash);
	}

	const now = Math.floor(Date.now() / 1000);
	const cutoff = now - REFLOG_EXPIRE_SECONDS;
	const logsDir = join(gitCtx.gitDir, "logs");
	if (await gitCtx.fs.exists(logsDir)) {
		await expireAndCollectLogsDir(gitCtx, logsDir, logsDir, cutoff, roots);
	}

	const index = await readIndex(gitCtx);
	for (const entry of index.entries) {
		roots.add(entry.hash);
	}

	for (const stateRef of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "ORIG_HEAD"]) {
		const hash = await resolveRef(gitCtx, stateRef);
		if (hash) roots.add(hash);
	}

	const existing: ObjectId[] = [];
	for (const hash of roots) {
		if (await objectExists(gitCtx, hash)) {
			existing.push(hash);
		}
	}
	return existing;
}

async function expireAndCollectLogsDir(
	gitCtx: GitContext,
	dirPath: string,
	logsDir: string,
	cutoff: number,
	roots: Set<ObjectId>,
): Promise<void> {
	const entries = await gitCtx.fs.readdir(dirPath);
	for (const entry of entries) {
		const fullPath = join(dirPath, entry);
		const stat = await gitCtx.fs.stat(fullPath);
		if (stat.isDirectory) {
			await expireAndCollectLogsDir(gitCtx, fullPath, logsDir, cutoff, roots);
			try {
				const remaining = await gitCtx.fs.readdir(fullPath);
				if (remaining.length === 0) {
					await gitCtx.fs.rm(fullPath, { recursive: true });
				}
			} catch {
				// ignore
			}
		} else if (stat.isFile) {
			const refName = fullPath.slice(logsDir.length + 1);
			const reflogEntries = await readReflog(gitCtx, refName);

			if (refName === "refs/stash") {
				for (const e of reflogEntries) {
					if (e.newHash !== ZERO_HASH) roots.add(e.newHash);
				}
				continue;
			}

			const kept = reflogEntries.filter((e) => e.timestamp >= cutoff);
			await writeReflog(gitCtx, refName, kept);

			for (const e of kept) {
				if (e.newHash !== ZERO_HASH) roots.add(e.newHash);
			}
		}
	}
}

// ── Prune helpers ───────────────────────────────────────────────────

async function pruneAllLoose(gitDir: string, fs: FileSystem): Promise<void> {
	const objectsDir = join(gitDir, "objects");
	let entries: string[];
	try {
		entries = await fs.readdir(objectsDir);
	} catch {
		return;
	}

	for (const dir of entries) {
		if (dir === "pack" || dir === "info" || dir.length !== 2) continue;
		try {
			await fs.rm(join(objectsDir, dir), { recursive: true });
		} catch {
			// ignore
		}
	}
}
