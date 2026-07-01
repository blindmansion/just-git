import { Bash } from "just-bash";
import { createGitCommand } from "../../src/commands/git";
import {
	DEFAULT_FILE_GEN_CONFIG,
	type FileGenConfig,
	type FileOpTarget,
	generateAndApplyFileOps,
	posixRelative,
	resolveAllFiles,
	resolveWorktreeRoot,
} from "./file-gen";

// ── Types ────────────────────────────────────────────────────────────

export interface ExecResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

/**
 * A linked worktree as seen from the main repo. `id` is the admin-dir basename
 * (the stable identity, used as the sticky-targeting key); `path` is the
 * checkout location as a repo-root-relative selector (e.g. `../wt-x`,
 * `../sub/wt-x`), read from the admin dir's `gitdir` pointer so it survives
 * `worktree move` and same-basename checkouts. Address a worktree (commands,
 * file ops, action arguments) by `path`; resolve its admin state by `id`.
 */
export interface WorktreeInfo {
	/** Admin-dir id (basename under `.git/worktrees`), e.g. "wt-abc123". */
	id: string;
	/** Checkout path as a repo-root-relative selector, e.g. "../wt-abc123". */
	path: string;
	/** Short branch name checked out here, or null when detached. */
	branch: string | null;
	/** Whether the worktree is locked. */
	locked: boolean;
}

/** Snapshot of repo state used by actions to check preconditions. */
export interface QueryState {
	/** Working tree file paths (relative to repo root). */
	files: string[];
	/** Branch names (without refs/heads/ prefix). */
	branches: string[];
	/** Current branch name, or null if detached. */
	currentBranch: string | null;
	/** Whether the repo has at least one commit. */
	hasCommits: boolean;
	/** Whether a merge conflict is in progress (MERGE_HEAD exists). */
	inMergeConflict: boolean;
	/** Whether a cherry-pick conflict is in progress (CHERRY_PICK_HEAD exists). */
	inCherryPickConflict: boolean;
	/** Whether a revert conflict is in progress (REVERT_HEAD exists). */
	inRevertConflict: boolean;
	/** Whether a rebase conflict is in progress (rebase-merge/ exists). */
	inRebaseConflict: boolean;
	/** Number of stash entries. */
	stashCount: number;
	/** Configured remote names (e.g. ["origin"]). */
	remotes: string[];
	/** Linked worktrees (admin dirs under .git/worktrees), sorted by id. */
	worktrees: WorktreeInfo[];
}

// ── WalkHarness interface ────────────────────────────────────────────

/**
 * Minimal interface for executing git commands and managing files
 * in a repository. Actions and the walk engine use only this interface,
 * so any implementation (virtual-only, oracle dual, etc.) can be plugged in.
 */
export interface WalkHarness {
	/**
	 * Run a git command. `cwd` is a worktree-relative execution context (e.g.
	 * "../wt-x" to run inside a linked worktree); omit/undefined = primary.
	 */
	git(command: string, envOverride?: Record<string, string>, cwd?: string): Promise<ExecResult>;
	gitCommit(message: string, cwd?: string): Promise<ExecResult>;

	// File operations (used by conflict resolution actions). `cwd` targets a
	// linked worktree's checkout; omit/undefined = primary.
	writeFile(relPath: string, content: string, cwd?: string): Promise<void>;
	readFile(relPath: string, cwd?: string): Promise<string>;
	spliceFile(
		relPath: string,
		content: string,
		offset: number,
		deleteCount: number,
		cwd?: string,
	): Promise<void>;
	deleteFile(relPath: string, cwd?: string): Promise<void>;

	/** Apply a seed-determined batch of random file ops (optionally in a worktree). */
	applyFileOpBatch(seed: number, files: string[], cwd?: string): Promise<void>;

	/** Resolve all worktree files with deterministic random content. */
	resolveFiles(seed: number, cwd?: string): Promise<void>;

	/** Create a commit directly on the remote server. No-op when no server is available. */
	serverCommit?(seed: number, branch?: string): Promise<void>;

