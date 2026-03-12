/**
 * Replay oracle traces against the just-git virtual implementation.
 *
 * Creates a Bash instance, replays each command from the oracle DB,
 * captures state after each step, and compares against the oracle snapshot.
 */

import { Bash, type IFileSystem } from "just-bash";
import { createGitCommand } from "../../src/commands/git";
import { readIndex } from "../../src/lib/index";
import { readReflog } from "../../src/lib/reflog";
import { listRefs, readHead, resolveRef } from "../../src/lib/refs";
import { findGitDir } from "../../src/lib/repo";
import type { GitContext } from "../../src/lib/types";
import {
	DEFAULT_FILE_GEN_CONFIG,
	type FileGenConfig,
	type FileOpTarget,
	generateAndApplyFileOps,
	resolveAllFiles,
} from "../random/file-gen";
import { DEFAULT_TEST_ENV } from "../random/harness";
import { BatchChecker } from "./checker";
import { normalizeRebaseField, type ImplState } from "./compare";
import {
	isCommitCommand,
	isFileOpBatch,
	isFileResolve,
	isIndividualFileOp,
	parseFileOp,
	parseFileOpBatchSeed,
	parseFileResolveSeed,
} from "./fileops";

// ── Constants ────────────────────────────────────────────────────

const VFS_ROOT = "/repo";

interface ReplayEnvironment {
	bash: Bash;
	checker: BatchChecker;
	fileGenConfig: FileGenConfig;
}

// ── VFS adapters ─────────────────────────────────────────────────

/** Wrap IFileSystem into a FileOpTarget for the generation function. */
function createVfsTarget(fs: IFileSystem, root: string): FileOpTarget {
	return {
		async writeFile(relPath: string, content: string): Promise<void> {
			const fullPath = `${root}/${relPath}`;
			const dir = fullPath.slice(0, fullPath.lastIndexOf("/"));
			if (!(await fs.exists(dir))) {
				await fs.mkdir(dir, { recursive: true });
			}
			await fs.writeFile(fullPath, content);
		},
		async readFile(relPath: string): Promise<string> {
			return fs.readFile(`${root}/${relPath}`);
		},
		async spliceFile(
			relPath: string,
			content: string,
			offset: number,
			deleteCount: number,
		): Promise<void> {
			const fullPath = `${root}/${relPath}`;
			const existing = await fs.readFile(fullPath);
			const before = existing.slice(0, offset);
			const after = existing.slice(offset + deleteCount);
			await fs.writeFile(fullPath, before + content + after);
		},
		async deleteFile(relPath: string): Promise<void> {
			const fullPath = `${root}/${relPath}`;
			if (await fs.exists(fullPath)) {
				await fs.rm(fullPath);
			}
		},
	};
}

/** List all worktree files (sorted, excluding .git/). */
async function listVirtualWorkTreeFiles(fs: IFileSystem, root: string): Promise<string[]> {
	const files: string[] = [];
	await walkDir(fs, root, "", files);
	return files.sort();
}

async function walkDir(
	fs: IFileSystem,
	dirPath: string,
	prefix: string,
	files: string[],
): Promise<void> {
	let entries: string[];
	try {
		entries = await fs.readdir(dirPath);
	} catch {
		return;
	}
	for (const entry of entries.sort()) {
		if (entry === ".git") continue;
		const fullPath = `${dirPath}/${entry}`;
		const relPath = prefix ? `${prefix}/${entry}` : entry;
		const stat = await fs.stat(fullPath);
		if (stat.isDirectory) {
			await walkDir(fs, fullPath, relPath, files);
		} else if (stat.isFile) {
			files.push(relPath);
		}
	}
}

// ── State capture ────────────────────────────────────────────────

/**
 * Capture the full observable state from the virtual filesystem.
 * Produces an ImplState that can be compared against an OracleState.
 */
