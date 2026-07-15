import { durableFileSystemFromNodeFs, type NodeFsPromises } from "../fs/node-durable-fs.ts";
import { createFsRepoPool, createFsSingleRepoPool, recoverFsRepoPool } from "./fs-repo-pool.ts";
import { createFsRepoStorage, recoverFsRepoStorage } from "./fs-repo-storage.ts";
import type { RepoPool } from "./repo-pool.ts";
import type { RepoStorage } from "./repo-storage.ts";

/** Open or create one native bare repository using a Node-compatible filesystem. */
export function createNodeFsRepoStorage(
	nodeFs: NodeFsPromises,
	repoDir: string,
): Promise<RepoStorage> {
	return createFsRepoStorage(durableFileSystemFromNodeFs(nodeFs), repoDir);
}

/** Explicitly recover a repository after confirming its durable ref lock is stale. */
export function recoverNodeFsRepoStorage(
	nodeFs: NodeFsPromises,
	repoDir: string,
): Promise<RepoStorage> {
	return recoverFsRepoStorage(durableFileSystemFromNodeFs(nodeFs), repoDir);
}

/** Create a managed pool of native bare repositories using a Node-compatible filesystem. */
export function createNodeFsRepoPool(nodeFs: NodeFsPromises, rootDir: string): Promise<RepoPool> {
	return createFsRepoPool(durableFileSystemFromNodeFs(nodeFs), rootDir);
}

/** Explicitly recover a managed pool after confirming its durable lock is stale. */
export function recoverNodeFsRepoPool(nodeFs: NodeFsPromises, rootDir: string): Promise<RepoPool> {
	return recoverFsRepoPool(durableFileSystemFromNodeFs(nodeFs), rootDir);
}

/** Expose one native bare repository through a fixed logical repository ID. */
export function createNodeFsSingleRepoPool(
	nodeFs: NodeFsPromises,
	repoId: string,
	repoDir: string,
): Promise<RepoPool> {
	return createFsSingleRepoPool(durableFileSystemFromNodeFs(nodeFs), repoId, repoDir);
}