	// State queries. Methods that take `cwd` are *per-worktree* (HEAD, operation
	// state, working-tree files); pass a worktree-relative selector to query a
	// linked checkout. The rest (branches, stash, remotes, worktree list) are
	// shared common-dir state and ignore any execution context.
	listWorkTreeFiles(cwd?: string): Promise<string[]>;
	listBranches(): Promise<string[]>;
	getCurrentBranch(cwd?: string): Promise<string | null>;
	isInMergeConflict(cwd?: string): Promise<boolean>;
	isInCherryPickConflict(cwd?: string): Promise<boolean>;
	isInRevertConflict(cwd?: string): Promise<boolean>;
	isInRebaseConflict(cwd?: string): Promise<boolean>;
	hasCommits(cwd?: string): Promise<boolean>;
	getStashCount(): Promise<number>;
	listRemotes(): Promise<string[]>;
	/** Linked worktrees (admin dirs under .git/worktrees), sorted by id. */
	listWorktrees(): Promise<WorktreeInfo[]>;
}

// ── Default environment ──────────────────────────────────────────────

/**
 * Shared identity env vars for deterministic commits.
 * Timestamps include "+0000" to ensure consistent timezone.
 */
export const DEFAULT_TEST_ENV: Record<string, string> = {
	GIT_AUTHOR_NAME: "Test Author",
	GIT_AUTHOR_EMAIL: "author@test.com",
	GIT_COMMITTER_NAME: "Test Committer",
	GIT_COMMITTER_EMAIL: "committer@test.com",
	GIT_AUTHOR_DATE: "1000000000 +0000",
	GIT_COMMITTER_DATE: "1000000000 +0000",
};

/**
 * The admin-dir id for a worktree-relative selector, by the sibling-path
 * convention (`../wt-x` → `wt-x`). Used only as a fallback for resolving a
 * worktree's admin dir when its `.git` gitlink can't be read; the primary path
 * reads the gitlink so it survives `worktree move` and same-basename checkouts.
 */
export function worktreeIdFromCwd(cwd: string): string {
	return cwd.slice(cwd.lastIndexOf("/") + 1);
}

/**
 * Parse a worktree `.git` gitlink file's content (`gitdir: <adminDir>`) into
 * the admin dir path. Returns null when the content isn't a gitlink.
 */
export function adminDirFromGitlink(content: string): string | null {
	const trimmed = content.trim();
	return trimmed.startsWith("gitdir:") ? trimmed.slice("gitdir:".length).trim() : null;
}

// ── VirtualHarness ───────────────────────────────────────────────────

/**
 * WalkHarness backed by the in-memory virtual filesystem only.
 * No real git, no temp directories, no comparisons.
 */
export class VirtualHarness implements WalkHarness {
	readonly bash: Bash;
	readonly fileGenConfig: FileGenConfig;
	private commitCounter = 0;
	private readonly vfsRoot = "/repo";

	constructor(options?: { env?: Record<string, string>; fileGenConfig?: FileGenConfig }) {
		this.bash = new Bash({
			cwd: "/repo",
			customCommands: [createGitCommand().toCommand()],
			env: { ...DEFAULT_TEST_ENV, ...options?.env },
		});
		this.fileGenConfig = options?.fileGenConfig ?? DEFAULT_FILE_GEN_CONFIG;
	}

	/** Resolve a worktree-relative selector against the VFS root. */
	private rootFor(cwd?: string): string {
		return resolveWorktreeRoot(this.vfsRoot, cwd);
	}

	/**
	 * The git/admin dir holding a worktree's private HEAD + operation state.
	 * Primary → `<root>/.git`; a linked checkout's admin dir is read from its
	 * `.git` gitlink (so it's correct under `worktree move` / same-basename
	 * checkouts), falling back to the sibling-path convention if unreadable.
	 */
	private async gitDirFor(cwd?: string): Promise<string> {
		if (!cwd) return `${this.vfsRoot}/.git`;
		const gitlinkPath = `${this.rootFor(cwd)}/.git`;
		if (await this.bash.fs.exists(gitlinkPath)) {
			const admin = adminDirFromGitlink(await this.bash.fs.readFile(gitlinkPath));
			if (admin) return admin;
		}
		return `${this.vfsRoot}/.git/worktrees/${worktreeIdFromCwd(cwd)}`;
	}

	/**
	 * A worktree's checkout path as a repo-root-relative selector, read from its
	 * admin dir's `gitdir` pointer. Falls back to the `../<id>` convention when
	 * the pointer is missing.
	 */
	private async worktreePath(adminDir: string, id: string): Promise<string> {
		const gitdirFile = `${adminDir}/gitdir`;
		if (await this.bash.fs.exists(gitdirFile)) {
			const gitlink = (await this.bash.fs.readFile(gitdirFile)).trim();
			if (gitlink) return posixRelative(this.vfsRoot, gitlink.slice(0, gitlink.lastIndexOf("/")));
		}
		return `../${id}`;
	}

