import { dirname } from "node:path";
import { captureWorkTree } from "../capture";
import { captureVirtualWorkTree, replayToVirtual } from "../impl-harness";
import { replayTo } from "../runner";
import { dbPath, parseArgs } from "./shared/args";
import { printFirstMismatch, resolveWorktreeDirs } from "./shared/worktree-diff";
import { rm } from "node:fs/promises";

export async function cmdDiffFile(args: string[]): Promise<void> {
	const { positional, getOpt } = parseArgs(args);
	const dbName = positional[0] ?? getOpt("--db");
	const traceArg = positional[1] ?? getOpt("--trace");
	const stepArg = positional[2] ?? getOpt("--step");
	const path = positional[3];
	const worktreeId = getOpt("--worktree") ?? "main";

	if (!dbName || !traceArg || !stepArg || !path) {
		console.log(`Usage: bun oracle diff-file <name> <trace> <step> <path> [--worktree path]

Show first line-level mismatch for a specific file path.
Use --worktree <path> to resolve the path in a linked worktree (default: main).

Examples:
  diff-file basic 5 42 src/app.ts
  diff-file cherry-pick 149 281 initial.txt
  diff-file worktree 5 42 a.txt --worktree wt-abc123`);
		process.exit(1);
	}

	const db = dbPath(dbName);
	const traceId = parseInt(traceArg, 10);
	const step = parseInt(stepArg, 10);

	const repoDir = await replayTo(db, traceId, step);
	try {
		const virtual = await replayToVirtual(db, traceId, step);
		const { realDir, vfsDir } = resolveWorktreeDirs(repoDir, worktreeId);
		const [oracleFiles, implFiles] = await Promise.all([
			captureWorkTree(realDir),
			captureVirtualWorkTree(virtual.bash.fs, vfsDir),
		]);
		const oracleMap = new Map(oracleFiles.map((f) => [f.path, f.content]));
		const implMap = new Map(implFiles.map((f) => [f.path, f.content]));

		const oracle = oracleMap.get(path);
		const impl = implMap.get(path);

		console.log(`\n--- Trace ${traceId}, Step ${step}, File ${path} (${worktreeId}) ---\n`);
		if (oracle === undefined && impl === undefined) {
			console.log("File missing in both oracle and impl.\n");
			return;
		}
		if (oracle === undefined) {
			console.log("File missing in oracle, present in impl.\n");
			return;
		}
		if (impl === undefined) {
			console.log("File present in oracle, missing in impl.\n");
			return;
		}
		if (oracle === impl) {
			console.log("File contents match.\n");
			return;
		}

		printFirstMismatch(path, oracle, impl);
	} finally {
		// Remove the private parent (repo + sibling worktrees), not just the repo.
		await rm(dirname(repoDir), { recursive: true, force: true });
	}
}
