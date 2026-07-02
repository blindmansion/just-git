import type { BoundAttributes } from "../attributes/bound-attributes.ts";
import { resolveAttributes } from "../attributes/bound-attributes.ts";
import { isBinaryBytes } from "../object-db.ts";
import type { GitContext, GitRepo } from "../types.ts";
import { isGitContext } from "../config/parse.ts";

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

/** The result of resolving a path's `diff=<driver>` for **summary** output. */
export interface DiffStatPresentation {
	/** Final binariness after the driver's force flags / sniffing the bytes. */
	binary: boolean;
	/** textconv-converted bytes (raw when no textconv / forced binary). */
	oldBytes: Uint8Array;
	newBytes: Uint8Array;
}

/**
 * Resolve a path's `diff=<driver>` for **summary** formats (`--stat` /
 * `--numstat` / `--shortstat`), where the caller needs the binariness decision
 * and the (possibly textconv'd) bytes to count lines / report sizes — not a
 * rendered patch.
 *
 * With no diff driver this is the plain `isBinaryBytes` sniff over the raw bytes
 * — byte-identical to the pre-driver behavior. Otherwise: `-diff` forces binary
 * (sizes reported from the raw bytes); a textconv driver converts both sides
 * before counting; a `diff` attribute forces textual.
 */
export async function resolveDiffStat(
	bound: BoundAttributes | undefined,
	path: string,
	oldBytes: Uint8Array,
	oldOid: string | undefined,
	newBytes: Uint8Array,
	newOid: string | undefined,
): Promise<DiffStatPresentation> {
	const d = await bound?.diff(path);
	if (!d) {
		return { binary: isBinaryBytes(oldBytes) || isBinaryBytes(newBytes), oldBytes, newBytes };
	}
	if (d.binary === true) {
		return { binary: true, oldBytes, newBytes };
	}
	let oldOut = oldBytes;
	let newOut = newBytes;
	if (d.textconv) {
		oldOut = await d.textconv(oldBytes, oldOid);
		newOut = await d.textconv(newBytes, newOid);
	}
	const binary = d.binary === false ? false : isBinaryBytes(oldOut) || isBinaryBytes(newOut);
	return { binary, oldBytes: oldOut, newBytes: newOut };
}

/** The result of resolving a path's `diff=<driver>` for **combined** (`--cc`) output. */
export interface CombinedDiffPresentation {
	/** Final binariness after the driver's force flags / sniffing the bytes. */
	binary: boolean;
	/** textconv-converted parent contents (raw when no textconv / forced binary). */
	parentContents: string[];
	resultContent: string;
	funcnameRegex?: RegExp;
}

/**
 * Resolve a path's `diff=<driver>` for **combined** diff (`diff --cc`), where a
 * result is diffed against N parents. Mirrors {@link resolveDiffStat} but over
 * the multi-parent shape: `-diff` forces binary, a textconv converts every side
 * before diffing, a `diff` attribute forces textual, and the driver's funcname
 * (if any) drives the combined hunk header.
 *
 * The combined-diff content pass emits actual file lines, so routing it through
 * the driver is what keeps a redaction textconv from leaking the unmasked
 * content during a conflict.
 */
export async function resolveCombinedDiffPresentation(
	bound: BoundAttributes | undefined,
	path: string,
	parents: { bytes: Uint8Array; oid: string | undefined }[],
	resultBytes: Uint8Array,
	resultOid: string | undefined,
): Promise<CombinedDiffPresentation> {
	const d = await bound?.diff(path);
	const plain = (): CombinedDiffPresentation => ({
		binary: parents.some((p) => isBinaryBytes(p.bytes)) || isBinaryBytes(resultBytes),
		parentContents: parents.map((p) => decoder.decode(p.bytes)),
		resultContent: decoder.decode(resultBytes),
	});
	if (!d) return plain();
	if (d.binary === true) {
		return {
			binary: true,
			parentContents: parents.map((p) => decoder.decode(p.bytes)),
			resultContent: decoder.decode(resultBytes),
		};
	}
	let parentOut = parents.map((p) => p.bytes);
	let resultOut = resultBytes;
	const tc = d.textconv;
	if (tc) {
		parentOut = await Promise.all(parents.map((p) => tc(p.bytes, p.oid)));
		resultOut = await tc(resultBytes, resultOid);
	}
	const binary =
		d.binary === false
			? false
			: parentOut.some((b) => isBinaryBytes(b)) || isBinaryBytes(resultOut);
	return {
		binary,
		parentContents: parentOut.map((b) => decoder.decode(b)),
		resultContent: decoder.decode(resultOut),
		funcnameRegex: d.funcname,
	};
}
