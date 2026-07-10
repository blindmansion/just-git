/**
 * Port of git's `wt_status_get_detached_from` (wt-status.c): figures out
 * what a detached HEAD detached *from*, for `git status` / `git branch`'s
 * `(HEAD detached from <ref-or-hash>)` label.
 *
 * Git walks the HEAD reflog for the most recent "checkout: moving from A to
 * B" entry, then tries to `dwim` `B` back into a ref — if that ref's current
 * oid still matches the oid HEAD moved *to* at that reflog entry, the label
 * uses the ref name (stripping a `refs/tags/`/`refs/remotes/` prefix, but
 * keeping `refs/heads/`); otherwise it falls back to an abbreviated hash.
 */
import { uniqueAbbrev } from "../abbrev.ts";
import type { GitContext, ObjectId } from "../types.ts";
import { readReflog } from "./reflog.ts";
import { resolveRef } from "./refs.ts";

/** What HEAD detached from: a display label plus whether HEAD is still there. */
export interface DetachedFrom {
	/** Ref name (e.g. `refs/heads/fix-z37n`, `v1.0`) or abbreviated hash. */
	from: string;
	/** True when current HEAD still equals the reflog entry's recorded oid. */
	detachedAt: boolean;
}

/**
 * Git's `dwim_ref` search order (`ref_rev_parse_rules` in refs.c): try each
 * expansion in priority order and take the first that resolves to a ref.
 *
 * Note: git also accepts the tag-deref variant (a tag whose peeled target
 * matches) — not implemented here as no observed trace needs it.
 */
function dwimCandidates(name: string): string[] {
	return [
		name,
		`refs/${name}`,
		`refs/tags/${name}`,
		`refs/heads/${name}`,
		`refs/remotes/${name}`,
		`refs/remotes/${name}/HEAD`,
	];
}

async function dwimRef(
	gitCtx: GitContext,
	name: string,
): Promise<{ refName: string; hash: ObjectId } | null> {
	for (const candidate of dwimCandidates(name)) {
		const hash = await resolveRef(gitCtx, candidate);
		if (hash) return { refName: candidate, hash };
	}
	return null;
}

/** Strip a `refs/tags/` or `refs/remotes/` prefix; `refs/heads/` is kept as-is. */
function stripDwimPrefix(refName: string): string {
	if (refName.startsWith("refs/tags/")) return refName.slice("refs/tags/".length);
	if (refName.startsWith("refs/remotes/")) return refName.slice("refs/remotes/".length);
	return refName;
}

/**
 * Find what HEAD detached from, by scanning the HEAD reflog newest-to-oldest
 * for the last `checkout: moving from A to B` entry.
 *
 * Returns `null` when no such entry exists (caller should fall back to a
 * plain `(no branch)`).
 */
export async function getDetachedFrom(gitCtx: GitContext): Promise<DetachedFrom | null> {
	const entries = await readReflog(gitCtx, "HEAD");
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (!entry) continue;
		const match = entry.message.match(/^checkout: moving from (.+) to (.+)$/);
		if (!match) continue;

		const noid = entry.newHash;
		const target = match[2] === "HEAD" ? "" : (match[2] as string);

		const dwim = target ? await dwimRef(gitCtx, target) : null;
		const from =
			dwim && dwim.hash === noid ? stripDwimPrefix(dwim.refName) : await uniqueAbbrev(gitCtx, noid);

		const headHash = await resolveRef(gitCtx, "HEAD");
		return { from, detachedAt: headHash === noid };
	}
	return null;
}
