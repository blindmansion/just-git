/**
 * WalkHarness backed by real git in a temp directory.
 * Extracted from test/random/harness.ts — same isolation, no virtual side.
 */

import { mkdir, mkdtemp, readdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	DEFAULT_FILE_GEN_CONFIG,
	type FileGenConfig,
	type FileOpTarget,
	generateAndApplyFileOps,
	generateServerCommitFiles,
	resolveAllFiles,
	resolveWorktreeRoot,
} from "../random/file-gen";
import {
	DEFAULT_TEST_ENV,
	type ExecResult,
	type WalkHarness,
	type WorktreeInfo,
	worktreeIdFromCwd,
} from "../random/harness";
import { isolatedGitEnv } from "../real-git";
import { isCommitCommand } from "./fileops";
import { createServer, MemoryStorage, type GitServer } from "../../src/server/index";

// ── Environment ──────────────────────────────────────────────────

/**
 * Build an isolated environment for running real git in a temp directory.
 * Blocks global/system config, sets default branch to "main", and includes
 * the shared test identity from DEFAULT_TEST_ENV.
 */
export function buildRealGitEnv(
	homeDir: string,
	overrides?: Record<string, string>,
): Record<string, string> {
	return isolatedGitEnv(homeDir, { ...DEFAULT_TEST_ENV, ...overrides });
}

// ── RealGitHarness ───────────────────────────────────────────────

export class RealGitHarness implements WalkHarness {
	commitCounter = 0;
	readonly fileGenConfig: FileGenConfig;
	/** HTTP base URL when a remote server is active (e.g. "http://localhost:34567"). */
	readonly remoteBaseUrl: string | null;

	private server: GitServer | null = null;
	private httpServer: ReturnType<typeof Bun.serve> | null = null;

	private constructor(
		readonly repoDir: string,
		private readonly homeDir: string,
		private readonly env: Record<string, string>,
		fileGenConfig: FileGenConfig,
		remoteBaseUrl: string | null,
	) {
		this.fileGenConfig = fileGenConfig;
		this.remoteBaseUrl = remoteBaseUrl;
	}

	static async create(
		fileGenConfig: FileGenConfig = DEFAULT_FILE_GEN_CONFIG,
		options?: { withRemote?: boolean },
	): Promise<RealGitHarness> {
		const homeDir = await mkdtemp(join(tmpdir(), "oracle-home-"));
		// Nest the repo one level down so sibling paths (e.g. a worktree added
		// at `../wt-x`) land inside this trace's private temp dir — isolated
		// from other traces and removed by cleanup — rather than in the shared
		// system temp root.
		const repoParent = await mkdtemp(join(tmpdir(), "oracle-git-"));
		const repoDir = join(repoParent, "repo");
		await mkdir(repoDir, { recursive: true });
		const env = buildRealGitEnv(homeDir);

		let remoteBaseUrl: string | null = null;
		const harness = new RealGitHarness(repoDir, homeDir, env, fileGenConfig, null);

		if (options?.withRemote) {
			const server = createServer({
				storage: new MemoryStorage(),
				autoCreate: true,
			});
			const httpServer = Bun.serve({
				fetch: server.fetch,
				port: 0,
			});
			remoteBaseUrl = `http://localhost:${httpServer.port}`;
			harness.server = server;
			harness.httpServer = httpServer;
			(harness as { remoteBaseUrl: string | null }).remoteBaseUrl = remoteBaseUrl;
		}

		return harness;
	}

	// ── WalkHarness: commands ────────────────────────────────────

	/** Resolve a worktree-relative selector against the repo root. */
	private rootFor(cwd?: string): string {
		return resolveWorktreeRoot(this.repoDir, cwd);
	}

