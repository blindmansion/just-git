/**
 * Replay oracle traces against real git for debugging.
 *
 * Given a DB path, trace ID, and step number, reconstructs the real git repo
 * at that point by replaying all commands up to (and including) that step.
 *
 * Used by `cli.ts rebuild`. Not meant to be run directly.
 */

import { mkdir, mkdtemp, readdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	DEFAULT_FILE_GEN_CONFIG,
	type FileGenConfig,
	type FileOpTarget,
	generateAndApplyFileOps,
	resolveAllFiles,
} from "../random/file-gen";
import {
	isCommitCommand,
	isFileOpBatch,
	isFileResolve,
	isIndividualFileOp,
	parseFileOp,
	parseFileOpBatchSeed,
	parseFileResolveSeed,
} from "./fileops";
import { buildRealGitEnv } from "./real-harness";
import { initDb } from "./schema";
import { OracleStore } from "./store";

// ── Real FS adapters ─────────────────────────────────────────────

/** Wrap node:fs into a FileOpTarget for the generation function. */
function createRealFsTarget(repoDir: string): FileOpTarget {
	return {
		async writeFile(relPath: string, content: string): Promise<void> {
			const fullPath = join(repoDir, relPath);
			await mkdir(dirname(fullPath), { recursive: true });
			await writeFile(fullPath, content);
		},
		async readFile(relPath: string): Promise<string> {
			return readFile(join(repoDir, relPath), "utf-8");
		},
		async spliceFile(
			relPath: string,
			content: string,
			offset: number,
			deleteCount: number,
		): Promise<void> {
			const fullPath = join(repoDir, relPath);
			const existing = await readFile(fullPath, "utf-8");
			const before = existing.slice(0, offset);
			const after = existing.slice(offset + deleteCount);
			await writeFile(fullPath, before + content + after);
		},
		async deleteFile(relPath: string): Promise<void> {
			try {
				await unlink(join(repoDir, relPath));
			} catch {
				/* file may not exist */
			}
		},
	};
}

/** List all worktree files (sorted, excluding .git/). */
async function listRealWorkTreeFiles(repoDir: string): Promise<string[]> {
	const files: string[] = [];
	await walkRealDir(repoDir, "", files);
	return files.sort();
}

async function walkRealDir(dirPath: string, prefix: string, files: string[]): Promise<void> {
	let entries: string[];
	try {
		entries = await readdir(dirPath);
	} catch {
		return;
	}
	for (const entry of entries.sort()) {
		if (entry === ".git") continue;
		const fullPath = join(dirPath, entry);
		const relPath = prefix ? `${prefix}/${entry}` : entry;
		const info = await stat(fullPath).catch(() => null);
		if (!info) continue;
		if (info.isDirectory()) {
			await walkRealDir(fullPath, relPath, files);
		} else if (info.isFile()) {
			files.push(relPath);
		}
	}
}

// ── Replay ───────────────────────────────────────────────────────

/**
 * Replay a trace up to a given step, returning the path to a real git repo.
 *
 * The caller is responsible for cleaning up the returned directory
 * (rm -rf when done inspecting).
 */
export async function replayTo(
	dbPath: string,
	traceId: number,
	stopAtSeq: number,
): Promise<string> {
	const db = initDb(dbPath);
	const store = new OracleStore(db);
	const steps = store.getTraceSteps(traceId);
	const traceConfig = store.getTraceConfig(traceId);
	db.close();

	const fileGenConfig: FileGenConfig = traceConfig?.fileGen ?? DEFAULT_FILE_GEN_CONFIG;

	const homeDir = await mkdtemp(join(tmpdir(), "replay-home-"));
	const repoDir = await mkdtemp(join(tmpdir(), "replay-git-"));
	const env = buildRealGitEnv(homeDir);
	let commitCounter = 0;

	try {
		for (const step of steps) {
			if (step.seq > stopAtSeq) break;

			if (isFileOpBatch(step.command)) {
				const seed = parseFileOpBatchSeed(step.command);
				const files = await listRealWorkTreeFiles(repoDir);
				const target = createRealFsTarget(repoDir);
				await generateAndApplyFileOps(target, seed, files, fileGenConfig);
			} else if (isFileResolve(step.command)) {
				const seed = parseFileResolveSeed(step.command);
				const files = await listRealWorkTreeFiles(repoDir);
				const target = createRealFsTarget(repoDir);
				await resolveAllFiles(target, seed, files, fileGenConfig);
			} else if (isIndividualFileOp(step.command)) {
				await execIndividualFileOp(repoDir, step.command);
			} else {
				let stepEnv = env;
				if (isCommitCommand(step.command)) {
					commitCounter++;
					const ts = `${1000000000 + commitCounter} +0000`;
					stepEnv = {
						...env,
						GIT_AUTHOR_DATE: ts,
						GIT_COMMITTER_DATE: ts,
					};
				}
				await execShell(repoDir, step.command, stepEnv);
			}
		}
	} catch (err) {
		// Clean up both dirs on failure so we don't leak temp repos
		await rm(repoDir, { recursive: true, force: true });
		await rm(homeDir, { recursive: true, force: true });
		throw err;
	}

	await rm(homeDir, { recursive: true, force: true });
	return repoDir;
}

// ── Helpers ──────────────────────────────────────────────────────

async function execShell(cwd: string, command: string, env: Record<string, string>): Promise<void> {
	const proc = Bun.spawn(["sh", "-c", command], {
		cwd,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	await proc.exited;
}

async function execIndividualFileOp(repoDir: string, command: string): Promise<void> {
	const op = parseFileOp(command);
	switch (op.type) {
		case "write": {
			const fullPath = join(repoDir, op.path);
			await mkdir(dirname(fullPath), { recursive: true });
			if (op.offset != null || op.deleteCount != null) {
				const existing = await readFile(fullPath, "utf-8").catch(() => "");
				const before = existing.slice(0, op.offset ?? 0);
				const after = existing.slice((op.offset ?? 0) + (op.deleteCount ?? Infinity));
				await writeFile(fullPath, before + op.content + after);
			} else {
				await writeFile(fullPath, op.content);
			}
			break;
		}
		case "delete":
			try {
				await unlink(join(repoDir, op.path));
			} catch {
				/* file may not exist */
			}
			break;
	}
}
