import { durableFileSystemFromNodeFs, type NodeFsPromises } from "../fs/node-durable-fs.ts";
import { createFsRepoPool, createFsSingleRepoPool } from "./fs-repo-pool.ts";
import { createFsRepoStorage } from "./fs-repo-storage.ts";
import type { RepoPool } from "./repo-pool.ts";
import type { RepoStorage } from "./repo-storage.ts";

/** Open or create one native bare repository using a Node-compatible filesystem. */
export function createNodeFsRepoStorage(
	nodeFs: NodeFsPromises,
	repoDir: string,
): Promise<RepoStorage> {
	return createFsRepoStorage(durableFileSystemFromNodeFs(nodeFs), repoDir);
}

/** Create a managed pool of native bare repositories using a Node-compatible filesystem. */
export function createNodeFsRepoPool(nodeFs: NodeFsPromises, rootDir: string): Promise<RepoPool> {
	return createFsRepoPool(durableFileSystemFromNodeFs(nodeFs), rootDir);
}

/** Expose one native bare repository through a fixed logical repository ID. */
export function createNodeFsSingleRepoPool(
	nodeFs: NodeFsPromises,
	repoId: string,
	repoDir: string,
): Promise<RepoPool> {
	return createFsSingleRepoPool(durableFileSystemFromNodeFs(nodeFs), repoId, repoDir);
}
