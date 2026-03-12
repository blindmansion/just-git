import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { normalizeRebaseField } from "./compare";

/**
 * Run a git command in the given repo directory with an isolated environment.
 *
 * If `env` is provided, it's used directly (should already be the isolated env
 * from buildGitEnv). Otherwise falls back to a minimal isolated env — but callers
 * should prefer passing the pre-built env for consistency.
 */
async function run(
	cmd: string[],
	cwd: string,
	env?: Record<string, string>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(cmd, {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: env ?? {
			PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/local/bin",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: "/dev/null",
			HOME: cwd,
		},
	});
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const exitCode = await proc.exited;
	return { exitCode, stdout, stderr };
}

// ── HEAD ──────────────────────────────────────────────────────────

export interface HeadState {
	/** e.g. "ref: refs/heads/main" or null if detached */
	headRef: string | null;
	/** Resolved SHA */
	headSha: string | null;
}

async function captureHead(repoDir: string, env?: Record<string, string>): Promise<HeadState> {
	// Read raw HEAD to determine if symbolic or detached
	const headContent = (await Bun.file(`${repoDir}/.git/HEAD`).text()).trim();

	const headRef = headContent.startsWith("ref: ") ? headContent : null;

	const resolved = await run(["git", "rev-parse", "HEAD"], repoDir, env);
	const headSha = resolved.exitCode === 0 ? resolved.stdout.trim() : null;

	return { headRef, headSha };
}

// ── Refs ──────────────────────────────────────────────────────────

export interface RefEntry {
	refName: string;
	sha: string;
}

async function captureRefs(repoDir: string, env?: Record<string, string>): Promise<RefEntry[]> {
	const result = await run(
		["git", "for-each-ref", "--format=%(objectname) %(refname)"],
		repoDir,
		env,
	);
	if (result.exitCode !== 0 || !result.stdout.trim()) return [];

	return result.stdout
		.trim()
		.split("\n")
		.map((line) => {
			const spaceIdx = line.indexOf(" ");
			return {
				sha: line.slice(0, spaceIdx),
				refName: line.slice(spaceIdx + 1),
			};
		});
}

// ── Index (staging area) ─────────────────────────────────────────

export interface IndexEntry {
	mode: number;
	sha: string;
	/** Stage number: 0 = normal, 1 = base, 2 = ours, 3 = theirs (during conflicts) */
	stage: number;
	path: string;
}

export async function captureIndex(
	repoDir: string,
	env?: Record<string, string>,
): Promise<IndexEntry[]> {
	const result = await run(["git", "ls-files", "--stage"], repoDir, env);
	if (result.exitCode !== 0 || !result.stdout.trim()) return [];

	return result.stdout
		.trim()
		.split("\n")
		.map((line) => {
			// Format: <mode> <sha> <stage>\t<path>
			const tabIdx = line.indexOf("\t");
			const meta = line.slice(0, tabIdx).split(" ");
			return {
				mode: parseInt(meta[0], 8),
				sha: meta[1],
				stage: parseInt(meta[2], 10),
				path: line.slice(tabIdx + 1),
			};
		});
}

// ── Active operation detection ───────────────────────────────────

interface OperationState {
	operation: string | null;
	stateHash: string | null;
}

const OPERATION_FILES: Record<string, string[]> = {
	merge: ["MERGE_HEAD", "MERGE_MSG", "MERGE_MODE"],
	"cherry-pick": ["CHERRY_PICK_HEAD"],
	revert: ["REVERT_HEAD"],
};

// Rebase is special — it uses a directory
const REBASE_DIRS = ["rebase-merge", "rebase-apply"];

