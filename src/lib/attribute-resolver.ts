import type { AttrLookup, AttrValue } from "./attributes.ts";
import { parseAttributesText } from "./attributes.ts";
import { diff3Merge, splitLinesWithSentinel, stripSentinel } from "./diff3.ts";
import type { FilterDriver } from "./filters.ts";
import type { MergeDriver, MergeDriverInput, MergeDriverResult } from "./merge-ort.ts";
import type { CapabilityContext, ObjectId } from "./types.ts";

// ── The seam ────────────────────────────────────────────────────────

/**
 * The single open seam for `.gitattributes`-driven behavior — the merge/diff/
 * filter analog of `TransportResolver`. Given a path, return the fully-resolved
 * behaviors that apply to it (ready-to-run impls, NOT names): the core never
 * parses `.gitattributes` and never does a name → impl registry lookup, it just
 * calls this and reads the one field it needs.
 *
 * Takes a {@link CapabilityContext} (no `fs`), so a resolver driven by non-vfs
 * sources — host policy, size sniffing, a per-tenant DB, `ctx.operation` /
 * `ctx.env` — is portable to a bare {@link GitRepo}. Reading in-tree
 * `.gitattributes` is not a property of the seam; it is a property of the
 * built-in {@link gitAttributes} default, which reads it through
 * `ctx.attributes` (the in-tree provider the core builds at the bind boundary).
 */
export type AttributeResolver = (
	ctx: CapabilityContext,
	path: string,
) => ResolvedAttributes | Promise<ResolvedAttributes>;

/**
 * The resolved behaviors for one path — a typed struct of ready-to-run impls.
 * Only the behaviors that apply to this path are present; an empty object means
 * "git defaults everywhere" for it. Each engine seam reads exactly one field.
 */
export interface ResolvedAttributes {
	/** Clean/smudge content filter, ready to run. */
	filter?: FilterDriver;
	/** Attribute-selected merge driver (per-path). */
	merge?: MergeDriver;
	/** Display-only diff customization (textconv / binariness / hunk headers). */
	diff?: DiffDriver;
	// text / eol / ident … land here as consumers arrive (later phases).
}

// ── Diff drivers (display-only) ─────────────────────────────────────

/**
 * A `diff=<name>` driver — the **read-only / display-only** half of attributes.
 * Unlike a {@link FilterDriver} (which rewrites stored bytes), nothing here
 * changes content: it only customizes how a diff is *rendered*. Selected by the
 * `diff` attribute (`diff=<name>` for a named driver; the boolean forms `diff` /
 * `-diff` map onto {@link binary} below).
 *
 * The high-value field for agent workflows is {@link textconv}: convert an
 * opaque/noisy blob to a compact, stable text form before diffing (LFS pointer →
 * metadata, minified bundle → pretty, generated file → digest), shrinking the
 * diff a reader has to consume. (`command` / `wordRegex` — external diff and
 * `--word-diff` tokenization — are not executed yet; they land when a consumer
 * exists.)
 */
export interface DiffDriver {
	/**
	 * Force binariness, overriding content sniffing. `true` ⇒ treat as binary
	 * (`Binary files differ`, the `-diff` attribute); `false` ⇒ force a textual
	 * diff even if the bytes look binary (the `diff` attribute); `undefined` ⇒
	 * auto-detect as usual.
	 */
	binary?: boolean;
	/**
	 * Convert a blob to its text representation *before* diffing — git's
	 * `diff.<name>.textconv`. Display-only and cacheable by `blobOid`. Return the
	 * converted bytes/text, or `null` to decline (use the raw content unchanged).
	 */
	textconv?: (
		ctx: CapabilityContext,
		input: DiffTextconvInput,
	) => Uint8Array | string | null | Promise<Uint8Array | string | null>;
	/**
	 * Hunk-header pattern — git's `diff.<name>.xfuncname`. Lines matching this
	 * regex become the `@@ … <here> @@` context shown above each hunk, giving an
	 * agent semantic locality without reading the surrounding body. Overrides the
	 * built-in default funcname scan.
	 */
	funcname?: RegExp;
}

/** Per-blob input to a {@link DiffDriver.textconv}. */
export interface DiffTextconvInput {
	/** Repo-relative path — the `.gitattributes` lookup key. */
	path: string;
	/** Blob bytes to convert. */
	content: Uint8Array;
	/** Blob OID, when diffing a stored object (absent for worktree content). */
	blobOid?: ObjectId;
}

// ── The shipped default: a helper that PRODUCES a resolver ───────────

/** Options for the git-faithful {@link gitAttributes} resolver. */
export interface GitAttributesOptions {
	/** `name → clean/smudge driver` registry, selected by `filter=<name>`. */
	filters?: Record<string, FilterDriver>;
	/**
	 * `name → merge driver` registry, selected by `merge=<name>`. Layered over
	 * the built-in drivers (`union`, `binary`); a host entry overrides a builtin
	 * of the same name.
	 */
	mergeDrivers?: Record<string, MergeDriver>;
	/**
	 * `name → diff driver` registry, selected by `diff=<name>`. The boolean
	 * attribute forms need no registry: `-diff` ⇒ binary, `diff` ⇒ force textual.
	 */
	diffDrivers?: Record<string, DiffDriver>;
	/**
	 * Host policy in `.gitattributes` format, layered ABOVE in-tree attributes —
	 * an untrusted in-tree `.gitattributes` cannot override it.
	 */
	locked?: string;
	/** Baseline in `.gitattributes` format, layered BELOW in-tree attributes. */
	defaults?: string;
}