	async git(
		command: string,
		envOverride?: Record<string, string>,
		cwd?: string,
	): Promise<ExecResult> {
		let env = envOverride;
		if (!env && VirtualHarness.isCommitLikeCommand(command)) {
			this.commitCounter++;
			const ts = `${1000000000 + this.commitCounter} +0000`;
			env = { GIT_AUTHOR_DATE: ts, GIT_COMMITTER_DATE: ts };
		}
		const result = await this.bash.exec(`git ${command}`, {
			env,
			cwd: cwd ? this.rootFor(cwd) : undefined,
		});
		return {
			stdout: result.stdout,
			stderr: result.stderr,
			exitCode: result.exitCode,
		};
	}

	/**
	 * Detect git commands that create commits (need incrementing timestamps).
	 * Mirrors the logic in oracle/fileops.ts isCommitCommand(), inlined here
	 * to avoid a dependency from test/random/ to test/oracle/.
	 */
	private static isCommitLikeCommand(command: string): boolean {
		const lower = command.toLowerCase();
		return (
			lower.startsWith("commit") ||
			lower.startsWith("merge") ||
			lower.startsWith("cherry-pick") ||
			lower.startsWith("revert") ||
			lower.startsWith("pull") ||
			lower.includes("rebase --continue")
		);
	}

	async gitCommit(message: string, cwd?: string): Promise<ExecResult> {
		this.commitCounter++;
		const ts = `${1000000000 + this.commitCounter} +0000`;
		return this.git(
			`commit -m "${message}"`,
			{
				GIT_AUTHOR_DATE: ts,
				GIT_COMMITTER_DATE: ts,
			},
			cwd,
		);
	}

	async writeFile(relPath: string, content: string, cwd?: string): Promise<void> {
		const vfsPath = `${this.rootFor(cwd)}/${relPath}`;
		const dir = vfsPath.slice(0, vfsPath.lastIndexOf("/"));
		if (!(await this.bash.fs.exists(dir))) {
			await this.bash.fs.mkdir(dir, { recursive: true });
		}
		await this.bash.fs.writeFile(vfsPath, content);
	}

	async readFile(relPath: string, cwd?: string): Promise<string> {
		return this.bash.fs.readFile(`${this.rootFor(cwd)}/${relPath}`);
	}

	async spliceFile(
		relPath: string,
		content: string,
		offset: number,
		deleteCount: number,
		cwd?: string,
	): Promise<void> {
		const vfsPath = `${this.rootFor(cwd)}/${relPath}`;
		const existing = await this.bash.fs.readFile(vfsPath);
		const before = existing.slice(0, offset);
		const after = existing.slice(offset + deleteCount);
		await this.bash.fs.writeFile(vfsPath, before + content + after);
	}

	async deleteFile(relPath: string, cwd?: string): Promise<void> {
		await this.bash.fs.rm(`${this.rootFor(cwd)}/${relPath}`);
	}

	/** Build a FileOpTarget rooted at a worktree-relative selector. */
	private targetFor(cwd?: string): FileOpTarget {
		return {
			writeFile: (relPath, content) => this.writeFile(relPath, content, cwd),
			readFile: (relPath) => this.readFile(relPath, cwd),
			spliceFile: (relPath, content, offset, deleteCount) =>
				this.spliceFile(relPath, content, offset, deleteCount, cwd),
			deleteFile: (relPath) => this.deleteFile(relPath, cwd),
		};
	}

	async applyFileOpBatch(seed: number, files: string[], cwd?: string): Promise<void> {
		const list = cwd ? await this.listWorkTreeFiles(cwd) : files;
		await generateAndApplyFileOps(this.targetFor(cwd), seed, list, this.fileGenConfig);
	}

	async resolveFiles(seed: number, cwd?: string): Promise<void> {
		const files = await this.listWorkTreeFiles(cwd);
		await resolveAllFiles(this.targetFor(cwd), seed, files, this.fileGenConfig);
	}

	async listWorkTreeFiles(cwd?: string): Promise<string[]> {
		const files: string[] = [];
		await this.walkDir(this.rootFor(cwd), "", files);
		return files.sort();
	}

