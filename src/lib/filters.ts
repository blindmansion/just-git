import type { CapabilityContext, ObjectId } from "./types.ts";

// ── Driver shape ────────────────────────────────────────────────────

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
 * A registry of named clean/smudge drivers, selected by `.gitattributes`
 * `filter=<name>`. Pass to `gitAttributes({ filters })`: the in-tree
 * `.gitattributes` resolves a path to a name, and the matching driver fires if
 * (and only if) it is registered here. A `filter=<name>` whose name is not in
 * the registry is passthrough, matching git.
 */
export type FilterConfig = Record<string, FilterDriver>;

/** Raised when a `required` driver throws, mirroring git's fatal filter error. */
export class FilterError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "FilterError";
	}
}