async function captureImplState(fs: IFileSystem): Promise<ImplState> {
	const gitCtx = await findGitDir(fs, VFS_ROOT);

	if (!gitCtx) {
		return {
			headRef: null,
			headSha: null,
			refs: new Map(),
			index: new Map(),
			workTreeHash: await virtualHashWorkTree(fs, VFS_ROOT),
			activeOperation: null,
			operationStateHash: null,
			stashHashes: [],
		};
	}

	const [headState, refs, index, operation, workTreeHash, stashHashes] = await Promise.all([
		captureVirtualHead(gitCtx),
		captureVirtualRefs(gitCtx),
		captureVirtualIndex(gitCtx),
		captureVirtualOperation(fs, gitCtx.gitDir),
		virtualHashWorkTree(fs, VFS_ROOT),
		captureVirtualStash(gitCtx),
	]);

	return {
		...headState,
		refs,
		index,
		workTreeHash,
		stashHashes,
		...operation,
	};
}

// ── HEAD ─────────────────────────────────────────────────────────

async function captureVirtualHead(
	ctx: GitContext,
): Promise<{ headRef: string | null; headSha: string | null }> {
	const head = await readHead(ctx);
	if (!head) return { headRef: null, headSha: null };

	const headRef = head.type === "symbolic" ? `ref: ${head.target}` : null;
	const headSha = await resolveRef(ctx, "HEAD");

	return { headRef, headSha };
}

// ── Refs ─────────────────────────────────────────────────────────

async function captureVirtualRefs(ctx: GitContext): Promise<Map<string, string>> {
	const entries = await listRefs(ctx, "refs");
	const map = new Map<string, string>();
	for (const entry of entries) {
		map.set(entry.name, entry.hash);
	}
	return map;
}

// ── Index ────────────────────────────────────────────────────────

async function captureVirtualIndex(
	ctx: GitContext,
): Promise<Map<string, { mode: number; sha: string }>> {
	const index = await readIndex(ctx);
	const map = new Map<string, { mode: number; sha: string }>();
	for (const entry of index.entries) {
		map.set(`${entry.path}:${entry.stage}`, {
			mode: entry.mode,
			sha: entry.hash,
		});
	}
	return map;
}

// ── Operation state ──────────────────────────────────────────────

const OPERATION_FILES: Record<string, string[]> = {
	merge: ["MERGE_HEAD", "MERGE_MSG", "MERGE_MODE"],
	"cherry-pick": ["CHERRY_PICK_HEAD"],
	revert: ["REVERT_HEAD"],
};

const REBASE_DIRS = ["rebase-merge", "rebase-apply"];

async function captureVirtualOperation(
	fs: IFileSystem,
	gitDir: string,
): Promise<{
	activeOperation: string | null;
	operationStateHash: string | null;
}> {
	for (const dir of REBASE_DIRS) {
		const dirPath = `${gitDir}/${dir}`;
		if (await fs.exists(dirPath)) {
			const hash = new Bun.CryptoHasher("sha1");
			// Canonicalize rebase state across real git and virtual impl.
			// Hash only semantically shared fields, not all internal files.
			const fields: Array<[string, string | null]> = [
				[
					"head-name",
					(await fs.exists(`${dirPath}/head-name`))
						? await fs.readFile(`${dirPath}/head-name`)
						: null,
				],
				[
					"orig-head",
					(await fs.exists(`${dirPath}/orig-head`))
						? await fs.readFile(`${dirPath}/orig-head`)
						: null,
				],
				[
					"onto",
					(await fs.exists(`${dirPath}/onto`)) ? await fs.readFile(`${dirPath}/onto`) : null,
				],
				[
					"REBASE_HEAD",
					(await fs.exists(`${gitDir}/REBASE_HEAD`))
						? await fs.readFile(`${gitDir}/REBASE_HEAD`)
						: null,
				],
				[
					"MERGE_MSG",
					(await fs.exists(`${gitDir}/MERGE_MSG`))
						? await fs.readFile(`${gitDir}/MERGE_MSG`)
						: null,
				],
			];
			for (const [name, rawContent] of fields) {
				const content = normalizeRebaseField(name, rawContent);
				if (content !== null) {
					hash.update(`${name}\0`);
					hash.update(content);
				}
			}
			return {
				activeOperation: "rebase",
				operationStateHash: hash.digest("hex"),
			};
		}
	}

	for (const [op, files] of Object.entries(OPERATION_FILES)) {
		const firstFile = `${gitDir}/${files[0]}`;
		if (await fs.exists(firstFile)) {
			const hash = new Bun.CryptoHasher("sha1");
			for (const f of files) {
				const filePath = `${gitDir}/${f}`;
				if (await fs.exists(filePath)) {
					const content = await fs.readFile(filePath);
					hash.update(`${f}\0`);
					hash.update(content);
				}
			}
			return {
				activeOperation: op,
				operationStateHash: hash.digest("hex"),
			};
		}
	}

	return { activeOperation: null, operationStateHash: null };
}

