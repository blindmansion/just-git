// Client-side network operations as functions over a GitRepo + transport
// context. These mirror what the `clone` / `fetch` / `push` CLI handlers do,
// minus argument parsing and stdout/stderr formatting, and work against both
// filesystem-backed and storage-backed repos (no worktree assumed).
//
// Hooks fire via `repo.hooks` (the handle already carries them) — there is no
// separate hook channel on the transport context.

import type { CredentialProvider } from "../hooks.ts";
import { isRejection } from "../hooks.ts";
import { withCapabilities } from "../lib/capabilities.ts";
import { ZERO_HASH } from "../lib/hex.ts";
import { isAncestor } from "../lib/merge.ts";
import { listRefs, resolveRef } from "../lib/refs.ts";
import { createTransportForUrl, type TransportEnv } from "../lib/transport/remote.ts";
import { mapRefspec, parseRefspec } from "../lib/transport/refspec.ts";
import type { HttpAuth } from "../lib/transport/transport.ts";
import type { RemoteRef, ShallowFetchOptions } from "../lib/transport/transport.ts";
import type { GitRepo, ObjectId, ObjectStore, RefStore, RepoCapabilities } from "../lib/types.ts";

const DEFAULT_REMOTE = "origin";
const NO_ENV = new Map<string, string>();

/** Default mirror-all refspec for a remote name: `+refs/heads/*:refs/remotes/<name>/*`. */
function defaultFetchRefspec(remote: string): string {
	return `+refs/heads/*:refs/remotes/${remote}/*`;
}

// ── Public types ────────────────────────────────────────────────────

/** A ref advertised by a remote. */
export type { RemoteRef } from "../lib/transport/transport.ts";

/** Result of {@link fetch}. */
export interface FetchResult {
	/** Refs advertised by the remote. */
	remoteRefs: RemoteRef[];
	/** Number of objects received into the local store. */
	objectCount: number;
	/** Local tracking refs that were updated. */
	updated: Array<{ ref: string; oldHash: string | null; newHash: string }>;
}

/** Per-ref outcome of a {@link push}. */
export type PushRefStatus =
	| "ok"
	| "up-to-date"
	| "rejected-non-fast-forward"
	| "rejected-fetch-first"
	| "rejected-already-exists"
	| "rejected-hook"
	| "error";

/** Status of a single ref in a {@link push}. */
export interface PushRefResult {
	ref: string;
	oldHash: string | null;
	/** New value, or the zero hash for a deletion. */
	newHash: string;
	status: PushRefStatus;
	/** True when the update overwrote a non-ancestor (forced update). */
	forced: boolean;
	deleted: boolean;
	/** Raw transport error string, when the update was rejected. */
	error?: string;
}

/** Result of {@link push}. */
export interface PushResult {
	/** True when every ref update succeeded. */
	ok: boolean;
	refs: PushRefResult[];
}

/** A remote ref descriptor for {@link push}. */
export interface PushRemote {
	url: string;
	/** Sugar: push `refs/heads/<branch>` to the same name on the remote. */
	branch?: string;
	/** Sugar: explicit source ref (branch name, tag, `HEAD`, or full ref). */
	src?: string;
	/** Sugar: explicit destination ref on the remote. */
	dst?: string;
	/** Sugar: allow a non-fast-forward (force) update. */
	force?: boolean;
	/**
	 * Escape hatch: raw `src:dst` refspecs (with `+` force, `:dst` deletes,
	 * and `*` globs). Mutually exclusive with the sugar fields above.
	 */
	refspecs?: string[];
}

/** Result of {@link cloneInto}. */
export interface CloneResult {
	remoteRefs: RemoteRef[];
	/** Branch HEAD was pointed at, or null for an empty remote. */
	defaultBranch: string | null;
	objectCount: number;
	/** Local `refs/heads/*` written into the repo. */
	fetchedRefs: Array<{ ref: string; hash: string }>;
	/** Remote-tracking `refs/remotes/<remote>/*` written into the repo. */
	trackingRefs: Array<{ ref: string; hash: string }>;
}

// ── Shared helpers ──────────────────────────────────────────────────

function toCredentialProvider(c?: HttpAuth | CredentialProvider): CredentialProvider | undefined {
	if (!c) return undefined;
	return typeof c === "function" ? c : () => c;
}

/**
 * Augment a repo handle with the transport environment derived from its
 * attached capabilities (`repo.capabilities.{network,credentials,resolveRemote,
 * onProgress}`). Network behavior now rides on the handle (wrap with
 * `withCapabilities`) rather than a per-call transport bag.
 */
