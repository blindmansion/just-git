import { isGitContext } from "./config.ts";
import { bindFilters } from "./filters.ts";
import { bindMergeDriver, type ContentMergeFn } from "./merge-ort.ts";
import type { GitContext, GitOperation, GitRepo, ObjectId } from "./types.ts";

/**
 * The context-bound, path-aware accessor threaded through the engine — the
 * generalization of `BoundFilters` and the bound `ContentMergeFn` into ONE
 * handle. Bound once per operation at the capability boundary.
 *
 * Phase 1 (current): implemented purely over today's `capabilities.filters` +
 * `capabilities.mergeDriver` — there is no `AttributeResolver` yet.
 * `clean`/`smudge` delegate to {@link bindFilters}; `merge` is the single global
 * driver (it fires for every conflicting path, exactly as today). Per-path,
 * attribute-selected behavior arrives in Phase 3, when this is backed by the
 * resolver instead. The shape is chosen so that swap is invisible to callers.
 *
 * See the design sketch: `local-docs/sketches/attribute-resolver-types.d.ts` §8
 * and the plan `local-docs/plans/attribute-resolver-seam.md` §10–§11.
 */
export interface BoundAttributes {
	/** Worktree → blob. Passthrough when no filter applies to `path`. */
	clean(path: string, content: Uint8Array): Promise<Uint8Array>;
	/** Blob → worktree. Passthrough when no filter applies to `path`. */
	smudge(path: string, content: Uint8Array, blobOid?: ObjectId): Promise<Uint8Array>;
	/**
	 * Context-bound, per-path merge function (a {@link ContentMergeFn}), or
	 * `undefined` when no driver applies — preserving today's "undefined ⇒
	 * diff3 fallback" engine semantics exactly. The engine threads this in place
	 * of the bare bound merge driver; `path` is already carried in the
	 * `MergeDriverInput` the engine passes, so no leaf signature changes.
	 */
	merge?: ContentMergeFn;
}

const passthroughClean: BoundAttributes["clean"] = (_path, content) => Promise.resolve(content);
const passthroughSmudge: BoundAttributes["smudge"] = (_path, content) => Promise.resolve(content);

/**
 * Bind once per operation at the capability boundary — the unified replacement
 * for separate {@link bindFilters} + {@link bindMergeDriver} calls (Phase 2
 * migrates the worktree and merge engines onto it). Returns `undefined` —
 * skipping all context construction — when neither filters nor a merge driver
 * are configured, preserving the zero-overhead no-capability path.
 *
 * Accepts `GitRepo | GitContext` like `bindMergeDriver`. Content filters need a
 * {@link GitContext} (they read `.gitattributes` off the vfs), so a bare-`GitRepo`
 * bind yields the merge driver only and leaves `clean`/`smudge` as passthrough.
 * In-tree attribute selection (Phase 3) likewise requires a `GitContext`, so
 * commands — which hold a `gitCtx` — remain the place that wires it.
 */
export async function bindAttributes(
	handle: GitRepo | GitContext,
	operation: GitOperation,
): Promise<BoundAttributes | undefined> {
	const filters = isGitContext(handle) ? await bindFilters(handle, operation) : undefined;
	const merge = await bindMergeDriver(handle, operation);
	if (!filters && !merge) return undefined;
	return {
		clean: filters ? filters.clean : passthroughClean,
		smudge: filters ? filters.smudge : passthroughSmudge,
		merge,
	};
}

// ── Cached resolution for worktree seams (Pattern B) ────────────────

/**
 * Per-context, per-operation memo of {@link bindAttributes} — the unified
 * successor to `resolveFilters`. The worktree engine (`status`/`checkout`/
 * `add`) touches many files through the same `ctx`; caching the bound form
 * means the capability context and each `.gitattributes` file are built/read
 * once per command rather than once per file.
 */
const attributesCache = new WeakMap<
	GitContext,
	Map<GitOperation, Promise<BoundAttributes | undefined>>
>();

/**
 * Resolve {@link BoundAttributes} for a worktree seam, memoized per `ctx`
 * (Pattern B: pull-on-demand). The synchronous capability check keeps the
 * no-capability path allocation-free; only when filters or a merge driver are
 * configured do we build (and cache) the bound form. Worktree leaves read only
 * `.clean`/`.smudge` from it — `.merge` is unused there but harmless to bind.
 */
export function resolveAttributes(
	ctx: GitContext,
	operation: GitOperation,
): Promise<BoundAttributes | undefined> {
	if (!ctx.capabilities?.filters && !ctx.capabilities?.mergeDriver) {
		return Promise.resolve(undefined);
	}

	let byOp = attributesCache.get(ctx);
	if (!byOp) {
		byOp = new Map();
		attributesCache.set(ctx, byOp);
	}
	let pending = byOp.get(operation);
	if (!pending) {
		pending = bindAttributes(ctx, operation);
		byOp.set(operation, pending);
	}
	return pending;
}
