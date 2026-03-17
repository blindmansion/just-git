import type { ObjectStore, RefStore } from "../lib/types.ts";

/**
 * Minimal storage context for a server-side repository.
 * Provides just the two backends needed for Smart HTTP serving.
 */
export interface ServerRepoContext {
	objects: ObjectStore;
	refs: RefStore;
}

/**
 * Options for `createGitServer()`.
 */
export interface GitServerOptions {
	/** Map a URL path segment to a repo's storage backends. */
	resolve: (repoPath: string) => ServerRepoContext | Promise<ServerRepoContext>;
	/** Optional authorization hook called before upload-pack and receive-pack. */
	authorize?: (
		req: Request,
		repoPath: string,
		operation: "upload-pack" | "receive-pack",
	) => AuthResult | Promise<AuthResult>;
	/** Called after a successful push with the list of ref updates. */
	onPush?: (repoPath: string, refUpdates: RefUpdate[]) => void | Promise<void>;
	/** Base path prefix to strip from URLs (e.g. "/git"). */
	basePath?: string;
	/** Reject non-fast-forward ref updates (like `receive.denyNonFastForwards`). Defaults to false. */
	denyNonFastForwards?: boolean;
}

export interface AuthResult {
	ok: boolean;
	status?: number;
	message?: string;
}

export interface RefUpdate {
	name: string;
	oldHash: string;
	newHash: string;
	ok: boolean;
	error?: string;
}