function withEnv(repo: GitRepo): GitRepo & TransportEnv {
	const caps = repo.capabilities;
	const policy = caps?.network;
	// Mirror createGit: a NetworkPolicy object may carry the fetch function.
	const fetchFn = policy && typeof policy === "object" ? policy.fetch : undefined;
	return {
		...repo,
		credentialProvider: toCredentialProvider(caps?.credentials),
		fetchFn,
		networkPolicy: policy,
		resolveRemote: caps?.resolveRemote,
		onProgress: caps?.onProgress,
		credentialCache: new Map(),
	};
}

// A repo placeholder for URL-only operations (listRemoteRefs). The transport's
// `local` store is never read when only advertising refs.
const UNUSED_REPO: GitRepo = {
	objectStore: undefined as unknown as ObjectStore,
	refStore: undefined as unknown as RefStore,
};

async function collectHaves(repo: GitRepo): Promise<ObjectId[]> {
	const refs = await listRefs(repo);
	const haves = refs.map((r) => r.hash);
	const head = await resolveRef(repo, "HEAD");
	if (head) haves.push(head);
	return haves;
}

// ── listRemoteRefs ──────────────────────────────────────────────────

/**
 * Enumerate the refs a remote advertises, without fetching any objects.
 *
 * Handle-less: there is no repo to wrap, so network behavior is passed as a
 * `capabilities` bag (`{ network, credentials, resolveRemote, onProgress }`).
 * This is the one place a capability bag is still an argument.
 */
export async function listRemoteRefs(
	url: string,
	capabilities?: RepoCapabilities,
): Promise<RemoteRef[]> {
	const transport = await createTransportForUrl(
		withEnv(withCapabilities(UNUSED_REPO, capabilities)),
		url,
		NO_ENV,
	);
	return transport.advertiseRefs();
}

// ── fetch ───────────────────────────────────────────────────────────

/**
 * Fetch objects from a remote and update local tracking refs on `repo`.
 *
 * `refspecs` is optional; when omitted it defaults to mirroring all branches
 * into the remote's tracking namespace (`+refs/heads/*:refs/remotes/<name>/*`).
 * `name` is the remote's short name (default `"origin"`); it drives that
 * default tracking namespace and is reported to the `preFetch`/`postFetch`
 * hooks as `remote`. Fires `repo.hooks.preFetch` / `postFetch`.
 */
export async function fetch(
	repo: GitRepo,
	remote: { url: string; name?: string; refspecs?: string[] },
): Promise<FetchResult> {
	const remoteName = remote.name ?? DEFAULT_REMOTE;
	const transport = await createTransportForUrl(withEnv(repo), remote.url, NO_ENV);

	const specs = (
		remote.refspecs && remote.refspecs.length > 0
			? remote.refspecs
			: [defaultFetchRefspec(remoteName)]
	).map(parseRefspec);

	const rej = await repo.hooks?.preFetch?.({
		repo,
		remote: remoteName,
		url: remote.url,
		refspecs: specs.map((s) => `${s.src}:${s.dst}`),
		prune: false,
		tags: false,
	});
	if (isRejection(rej)) throw new Error(rej.message ?? "fetch rejected by preFetch hook");

	const remoteRefs = await transport.advertiseRefs();

	const wants: ObjectId[] = [];
	const seen = new Set<ObjectId>();
	const planned: Array<{ remote: RemoteRef; localRef: string }> = [];
	for (const ref of remoteRefs) {
		if (ref.name === "HEAD") continue;
		for (const spec of specs) {
			const dst = mapRefspec(spec, ref.name);
			if (dst === null) continue;
			planned.push({ remote: ref, localRef: dst });
			if (!seen.has(ref.hash)) {
				seen.add(ref.hash);
				wants.push(ref.hash);
			}
			break;
		}
	}

	const haves = await collectHaves(repo);
	const haveSet = new Set(haves);
	const filtered = wants.filter((w) => !haveSet.has(w));

	let objectCount = 0;
	if (filtered.length > 0) {
		const result = await transport.fetch(filtered, haves);
		objectCount = result.objectCount;
	}

	const updated: FetchResult["updated"] = [];
	for (const p of planned) {
		const oldHash = await resolveRef(repo, p.localRef);
		if (oldHash === p.remote.hash) continue;
		await repo.refStore.writeRef(p.localRef, p.remote.hash);
		updated.push({ ref: p.localRef, oldHash: oldHash ?? null, newHash: p.remote.hash });
	}

	await repo.hooks?.postFetch?.({
		repo,
		remote: remoteName,
		url: remote.url,
		updatedRefCount: updated.length,
	});

	return { remoteRefs, objectCount, updated };
}

