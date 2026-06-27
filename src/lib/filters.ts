import { createAttributesProvider } from "./attributes.ts";
import { buildCapabilityContext } from "./config.ts";
import type { CapabilityContext, GitContext, GitOperation, ObjectId } from "./types.ts";

// ── Capability shape ────────────────────────────────────────────────

/**
 * A single named clean/smudge driver — the host-provided, trusted half of a
 * git content filter (git's `[filter "<name>"]`). The untrusted half lives in
 * `.gitattributes` (`filter=<name>`), which only *selects* a driver; a name
 * with no registered driver is passthrough, exactly as git treats a `filter=`
 * attribute with no matching config.
 *
 * Either direction may be omitted (a missing side is identity passthrough,
 * matching git). The async-function form subsumes all of git's mechanics:
 * single-shot `clean`/`smudge`, the long-running `process` protocol, and the
 * `delay` capability collapse to "return the bytes (eventually)".
 */
export interface FilterDriver {
	/** Check-in: worktree bytes → blob bytes (add / commit -a / status / diff). */
	clean?: FilterFn;
	/** Check-out: blob bytes → worktree bytes (checkout / merge / …). */
	smudge?: FilterFn;
	/**
	 * git's `filter.<name>.required`. Default `false`. Governs a *thrown* error
	 * only: `true` ⇒ fatal (the operation aborts); `false` ⇒ passthrough the
	 * input bytes. A `null` return is always a clean passthrough regardless.
	 */
	required?: boolean;
}

/**
 * One direction of a {@link FilterDriver}. Returns the transformed bytes, or
 * `null` to decline (passthrough the input unchanged) — the same "fall back to
 * default" convention as a merge driver. Throw to signal failure, whose
 * fatal-vs-passthrough handling is decided by {@link FilterDriver.required}.
 */
export type FilterFn = (
	ctx: CapabilityContext,
	input: FilterInput,
) => Uint8Array | null | Promise<Uint8Array | null>;

/** Per-file data for one filter invocation. */
export interface FilterInput {
	/** Repo-relative path — the `.gitattributes` lookup key and git's `%f`. */
	path: string;
	/** Bytes to transform: worktree bytes on clean, blob bytes on smudge. */
	content: Uint8Array;
	/** Which direction is running. */
	direction: "clean" | "smudge";
	/** Blob OID — present on smudge only; there is no OID yet on clean. */
	blobOid?: ObjectId;
}

/**
 * The filters capability: a registry of named drivers. `.gitattributes`
 * resolves a path to a name; the engine fires the matching driver if (and only
 * if) it is registered here.
 *
 * Filtering needs BOTH halves and fails *silently* (passthrough, never an
 * error) when either is missing — matching git. So a registered driver does
 * nothing on its own: if no `.gitattributes` maps the path to its name (e.g.
 * the file is absent, or has no `filter=<name>` line for that path), the
 * content is passed through untouched. Likewise a `filter=<name>` attribute
 * whose name is not in this registry is passthrough. When debugging "my filter
 * never ran", check the `.gitattributes` mapping first.
 */
export type FilterConfig = Record<string, FilterDriver>;

/** Raised when a `required` driver throws, mirroring git's fatal filter error. */
export class FilterError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "FilterError";
	}
}

// ── Bound form ──────────────────────────────────────────────────────

/**
 * The context-bound filter chokepoints threaded through the worktree engine.
 * Both always resolve to bytes — attribute lookup, missing drivers, `null`
 * returns, and non-required failures are all handled internally as
 * passthrough — so a seam is just `content = await filters.clean(path, bytes)`.
 */
export interface BoundFilters {
	clean(path: string, content: Uint8Array): Promise<Uint8Array>;
	smudge(path: string, content: Uint8Array, blobOid?: ObjectId): Promise<Uint8Array>;
}

/**
 * Read the `filters` capability off a handle and bind it to a freshly
 * snapshotted {@link CapabilityContext} plus an attribute resolver, yielding
 * the context-free {@link BoundFilters} the engine uses. Returns `undefined` —
 * and skips building the context entirely — when no filters are configured, so
 * the common no-filter path keeps zero overhead. Mirrors `bindMergeDriver`.
 *
 * The bound `clean`/`smudge` always resolve to bytes: a path with no matching
 * `.gitattributes` `filter=<name>`, a name with no registered driver, a driver
 * missing that direction, and a `null` return are all silent passthrough. Only
 * a thrown error from a `required` driver surfaces (as {@link FilterError}).
 */
export async function bindFilters(
	handle: GitContext,
	operation: GitOperation,
): Promise<BoundFilters | undefined> {
	const filters = handle.capabilities?.filters;
	if (!filters || Object.keys(filters).length === 0) return undefined;

	const cap = await buildCapabilityContext(handle, operation);
	const attrs = createAttributesProvider(handle);

	async function run(
		direction: "clean" | "smudge",
		path: string,
		content: Uint8Array,
		blobOid?: ObjectId,
	): Promise<Uint8Array> {
		const name = await attrs.get(path, "filter");
		if (typeof name !== "string" || name === "") return content;

		const driver = filters![name];
		if (!driver) return content;

		const fn = direction === "clean" ? driver.clean : driver.smudge;
		if (!fn) return content;

		try {
			const out = await fn(cap, { path, content, direction, blobOid });
			return out == null ? content : out;
		} catch (err) {
			if (driver.required) {
				throw new FilterError(`${direction} filter '${name}' failed for '${path}'`, {
					cause: err,
				});
			}
			return content;
		}
	}

	return {
		clean: (path, content) => run("clean", path, content),
		smudge: (path, content, blobOid) => run("smudge", path, content, blobOid),
	};
}
