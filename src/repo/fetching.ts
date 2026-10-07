import { isRejection } from "../hooks.ts";
import { objectExists } from "../lib/object-db.ts";
import { resolveRemoteTransport } from "../lib/transport/remote.ts";
import type { GitContext, ObjectId } from "../lib/types.ts";

export interface FetchObjectsOptions {
	/** Configured remote name (defaults to origin). */
	remote?: string;
	/** Environment used by the normal credential resolver. */
	env?: Map<string, string>;
	/** Maximum requested objects per round trip (defaults to 128, maximum 1024). */
	batchSize?: number;
}

/**
 * Explicitly fetch missing objects by SHA-1, without changing refs, FETCH_HEAD,
 * or the shallow boundary. Intended for hydrating selected blobs after a
 * blobless fetch. Servers must allow requests for reachable object IDs.
 * Existing objects are skipped; reads and existence checks never fetch implicitly.
 */
export async function fetchObjects(
	repo: GitContext,
	objectIds: readonly ObjectId[],
	options: FetchObjectsOptions = {},
): Promise<{ fetched: number }> {
	const batchSize = options.batchSize ?? 128;
	if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1024) {
		throw new Error("Object fetch batch size must be an integer between 1 and 1024");
	}
	const ids = [...new Set(objectIds)];
	if (ids.some((id) => !/^[a-f0-9]{40}$/.test(id))) throw new Error("Invalid SHA-1 object ID");
	const missing: ObjectId[] = [];
	for (const id of ids) if (!(await objectExists(repo, id))) missing.push(id);
	if (missing.length === 0) return { fetched: 0 };
	const remote = options.remote ?? "origin";
	const resolved = await resolveRemoteTransport(repo, remote, options.env ?? new Map());
	if (!resolved) throw new Error(`Cannot resolve remote '${remote}'`);
	const rejection = await repo.hooks?.preFetch?.({
		repo,
		remote,
		url: resolved.config.url,
		refspecs: [],
		prune: false,
		tags: false,
		objectIds: missing,
	});
	if (isRejection(rejection)) throw new Error(rejection.message ?? "Object fetch rejected");
	for (let offset = 0; offset < missing.length; offset += batchSize) {
		const batch = missing.slice(offset, offset + batchSize);
		// A commit "have" implies its blobs are present. That is deliberately
		// false in a partial clone, so hydration sends no commit haves.
		await resolved.transport.fetch(batch, []);
		for (const id of batch) {
			if (!(await objectExists(repo, id)))
				throw new Error(`Remote did not provide requested object ${id}`);
		}
	}
	await repo.hooks?.postFetch?.({ repo, remote, url: resolved.config.url, updatedRefCount: 0 });
	return { fetched: missing.length };
}