// ── push ────────────────────────────────────────────────────────────

interface ResolvedSrc {
	hash: ObjectId;
	fullRef: string;
}

async function resolveSrcRef(repo: GitRepo, src: string): Promise<ResolvedSrc | null> {
	if (src.startsWith("refs/")) {
		const hash = await resolveRef(repo, src);
		return hash ? { hash, fullRef: src } : null;
	}
	const asBranch = await resolveRef(repo, `refs/heads/${src}`);
	if (asBranch) return { hash: asBranch, fullRef: `refs/heads/${src}` };
	const asTag = await resolveRef(repo, `refs/tags/${src}`);
	if (asTag) return { hash: asTag, fullRef: `refs/tags/${src}` };
	if (src === "HEAD") {
		const hash = await resolveRef(repo, "HEAD");
		return hash ? { hash, fullRef: "HEAD" } : null;
	}
	return null;
}

function normalizeDst(dst: string, srcFullRef: string): string {
	if (dst.startsWith("refs/")) return dst;
	if (srcFullRef.startsWith("refs/")) {
		// Reuse the source ref's namespace (refs/heads/, refs/tags/, ...).
		const prefix = srcFullRef.slice(0, srcFullRef.indexOf("/", 5) + 1);
		return prefix + dst;
	}
	return `refs/heads/${dst}`;
}

interface PreparedUpdate {
	name: string;
	oldHash: ObjectId | null;
	newHash: ObjectId;
	/** force-requested */
	force: boolean;
}

async function prepareDeleteUpdate(
	dst: string,
	force: boolean,
	remoteMap: Map<string, ObjectId>,
): Promise<PreparedUpdate> {
	const name = dst.startsWith("refs/") ? dst : `refs/heads/${dst}`;
	return { name, oldHash: remoteMap.get(name) ?? null, newHash: ZERO_HASH, force };
}

function pushStatus(name: string, ok: boolean, error: string | undefined): PushRefStatus {
	if (ok) return "ok";
	const e = error ?? "";
	if (e.includes("fetch first")) return "rejected-fetch-first";
	if (name.startsWith("refs/tags/") && e.includes("non-fast-forward")) {
		return "rejected-already-exists";
	}
	if (e.includes("non-fast-forward")) return "rejected-non-fast-forward";
	if (e.toLowerCase().includes("hook")) return "rejected-hook";
	return "error";
}

/**
 * Push local refs to a remote.
 *
 * Common case: `{ url, branch: "main" }`. The `src`/`dst`/`force` fields cover
 * explicit single-ref pushes; `refspecs` is the escape hatch for raw `src:dst`
 * grammar (force `+`, deletes `:dst`, globs `*`). The sugar fields and
 * `refspecs` are mutually exclusive. Fires `repo.hooks.prePush` / `postPush`.
 */
