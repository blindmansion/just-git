import type { AttributesProvider } from "./attributes.ts";
import { buildCapabilityContext } from "./config.ts";
import { FilterError } from "./filters.ts";
import type { ContentMergeFn } from "./merge-ort.ts";
import type { GitContext, GitOperation, GitRepo, ObjectId } from "./types.ts";

const encoder = new TextEncoder();

/**
 * The context-bound, path-aware accessor threaded through the engine — the one
 * handle both threading patterns read (merge threads it as a param; the
 * worktree pulls it on demand via {@link resolveAttributes}). Bound once per
 * operation at the capability boundary, over the single `attributes`
 * {@link AttributeResolver} capability.
 *
 * Every accessor is per-path and self-resolves the attribute: `clean`/`smudge`
 * are passthrough when no `filter=` driver applies, and `merge` returns `null`
 * (diff3 fallback) when no `merge=` driver applies — so a path with no
 * attributes keeps the engine's zero-overhead default behavior.
 *
 * See `local-docs/plans/attribute-resolver-seam.md` and the type sketch
 * `local-docs/sketches/attribute-resolver-types.d.ts`.
 */
export interface BoundAttributes {
	/** Worktree → blob. Passthrough when no filter applies to `path`. */
	clean(path: string, content: Uint8Array): Promise<Uint8Array>;
	/** Blob → worktree. Passthrough when no filter applies to `path`. */
	smudge(path: string, content: Uint8Array, blobOid?: ObjectId): Promise<Uint8Array>;
	/**
	 * Context-bound, per-path merge function (a {@link ContentMergeFn}). Resolves
	 * the path's `merge=<name>` driver and runs it, or returns `null` when none
	 * applies — preserving the engine's "null ⇒ diff3 fallback" semantics. Typed
	 * as a plain `ContentMergeFn` so the merge engine threads it unchanged; the
	 * `path` it needs is already carried in the `MergeDriverInput`.
	 */
	merge?: ContentMergeFn;
	/**
	 * Resolve the path's `diff=<driver>` presentation — the display-only half of
	 * attributes. Returns `undefined` when no diff driver applies (the formatter
	 * keeps its built-in binariness/funcname defaults). The returned
	 * {@link BoundDiff} carries the binary override and funcname regex as plain
	 * data, plus a ctx-bound {@link BoundDiff.textconv} runner.
	 */
	diff(path: string): Promise<BoundDiff | undefined>;
}

/**
 * The resolved, ctx-bound diff presentation for one path (the display-only
 * fields of a {@link DiffDriver}). `binary` overrides content sniffing
 * (`true` ⇒ "Binary files differ", `false` ⇒ force textual); `funcname` overrides
 * the hunk-header scan; `textconv` (present only when the driver defines one)
 * converts a blob to its display text with the capability context baked in.
 */
export interface BoundDiff {
	binary?: boolean;
	funcname?: RegExp;
	/** Run the driver's textconv (blob → display bytes); identity if it declines. */
	textconv?: (content: Uint8Array, blobOid?: ObjectId) => Promise<Uint8Array>;
}

/**
 * Bind the `attributes` resolver once per operation at the capability boundary.
 * Returns `undefined` — skipping all context construction — when no resolver is
 * configured, preserving the zero-overhead no-capability path.
 *
 * Accepts `GitRepo | GitContext`. A bare-`GitRepo` bind still yields host-policy
 * / computed behavior (the resolver needs only a {@link CapabilityContext}), but
 * in-tree `.gitattributes`-selected behavior requires a `GitContext` (the core
 * reads it into `ctx.attributes` at bind time). Commands hold a `gitCtx`, so
 * that is where in-tree selection is wired.
 *
 * `opts.attributes` overrides the in-tree lookup the core would otherwise build
 * from the handle. The SDK materialization seams use this to supply a
 * *tree-backed* {@link AttributesProvider} (`createTreeAttributesProvider`) so a
 * bare `GitRepo` with no worktree fs can still select filters from the
 * `.gitattributes` committed in the tree being written out.
 */
export async function bindAttributes(
	handle: GitRepo | GitContext,
	operation: GitOperation,
	opts?: { attributes?: AttributesProvider },
): Promise<BoundAttributes | undefined> {
	const resolver = handle.capabilities?.attributes;
	if (!resolver) return undefined;

	const base = await buildCapabilityContext(handle, operation);
	const ctx = opts?.attributes ? { ...base, attributes: opts.attributes } : base;

	async function runFilter(
		direction: "clean" | "smudge",
		path: string,
		content: Uint8Array,
		blobOid?: ObjectId,
	): Promise<Uint8Array> {
		const { filter } = await resolver!(ctx, path);
		const fn = direction === "clean" ? filter?.clean : filter?.smudge;
		if (!fn) return content;
		try {
			const out = await fn(ctx, { path, content, direction, blobOid });
			return out == null ? content : out;
		} catch (err) {
			if (filter?.required) {
				throw new FilterError(`${direction} filter failed for '${path}'`, { cause: err });
			}
			return content;
		}
	}

	const merge: ContentMergeFn = async (input) => {
		const { merge: driver } = await resolver!(ctx, input.path);
		if (!driver) return null;
		return driver(ctx, input);
	};

	const diff = async (path: string): Promise<BoundDiff | undefined> => {
		const { diff: driver } = await resolver!(ctx, path);
		if (!driver) return undefined;
		const convert = driver.textconv;
		return {
			binary: driver.binary,
			funcname: driver.funcname,
			textconv: convert
				? async (content, blobOid) => {
						const out = await convert(ctx, { path, content, blobOid });
						if (out == null) return content;
						return typeof out === "string" ? encoder.encode(out) : out;
					}
				: undefined,
		};
	};

	return {
		clean: (path, content) => runFilter("clean", path, content),
		smudge: (path, content, blobOid) => runFilter("smudge", path, content, blobOid),
		merge,
		diff,
	};
}

// ── Cached resolution for worktree seams (Pattern B) ────────────────

/**
 * Per-context, per-operation memo of {@link bindAttributes}. The worktree
 * engine (`status`/`checkout`/`add`) touches many files through the same `ctx`;
 * caching the bound form means the capability context and each `.gitattributes`
 * file are built/read once per command rather than once per file.
 */
const attributesCache = new WeakMap<
	GitContext,
	Map<GitOperation, Promise<BoundAttributes | undefined>>
>();

/**
 * Resolve {@link BoundAttributes} for a worktree seam, memoized per `ctx`
 * (Pattern B: pull-on-demand). The synchronous capability check keeps the
 * no-capability path allocation-free; only when an `attributes` resolver is
 * configured do we build (and cache) the bound form.
 */
export function resolveAttributes(
	ctx: GitContext,
	operation: GitOperation,
): Promise<BoundAttributes | undefined> {
	if (!ctx.capabilities?.attributes) {
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
