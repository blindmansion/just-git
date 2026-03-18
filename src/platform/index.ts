export { createPlatform, Platform } from "./platform.ts";
export { MergeError } from "./pull-requests.ts";
export { PlatformDb } from "./storage.ts";

export type {
	CreatePullRequestOptions,
	ListPullRequestsFilter,
	MergePullRequestOptions,
	MergeResult,
	MergeStrategy,
	PlatformCallbacks,
	PlatformConfig,
	PRClosedEvent,
	PRCreatedEvent,
	PRMergedEvent,
	PRState,
	PullRequest,
	PushEvent,
	Repo,
	UpdatePullRequestOptions,
} from "./types.ts";
