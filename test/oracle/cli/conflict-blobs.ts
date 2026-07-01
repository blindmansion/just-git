import { parseArgs } from "./shared/args";
import { dbPath } from "./shared/args";
import { replayTo } from "../runner";
import { replayToVirtual } from "../impl-harness";
import { printStageBlob, readRealStageBlob, resolveWorktreeDirs } from "./shared/worktree-diff";
import { captureIndex } from "../capture";
import { findRepo } from "../../../src";
import { readIndex } from "../../../src/lib";
import { readObject } from "../../../src/lib/object-db";
import { rm } from "node:fs/promises";
import { dirname } from "node:path";

export async function cmdConflictBlobs(args: string[]): Promise<void> {
	const { positional, getOpt, hasFlag } = parseArgs(args);
	const dbName = positional[0] ?? getOpt("--db");
	const traceArg = positional[1] ?? getOpt("--trace");
	const stepArg = positional[2] ?? getOpt("--step");
	const path = positional[3];
	const full = hasFlag("--full");
	const worktreeId = getOpt("--worktree") ?? "main";

	if (!dbName || !traceArg || !stepArg || !path) {
		console.log(`Usage: bun oracle conflict-blobs <name> <trace> <step> <path> [--full] [--worktree path]

Print stage 1/2/3 index blob info for a conflicted path in oracle and impl.
Use --worktree <path> to read a linked worktree's private index (default: main).

Examples:
  conflict-blobs cherry-pick 149 281 initial.txt
  conflict-blobs cherry-pick 149 281 initial.txt --full
  conflict-blobs worktree 5 42 a.txt --worktree wt-abc123`);
		process.exit(1);
	}

	const db = dbPath(dbName);
	const traceId = parseInt(traceArg, 10);
	const step = parseInt(stepArg, 10);
	const repoDir = await replayTo(db, traceId, step);

	try {
		const virtual = await replayToVirtual(db, traceId, step);
		const { realDir, vfsDir } = resolveWorktreeDirs(repoDir, worktreeId);
		const gitCtx = await findRepo(virtual.bash.fs, vfsDir);
		if (!gitCtx) {
			console.log("No git repository in virtual replay.\n");
			return;
		}

		const [oracleEntries, implIndex] = await Promise.all([
			captureIndex(realDir),
			readIndex(gitCtx),
		]);

		const oracleStages = oracleEntries
			.filter((e) => e.path === path && e.stage > 0)
			.sort((a, b) => a.stage - b.stage);
		const implStages = implIndex.entries
			.filter((e) => e.path === path && e.stage > 0)
			.sort((a, b) => a.stage - b.stage);

		console.log(
			`\n--- Trace ${traceId}, Step ${step}, Conflict Blobs: ${path} (${worktreeId}) ---\n`,
		);

		console.log("Oracle:");
		if (oracleStages.length === 0) {
			console.log("  (no stage 1/2/3 entries)");
		}
		for (const entry of oracleStages) {
			const content = await readRealStageBlob(realDir, path, entry.stage);
			printStageBlob("  ", entry.stage, entry.sha, entry.mode, content, full);
		}

		console.log("\nImpl:");
		if (implStages.length === 0) {
			console.log("  (no stage 1/2/3 entries)");
		}
		for (const entry of implStages) {
			const raw = await readObject(gitCtx, entry.hash);
			const content = new TextDecoder().decode(raw.content);
			printStageBlob("  ", entry.stage, entry.hash, entry.mode, content, full);
		}
		console.log("");
	} finally {
		// Remove the private parent (repo + sibling worktrees), not just the repo.
		await rm(dirname(repoDir), { recursive: true, force: true });
	}
}
