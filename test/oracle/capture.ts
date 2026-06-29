import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";
import { GitCommandError, RealGit } from "../real-git";
import { normalizeRebaseField } from "./compare";

/**
 * Run `git` with the given arguments in a repo directory under an isolated
 * environment. If `env` is provided (the harness's pre-built isolated env) it
 * takes precedence; otherwise a fresh isolated environment is used.
 *
 * Capture intentionally tolerates non-zero exits — e.g. `rev-parse HEAD` on an
 * unborn branch exits 128, and callers branch on `exitCode`. `execAsync` throws
 * on failure, so recover the captured result instead of propagating.
 */
async function run(
	args: string[],
	cwd: string,
	env?: Record<string, string>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	try {
		return await RealGit.in(cwd, env ? { env } : undefined).execAsync(args);
	} catch (error) {
		if (error instanceof GitCommandError) return error.result;
		throw error;
	}
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

	const resolved = await run(["rev-parse", "HEAD"], repoDir, env);
	const headSha = resolved.exitCode === 0 ? resolved.stdout.trim() : null;

	return { headRef, headSha };
}

// ── Refs ──────────────────────────────────────────────────────────

export interface RefEntry {
	refName: string;
	sha: string;
}

async function captureRefs(repoDir: string, env?: Record<string, string>): Promise<RefEntry[]> {
	const result = await run(["for-each-ref", "--format=%(objectname) %(refname)"], repoDir, env);
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

function parseLsFilesStage(stdout: string): IndexEntry[] {
	if (!stdout.trim()) return [];
	return stdout
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

export async function captureIndex(
	repoDir: string,
	env?: Record<string, string>,
): Promise<IndexEntry[]> {
	const result = await run(["ls-files", "--stage"], repoDir, env);
	if (result.exitCode !== 0) return [];
	return parseLsFilesStage(result.stdout);
}

/**
 * Capture a worktree's private index by pointing `--git-dir` at its admin dir.
 * Reads `<gitDir>/index` directly, so it works even when the checkout dir has
 * been removed (a prunable worktree) — git only needs the index, not the tree.
 */
async function captureIndexAt(
	repoDir: string,
	gitDir: string,
	env?: Record<string, string>,
): Promise<IndexEntry[]> {
	const result = await run(["--git-dir", gitDir, "ls-files", "--stage"], repoDir, env);
	if (result.exitCode !== 0) return [];
	return parseLsFilesStage(result.stdout);
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

async function captureOperation(gitDir: string): Promise<OperationState> {
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
	const result = await run(["stash", "list", "--format=%H"], repoDir, env);
	if (result.exitCode !== 0 || !result.stdout.trim()) return [];
	return result.stdout.trim().split("\n");
}

// ── Per-worktree state ───────────────────────────────────────────

/**
 * The full observable state of a single worktree: its private HEAD, index,
 * checkout contents, operation state, and lock/prunable/existence status.
 *
 * The main worktree is `id: "main"`; linked worktrees are keyed by their
 * admin-dir id (the directory name under `.git/worktrees`). That id is
 * path-agnostic, so a real-git temp checkout and the in-memory VFS produce
 * comparable keys. (Tier 3 will switch the comparison key to a normalized
 * path and retire the id convention.)
 */
export interface WorktreeSnapshot {
	id: string;
	/** Checkout path; "." for the main worktree. Not compared in Tier 1. */
	path: string;
	/** e.g. "ref: refs/heads/main", or null when detached. */
	headRef: string | null;
	headSha: string | null;
	/** This worktree's staging area (stage-aware). */
	index: IndexEntry[];
	/** SHA-1 hash of this checkout's files (sorted path+content). */
	workTreeHash: string;
	/** merge | cherry-pick | revert | rebase | null. */
	operation: string | null;
	operationStateHash: string | null;
	locked: boolean;
	lockReason: string | null;
	/** git's prunable reason for this worktree, or null. */
	prunable: string | null;
	/** Whether the checkout directory is physically present. */
	checkoutExists: boolean;
}

/** Resolve a worktree's HEAD-file content into a (headRef, headSha) pair. */
async function resolveWorktreeHead(
	repoDir: string,
	headContent: string,
	env?: Record<string, string>,
): Promise<{ headRef: string | null; headSha: string | null }> {
	if (!headContent.startsWith("ref: ")) {
		return { headRef: null, headSha: headContent || null };
	}
	const ref = headContent.slice("ref: ".length);
	const resolved = await run(["rev-parse", ref], repoDir, env);
	return { headRef: headContent, headSha: resolved.exitCode === 0 ? resolved.stdout.trim() : null };
}

/** Capture the main worktree's full state (id "main"). */
async function captureMainWorktree(
	repoDir: string,
	env?: Record<string, string>,
): Promise<WorktreeSnapshot> {
	const [head, index, workTreeHash, operation] = await Promise.all([
		captureHead(repoDir, env),
		captureIndex(repoDir, env),
		hashWorkTree(repoDir),
		captureOperation(`${repoDir}/.git`),
	]);
	return {
		id: "main",
		path: ".",
		headRef: head.headRef,
		headSha: head.headSha,
		index,
		workTreeHash,
		operation: operation.operation,
		operationStateHash: operation.stateHash,
		locked: false,
		lockReason: null,
		prunable: null,
		checkoutExists: true,
	};
}

/**
 * Capture every worktree's full state — the main worktree first, then each
 * linked worktree registered under `.git/worktrees`, sorted by admin id.
 *
 * Lock and prunable status are derived from the admin dir directly (same
 * logic as the impl's `listWorktrees`), so both sides agree byte-for-byte
 * rather than depending on porcelain reason-string wording.
 */
async function captureWorktrees(
	repoDir: string,
	env?: Record<string, string>,
): Promise<WorktreeSnapshot[]> {
	const worktrees: WorktreeSnapshot[] = [await captureMainWorktree(repoDir, env)];

	const worktreesDir = `${repoDir}/.git/worktrees`;
	let ids: string[];
	try {
		ids = await readdir(worktreesDir);
	} catch {
		return worktrees;
	}

	for (const id of ids.sort()) {
		const adminDir = `${worktreesDir}/${id}`;
		const headContent = (await safeReadFile(`${adminDir}/HEAD`))?.trim();
		if (headContent === undefined) continue;

		const { headRef, headSha } = await resolveWorktreeHead(repoDir, headContent, env);

		const gitlinkRaw = await safeReadFile(`${adminDir}/gitdir`);
		const gitlink = gitlinkRaw?.trim() || null;
		const wtPath = gitlink ? dirname(gitlink) : "";

		let prunable: string | null = null;
		if (!gitlink) prunable = "gitdir file does not exist";
		else if (!(await exists(gitlink))) prunable = "gitdir file points to non-existent location";

		const locked = await exists(`${adminDir}/locked`);
		const lockReason = locked ? (await safeReadFile(`${adminDir}/locked`))?.trim() || null : null;

		const [index, workTreeHash, operation] = await Promise.all([
			captureIndexAt(repoDir, adminDir, env),
			hashWorkTree(wtPath),
			captureOperation(adminDir),
		]);

		worktrees.push({
			id,
			path: wtPath,
			headRef,
			headSha,
			index,
			workTreeHash,
			operation: operation.operation,
			operationStateHash: operation.stateHash,
			locked,
			lockReason,
			prunable,
			checkoutExists: wtPath ? await exists(wtPath) : false,
		});
	}

	return worktrees;
}

// ── Full snapshot capture ────────────────────────────────────────

export interface GitSnapshot {
	/** Shared (common-dir) refs. */
	refs: RefEntry[];
	/** Shared stash commit hashes in stack order (newest first). */
	stashHashes: string[];
	/** Every worktree's full state — the main worktree first. */
	worktrees: WorktreeSnapshot[];
}

/**
 * Capture the complete observable state of a git repository.
 * Stores a hash of each worktree instead of full file contents —
 * on mismatch, replay the trace and call captureWorkTree() to get the diff.
 *
 * @param env - Optional isolated environment for git commands.
 *   Pass the same env used for running git to ensure consistent isolation.
 */
export async function captureSnapshot(
	repoDir: string,
	env?: Record<string, string>,
): Promise<GitSnapshot> {
	const [refs, stashHashes, worktrees] = await Promise.all([
		captureRefs(repoDir, env),
		captureStashHashes(repoDir, env),
		captureWorktrees(repoDir, env),
	]);
	return { refs, stashHashes, worktrees };
}