	private async walkDir(dirPath: string, prefix: string, files: string[]): Promise<void> {
		const entries = await this.bash.fs.readdir(dirPath);
		for (const entry of entries) {
			if (entry === ".git") continue;
			const fullPath = `${dirPath}/${entry}`;
			const relPath = prefix ? `${prefix}/${entry}` : entry;
			const stat = await this.bash.fs.lstat(fullPath);
			if (stat.isDirectory) {
				await this.walkDir(fullPath, relPath, files);
			} else if (stat.isFile) {
				files.push(relPath);
			}
		}
	}

	async listBranches(): Promise<string[]> {
		const branches = new Set<string>();
		const headsDir = `${this.vfsRoot}/.git/refs/heads`;
		await this.walkBranchNames(headsDir, "", branches);
		await this.collectPackedBranches(branches);
		return [...branches].sort();
	}

	private async walkBranchNames(
		dirPath: string,
		prefix: string,
		branches: Set<string>,
	): Promise<void> {
		if (!(await this.bash.fs.exists(dirPath))) return;
		const entries = await this.bash.fs.readdir(dirPath);
		for (const entry of entries) {
			const fullPath = `${dirPath}/${entry}`;
			const name = prefix ? `${prefix}/${entry}` : entry;
			const stat = await this.bash.fs.lstat(fullPath);
			if (stat.isDirectory) {
				await this.walkBranchNames(fullPath, name, branches);
			} else if (stat.isFile) {
				branches.add(name);
			}
		}
	}

	private async collectPackedBranches(branches: Set<string>): Promise<void> {
		const packedPath = `${this.vfsRoot}/.git/packed-refs`;
		if (!(await this.bash.fs.exists(packedPath))) return;
		const content = await this.bash.fs.readFile(packedPath);
		for (const line of content.split("\n")) {
			if (line.startsWith("#") || line.startsWith("^") || !line.trim()) continue;
			const parts = line.split(" ");
			if (parts.length >= 2 && parts[1]?.startsWith("refs/heads/")) {
				branches.add(parts[1].slice("refs/heads/".length));
			}
		}
	}

	async getCurrentBranch(cwd?: string): Promise<string | null> {
		const headPath = `${await this.gitDirFor(cwd)}/HEAD`;
		if (!(await this.bash.fs.exists(headPath))) return null;
		const content = (await this.bash.fs.readFile(headPath)).trim();
		return content.startsWith("ref: refs/heads/") ? content.slice("ref: refs/heads/".length) : null;
	}

	async isInMergeConflict(cwd?: string): Promise<boolean> {
		return this.bash.fs.exists(`${await this.gitDirFor(cwd)}/MERGE_HEAD`);
	}

	async isInCherryPickConflict(cwd?: string): Promise<boolean> {
		return this.bash.fs.exists(`${await this.gitDirFor(cwd)}/CHERRY_PICK_HEAD`);
	}

	async isInRevertConflict(cwd?: string): Promise<boolean> {
		return this.bash.fs.exists(`${await this.gitDirFor(cwd)}/REVERT_HEAD`);
	}

	async isInRebaseConflict(cwd?: string): Promise<boolean> {
		return this.bash.fs.exists(`${await this.gitDirFor(cwd)}/rebase-merge`);
	}

	async hasCommits(cwd?: string): Promise<boolean> {
		const headPath = `${await this.gitDirFor(cwd)}/HEAD`;
		if (!(await this.bash.fs.exists(headPath))) return false;
		const content = (await this.bash.fs.readFile(headPath)).trim();
		if (content.startsWith("ref: ")) {
			const refName = content.slice(5);
			// Branch refs live in the shared common-dir, not the per-worktree dir.
			if (await this.bash.fs.exists(`${this.vfsRoot}/.git/${refName}`)) return true;
			return this.refExistsInPackedRefs(refName);
		}
		return content.length === 40;
	}

	private async refExistsInPackedRefs(refName: string): Promise<boolean> {
		const packedPath = `${this.vfsRoot}/.git/packed-refs`;
		if (!(await this.bash.fs.exists(packedPath))) return false;
		const content = await this.bash.fs.readFile(packedPath);
		for (const line of content.split("\n")) {
			if (line.startsWith("#") || line.startsWith("^") || !line.trim()) continue;
			const parts = line.split(" ");
			if (parts.length >= 2 && parts[1] === refName) return true;
		}
		return false;
	}

	async getStashCount(): Promise<number> {
		const reflogPath = `${this.vfsRoot}/.git/logs/refs/stash`;
		if (!(await this.bash.fs.exists(reflogPath))) return 0;
		const content = await this.bash.fs.readFile(reflogPath);
		if (!content.trim()) return 0;
		return content.trim().split("\n").length;
	}