// ── Stash ────────────────────────────────────────────────────────

/**
 * Capture stash commit hashes from the virtual reflog.
 * Returns hashes in stack order (newest first).
 */
async function captureVirtualStash(ctx: GitContext): Promise<string[]> {
	const entries = await readReflog(ctx, "refs/stash");
	if (entries.length === 0) return [];
	// Reflog is chronological (oldest first); stash@{0} = last entry
	const hashes: string[] = [];
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry) hashes.push(entry.newHash);
	}
	return hashes;
}

// ── Worktree hash ────────────────────────────────────────────────

/**
 * Deterministic hash of the virtual worktree.
 * Same algorithm as capture.ts hashWorkTree — walks files in sorted order,
 * feeds "path\0length\0content" into SHA-1.
 */
async function virtualHashWorkTree(fs: IFileSystem, root: string): Promise<string> {
	const hash = new Bun.CryptoHasher("sha1");
	await walkVirtualDirHash(fs, root, "", hash);
	return hash.digest("hex");
}

async function walkVirtualDirHash(
	fs: IFileSystem,
	dirPath: string,
	prefix: string,
	hash: InstanceType<typeof Bun.CryptoHasher>,
): Promise<void> {
	let entries: string[];
	try {
		entries = await fs.readdir(dirPath);
	} catch {
		return;
	}
	for (const entry of entries.sort()) {
		if (entry === ".git") continue;
		const fullPath = `${dirPath}/${entry}`;
		const relPath = prefix ? `${prefix}/${entry}` : entry;
		const stat = await fs.stat(fullPath);
		if (stat.isDirectory) {
			await walkVirtualDirHash(fs, fullPath, relPath, hash);
		} else if (stat.isFile) {
			const content = await fs.readFile(fullPath);
			hash.update(`${relPath}\0${content.length}\0`);
			hash.update(content);
		}
	}
}

interface VirtualWorkTreeFile {
	path: string;
	content: string;
}

/**
 * Capture virtual worktree files with full content (excluding .git/).
 */
export async function captureVirtualWorkTree(
	fs: IFileSystem,
	root = VFS_ROOT,
): Promise<VirtualWorkTreeFile[]> {
	const files: VirtualWorkTreeFile[] = [];
	await walkVirtualDirCollect(fs, root, "", files);
	return files;
}

async function walkVirtualDirCollect(
	fs: IFileSystem,
	dirPath: string,
	prefix: string,
	files: VirtualWorkTreeFile[],
): Promise<void> {
	let entries: string[];
	try {
		entries = await fs.readdir(dirPath);
	} catch {
		return;
	}
	for (const entry of entries.sort()) {
		if (entry === ".git") continue;
		const fullPath = `${dirPath}/${entry}`;
		const relPath = prefix ? `${prefix}/${entry}` : entry;
		const stat = await fs.stat(fullPath);
		if (stat.isDirectory) {
			await walkVirtualDirCollect(fs, fullPath, relPath, files);
		} else if (stat.isFile) {
			files.push({
				path: relPath,
				content: await fs.readFile(fullPath),
			});
		}
	}
}

// ── Individual file op dispatch (for conflict resolution writes) ─

async function applyIndividualFileOp(fs: IFileSystem, command: string): Promise<void> {
	const op = parseFileOp(command);
	switch (op.type) {
		case "write": {
			const fullPath = `${VFS_ROOT}/${op.path}`;
			const dir = fullPath.slice(0, fullPath.lastIndexOf("/"));
			if (!(await fs.exists(dir))) {
				await fs.mkdir(dir, { recursive: true });
			}
			if (op.offset != null || op.deleteCount != null) {
				let existing = "";
				if (await fs.exists(fullPath)) {
					existing = await fs.readFile(fullPath);
				}
				const before = existing.slice(0, op.offset ?? 0);
				const after = existing.slice((op.offset ?? 0) + (op.deleteCount ?? Infinity));
				await fs.writeFile(fullPath, before + op.content + after);
			} else {
				await fs.writeFile(fullPath, op.content);
			}
			break;
		}
		case "delete":
			if (await fs.exists(`${VFS_ROOT}/${op.path}`)) {
				await fs.rm(`${VFS_ROOT}/${op.path}`);
			}
			break;
	}
}

