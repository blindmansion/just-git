import type { Database } from "bun:sqlite";
import type { GitRepo } from "../lib/types.ts";
import { composeHooks, createGitServer } from "../server/handler.ts";
import { resolveRef } from "../repo/helpers.ts";
import { SqliteStorage } from "../server/sqlite-storage.ts";
import type { GitServer, GitServerConfig, ServerHooks } from "../server/types.ts";
import { executeMerge, MergeError } from "./pull-requests.ts";
import { PlatformDb } from "./storage.ts";
import type {
	Authorize,
	CreatePullRequestOptions,
	ListPullRequestsFilter,
	MergePullRequestOptions,
	MergeResult,
	PlatformCallbacks,
	PlatformConfig,
	PlatformServerOptions,
	PRState,
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

		if (this.callbacks.beforeMerge) {
			const rejection = await this.callbacks.beforeMerge({
				repo: gitRepo,
				repoId,
				pr,
				strategy: opts.strategy,
			});
			if (rejection && "reject" in rejection && rejection.reject) {
				throw new MergeError(rejection.message ?? `merge rejected for PR #${number}`, "rejected");
			}
		}

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

	gitServer(options?: {
		hooks?: ServerHooks;
		basePath?: string;
		authorize?: Authorize;
	}): GitServer {
		const platform = this;
		const authorize = options?.authorize;

		const config: GitServerConfig = {
			resolveRepo: async (repoPath: string, request: Request) => {
				const repoRecord = platform.platformDb.getRepo(repoPath);
				if (!repoRecord) return null;
				if (authorize) {
					const denied = await authorize(request, repoPath);
					if (denied) return denied;
				}
				return platform.storage.repo(repoPath);
			},

			hooks: composeHooks(
				{
					async postReceive(event) {
						const repoId = event.repoPath;

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
								const previousHeadSha = pr.headSha;
								platform.platformDb.updateHeadSha(repoId, pr.number, update.newHash);
								await event.repo.refStore.writeRef(`refs/pull/${pr.number}/head`, {
									type: "direct",
									hash: update.newHash,
								});

								if (platform.callbacks.onPullRequestUpdated) {
									const updated = platform.platformDb.getPullRequest(repoId, pr.number)!;
									try {
										await platform.callbacks.onPullRequestUpdated({
											repo: event.repo,
											repoId,
											pr: updated,
											previousHeadSha,
										});
									} catch {
										// fire-and-forget
									}
								}
							}
						}
					},
				},
				options?.hooks,
			),

			basePath: options?.basePath,
		};

		return createGitServer(config);
	}

	// ── Combined server (git protocol + REST API) ────────────────────

	/**
	 * Returns a combined server handling both git Smart HTTP protocol
	 * and REST API routes for pull requests.
	 *
	 * API routes (under `apiBasePath`, default "/api"):
	 *   GET    /:repo/pulls            — list PRs (?state=open|closed|merged)
	 *   POST   /:repo/pulls            — create PR
	 *   GET    /:repo/pulls/:number    — get PR
	 *   PATCH  /:repo/pulls/:number    — update PR title/body
	 *   POST   /:repo/pulls/:number/merge — merge PR
	 *   POST   /:repo/pulls/:number/close — close PR
	 *
	 * All other routes are handled by the git protocol server.
	 */
	server(options?: PlatformServerOptions): GitServer {
		const apiBase = options?.apiBasePath ?? "/api";
		const authorize = options?.authorize;
		const git = this.gitServer({ hooks: options?.hooks, authorize });

		return {
			fetch: async (req: Request): Promise<Response> => {
				const { pathname } = new URL(req.url);
				if (pathname.startsWith(apiBase + "/")) {
					const apiPath = pathname.slice(apiBase.length);
					if (authorize) {
						const repoId = apiPath.split("/")[1];
						if (repoId) {
							const denied = await authorize(req, repoId);
							if (denied) return denied;
						}
					}
					const apiResponse = await this.handleApiRoute(req, apiPath);
					if (apiResponse) return apiResponse;
					return jsonResponse({ error: "not found" }, 404);
				}
				return git.fetch(req);
			},
		};
	}

	private async handleApiRoute(req: Request, path: string): Promise<Response | null> {
		const { method } = req;

		// /:repo/pulls
		const pullsMatch = path.match(/^\/([^/]+)\/pulls$/);
		if (pullsMatch) {
			const repoId = pullsMatch[1]!;
			if (method === "GET") {
				const state = new URL(req.url).searchParams.get("state") as PRState | null;
				return jsonResponse(this.listPullRequests(repoId, state ? { state } : undefined));
			}
			if (method === "POST") {
				try {
					const body = (await req.json()) as CreatePullRequestOptions;
					const pr = await this.createPullRequest(repoId, body);
					return jsonResponse(pr, 201);
				} catch (e: any) {
					return jsonResponse({ error: e.message }, 400);
				}
			}
			return null;
		}

		// /:repo/pulls/:number/merge
		const mergeMatch = path.match(/^\/([^/]+)\/pulls\/(\d+)\/merge$/);
		if (mergeMatch && method === "POST") {
			try {
				const body = (await req.json()) as MergePullRequestOptions;
				const result = await this.mergePullRequest(mergeMatch[1]!, Number(mergeMatch[2]!), body);
				return jsonResponse(result);
			} catch (e: any) {
				const status = e instanceof MergeError ? 409 : 400;
				return jsonResponse({ error: e.message }, status);
			}
		}

		// /:repo/pulls/:number/close
		const closeMatch = path.match(/^\/([^/]+)\/pulls\/(\d+)\/close$/);
		if (closeMatch && method === "POST") {
			try {
				await this.closePullRequest(closeMatch[1]!, Number(closeMatch[2]!));
				return jsonResponse({ ok: true });
			} catch (e: any) {
				return jsonResponse({ error: e.message }, 400);
			}
		}

		// /:repo/pulls/:number (must come after /merge and /close)
		const prMatch = path.match(/^\/([^/]+)\/pulls\/(\d+)$/);
		if (prMatch) {
			const repoId = prMatch[1]!;
			const num = Number(prMatch[2]!);
			if (method === "GET") {
				const pr = this.getPullRequest(repoId, num);
				return pr ? jsonResponse(pr) : jsonResponse({ error: "not found" }, 404);
			}
			if (method === "PATCH") {
				try {
					const body = (await req.json()) as UpdatePullRequestOptions;
					this.updatePullRequest(repoId, num, body);
					return jsonResponse(this.getPullRequest(repoId, num));
				} catch (e: any) {
					return jsonResponse({ error: e.message }, 400);
				}
			}
			return null;
		}

		return null;
	}
}

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data, null, 2), {
		status,
		headers: { "content-type": "application/json" },
	});
}

export function createPlatform(config: PlatformConfig): Platform {
	return new Platform(config);
}