	async listRemotes(): Promise<string[]> {
		const result = await this.bash.exec("git remote");
		if (result.exitCode !== 0 || !result.stdout.trim()) return [];
		return result.stdout.trim().split("\n").filter(Boolean);
	}

	async listWorktrees(): Promise<WorktreeInfo[]> {
		const worktreesDir = `${this.vfsRoot}/.git/worktrees`;
		if (!(await this.bash.fs.exists(worktreesDir))) return [];
		const ids = (await this.bash.fs.readdir(worktreesDir)).sort();
		const infos: WorktreeInfo[] = [];
		for (const id of ids) {
			const adminDir = `${worktreesDir}/${id}`;
			let branch: string | null = null;
			const headPath = `${adminDir}/HEAD`;
			if (await this.bash.fs.exists(headPath)) {
				const content = (await this.bash.fs.readFile(headPath)).trim();
				if (content.startsWith("ref: refs/heads/")) {
					branch = content.slice("ref: refs/heads/".length);
				}
			}
			const locked = await this.bash.fs.exists(`${adminDir}/locked`);
			infos.push({ id, path: await this.worktreePath(adminDir, id), branch, locked });
		}
		return infos;
	}
}

// ── WorktreeView ─────────────────────────────────────────────────────

/**
 * A {@link WalkHarness} bound to a single linked worktree. Every command, file
 * op, and per-worktree state query is forwarded to the wrapped harness with a
 * fixed `cwd` selector, so an ordinary (worktree-unaware) action runs entirely
 * *inside* that checkout. Shared common-dir state (branches, stash, remotes,
 * the worktree list itself) is forwarded without a context.
 *
 * This is the mechanism behind the walk's worktree targeting: pick a worktree,
 * wrap the harness in a view, and the existing action catalog operates on it
 * unchanged — no per-action `cwd` plumbing required.
 */
export class WorktreeView implements WalkHarness {
	constructor(
		private readonly inner: WalkHarness,
		private readonly cwd: string,
	) {}

	// Per-worktree: commands + file ops route into the checkout.
	git(command: string, envOverride?: Record<string, string>): Promise<ExecResult> {
		return this.inner.git(command, envOverride, this.cwd);
	}
	gitCommit(message: string): Promise<ExecResult> {
		return this.inner.gitCommit(message, this.cwd);
	}
	writeFile(relPath: string, content: string): Promise<void> {
		return this.inner.writeFile(relPath, content, this.cwd);
	}
	readFile(relPath: string): Promise<string> {
		return this.inner.readFile(relPath, this.cwd);
	}
	spliceFile(relPath: string, content: string, offset: number, deleteCount: number): Promise<void> {
		return this.inner.spliceFile(relPath, content, offset, deleteCount, this.cwd);
	}
	deleteFile(relPath: string): Promise<void> {
		return this.inner.deleteFile(relPath, this.cwd);
	}
	applyFileOpBatch(seed: number, files: string[]): Promise<void> {
		return this.inner.applyFileOpBatch(seed, files, this.cwd);
	}
	resolveFiles(seed: number): Promise<void> {
		return this.inner.resolveFiles(seed, this.cwd);
	}

	// Per-worktree state queries.
	listWorkTreeFiles(): Promise<string[]> {
		return this.inner.listWorkTreeFiles(this.cwd);
	}
	getCurrentBranch(): Promise<string | null> {
		return this.inner.getCurrentBranch(this.cwd);
	}
	isInMergeConflict(): Promise<boolean> {
		return this.inner.isInMergeConflict(this.cwd);
	}
	isInCherryPickConflict(): Promise<boolean> {
		return this.inner.isInCherryPickConflict(this.cwd);
	}
	isInRevertConflict(): Promise<boolean> {
		return this.inner.isInRevertConflict(this.cwd);
	}
	isInRebaseConflict(): Promise<boolean> {
		return this.inner.isInRebaseConflict(this.cwd);
	}
	hasCommits(): Promise<boolean> {
		return this.inner.hasCommits(this.cwd);
	}

	// Shared common-dir state: context-independent.
	listBranches(): Promise<string[]> {
		return this.inner.listBranches();
	}
	getStashCount(): Promise<number> {
		return this.inner.getStashCount();
	}
	listRemotes(): Promise<string[]> {
		return this.inner.listRemotes();
	}
	listWorktrees(): Promise<WorktreeInfo[]> {
		return this.inner.listWorktrees();
	}
}
