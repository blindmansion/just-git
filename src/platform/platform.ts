import type { Database } from "bun:sqlite";
import type { GitRepo, ObjectStore } from "../lib/types.ts";
import { createGitServer } from "../server/handler.ts";
import { resolveRef } from "../server/helpers.ts";
import { SqliteStorage } from "../server/sqlite-storage.ts";
import type { GitServer, GitServerConfig, ServerHooks } from "../server/types.ts";
import { executeMerge, MergeError } from "./pull-requests.ts";
import { PlatformDb } from "./storage.ts";
import type {
	CreatePullRequestOptions,
	ListPullRequestsFilter,
	MergePullRequestOptions,
	MergeResult,
	PlatformCallbacks,
	PlatformConfig,
	PullRequest,
	Repo,
	UpdatePullRequestOptions,
} from "./types.ts";

export class Platform {
	private storage: SqliteStorage;
	private platformDb: PlatformDb;
	private callbacks: PlatformCallbacks;

	/** The raw SQLite database, for user queries against platform tables. */
	readonly db: Database;

	constructor(config: PlatformConfig) {
		this.db = config.database;
		this.storage = new SqliteStorage(config.database);
		this.platformDb = new PlatformDb(config.database);
		this.callbacks = config.on ?? {};
	}

	// ── Repo operations ─────────────────────────────────────────────

	createRepo(id: string, options?: { defaultBranch?: string }): Repo {
		const defaultBranch = options?.defaultBranch ?? "main";
		const repo = this.platformDb.createRepo(id, defaultBranch);

		const gitRepo = this.storage.repo(id);
		gitRepo.refStore.writeRef("HEAD", {
			type: "symbolic",
			target: `refs/heads/${defaultBranch}`,
		});

		return repo;
	}

	getRepo(id: string): Repo | null {
		return this.platformDb.getRepo(id);
	}

	listRepos(): Repo[] {
		return this.platformDb.listRepos();
	}

	deleteRepo(id: string): void {
		this.platformDb.deleteRepo(id);
		this.storage.deleteRepo(id);
	}

	// ── Direct git access ───────────────────────────────────────────

	gitRepo(repoId: string): GitRepo {
		return this.storage.repo(repoId);
	}

	// ── PR operations ───────────────────────────────────────────────

	async createPullRequest(repoId: string, opts: CreatePullRequestOptions): Promise<PullRequest> {
		const repoRecord = this.platformDb.getRepo(repoId);
		if (!repoRecord) {
			throw new Error(`repo '${repoId}' not found`);
		}

		const gitRepo = this.storage.repo(repoId);

		const headSha = await resolveRef(gitRepo, `refs/heads/${opts.head}`);
		if (!headSha) {
			throw new Error(`head ref 'refs/heads/${opts.head}' does not exist`);
		}

		const baseSha = await resolveRef(gitRepo, `refs/heads/${opts.base}`);
		if (!baseSha) {
			throw new Error(`base ref 'refs/heads/${opts.base}' does not exist`);
		}

		const pr = this.platformDb.createPullRequest(repoId, opts, headSha);

		await gitRepo.refStore.writeRef(`refs/pull/${pr.number}/head`, {
			type: "direct",
			hash: headSha,
		});

		if (this.callbacks.onPullRequestCreated) {
			try {
				await this.callbacks.onPullRequestCreated({ repo: gitRepo, repoId, pr });
			} catch {
				// callback errors don't affect operation
			}
		}

		return pr;
	}

	getPullRequest(repoId: string, number: number): PullRequest | null {
		return this.platformDb.getPullRequest(repoId, number);
	}

	listPullRequests(repoId: string, filter?: ListPullRequestsFilter): PullRequest[] {
		return this.platformDb.listPullRequests(repoId, filter);
	}

	updatePullRequest(repoId: string, number: number, opts: UpdatePullRequestOptions): void {
		const pr = this.platformDb.getPullRequest(repoId, number);
		if (!pr) throw new Error(`PR #${number} not found in repo '${repoId}'`);
		this.platformDb.updatePullRequest(repoId, number, opts);
	}

