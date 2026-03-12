import { Bash } from "just-bash";
import { createGitCommand } from "../../src/commands/git";
import {
	DEFAULT_FILE_GEN_CONFIG,
	type FileGenConfig,
	generateAndApplyFileOps,
	resolveAllFiles,
} from "./file-gen";

// ── Types ────────────────────────────────────────────────────────────

export interface ExecResult {
	stdout: string;
	stderr: string;
	exitCode: number;
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
}

// ── WalkHarness interface ────────────────────────────────────────────

/**
 * Minimal interface for executing git commands and managing files
 * in a repository. Actions and the walk engine use only this interface,
 * so any implementation (virtual-only, oracle dual, etc.) can be plugged in.
 */
export interface WalkHarness {
	git(command: string, envOverride?: Record<string, string>): Promise<ExecResult>;
	gitCommit(message: string): Promise<ExecResult>;

	// File operations (used by conflict resolution actions)
	writeFile(relPath: string, content: string): Promise<void>;
	readFile(relPath: string): Promise<string>;
	spliceFile(relPath: string, content: string, offset: number, deleteCount: number): Promise<void>;
	deleteFile(relPath: string): Promise<void>;

	/** Apply a seed-determined batch of random file ops. */
	applyFileOpBatch(seed: number, files: string[]): Promise<void>;

	/** Resolve all worktree files with deterministic random content. */
	resolveFiles(seed: number): Promise<void>;

	// State queries
	listWorkTreeFiles(): Promise<string[]>;
	listBranches(): Promise<string[]>;
	getCurrentBranch(): Promise<string | null>;
	isInMergeConflict(): Promise<boolean>;
	isInCherryPickConflict(): Promise<boolean>;
	isInRevertConflict(): Promise<boolean>;
	isInRebaseConflict(): Promise<boolean>;
	hasCommits(): Promise<boolean>;
	getStashCount(): Promise<number>;
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

	async git(command: string, envOverride?: Record<string, string>): Promise<ExecResult> {
		let env = envOverride;
		if (!env && VirtualHarness.isCommitLikeCommand(command)) {
			this.commitCounter++;
			const ts = `${1000000000 + this.commitCounter} +0000`;
			env = { GIT_AUTHOR_DATE: ts, GIT_COMMITTER_DATE: ts };
		}
		const result = await this.bash.exec(`git ${command}`, { env });
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
			lower.includes("rebase --continue")
		);
	}

	async gitCommit(message: string): Promise<ExecResult> {
		this.commitCounter++;
		const ts = `${1000000000 + this.commitCounter} +0000`;
		return this.git(`commit -m "${message}"`, {
			GIT_AUTHOR_DATE: ts,
			GIT_COMMITTER_DATE: ts,
		});
	}

	async writeFile(relPath: string, content: string): Promise<void> {
		const vfsPath = `${this.vfsRoot}/${relPath}`;
		const dir = vfsPath.slice(0, vfsPath.lastIndexOf("/"));
		if (!(await this.bash.fs.exists(dir))) {
			await this.bash.fs.mkdir(dir, { recursive: true });
		}
		await this.bash.fs.writeFile(vfsPath, content);
	}

	async readFile(relPath: string): Promise<string> {
		return this.bash.fs.readFile(`${this.vfsRoot}/${relPath}`);
	}

	async spliceFile(
		relPath: string,
		content: string,
		offset: number,
		deleteCount: number,
	): Promise<void> {
		const vfsPath = `${this.vfsRoot}/${relPath}`;
		const existing = await this.bash.fs.readFile(vfsPath);
		const before = existing.slice(0, offset);
		const after = existing.slice(offset + deleteCount);
		await this.bash.fs.writeFile(vfsPath, before + content + after);
	}

	async deleteFile(relPath: string): Promise<void> {
		await this.bash.fs.rm(`${this.vfsRoot}/${relPath}`);
	}

	async applyFileOpBatch(seed: number, files: string[]): Promise<void> {
		await generateAndApplyFileOps(this, seed, files, this.fileGenConfig);
	}

	async resolveFiles(seed: number): Promise<void> {
		const files = await this.listWorkTreeFiles();
		await resolveAllFiles(this, seed, files, this.fileGenConfig);
	}

	async listWorkTreeFiles(): Promise<string[]> {
		const files: string[] = [];
		await this.walkDir(this.vfsRoot, "", files);
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

	async getCurrentBranch(): Promise<string | null> {
		const headPath = `${this.vfsRoot}/.git/HEAD`;
		if (!(await this.bash.fs.exists(headPath))) return null;
		const content = (await this.bash.fs.readFile(headPath)).trim();
		return content.startsWith("ref: refs/heads/") ? content.slice("ref: refs/heads/".length) : null;
	}

	async isInMergeConflict(): Promise<boolean> {
		return this.bash.fs.exists(`${this.vfsRoot}/.git/MERGE_HEAD`);
	}

	async isInCherryPickConflict(): Promise<boolean> {
		return this.bash.fs.exists(`${this.vfsRoot}/.git/CHERRY_PICK_HEAD`);
	}

	async isInRevertConflict(): Promise<boolean> {
		return this.bash.fs.exists(`${this.vfsRoot}/.git/REVERT_HEAD`);
	}

	async isInRebaseConflict(): Promise<boolean> {
		return this.bash.fs.exists(`${this.vfsRoot}/.git/rebase-merge`);
	}

	async hasCommits(): Promise<boolean> {
		const headPath = `${this.vfsRoot}/.git/HEAD`;
		if (!(await this.bash.fs.exists(headPath))) return false;
		const content = (await this.bash.fs.readFile(headPath)).trim();
		if (content.startsWith("ref: ")) {
			const refName = content.slice(5);
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
}
