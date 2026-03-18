import type { Database } from "bun:sqlite";
import type { GitRepo, Identity } from "../lib/types.ts";
import type { Rejection } from "../server/types.ts";

export type { Rejection };

// ── Configuration ───────────────────────────────────────────────────

export interface PlatformConfig {
	database: Database;
	on?: PlatformCallbacks;
}

export interface PlatformCallbacks {
	beforeMerge?: (event: BeforeMergeEvent) => void | Rejection | Promise<void | Rejection>;
	onPullRequestCreated?: (event: PRCreatedEvent) => void | Promise<void>;
	onPullRequestUpdated?: (event: PRUpdatedEvent) => void | Promise<void>;
	onPullRequestMerged?: (event: PRMergedEvent) => void | Promise<void>;
	onPullRequestClosed?: (event: PRClosedEvent) => void | Promise<void>;
	onPush?: (event: PushEvent) => void | Promise<void>;
}

// ── Callback events ─────────────────────────────────────────────────

export interface PRCreatedEvent {
	repo: GitRepo;
	repoId: string;
	pr: PullRequest;
}

export interface PRMergedEvent {
	repo: GitRepo;
	repoId: string;
	pr: PullRequest;
	mergeCommitSha: string;
	strategy: MergeStrategy;
}

export interface BeforeMergeEvent {
	repo: GitRepo;
	repoId: string;
	pr: PullRequest;
	strategy: MergeStrategy;
}

export interface PRUpdatedEvent {
	repo: GitRepo;
	repoId: string;
	pr: PullRequest;
	previousHeadSha: string | null;
}

export interface PRClosedEvent {
	repo: GitRepo;
	repoId: string;
	pr: PullRequest;
}

export interface PushEvent {
	repo: GitRepo;
	repoId: string;
	ref: string;
	oldHash: string | null;
	newHash: string;
}

// ── Domain models ───────────────────────────────────────────────────

export interface Repo {
	id: string;
	defaultBranch: string;
	createdAt: string;
}

export interface PullRequest {
	repoId: string;
	number: number;
	headRef: string;
	baseRef: string;
	headSha: string | null;
	title: string;
	body: string;
	state: PRState;
	authorName: string;
	authorEmail: string;
	createdAt: string;
	updatedAt: string;
	mergedAt: string | null;
	mergeCommitSha: string | null;
	mergeStrategy: MergeStrategy | null;
}

export type PRState = "open" | "closed" | "merged";

export type MergeStrategy = "merge" | "squash" | "fast-forward";

// ── Merge ───────────────────────────────────────────────────────────

export interface MergeResult {
	sha: string;
	strategy: MergeStrategy;
}

export interface MergePullRequestOptions {
	strategy: MergeStrategy;
	committer: Identity;
	message?: string;
}

// ── PR creation ─────────────────────────────────────────────────────

export interface CreatePullRequestOptions {
	head: string;
	base: string;
	title: string;
	body?: string;
	author: { name: string; email: string };
}

export interface UpdatePullRequestOptions {
	title?: string;
	body?: string;
}

export interface ListPullRequestsFilter {
	state?: PRState;
}

// ── Server ──────────────────────────────────────────────────────────

/**
 * Called before each request that targets a repo (git protocol and API).
 * Return a `Response` to deny the request (e.g., 401/403).
 * Return `void` to allow it.
 */
export type Authorize = (
	request: Request,
	repoId: string,
) => Response | void | Promise<Response | void>;

export interface PlatformServerOptions {
	/** Server-side git hooks (preReceive, update, postReceive, advertiseRefs). */
	hooks?: import("../server/types.ts").ServerHooks;
	/** URL prefix for REST API routes (default: "/api"). */
	apiBasePath?: string;
	/**
	 * Called before each request (git and API) that targets a repo.
	 * Receives the raw `Request` and the `repoId` extracted from the URL.
	 * Return a `Response` to deny (e.g., 401/403). Return void to allow.
	 */
	authorize?: Authorize;
}