export async function push(repo: GitRepo, remote: PushRemote): Promise<PushResult> {
	const hasRefspecs = !!remote.refspecs && remote.refspecs.length > 0;
	const hasSugar = !!(remote.branch || remote.src || remote.dst || remote.force);
	if (hasRefspecs && hasSugar) {
		throw new Error("push: pass either `refspecs` or the branch/src/dst/force sugar, not both");
	}

	const transport = await createTransportForUrl(withEnv(repo), remote.url, NO_ENV);
	const remoteRefs = await transport.advertiseRefs();
	const remoteMap = new Map<string, ObjectId>(remoteRefs.map((r) => [r.name, r.hash]));

	const prepared: PreparedUpdate[] = [];

	if (hasRefspecs) {
		for (const raw of remote.refspecs!) {
			const spec = parseRefspec(raw);
			if (spec.src === "") {
				prepared.push(await prepareDeleteUpdate(spec.dst, spec.force, remoteMap));
				continue;
			}
			const resolved = await resolveSrcRef(repo, spec.src);
			if (!resolved) {
				throw new Error(`push: src refspec '${spec.src}' does not match any ref`);
			}
			const name = normalizeDst(spec.dst || spec.src, resolved.fullRef);
			prepared.push({
				name,
				oldHash: remoteMap.get(name) ?? null,
				newHash: resolved.hash,
				force: spec.force,
			});
		}
	} else {
		const src = remote.src ?? (remote.branch ? `refs/heads/${remote.branch}` : undefined);
		if (!src) throw new Error("push: specify `branch`, `src`/`dst`, or `refspecs`");
		const resolved = await resolveSrcRef(repo, src);
		if (!resolved) throw new Error(`push: '${src}' does not match any ref`);
		const dstSpec = remote.dst ?? (remote.branch ? `refs/heads/${remote.branch}` : src);
		const name = normalizeDst(dstSpec, resolved.fullRef);
		prepared.push({
			name,
			oldHash: remoteMap.get(name) ?? null,
			newHash: resolved.hash,
			force: !!remote.force,
		});
	}

	// Drop no-op updates (local already matches remote).
	const effective = prepared.filter((u) => u.oldHash !== u.newHash);

	if (effective.length === 0) {
		return {
			ok: true,
			refs: prepared.map((u) => ({
				ref: u.name,
				oldHash: u.oldHash,
				newHash: u.newHash,
				status: "up-to-date" as const,
				forced: false,
				deleted: u.newHash === ZERO_HASH,
			})),
		};
	}

	const rej = await repo.hooks?.prePush?.({
		repo,
		remote: remote.url,
		url: remote.url,
		refs: effective.map((u) => ({
			srcRef: u.newHash === ZERO_HASH ? null : u.name,
			srcHash: u.newHash === ZERO_HASH ? null : u.newHash,
			dstRef: u.name,
			dstHash: u.oldHash,
			force: u.force,
			delete: u.newHash === ZERO_HASH,
		})),
	});
	if (isRejection(rej)) throw new Error(rej.message ?? "push rejected by prePush hook");

	const forceRequested = new Set(effective.filter((u) => u.force).map((u) => u.name));
	const result = await transport.push(
		effective.map((u) => ({ name: u.name, oldHash: u.oldHash, newHash: u.newHash, ok: u.force })),
	);

	// Detect which succeeded updates were actually forced (non-fast-forward).
	const forceCandidates = result.updates.filter(
		(u) => u.ok && u.oldHash && u.newHash !== ZERO_HASH && forceRequested.has(u.name),
	);
	const ancestry = await Promise.all(
		forceCandidates.map((u) => isAncestor(repo, u.oldHash!, u.newHash)),
	);
	const forced = new Set<string>();
	forceCandidates.forEach((u, i) => {
		if (!ancestry[i]) forced.add(u.name);
	});

	const refs: PushRefResult[] = result.updates.map((u) => ({
		ref: u.name,
		oldHash: u.oldHash,
		newHash: u.newHash,
		status: pushStatus(u.name, u.ok, u.error),
		forced: forced.has(u.name),
		deleted: u.newHash === ZERO_HASH,
		error: u.ok ? undefined : u.error,
	}));

	const ok = refs.every((r) => r.status === "ok" || r.status === "up-to-date");

	if (ok) {
		await repo.hooks?.postPush?.({
			repo,
			remote: remote.url,
			url: remote.url,
			refs: effective.map((u) => ({
				srcRef: u.newHash === ZERO_HASH ? null : u.name,
				srcHash: u.newHash === ZERO_HASH ? null : u.newHash,
				dstRef: u.name,
				dstHash: u.oldHash,
				force: u.force,
				delete: u.newHash === ZERO_HASH,
			})),
		});
	}

	return { ok, refs };
}

// ── cloneInto ───────────────────────────────────────────────────────

function resolveDefaultBranch(
	remoteRefs: RemoteRef[],
	headTarget: string | undefined,
): { branch: string; hash: ObjectId } | null {
	if (headTarget?.startsWith("refs/heads/")) {
		const match = remoteRefs.find((r) => r.name === headTarget);
		if (match) return { branch: headTarget.slice("refs/heads/".length), hash: match.hash };
	}
	const head = remoteRefs.find((r) => r.name === "HEAD");
	if (head) {
		const match = remoteRefs.find((r) => r.name.startsWith("refs/heads/") && r.hash === head.hash);
		if (match) return { branch: match.name.slice("refs/heads/".length), hash: match.hash };
	}
	const first = remoteRefs.find((r) => r.name.startsWith("refs/heads/"));
	if (first) return { branch: first.name.slice("refs/heads/".length), hash: first.hash };
	return null;
}