/**
 * Build the git-faithful resolver from `name → impl` registries plus optional
 * host policy layers. This is the `httpTransport(...)` analog: git-faithful
 * behavior lives here, in helper-land, not in core. It reads in-tree
 * `.gitattributes` through `ctx.attributes` (so it needs no `fs` of its own)
 * and looks the resolved names up in the registries.
 *
 * Precedence per attribute: `locked` (host) > in-tree (info/attributes >
 * `.gitattributes` deep→shallow, via the provider) > `defaults` (host).
 */
export function gitAttributes(opts: GitAttributesOptions = {}): AttributeResolver {
	const locked: AttrLookup | undefined = opts.locked ? parseAttributesText(opts.locked) : undefined;
	const defaults: AttrLookup | undefined = opts.defaults
		? parseAttributesText(opts.defaults)
		: undefined;
	const filters = opts.filters ?? {};
	const mergeDrivers = { ...BUILTIN_MERGE_DRIVERS, ...opts.mergeDrivers };
	const diffDrivers = opts.diffDrivers ?? {};

	return async (ctx, path) => {
		const attr = async (name: string): Promise<AttrValue> => {
			if (locked) {
				const v = locked(path, name);
				if (v !== undefined) return v;
			}
			const inTree = await ctx.attributes.get(path, name);
			if (inTree !== undefined) return inTree;
			return defaults ? defaults(path, name) : undefined;
		};

		const resolved: ResolvedAttributes = {};

		const filterName = await attr("filter");
		if (typeof filterName === "string" && filters[filterName]) {
			resolved.filter = filters[filterName];
		}

		const mergeName = await attr("merge");
		if (typeof mergeName === "string" && mergeDrivers[mergeName]) {
			resolved.merge = mergeDrivers[mergeName];
		}

		const diffAttr = await attr("diff");
		if (diffAttr === false) {
			// `-diff`: treat the path as binary.
			resolved.diff = { binary: true };
		} else if (diffAttr === true) {
			// `diff`: force a textual diff regardless of content sniffing.
			resolved.diff = { binary: false };
		} else if (typeof diffAttr === "string" && diffDrivers[diffAttr]) {
			resolved.diff = diffDrivers[diffAttr];
		}

		return resolved;
	};
}

/**
 * The trivial "apply to every path" resolver — the composable replacement for
 * the old global `mergeDriver` / `filters` capabilities. `everyPath({ merge })`
 * returns `{ merge }` for every path (the legacy global-driver ergonomic),
 * `everyPath({ filter })` likewise. It composes the one seam, rather than being
 * a second published field.
 */
export function everyPath(behaviors: ResolvedAttributes): AttributeResolver {
	return () => behaviors;
}

/**
 * Compose resolvers into one, first-set-wins per field — the {@link AttributeResolver}
 * analog of transport's `pipe`. For each behavior (`filter`, `merge`, …) the
 * earliest resolver that supplies it wins; later resolvers only fill the gaps.
 *
 * This is how host policy layers over project defaults at the *impl* level:
 * `pipeAttributes(everyPath({ filter: hostLocked }), gitAttributes({…}))` lets a
 * host pin a filter no in-tree `.gitattributes` can displace, while still
 * deferring every un-pinned field to the git-faithful resolver. (Value-level
 * layering — forcing a `filter=<name>` *selection* rather than an impl — is the
 * `locked` / `defaults` options on {@link gitAttributes}.)
 */
export function pipeAttributes(...resolvers: AttributeResolver[]): AttributeResolver {
	return async (ctx, path) => {
		const merged: ResolvedAttributes = {};
		for (const resolve of resolvers) {
			const part = await resolve(ctx, path);
			for (const key of Object.keys(part) as (keyof ResolvedAttributes)[]) {
				if (merged[key] === undefined && part[key] !== undefined) {
					merged[key] = part[key] as never;
				}
			}
		}
		return merged;
	};
}

// ── Built-in merge drivers ──────────────────────────────────────────

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/**
 * git's built-in `merge=union`: keep both sides' changes in a conflicting
 * region (ours then theirs), with no conflict markers. Always resolves clean.
 */
const unionMergeDriver: MergeDriver = (_ctx, input: MergeDriverInput): MergeDriverResult => {
	const a = splitLinesWithSentinel(decoder.decode(input.ours));
	const o = splitLinesWithSentinel(input.base ? decoder.decode(input.base) : "");
	const b = splitLinesWithSentinel(decoder.decode(input.theirs));

	const out: string[] = [];
	for (const block of diff3Merge(a, o, b, { conflictStyle: "merge" })) {
		if (block.type === "ok") {
			out.push(...block.lines);
		} else {
			out.push(...block.a, ...block.b);
		}
	}

	return { content: encoder.encode(joinSentinelLines(out)), conflict: false };
};

/**
 * git's built-in `merge=binary` (`-merge`): never textually merge — keep ours
 * and report a conflict so the index preserves stages 1/2/3.
 */
const binaryMergeDriver: MergeDriver = (_ctx, input: MergeDriverInput): MergeDriverResult => ({
	content: input.ours,
	conflict: true,
});

const BUILTIN_MERGE_DRIVERS: Record<string, MergeDriver> = {
	union: unionMergeDriver,
	binary: binaryMergeDriver,
};

/** Reconstruct text from diff3 sentinel-annotated lines (trailing-newline aware). */
function joinSentinelLines(sentinelLines: string[]): string {
	if (sentinelLines.length === 0) return "";
	const lines = sentinelLines.map(stripSentinel);
	const lastRaw = sentinelLines[sentinelLines.length - 1] ?? "";
	const noTrailingNl = lastRaw.endsWith("\u0000");
	return noTrailingNl ? lines.join("\n") : `${lines.join("\n")}\n`;
}