	/**
	 * The git/admin dir holding a worktree's private HEAD + operation state.
	 * Primary → `<repo>/.git`; a linked checkout → `<repo>/.git/worktrees/<id>`,
	 * where `<id>` is the selector basename (the sibling-path convention).
	 */
	private gitDirFor(cwd?: string): string {
		if (!cwd) return join(this.repoDir, ".git");
		return join(this.repoDir, ".git", "worktrees", worktreeIdFromCwd(cwd));
	}

	async git(
		command: string,
		envOverride?: Record<string, string>,
		cwd?: string,
	): Promise<ExecResult> {
		let env: Record<string, string>;
		if (envOverride) {
			env = { ...this.env, ...envOverride };
		} else if (isCommitCommand(command)) {
			this.commitCounter++;
			const ts = `${1000000000 + this.commitCounter} +0000`;
			env = { ...this.env, GIT_AUTHOR_DATE: ts, GIT_COMMITTER_DATE: ts };
		} else {
			env = this.env;
		}
		const proc = Bun.spawn(["sh", "-c", `git ${command}`], {
			cwd: this.rootFor(cwd),
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { stdout, stderr, exitCode };
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
		const fullPath = join(this.rootFor(cwd), relPath);
		await mkdir(join(fullPath, ".."), { recursive: true });
		await writeFile(fullPath, content);
	}

	async readFile(relPath: string, cwd?: string): Promise<string> {
		return readFile(join(this.rootFor(cwd), relPath), "utf-8");
	}

	async spliceFile(
		relPath: string,
		content: string,
		offset: number,
		deleteCount: number,
		cwd?: string,
	): Promise<void> {
		const fullPath = join(this.rootFor(cwd), relPath);
		const existing = await readFile(fullPath, "utf-8");
		const before = existing.slice(0, offset);
		const after = existing.slice(offset + deleteCount);
		await writeFile(fullPath, before + content + after);
	}

	async deleteFile(relPath: string, cwd?: string): Promise<void> {
		try {
			await unlink(join(this.rootFor(cwd), relPath));
		} catch {
			// File may not exist
		}
	}

	// ── WalkHarness: seed-based batch ────────────────────────────

	/** Build a FileOpTarget rooted at a worktree-relative selector. */
	private targetFor(cwd?: string): FileOpTarget {
		const root = this.rootFor(cwd);
		return {
			async writeFile(relPath, content) {
				const fullPath = join(root, relPath);
				await mkdir(join(fullPath, ".."), { recursive: true });
				await writeFile(fullPath, content);
			},
			readFile: (relPath) => readFile(join(root, relPath), "utf-8"),
			async spliceFile(relPath, content, offset, deleteCount) {
				const fullPath = join(root, relPath);
				const existing = await readFile(fullPath, "utf-8");
				await writeFile(
					fullPath,
					existing.slice(0, offset) + content + existing.slice(offset + deleteCount),
				);
			},
			async deleteFile(relPath) {
				try {
					await unlink(join(root, relPath));
				} catch {
					// File may not exist
				}
			},
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

	// ── WalkHarness: server-side commit ──────────────────────────

	async serverCommit(seed: number, branch: string = "main"): Promise<void> {
		if (!this.server) return;
		const files = generateServerCommitFiles(seed, this.fileGenConfig);
		await this.server.commit("repo", {
			files,
			message: `server-commit-${seed}`,
			author: {
				name: "Server",
				email: "server@test.com",
				date: new Date((3000000000 + seed) * 1000),
			},
			branch,
		});
	}

	// ── WalkHarness: state queries ───────────────────────────────

	async listWorkTreeFiles(cwd?: string): Promise<string[]> {
		const files: string[] = [];
		await this.walkDir(this.rootFor(cwd), "", files);
		return files.sort();
	}

	private async walkDir(dirPath: string, prefix: string, files: string[]): Promise<void> {
		let entries: string[];
		try {
			entries = await readdir(dirPath);
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry === ".git") continue;
			const fullPath = join(dirPath, entry);
			const relPath = prefix ? `${prefix}/${entry}` : entry;
			const info = await stat(fullPath).catch(() => null);
			if (!info) continue;
			if (info.isDirectory()) {
				await this.walkDir(fullPath, relPath, files);
			} else if (info.isFile()) {
				files.push(relPath);
			}
		}
	}

	async listBranches(): Promise<string[]> {
		// Use `git branch` instead of for-each-ref — the %(…) format
		// string gets mangled by sh -c (parens are shell syntax).
		const result = await this.git("branch");
		if (result.exitCode !== 0 || !result.stdout.trim()) return [];
		return (
			result.stdout
				.trim()
				.split("\n")
				// `git branch` prefixes the current branch with "* " and a branch
				// checked out in another worktree with "+ "; strip either marker.
				.map((line) => line.replace(/^[*+]?\s*/, "").trim())
				.filter((name) => name.length > 0 && !name.startsWith("("))
				.sort()
		);
	}

	async getCurrentBranch(cwd?: string): Promise<string | null> {
		const headPath = join(this.gitDirFor(cwd), "HEAD");
		try {
			const content = (await readFile(headPath, "utf-8")).trim();
			return content.startsWith("ref: refs/heads/")
				? content.slice("ref: refs/heads/".length)
				: null;
		} catch {
			return null;
		}
	}

	async isInMergeConflict(cwd?: string): Promise<boolean> {
		return fileExists(join(this.gitDirFor(cwd), "MERGE_HEAD"));
	}

	async isInCherryPickConflict(cwd?: string): Promise<boolean> {
		return fileExists(join(this.gitDirFor(cwd), "CHERRY_PICK_HEAD"));
	}

	async isInRevertConflict(cwd?: string): Promise<boolean> {
		return fileExists(join(this.gitDirFor(cwd), "REVERT_HEAD"));
	}

	async isInRebaseConflict(cwd?: string): Promise<boolean> {
		const gitDir = this.gitDirFor(cwd);
		return (
			(await fileExists(join(gitDir, "rebase-merge"))) ||
			(await fileExists(join(gitDir, "rebase-apply")))
		);
	}

	async hasCommits(cwd?: string): Promise<boolean> {
		const result = await this.git("rev-parse HEAD", undefined, cwd);
		return result.exitCode === 0;
	}

	async getStashCount(): Promise<number> {
		const result = await this.git("stash list");
		if (result.exitCode !== 0 || !result.stdout.trim()) return 0;
		return result.stdout.trim().split("\n").length;
	}

	async listRemotes(): Promise<string[]> {
		const result = await this.git("remote");
		if (result.exitCode !== 0 || !result.stdout.trim()) return [];
		return result.stdout.trim().split("\n").filter(Boolean);
	}

	async listWorktrees(): Promise<WorktreeInfo[]> {
		const worktreesDir = join(this.repoDir, ".git", "worktrees");
		let ids: string[];
		try {
			ids = (await readdir(worktreesDir)).sort();
		} catch {
			return [];
		}
		const infos: WorktreeInfo[] = [];
		for (const id of ids) {
			const adminDir = join(worktreesDir, id);
			let branch: string | null = null;
			try {
				const content = (await readFile(join(adminDir, "HEAD"), "utf-8")).trim();
				if (content.startsWith("ref: refs/heads/")) {
					branch = content.slice("ref: refs/heads/".length);
				}
			} catch {
				// HEAD missing — treat as detached/unknown.
			}
			const locked = await fileExists(join(adminDir, "locked"));
			infos.push({ id, branch, locked });
		}
		return infos;
	}

	// ── Cleanup ──────────────────────────────────────────────────

	async cleanup(): Promise<void> {
		if (this.httpServer) {
			this.httpServer.stop(true);
			this.httpServer = null;
		}
		if (this.server) {
			await this.server.close();
			this.server = null;
		}
		await rm(dirname(this.repoDir), { recursive: true, force: true });
		await rm(this.homeDir, { recursive: true, force: true });
	}
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}
