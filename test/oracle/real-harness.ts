/**
 * WalkHarness backed by real git in a temp directory.
 * Extracted from test/random/harness.ts — same isolation, no virtual side.
 */

import { mkdir, mkdtemp, readdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_FILE_GEN_CONFIG,
	type FileGenConfig,
	generateAndApplyFileOps,
	resolveAllFiles,
} from "../random/file-gen";
import { DEFAULT_TEST_ENV, type ExecResult, type WalkHarness } from "../random/harness";
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
	return {
		PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/local/bin",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_COUNT: "2",
		GIT_CONFIG_KEY_0: "init.defaultBranch",
		GIT_CONFIG_VALUE_0: "main",
		GIT_CONFIG_KEY_1: "gc.auto",
		GIT_CONFIG_VALUE_1: "0",
		HOME: homeDir,
		GIT_EDITOR: "true",
		...DEFAULT_TEST_ENV,
		...overrides,
	};
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
		const repoDir = await mkdtemp(join(tmpdir(), "oracle-git-"));
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

	async git(command: string, envOverride?: Record<string, string>): Promise<ExecResult> {
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
			cwd: this.repoDir,
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

	async gitCommit(message: string): Promise<ExecResult> {
		this.commitCounter++;
		const ts = `${1000000000 + this.commitCounter} +0000`;
		return this.git(`commit -m "${message}"`, {
			GIT_AUTHOR_DATE: ts,
			GIT_COMMITTER_DATE: ts,
		});
	}

	async writeFile(relPath: string, content: string): Promise<void> {
		const fullPath = join(this.repoDir, relPath);
		await mkdir(join(fullPath, ".."), { recursive: true });
		await writeFile(fullPath, content);
	}

	async readFile(relPath: string): Promise<string> {
		return readFile(join(this.repoDir, relPath), "utf-8");
	}

	async spliceFile(
		relPath: string,
		content: string,
		offset: number,
		deleteCount: number,
	): Promise<void> {
		const fullPath = join(this.repoDir, relPath);
		const existing = await readFile(fullPath, "utf-8");
		const before = existing.slice(0, offset);
		const after = existing.slice(offset + deleteCount);
		await writeFile(fullPath, before + content + after);
	}

	async deleteFile(relPath: string): Promise<void> {
		try {
			await unlink(join(this.repoDir, relPath));
		} catch {
			// File may not exist
		}
	}

	// ── WalkHarness: seed-based batch ────────────────────────────

	async applyFileOpBatch(seed: number, files: string[]): Promise<void> {
		await generateAndApplyFileOps(this, seed, files, this.fileGenConfig);
	}

	async resolveFiles(seed: number): Promise<void> {
		const files = await this.listWorkTreeFiles();
		await resolveAllFiles(this, seed, files, this.fileGenConfig);
	}

	// ── WalkHarness: state queries ───────────────────────────────

	async listWorkTreeFiles(): Promise<string[]> {
		const files: string[] = [];
		await this.walkDir(this.repoDir, "", files);
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
		return result.stdout
			.trim()
			.split("\n")
			.map((line) => line.replace(/^\*?\s*/, "").trim())
			.filter((name) => name.length > 0 && !name.startsWith("("))
			.sort();
	}

	async getCurrentBranch(): Promise<string | null> {
		const headPath = join(this.repoDir, ".git", "HEAD");
		try {
			const content = (await readFile(headPath, "utf-8")).trim();
			return content.startsWith("ref: refs/heads/")
				? content.slice("ref: refs/heads/".length)
				: null;
		} catch {
			return null;
		}
	}

	async isInMergeConflict(): Promise<boolean> {
		return fileExists(join(this.repoDir, ".git", "MERGE_HEAD"));
	}

	async isInCherryPickConflict(): Promise<boolean> {
		return fileExists(join(this.repoDir, ".git", "CHERRY_PICK_HEAD"));
	}

	async isInRevertConflict(): Promise<boolean> {
		return fileExists(join(this.repoDir, ".git", "REVERT_HEAD"));
	}

	async isInRebaseConflict(): Promise<boolean> {
		return (
			(await fileExists(join(this.repoDir, ".git", "rebase-merge"))) ||
			(await fileExists(join(this.repoDir, ".git", "rebase-apply")))
		);
	}

	async hasCommits(): Promise<boolean> {
		const result = await this.git("rev-parse HEAD");
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
		await rm(this.repoDir, { recursive: true, force: true });
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