// ── Command output ───────────────────────────────────────────────

export interface CommandOutput {
	stdout: string;
	stderr: string;
	exitCode: number;
}

const NO_OUTPUT: CommandOutput = { stdout: "", stderr: "", exitCode: 0 };

// ── Command execution helper ─────────────────────────────────────

/**
 * Execute a single command against a Bash instance + VFS.
 * Handles file op batches, individual file ops, and git commands.
 * Returns the command's stdout/stderr/exitCode.
 */
async function executeCommand(
	bash: Bash,
	command: string,
	commitCounter: { value: number },
	fileGenConfig: FileGenConfig = DEFAULT_FILE_GEN_CONFIG,
): Promise<CommandOutput> {
	if (isFileOpBatch(command)) {
		const seed = parseFileOpBatchSeed(command);
		const files = await listVirtualWorkTreeFiles(bash.fs, VFS_ROOT);
		const target = createVfsTarget(bash.fs, VFS_ROOT);
		await generateAndApplyFileOps(target, seed, files, fileGenConfig);
		return NO_OUTPUT;
	} else if (isFileResolve(command)) {
		const seed = parseFileResolveSeed(command);
		const files = await listVirtualWorkTreeFiles(bash.fs, VFS_ROOT);
		const target = createVfsTarget(bash.fs, VFS_ROOT);
		await resolveAllFiles(target, seed, files, fileGenConfig);
		return NO_OUTPUT;
	} else if (isIndividualFileOp(command)) {
		await applyIndividualFileOp(bash.fs, command);
		return NO_OUTPUT;
	} else {
		let envOverride: Record<string, string> | undefined;
		if (isCommitCommand(command)) {
			commitCounter.value++;
			const ts = `${1000000000 + commitCounter.value} +0000`;
			envOverride = {
				GIT_AUTHOR_DATE: ts,
				GIT_COMMITTER_DATE: ts,
			};
		}
		const result = await bash.exec(command, { env: envOverride });
		return {
			stdout: result.stdout,
			stderr: result.stderr,
			exitCode: result.exitCode,
		};
	}
}

// ── Replay engine ────────────────────────────────────────────────

import type { Divergence } from "./compare";

interface StepDivergence {
	seq: number;
	command: string;
	divergences: Divergence[];
}

interface ReplayResult {
	totalSteps: number;
	passed: number;
	/** Number of steps that had only warning-severity divergences. */
	warned: number;
	/** First step with warning-only divergences (may be root cause of later errors). */
	firstWarning: StepDivergence | null;
	/** First step with error-severity divergences. */
	firstDivergence: StepDivergence | null;
}

/**
 * Replay a trace against the virtual implementation and compare every step.
 *
 * Compares state (HEAD, refs, index, worktree) and output (exit code, stdout,
 * stderr) at each step. Warning-only divergences (e.g. different commit SHA
 * but identical worktree) are logged but do NOT stop the replay. Only
 * error-severity divergences cause the replay to stop.
 *
 * State failures fire first so post-mortem classification works before
 * output mismatches are reported.
 */
