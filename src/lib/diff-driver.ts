import type { BoundAttributes } from "./bound-attributes.ts";
import { resolveAttributes } from "./bound-attributes.ts";
import { isGitContext } from "./config.ts";
import type { GitContext, GitRepo } from "./types.ts";

const decoder = new TextDecoder();

/**
 * Resolve the memoized {@link BoundAttributes} for diff rendering, or `undefined`
 * when the handle is a bare `GitRepo` (no worktree to read `.gitattributes` from)
 * or no `attributes` capability is configured. Diff drivers are resolved from the
 * working tree's attributes — matching git, which uses the worktree/index
 * `.gitattributes` for diff rendering rather than the historical tree's.
 */
export function boundDiffAttributes(
	ctx: GitRepo | GitContext,
): Promise<BoundAttributes | undefined> {
	return isGitContext(ctx) ? resolveAttributes(ctx, "diff") : Promise.resolve(undefined);
}

/** The formatter-facing result of resolving a path's `diff=<driver>`. */
export interface DiffPresentation {
	oldContent: string;
	newContent: string;
	funcnameRegex?: RegExp;
	forceBinary?: boolean;
	forceTextual?: boolean;
}

/**
 * Resolve a path's `diff=<driver>` presentation into the `oldContent`/
 * `newContent` strings plus the formatter overrides (`funcnameRegex` /
 * `forceBinary` / `forceTextual`) to spread into a `formatUnifiedDiff` call.
 *
 * With no diff driver (the common path, `bound === undefined` or the resolver
 * returns nothing for `path`) this is a plain decode — byte-identical to reading
 * the raw content. Otherwise: a `-diff` attribute forces binary; a textconv
 * driver converts both sides before diffing; a `diff` attribute forces textual;
 * a custom `funcname` overrides the hunk header.
 *
 * `oldOid`/`newOid` are the blob OIDs passed to textconv (so it can fetch real
 * content for a pointer); pass `undefined` for worktree content with no OID.
 */
export async function resolveDiffPresentation(
	bound: BoundAttributes | undefined,
	path: string,
	oldBytes: Uint8Array,
	oldOid: string | undefined,
	newBytes: Uint8Array,
	newOid: string | undefined,
): Promise<DiffPresentation> {
	const d = await bound?.diff(path);
	if (!d) {
		return { oldContent: decoder.decode(oldBytes), newContent: decoder.decode(newBytes) };
	}
	if (d.binary === true) {
		return {
			oldContent: decoder.decode(oldBytes),
			newContent: decoder.decode(newBytes),
			forceBinary: true,
		};
	}
	let oldOut = oldBytes;
	let newOut = newBytes;
	if (d.textconv) {
		oldOut = await d.textconv(oldBytes, oldOid);
		newOut = await d.textconv(newBytes, newOid);
	}
	return {
		oldContent: decoder.decode(oldOut),
		newContent: decoder.decode(newOut),
		funcnameRegex: d.funcname,
		forceTextual: d.binary === false ? true : undefined,
	};
}
