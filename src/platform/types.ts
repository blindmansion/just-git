import type { Database } from "bun:sqlite";
import type { GitRepo, Identity } from "../lib/types.ts";

// ── Configuration ───────────────────────────────────────────────────

export interface PlatformConfig {
	database: Database;
	on?: PlatformCallbacks;
}

export interface PlatformCallbacks {
	onPullRequestCreated?: (event: PRCreatedEvent) => void | Promise<void>;
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
