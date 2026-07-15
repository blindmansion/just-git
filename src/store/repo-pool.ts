import type { MaybeAsync } from "./repo-store.ts";
import type { RepoStorage } from "./repo-storage.ts";

/**
 * A namespace of repositories that vends single-repo storage handles.
 *
 * Lifecycle and fork relationships live here rather than in RepoStorage so
 * single-repo backends do not need to implement multi-repo concerns.
 */
export interface RepoPool {
	hasRepo(repoId: string): MaybeAsync<boolean>;
	createRepo(repoId: string): MaybeAsync<void>;
	deleteRepo(repoId: string): MaybeAsync<void>;
	open(repoId: string): MaybeAsync<RepoStorage>;

	fork?(sourceId: string, targetId: string): MaybeAsync<void>;
	parentOf?(repoId: string): MaybeAsync<string | null>;
	forksOf?(repoId: string): MaybeAsync<string[]>;
}