export async function replayAndCheck(
	dbPath: string,
	traceId: number,
	options?: {
		stopAt?: number;
		verbose?: boolean;
	},
): Promise<ReplayResult> {
	const { checker, bash, fileGenConfig } = createReplayEnvironment(dbPath, traceId);
	const commands = checker.getCommands();

	const commitCounter = { value: 0 };
	let passed = 0;
	let warned = 0;
	let totalSteps = 0;
	let firstWarning: StepDivergence | null = null;

	for (const { seq, command } of commands) {
		if (options?.stopAt != null && seq > options.stopAt) break;
		totalSteps++;

		const output = await executeCommand(bash, command, commitCounter, fileGenConfig);

		// Skip comparison for placeholder snapshots
		if (checker.isPlaceholder(seq)) {
			passed++;
			if (options?.verbose) {
				console.log(`  [${seq}] SKIP  ${command.slice(0, 60)}`);
			}
			continue;
		}

		const implState = await captureImplState(bash.fs);
		const result = checker.checkStep(seq, implState);

		if (result.status === "fail") {
			// State error: stop replay (fires before output check so
			// post-mortem classification can kick in)
			if (options?.verbose) {
				console.log(`  [${seq}] FAIL  ${command.slice(0, 60)}`);
				for (const d of result.divergences) {
					console.log(
						`         ${d.field} [${d.severity}]: expected=${JSON.stringify(d.expected)} actual=${JSON.stringify(d.actual)}`,
					);
				}
			}
			return {
				totalSteps,
				passed,
				warned,
				firstWarning,
				firstDivergence: { seq, command, divergences: result.divergences },
			};
		}

		if (result.status === "warn") {
			warned++;
			if (!firstWarning) {
				firstWarning = { seq, command, divergences: result.divergences };
			}
			if (options?.verbose) {
				console.log(`  [${seq}] WARN  ${command.slice(0, 60)}`);
				for (const d of result.divergences) {
					console.log(
						`         ${d.field} [${d.severity}]: expected=${JSON.stringify(d.expected)} actual=${JSON.stringify(d.actual)}`,
					);
				}
			}
		}

		// Output comparison (exit code + stdout + stderr) — checked AFTER
		// state so state-level failures and post-mortem classification fire
		// first. Skip if there are state-level warnings at this step, since
		// warned divergences (e.g. different commit hash) will cascade into
		// stdout/stderr differences that aren't separate bugs.
		if (result.status !== "warn") {
			const outputDivs = checker.checkOutput(seq, output);
			if (outputDivs.length > 0) {
				if (options?.verbose) {
					console.log(`  [${seq}] FAIL  ${command.slice(0, 60)}`);
					for (const d of outputDivs) {
						console.log(
							`         ${d.field} [${d.severity}]: expected=${JSON.stringify(d.expected)} actual=${JSON.stringify(d.actual)}`,
						);
					}
				}
				return {
					totalSteps,
					passed,
					warned,
					firstWarning,
					firstDivergence: { seq, command, divergences: outputDivs },
				};
			}
		}

		// If we got here, state is pass or warn-only, and output (if checked) matched
		if (result.status === "pass") {
			passed++;
			if (options?.verbose) {
				console.log(`  [${seq}] PASS  ${command.slice(0, 60)}`);
			}
		}
	}

	return { totalSteps, passed, warned, firstWarning, firstDivergence: null };
}

/**
 * Replay a trace to a virtual shell up to stopAt (inclusive).
 */
export async function replayToVirtual(
	dbPath: string,
	traceId: number,
	stopAt: number,
): Promise<ReplayEnvironment> {
	const replay = createReplayEnvironment(dbPath, traceId);
	const commands = replay.checker.getCommands();
	const commitCounter = { value: 0 };

	for (const { seq, command } of commands) {
		if (seq > stopAt) break;
		await executeCommand(replay.bash, command, commitCounter, replay.fileGenConfig);
	}

	return replay;
}

/**
 * Replay a trace up to a given step and return both impl state and command output.
 * Single replay — used by `inspect` for combined state + output comparison.
 */
export async function replayToStateAndOutput(
	dbPath: string,
	traceId: number,
	stopAt: number,
): Promise<{ state: ImplState; output: CommandOutput }> {
	const replay = createReplayEnvironment(dbPath, traceId);
	const commands = replay.checker.getCommands();
	const commitCounter = { value: 0 };
	let lastOutput: CommandOutput = NO_OUTPUT;

	for (const { seq, command } of commands) {
		if (seq > stopAt) break;
		lastOutput = await executeCommand(replay.bash, command, commitCounter, replay.fileGenConfig);
	}

	const state = await captureImplState(replay.bash.fs);
	return { state, output: lastOutput };
}

// ── Timing-only replay (no state capture / comparison) ───────

export interface CommandTiming {
	seq: number;
	command: string;
	elapsedMs: number;
}

