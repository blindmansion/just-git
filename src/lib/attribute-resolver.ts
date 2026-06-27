import type { AttrLookup, AttrValue } from "./attributes.ts";
import { parseAttributesText } from "./attributes.ts";
import { diff3Merge, splitLinesWithSentinel, stripSentinel } from "./diff3.ts";
import type { FilterDriver } from "./filters.ts";
import type { MergeDriver, MergeDriverInput, MergeDriverResult } from "./merge-ort.ts";
import type { CapabilityContext } from "./types.ts";

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
	// diff / text / eol / ident … land here as consumers arrive (later phases).
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