	async closePullRequest(repoId: string, number: number): Promise<void> {
		const pr = this.platformDb.getPullRequest(repoId, number);
		if (!pr) throw new Error(`PR #${number} not found in repo '${repoId}'`);
		if (pr.state !== "open") throw new Error(`PR #${number} is already ${pr.state}`);

		this.platformDb.closePullRequest(repoId, number);

		if (this.callbacks.onPullRequestClosed) {
			const gitRepo = this.storage.repo(repoId);
			const closed = this.platformDb.getPullRequest(repoId, number)!;
			try {
				await this.callbacks.onPullRequestClosed({ repo: gitRepo, repoId, pr: closed });
			} catch {
				// callback errors don't affect operation
			}
		}
	}

	async mergePullRequest(
		repoId: string,
		number: number,
		opts: MergePullRequestOptions,
	): Promise<MergeResult> {
		const pr = this.platformDb.getPullRequest(repoId, number);
		if (!pr) throw new Error(`PR #${number} not found in repo '${repoId}'`);
		if (pr.state !== "open") {
			throw new MergeError(`PR #${number} is already ${pr.state}`, "not_open");
		}

		const gitRepo = this.storage.repo(repoId);

		const result = await executeMerge({
			repo: gitRepo,
			strategy: opts.strategy,
			baseRef: `refs/heads/${pr.baseRef}`,
			headRef: `refs/heads/${pr.headRef}`,
			expectedHeadSha: pr.headSha,
			committer: opts.committer,
			message: opts.message,
		});

		await gitRepo.refStore.writeRef(`refs/heads/${pr.baseRef}`, {
			type: "direct",
			hash: result.sha,
		});

		this.platformDb.markMerged(repoId, number, result.sha, result.strategy);

		if (this.callbacks.onPullRequestMerged) {
			const merged = this.platformDb.getPullRequest(repoId, number)!;
			try {
				await this.callbacks.onPullRequestMerged({
					repo: gitRepo,
					repoId,
					pr: merged,
					mergeCommitSha: result.sha,
					strategy: result.strategy,
				});
			} catch {
				// callback errors don't affect operation
			}
		}

		return result;
	}

	// ── Git server integration ──────────────────────────────────────

	gitServer(options?: { hooks?: ServerHooks; basePath?: string }): GitServer {
		const platform = this;
		const repoIdByStore = new WeakMap<ObjectStore, string>();

		const config: GitServerConfig = {
			resolveRepo: (repoPath: string) => {
				const repoRecord = platform.platformDb.getRepo(repoPath);
				if (!repoRecord) return null;
				const repo = platform.storage.repo(repoPath);
				repoIdByStore.set(repo.objectStore, repoPath);
				return repo;
			},

			hooks: {
				...options?.hooks,

				async postReceive(event) {
					const repoId = repoIdByStore.get(event.repo.objectStore);
					if (!repoId) return;

					for (const update of event.updates) {
						if (!update.ref.startsWith("refs/heads/")) continue;
						const branch = update.ref.slice("refs/heads/".length);

						if (platform.callbacks.onPush) {
							try {
								await platform.callbacks.onPush({
									repo: event.repo,
									repoId,
									ref: update.ref,
									oldHash: update.oldHash,
									newHash: update.newHash,
								});
							} catch {
								// fire-and-forget
							}
						}

						const openPRs = platform.platformDb.findOpenPRsByHeadRef(repoId, branch);
						for (const pr of openPRs) {
							platform.platformDb.updateHeadSha(repoId, pr.number, update.newHash);
							await event.repo.refStore.writeRef(`refs/pull/${pr.number}/head`, {
								type: "direct",
								hash: update.newHash,
							});
						}
					}

					if (options?.hooks?.postReceive) {
						await options.hooks.postReceive(event);
					}
				},
			},

			basePath: options?.basePath,
		};

		return createGitServer(config);
	}
}

export function createPlatform(config: PlatformConfig): Platform {
	return new Platform(config);
}
