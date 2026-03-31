import { type CommandResult, fatal, type TransferRefLine } from "./command-utils.ts";
import { objectExists } from "./object-db.ts";
import { appendReflog, ZERO_HASH } from "./reflog.ts";
import { listRefs, resolveRef, shortenRef, updateRef } from "./refs.ts";
import { INFINITE_DEPTH, isShallowRepo, readShallowCommits } from "./shallow.ts";
import { resolveRemoteTransport } from "./transport/remote.ts";
import type { RemoteRef, ShallowFetchOptions, Transport } from "./transport/transport.ts";
import type { GitContext, ObjectId } from "./types.ts";

interface NormalizedFetchArgs {
	depth?: number;
}

interface PreparedShallowFetch {
	existingShallows?: Set<ObjectId>;
	shallowOpts?: ShallowFetchOptions;
}

interface ReflogWriteIdentity {
	name: string;
	email: string;
	timestamp: number;
	tz: string;
}

type ResolvedRemoteTransport = NonNullable<Awaited<ReturnType<typeof resolveRemoteTransport>>>;

export async function normalizeFetchDepth(
	gitCtx: GitContext,
	args: { depth?: number; unshallow?: boolean },
): Promise<NormalizedFetchArgs | CommandResult> {
	if (args.depth !== undefined && args.unshallow) {
		return fatal("--depth and --unshallow cannot be used together");
	}
	if (args.unshallow && !(await isShallowRepo(gitCtx))) {
		return fatal("--unshallow on a complete repository does not make sense");
	}

	return {
		depth: args.unshallow ? INFINITE_DEPTH : args.depth,
	};
}

export async function resolveRemoteTransportOrError(
	gitCtx: GitContext,
	remoteName: string,
	env: Map<string, string>,
	buildError: (message: string) => CommandResult = fatal,
): Promise<ResolvedRemoteTransport | CommandResult> {
	try {
		const resolved = await resolveRemoteTransport(gitCtx, remoteName, env);
		if (!resolved) {
			return buildError(`'${remoteName}' does not appear to be a git repository`);
		}
		return resolved;
	} catch (e) {
		const msg = e instanceof Error ? e.message : "";
		if (msg.startsWith("network")) return buildError(msg);
		throw e;
	}
}

export async function collectFetchHaves(gitCtx: GitContext): Promise<ObjectId[]> {
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
	ident: ReflogWriteIdentity;
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
