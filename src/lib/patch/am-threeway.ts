/**
 * Shared tree-level three-way mechanism for CLI and repo `am`.
 *
 * This is git's `fall_back_threeway`: reconstruct the patch's base tree, apply
 * the patch there to obtain "theirs", then merge it with the caller's tree.
 * It is worktree/index-free; each orchestration shell decides how to expose or
 * persist the resulting merge.
 */
import type { MergeLabels } from "../diff/diff3.ts";
import { defaultStat } from "../index.ts";
import { type ContentMergeFn, mergeOrtNonRecursive } from "../merge-ort.ts";
import { findObjectsByPrefix, objectExists } from "../object-db.ts";
import { comparePaths } from "../path.ts";
import { buildTreeFromIndex, type FlatTreeEntry, flattenTreeToMap } from "../tree-ops.ts";
import type { GitRepo, IndexEntry } from "../types.ts";
import type { ParsedPatch } from "./parse-patch.ts";
import { applyPatchesToTree } from "./tree-apply-repo.ts";

/** The raw merge-ort data returned by the shared fallback. */
export type MergeOrtResultData = Awaited<ReturnType<typeof mergeOrtNonRecursive>>;

export type FallBackThreewayResult =
	| { status: "no-base"; missingPath: string; reason: "missing-oid" | "missing-mode-source" }
	| { status: "apply-failed" }
	| {
			status: "merged";
			baseTree: string;
			theirsTree: string;
			statusLines: string[];
			merge: MergeOrtResultData;
	  };

/** Resolve a patch's `index <old>..` OID prefix to a present base blob. */
async function resolveBaseBlob(repo: GitRepo, prefix: string | undefined): Promise<string | null> {
	if (!prefix || prefix.length < 4 || /^0+$/.test(prefix)) return null;
	const matches = await findObjectsByPrefix(repo, prefix);
	if (matches.length !== 1) return null;
	const oid = matches[0] as string;
	return (await objectExists(repo, oid)) ? oid : null;
}

/** Build git's synthetic `am -3` base tree from recorded preimage OIDs. */
export async function buildFakeAncestor(
	repo: GitRepo,
	patches: ParsedPatch[],
	fallbackEntries?: ReadonlyMap<string, FlatTreeEntry>,
): Promise<
	| { tree: string; entries: IndexEntry[] }
	| { missingPath: string; reason: "missing-oid" | "missing-mode-source" }
> {
	const entries: IndexEntry[] = [];
	for (const patch of patches) {
		if (patch.kind === "new") continue;
		const name = patch.oldName ?? patch.newName;
		if (!name) continue;
		let oid = await resolveBaseBlob(repo, patch.oldOidPrefix);
		let fallback: FlatTreeEntry | undefined;
		const usesModeFallback = !patch.oldOidPrefix && patch.fragments.length === 0 && !patch.isBinary;
		if (!oid && usesModeFallback) {
			fallback = fallbackEntries?.get(name);
			oid = fallback?.hash ?? null;
		}
		if (!oid) {
			return {
				missingPath: name,
				reason: usesModeFallback ? "missing-mode-source" : "missing-oid",
			};
		}
		entries.push({
			path: name,
			mode: patch.oldMode ?? patch.newMode ?? (fallback ? parseInt(fallback.mode, 8) : 0o100644),
			hash: oid,
			stage: 0,
			stat: defaultStat(),
		});
	}
	return { tree: await buildTreeFromIndex(repo, entries), entries };
}

function fakeAncestorStatus(
	entries: IndexEntry[],
	oursMap: ReadonlyMap<string, FlatTreeEntry>,
): string[] {
	const lines: string[] = [];
	for (const entry of [...entries].sort((a, b) => comparePaths(a.path, b.path))) {
		const head = oursMap.get(entry.path);
		if (!head) lines.push(`A\t${entry.path}`);
		else if (head.hash !== entry.hash || head.mode !== entry.mode.toString(8)) {
			lines.push(`M\t${entry.path}`);
		}
	}
	return lines;
}

/** Run git's worktree-free `fall_back_threeway` computation. */
export async function fallBackThreeway(
	repo: GitRepo,
	patches: ParsedPatch[],
	oursTree: string,
	labels?: MergeLabels,
	mergeDriver?: ContentMergeFn,
	reverse = false,
): Promise<FallBackThreewayResult> {
	const oursMap = await flattenTreeToMap(repo, oursTree);
	const fake = await buildFakeAncestor(repo, patches, oursMap);
	if ("missingPath" in fake) {
		return { status: "no-base", missingPath: fake.missingPath, reason: fake.reason };
	}

	const theirs = await applyPatchesToTree(repo, patches, fake.tree, {
		reverse,
		whitespace: "nowarn",
	});
	if (theirs.status === "rejected") return { status: "apply-failed" };

	const merge = await mergeOrtNonRecursive(
		repo,
		fake.tree,
		oursTree,
		theirs.treeHash,
		labels,
		mergeDriver,
	);
	return {
		status: "merged",
		baseTree: fake.tree,
		theirsTree: theirs.treeHash,
		statusLines: fakeAncestorStatus(fake.entries, oursMap),
		merge,
	};
}