/**
 * Populate an already-created repo from a remote: fetch objects, write
 * `refs/heads/*` (+ `refs/tags/*`) and matching `refs/remotes/<remote>/*`
 * tracking refs, and set HEAD to the default branch.
 *
 * Stops at objects + refs + HEAD — no worktree/config is written, since a
 * programmatic repo may have no filesystem. Unlike a bare clone, both local
 * heads and remote-tracking refs are written, so ahead/behind vs the remote is
 * answerable immediately (no initial fetch needed). `remote` sets the tracking
 * namespace (default `"origin"`). Pass `branch` to narrow to a single branch
 * (mirrors `git clone --branch`). Fires `repo.hooks.preClone` / `postClone`.
 */
export async function cloneInto(
	repo: GitRepo,
	url: string,
	options?: { branch?: string; depth?: number; remote?: string },
): Promise<CloneResult> {
	const branchOpt = options?.branch;
	const depth = options?.depth;
	const remoteName = options?.remote ?? DEFAULT_REMOTE;
	const transport = await createTransportForUrl(withEnv(repo), url, NO_ENV);

	const rej = await repo.hooks?.preClone?.({
		repo,
		repository: url,
		targetPath: "",
		bare: true,
		branch: branchOpt ?? null,
	});
	if (isRejection(rej)) throw new Error(rej.message ?? "clone rejected by preClone hook");

	const remoteRefs = await transport.advertiseRefs();

	if (remoteRefs.length === 0) {
		await repo.hooks?.postClone?.({
			repo,
			repository: url,
			targetPath: "",
			bare: true,
			branch: branchOpt ?? null,
		});
		return {
			remoteRefs,
			defaultBranch: null,
			objectCount: 0,
			fetchedRefs: [],
			trackingRefs: [],
		};
	}

	let defaultBranch: string | null = null;
	if (branchOpt) {
		const match = remoteRefs.find((r) => r.name === `refs/heads/${branchOpt}`);
		if (!match) throw new Error(`remote branch '${branchOpt}' not found`);
		defaultBranch = branchOpt;
	} else {
		defaultBranch = resolveDefaultBranch(remoteRefs, transport.headTarget)?.branch ?? null;
	}

	const singleBranch = !!branchOpt;
	const wants: ObjectId[] = [];
	const seen = new Set<ObjectId>();
	for (const ref of remoteRefs) {
		if (ref.name === "HEAD") continue;
		if (ref.name.startsWith("refs/heads/")) {
			if (singleBranch && ref.name !== `refs/heads/${defaultBranch}`) continue;
		} else if (ref.name.startsWith("refs/tags/")) {
			if (singleBranch) continue;
		} else {
			continue;
		}
		if (!seen.has(ref.hash)) {
			seen.add(ref.hash);
			wants.push(ref.hash);
		}
	}

	const shallow: ShallowFetchOptions | undefined =
		depth !== undefined && depth > 0 ? { depth } : undefined;

	let objectCount = 0;
	if (wants.length > 0) {
		const result = await transport.fetch(wants, await collectHaves(repo), shallow);
		objectCount = result.objectCount;
	}

	const fetchedRefs: CloneResult["fetchedRefs"] = [];
	const trackingRefs: CloneResult["trackingRefs"] = [];
	for (const ref of remoteRefs) {
		if (ref.name === "HEAD") continue;
		if (ref.name.startsWith("refs/heads/")) {
			if (singleBranch && ref.name !== `refs/heads/${defaultBranch}`) continue;
			await repo.refStore.writeRef(ref.name, ref.hash);
			fetchedRefs.push({ ref: ref.name, hash: ref.hash });
			// Mirror the branch into the remote-tracking namespace.
			const trackingRef = `refs/remotes/${remoteName}/${ref.name.slice("refs/heads/".length)}`;
			await repo.refStore.writeRef(trackingRef, ref.hash);
			trackingRefs.push({ ref: trackingRef, hash: ref.hash });
		} else if (ref.name.startsWith("refs/tags/")) {
			if (singleBranch) continue;
			await repo.refStore.writeRef(ref.name, ref.hash);
			fetchedRefs.push({ ref: ref.name, hash: ref.hash });
		} else {
			continue;
		}
	}

	if (defaultBranch) {
		await repo.refStore.writeRef("HEAD", {
			type: "symbolic",
			target: `refs/heads/${defaultBranch}`,
		});
	}

	await repo.hooks?.postClone?.({
		repo,
		repository: url,
		targetPath: "",
		bare: true,
		branch: defaultBranch,
	});

	return { remoteRefs, defaultBranch, objectCount, fetchedRefs, trackingRefs };
}
