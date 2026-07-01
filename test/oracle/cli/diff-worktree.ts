import { parseArgs } from "./shared/args";
import { dbPath } from "./shared/args";
import { replayTo } from "../runner";
import { captureVirtualWorkTree, replayToVirtual } from "../impl-harness";
import { resolveWorktreeDirs } from "./shared/worktree-diff";
import { captureWorkTree } from "../capture";
import { diffWorkTrees } from "./shared/worktree-diff";
import { rm } from "node:fs/promises";
import { dirname } from "node:path";

export async function cmdDiffWorktree(args: string[]): Promise<void> {
	const { positional, getOpt } = parseArgs(args);
	const dbName = positional[0] ?? getOpt("--db");
	const traceArg = positional[1] ?? getOpt("--trace");
	const stepArg = positional[2] ?? getOpt("--step");
	const limitArg = getOpt("--limit");
	const worktreeId = getOpt("--worktree") ?? "main";

	if (!dbName || !traceArg || !stepArg) {
		console.log(`Usage: bun oracle diff-worktree <name> <trace> <step> [--limit N] [--worktree path]

Compare oracle(real git) and impl virtual worktree files at a step.
Use --worktree <path> to diff a linked worktree's checkout (default: main).

Examples:
  diff-worktree basic 5 42
  diff-worktree basic 5 42 --limit 100
  diff-worktree worktree 5 42 --worktree wt-abc123`);
		process.exit(1);
	}

	const db = dbPath(dbName);
	const traceId = parseInt(traceArg, 10);
	const step = parseInt(stepArg, 10);
	const limit = parseInt(limitArg ?? "50", 10);

	const repoDir = await replayTo(db, traceId, step);
	try {
		const virtual = await replayToVirtual(db, traceId, step);
		const { realDir, vfsDir } = resolveWorktreeDirs(repoDir, worktreeId);
		const [oracleFiles, implFiles] = await Promise.all([
			captureWorkTree(realDir),
			captureVirtualWorkTree(virtual.bash.fs, vfsDir),
		]);
		const diff = diffWorkTrees(oracleFiles, implFiles);

		console.log(`\n--- Trace ${traceId}, Step ${step} Worktree Diff (${worktreeId}) ---\n`);
		console.log(
			`Differing paths: ${diff.differing.length}${diff.differing.length > limit ? ` (showing first ${limit})` : ""}\n`,
		);

		for (const d of diff.differing.slice(0, limit)) {
			console.log(
				`  ${d.path}\n    oracle: len=${d.oracleLen} sha1=${d.oracleSha}\n    impl:   len=${d.implLen} sha1=${d.implSha}`,
			);
		}
		console.log("");
	} finally {
		// Remove the private parent (repo + sibling worktrees), not just the repo.
		await rm(dirname(repoDir), { recursive: true, force: true });
	}
}
