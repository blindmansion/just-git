import { objectExists } from "./object-db.ts";
import { appendReflog, type ReflogIdentity } from "./refs/reflog.ts";
import { listRefs, resolveRef, updateRef } from "./refs/refs.ts";
import { readShallowCommits } from "./refs/shallow.ts";
import type { RemoteRef, ShallowFetchOptions, Transport } from "./transport/transport.ts";
import type { GitContext, GitRepo, ObjectId } from "./types.ts";
import type { TransferRefLine } from "./ref-format.ts";
import { shortenRef } from "./refs/name.ts";
import { ZERO_HASH } from "./hex.ts";

interface PreparedShallowFetch {
	existingShallows?: Set<ObjectId>;
	shallowOpts?: ShallowFetchOptions;
}

export async function collectFetchHaves(gitCtx: GitRepo): Promise<ObjectId[]> {
	const localRefs = await listRefs(gitCtx);
	const haves: ObjectId[] = localRefs.map((r) => r.hash);
	const localHead = await resolveRef(gitCtx, "HEAD");
	if (localHead) haves.push(localHead);
	return haves;
}

export async function prepareShallowFetch(
	gitCtx: GitContext,
	depth?: number,
): Promise<PreparedShallowFetch> {
	const existingShallows = depth !== undefined ? await readShallowCommits(gitCtx) : undefined;
	return {
		existingShallows,
		shallowOpts: depth !== undefined ? { depth, existingShallows } : undefined,
	};
}

export async function autoFollowReachableTags(options: {
	gitCtx: GitContext;
	transport: Transport;
	remoteRefs: RemoteRef[];
	ident: ReflogIdentity;
	reflogAction: "fetch" | "pull";
}): Promise<TransferRefLine[]> {
	const { gitCtx, transport, remoteRefs, ident, reflogAction } = options;

	const autoFollowTags: RemoteRef[] = [];
	for (const ref of remoteRefs) {
		if (!ref.name.startsWith("refs/tags/")) continue;
		if (await resolveRef(gitCtx, ref.name)) continue;

		const targetHash = ref.peeledHash ?? ref.hash;
		if (await objectExists(gitCtx, targetHash)) {
			autoFollowTags.push(ref);
		}
	}

	const tagObjectWants: ObjectId[] = [];
	for (const ref of autoFollowTags) {
		if (ref.peeledHash && !(await objectExists(gitCtx, ref.hash))) {
			tagObjectWants.push(ref.hash);
		}
	}
	if (tagObjectWants.length > 0) {
		await transport.fetch(tagObjectWants, await collectFetchHaves(gitCtx));
	}

	const refLines: TransferRefLine[] = [];
	for (const ref of autoFollowTags) {
		await updateRef(gitCtx, ref.name, ref.hash);
		await appendReflog(gitCtx, ref.name, {
			oldHash: ZERO_HASH,
			newHash: ref.hash,
			name: ident.name,
			email: ident.email,
			timestamp: ident.timestamp,
			tz: ident.tz,
			message: `${reflogAction}: storing head`,
		});
		refLines.push({
			prefix: " * [new tag]",
			from: shortenRef(ref.name),
			to: shortenRef(ref.name),
		});
	}

	return refLines;
}