/**
 * Replay a trace timing only command execution — no state capture,
 * no comparison, no post-mortem.  Returns per-step timing data.
 */
export async function replayWithTiming(dbPath: string, traceId: number): Promise<CommandTiming[]> {
	const { checker, bash, fileGenConfig } = createReplayEnvironment(dbPath, traceId);
	const commands = checker.getCommands();
	const commitCounter = { value: 0 };
	const timings: CommandTiming[] = [];

	for (const { seq, command } of commands) {
		const start = performance.now();
		await executeCommand(bash, command, commitCounter, fileGenConfig);
		const elapsed = performance.now() - start;
		timings.push({ seq, command, elapsedMs: elapsed });
	}

	return timings;
}

// ── Size-sampling replay ─────────────────────────────────────

export interface SizeSample {
	seq: number;
	command: string;
	workTreeFiles: number;
	workTreeBytes: number;
	indexEntries: number;
	conflictEntries: number;
	objectCount: number;
	objectBytes: number;
}

/**
 * Replay a trace and sample repo size metrics at regular intervals.
 * Collects worktree file count/bytes, index entry counts, and object
 * store stats. Sampling interval controls overhead vs resolution.
 */
export async function replayWithSize(
	dbPath: string,
	traceId: number,
	sampleEvery: number,
): Promise<SizeSample[]> {
	const { checker, bash, fileGenConfig } = createReplayEnvironment(dbPath, traceId);
	const commands = checker.getCommands();
	const commitCounter = { value: 0 };
	const samples: SizeSample[] = [];
	const totalSteps = commands.length;

	for (const { seq, command } of commands) {
		await executeCommand(bash, command, commitCounter, fileGenConfig);

		if (seq % sampleEvery === 0 || seq === totalSteps - 1) {
			const sample = await measureRepoSize(bash.fs, seq, command);
			samples.push(sample);
		}
	}

	return samples;
}

async function measureRepoSize(fs: IFileSystem, seq: number, command: string): Promise<SizeSample> {
	const root = VFS_ROOT;

	// Worktree files
	const files = await listVirtualWorkTreeFiles(fs, root);
	let workTreeBytes = 0;
	for (const f of files) {
		try {
			const content = await fs.readFile(`${root}/${f}`);
			workTreeBytes += content.length;
		} catch {
			// file may have been deleted between listing and reading
		}
	}

	// Index entries
	let indexEntries = 0;
	let conflictEntries = 0;
	try {
		const gitCtx = await findGitDir(fs, root);
		if (gitCtx) {
			const index = await readIndex(gitCtx);
			for (const entry of index.entries) {
				if (entry.stage === 0) indexEntries++;
				else conflictEntries++;
			}
		}
	} catch {
		// no git dir yet
	}

	// Object store
	let objectCount = 0;
	let objectBytes = 0;
	const objectsDir = `${root}/.git/objects`;
	try {
		if (await fs.exists(objectsDir)) {
			for (const fanout of await fs.readdir(objectsDir)) {
				if (fanout === "pack" || fanout === "info") continue;
				const fanoutDir = `${objectsDir}/${fanout}`;
				try {
					const stat = await fs.lstat(fanoutDir);
					if (!stat.isDirectory) continue;
					for (const obj of await fs.readdir(fanoutDir)) {
						objectCount++;
						const data = await fs.readFileBuffer(`${fanoutDir}/${obj}`);
						objectBytes += data.byteLength;
					}
				} catch {}
			}
		}
	} catch {
		// no objects dir yet
	}

	return {
		seq,
		command,
		workTreeFiles: files.length,
		workTreeBytes,
		indexEntries,
		conflictEntries,
		objectCount,
		objectBytes,
	};
}

function createReplayEnvironment(dbPath: string, traceId: number): ReplayEnvironment {
	const checker = new BatchChecker(dbPath, traceId);
	const traceConfig = checker.getTraceConfig();
	const fileGenConfig = traceConfig?.fileGen ?? DEFAULT_FILE_GEN_CONFIG;
	const bash = new Bash({
		cwd: VFS_ROOT,
		customCommands: [createGitCommand().toCommand()],
		env: { ...DEFAULT_TEST_ENV },
	});
	return { checker, bash, fileGenConfig };
}