async function captureOperation(repoDir: string): Promise<OperationState> {
	const gitDir = `${repoDir}/.git`;
	const hash = createHash("sha1");
	let found: string | null = null;

	// Check rebase first (directory-based)
	for (const dir of REBASE_DIRS) {
		const dirPath = `${gitDir}/${dir}`;
		if (await isDirectory(dirPath)) {
			found = "rebase";
			// Canonicalize rebase state across real git and virtual impl.
			// We intentionally hash only semantically shared fields, not the full
			// rebase-merge layout (which differs in internal bookkeeping files).
			const fields: Array<[string, string | null]> = [
				["head-name", await safeReadFile(`${dirPath}/head-name`)],
				["orig-head", await safeReadFile(`${dirPath}/orig-head`)],
				["onto", await safeReadFile(`${dirPath}/onto`)],
				["REBASE_HEAD", await safeReadFile(`${gitDir}/REBASE_HEAD`)],
				["MERGE_MSG", await safeReadFile(`${gitDir}/MERGE_MSG`)],
			];
			for (const [name, rawContent] of fields) {
				const content = normalizeRebaseField(name, rawContent);
				if (content !== null) {
					hash.update(`${name}\0`);
					hash.update(content);
				}
			}
			break;
		}
	}

	// Check file-based operations
	if (!found) {
		for (const [op, files] of Object.entries(OPERATION_FILES)) {
			const firstFile = `${gitDir}/${files[0]}`;
			if (await exists(firstFile)) {
				found = op;
				for (const f of files) {
					const content = await safeReadFile(`${gitDir}/${f}`);
					if (content !== null) {
						hash.update(`${f}\0`);
						hash.update(content);
					}
				}
				break;
			}
		}
	}

	if (!found) return { operation: null, stateHash: null };

	return {
		operation: found,
		stateHash: hash.digest("hex"),
	};
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

async function isDirectory(path: string): Promise<boolean> {
	try {
		const info = await stat(path);
		return info.isDirectory();
	} catch {
		return false;
	}
}

async function safeReadFile(path: string): Promise<string | null> {
	try {
		const f = Bun.file(path);
		if (await f.exists()) return await f.text();
		return null;
	} catch {
		return null;
	}
}

// ── Working tree ─────────────────────────────────────────────────

export interface WorkTreeFile {
	path: string;
	content: string;
}

/**
 * Deterministic hash of the entire worktree.
 * Walks files in sorted order, feeds "path\0length\0content" into SHA-1.
 * Two worktrees match iff their hashes match.
 */
async function hashWorkTree(repoDir: string): Promise<string> {
	const hash = createHash("sha1");
	await walkDirHash(repoDir, "", hash);
	return hash.digest("hex");
}

async function walkDirHash(
	dirPath: string,
	prefix: string,
	hash: ReturnType<typeof createHash>,
): Promise<void> {
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
			await walkDirHash(fullPath, relPath, hash);
		} else if (info.isFile()) {
			const content = await readFile(fullPath, "utf-8").catch(() => "");
			hash.update(`${relPath}\0${content.length}\0`);
			hash.update(content);
		}
	}
}

/**
 * Capture all working tree files with full content (excluding .git/).
 * Only needed on mismatch — call hashWorkTree for the fast path.
 */
export async function captureWorkTree(repoDir: string): Promise<WorkTreeFile[]> {
	const files: WorkTreeFile[] = [];
	await walkDirCollect(repoDir, "", files);
	return files;
}

async function walkDirCollect(
	dirPath: string,
	prefix: string,
	files: WorkTreeFile[],
): Promise<void> {
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
			await walkDirCollect(fullPath, relPath, files);
		} else if (info.isFile()) {
			const content = await readFile(fullPath, "utf-8").catch(() => "");
			files.push({ path: relPath, content });
		}
	}
}

// ── Stash ────────────────────────────────────────────────────────

/**
 * Capture stash commit hashes in stack order (newest first).
 * Uses `git stash list --format=%H` which reads the reflog.
 */
async function captureStashHashes(
	repoDir: string,
	env?: Record<string, string>,
): Promise<string[]> {
	const result = await run(["git", "stash", "list", "--format=%H"], repoDir, env);
	if (result.exitCode !== 0 || !result.stdout.trim()) return [];
	return result.stdout.trim().split("\n");
}

// ── Full snapshot capture ────────────────────────────────────────

export interface GitSnapshot {
	head: HeadState;
	refs: RefEntry[];
	index: IndexEntry[];
	operation: OperationState;
	/** SHA-1 hash of the worktree (sorted path+content). Fast to compare. */
	workTreeHash: string;
	/** Stash commit hashes in stack order (newest first). */
	stashHashes: string[];
}

/**
 * Capture the complete observable state of a git repository.
 * Stores a hash of the worktree instead of full file contents —
 * on mismatch, replay the trace and call captureWorkTree() to get the diff.
 *
 * @param env - Optional isolated environment for git commands.
 *   Pass the same env used for running git to ensure consistent isolation.
 */
export async function captureSnapshot(
	repoDir: string,
	env?: Record<string, string>,
): Promise<GitSnapshot> {
	const [head, refs, index, operation, workTreeHash, stashHashes] = await Promise.all([
		captureHead(repoDir, env),
		captureRefs(repoDir, env),
		captureIndex(repoDir, env),
		captureOperation(repoDir),
		hashWorkTree(repoDir),
		captureStashHashes(repoDir, env),
	]);
	return { head, refs, index, operation, workTreeHash, stashHashes };
}
