import type { FetchFunction } from "../../hooks.ts";
import { ZERO_HASH } from "../hex.ts";
import { isAncestor } from "../merge.ts";
import { ingestPackData } from "../object-db.ts";
import { findBestDeltas } from "../pack/delta.ts";
import type { DeltaPackInput } from "../pack/packfile.ts";
import { writePackDeltified } from "../pack/packfile.ts";
import { listRefs, readHead, resolveRef } from "../refs.ts";
import { computeShallowBoundary, type ShallowUpdate } from "../shallow.ts";
import type { GitContext, GitRepo, ObjectId } from "../types.ts";
import { collectEnumeration, enumerateObjectsWithContent } from "./object-walk.ts";
import {
	discoverRefs,
	fetchPack,
	type HttpAuth,
	type PushCommand,
	pushPack,
} from "./smart-http.ts";

// ── Transport interface ──────────────────────────────────────────────

/** A ref advertised by the remote. */
export interface RemoteRef {
	name: string;
	hash: ObjectId;
	/** For annotated tags: the hash of the object the tag points to. */
	peeledHash?: ObjectId;
}

/** Options for shallow/depth-limited fetches. */
export interface ShallowFetchOptions {
	/** Maximum commit depth from the wanted refs. */
	depth?: number;
	/** Commits currently in the client's `.git/shallow` file. */
	existingShallows?: Set<ObjectId>;
}

/** Result of a fetch operation at the transport level. */
export interface FetchResult {
	/** Refs advertised by the remote. */
	remoteRefs: RemoteRef[];
	/** Objects received (already unpacked into the local store). */
	objectCount: number;
	/** Shallow boundary changes, present when a depth-limited fetch was performed. */
	shallowUpdates?: ShallowUpdate;
}

/** Result of a push operation at the transport level. */
export interface PushResult {
	/** Per-ref update results. */
	updates: PushRefUpdate[];
}

export interface PushRefUpdate {
	name: string;
	oldHash: ObjectId | null;
	newHash: ObjectId;
	ok: boolean;
	error?: string;
}

/**
 * Transport interface: abstracts how objects and refs are exchanged
 * between repositories. Implementations handle local paths, HTTP, etc.
 */
export interface Transport {
	/**
	 * Get the list of refs the remote has.
	 */
	advertiseRefs(): Promise<RemoteRef[]>;

	/**
	 * Fetch objects from the remote that are reachable from `wants`
	 * but not from `haves`. Unpacks received objects into the local store.
	 * Pass `shallow` options for depth-limited fetches.
	 */
	fetch(wants: ObjectId[], haves: ObjectId[], shallow?: ShallowFetchOptions): Promise<FetchResult>;

	/**
	 * Push objects to the remote. Sends all objects reachable from the
	 * new ref values but not from the old ones, then updates remote refs.
	 */
	push(updates: PushRefUpdate[]): Promise<PushResult>;

	/**
	 * The ref that HEAD points to on the remote (e.g. "refs/heads/main").
	 * Available after advertiseRefs() has been called. Used by clone to
	 * determine the default branch.
	 */
	headTarget?: string;
}

// ── Local transport ──────────────────────────────────────────────────

/**
 * Transport implementation for local paths. Reads objects from
 * one repo and writes them to another via packfile serialization.
 * The remote only needs object/ref access (GitRepo), not a filesystem.
 */
export class LocalTransport implements Transport {
	headTarget?: string;

	constructor(
		private local: GitContext,
		private remote: GitRepo,
	) {}

	async advertiseRefs(): Promise<RemoteRef[]> {
		const refs = await listRefs(this.remote);
		const result: RemoteRef[] = [];
		for (const ref of refs) {
			result.push({ name: ref.name, hash: ref.hash });
		}

		// Also include HEAD if it resolves
		const head = await resolveRef(this.remote, "HEAD");
		if (head) {
			result.push({ name: "HEAD", hash: head });
		}

		// Derive headTarget from the remote's HEAD symref
		const headRef = await readHead(this.remote);
		if (headRef?.type === "symbolic") {
			this.headTarget = headRef.target;
		}

		return result;
	}

	async fetch(
		wants: ObjectId[],
		haves: ObjectId[],
		shallow?: ShallowFetchOptions,
	): Promise<FetchResult> {
		const remoteRefs = await this.advertiseRefs();

		if (wants.length === 0) {
			return { remoteRefs, objectCount: 0 };
		}

		let shallowBoundary: Set<ObjectId> | undefined;
		let shallowUpdates: ShallowUpdate | undefined;
		let clientShallowBoundary: Set<ObjectId> | undefined;

		if (shallow?.depth !== undefined) {
			const existingShallows = shallow.existingShallows ?? new Set<ObjectId>();
			const boundary = await computeShallowBoundary(
				this.remote,
				wants,
				shallow.depth,
				existingShallows,
			);
			shallowUpdates = boundary;
			shallowBoundary = new Set(boundary.shallow);
			if (existingShallows.size > 0) {
				clientShallowBoundary = existingShallows;
			}
		}

		const packData = await buildDeltifiedPack(
			this.remote,
			wants,
			haves,
			shallowBoundary,
			clientShallowBoundary,
		);
		if (!packData) {
			return { remoteRefs, objectCount: 0, shallowUpdates };
		}

		const objectCount = await ingestPackData(this.local, packData);
		return { remoteRefs, objectCount, shallowUpdates };
	}

	async push(updates: PushRefUpdate[]): Promise<PushResult> {
		const allWants: ObjectId[] = [];
		const allHaves: ObjectId[] = [];

		for (const update of updates) {
			if (update.newHash !== ZERO_HASH) {
				allWants.push(update.newHash);
			}
			if (update.oldHash) {
				allHaves.push(update.oldHash);
			}
		}

		if (allWants.length > 0) {
			const packData = await buildDeltifiedPack(this.local, allWants, allHaves);
			if (packData) {
				await ingestPackData(this.remote, packData);
			}
		}

		const results: PushRefUpdate[] = [];
		for (const update of updates) {
			try {
				const isDelete = update.newHash === ZERO_HASH;
				const expectedOld = update.oldHash ?? null;

				if (!isDelete && !update.ok && update.oldHash) {
					const ff = await isAncestor(this.remote, update.oldHash, update.newHash);
					if (!ff) {
						results.push({
							...update,
							ok: false,
							error: `non-fast-forward update rejected for ${update.name}`,
						});
						continue;
					}
				}

				const newRef = isDelete ? null : { type: "direct" as const, hash: update.newHash };
				const swapped = await this.remote.refStore.compareAndSwapRef(
					update.name,
					expectedOld,
					newRef,
				);
				if (!swapped) {
					results.push({
						...update,
						ok: false,
						error: `failed to lock ref '${update.name}'`,
					});
					continue;
				}

				if (this.remote.hooks) {
					if (isDelete && update.oldHash) {
						this.remote.hooks.onRefDelete?.({
							repo: this.remote,
							ref: update.name,
							oldHash: update.oldHash,
						});
					} else if (!isDelete) {
						this.remote.hooks.onRefUpdate?.({
							repo: this.remote,
							ref: update.name,
							oldHash: update.oldHash,
							newHash: update.newHash,
						});
					}
				}

				results.push({ ...update, ok: true });
			} catch (err) {
				results.push({
					...update,
					ok: false,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		return { updates: results };
	}
}

// ── Smart HTTP transport ─────────────────────────────────────────────

/**
 * Transport implementation for Git Smart HTTP protocol.
 * Communicates with real Git servers (GitHub, GitLab, etc.) via HTTP(S).
 */
export class SmartHttpTransport implements Transport {
	headTarget?: string;

	private cachedFetchCaps: string[] | null = null;
	private cachedPushCaps: string[] | null = null;
	private cachedFetchRefs: RemoteRef[] | null = null;

	constructor(
		private local: GitContext,
		private url: string,
		private auth?: HttpAuth,
		private fetchFn?: FetchFunction,
	) {}

	async advertiseRefs(): Promise<RemoteRef[]> {
		const result = await discoverRefs(this.url, "git-upload-pack", this.auth, this.fetchFn);
		this.cachedFetchCaps = result.capabilities;
		this.cachedFetchRefs = result.refs;

		const headSymref = result.symrefs.get("HEAD");
		if (headSymref) {
			this.headTarget = headSymref;
		}

		return result.refs;
	}

	private async ensureFetchDiscovery() {
		if (!this.cachedFetchCaps || !this.cachedFetchRefs) {
			await this.advertiseRefs();
		}
		return {
			caps: this.cachedFetchCaps as string[],
			refs: this.cachedFetchRefs as RemoteRef[],
		};
	}

	private async ensurePushDiscovery() {
		if (!this.cachedPushCaps) {
			const result = await discoverRefs(this.url, "git-receive-pack", this.auth, this.fetchFn);
			this.cachedPushCaps = result.capabilities;
		}
		return this.cachedPushCaps as string[];
	}

	async fetch(
		wants: ObjectId[],
		haves: ObjectId[],
		shallow?: ShallowFetchOptions,
	): Promise<FetchResult> {
		const { caps, refs } = await this.ensureFetchDiscovery();

		if (wants.length === 0) {
			return { remoteRefs: refs, objectCount: 0 };
		}

		const result = await fetchPack(this.url, wants, haves, caps, this.auth, this.fetchFn, shallow);

		if (result.packData.byteLength === 0) {
			return { remoteRefs: refs, objectCount: 0 };
		}

		const objectCount = await ingestPackData(this.local, result.packData);

		const shallowUpdates: ShallowUpdate | undefined =
			result.shallowLines.length > 0 || result.unshallowLines.length > 0
				? { shallow: result.shallowLines, unshallow: result.unshallowLines }
				: undefined;

		return { remoteRefs: refs, objectCount, shallowUpdates };
	}

	async push(updates: PushRefUpdate[]): Promise<PushResult> {
		// Client-side fast-forward check (mirrors LocalTransport behaviour).
		// Each ref is checked independently — real git is non-atomic by default.
		const rejectedNames = new Set<string>();
		const rejectedResults: PushRefUpdate[] = [];
		for (const update of updates) {
			if (
				update.oldHash &&
				update.oldHash !== ZERO_HASH &&
				update.newHash !== ZERO_HASH &&
				!update.ok
			) {
				const ff = await isAncestor(this.local, update.oldHash, update.newHash);
				if (!ff) {
					rejectedNames.add(update.name);
					rejectedResults.push({ ...update, ok: false, error: "non-fast-forward" });
				}
			}
		}

		const accepted = updates.filter((u) => !rejectedNames.has(u.name));

		if (accepted.length === 0) {
			return { updates: rejectedResults };
		}

		const pushCaps = await this.ensurePushDiscovery();

		const commands: PushCommand[] = accepted.map((u) => ({
			oldHash: u.oldHash ?? ZERO_HASH,
			newHash: u.newHash,
			refName: u.name,
		}));

		const allWants: ObjectId[] = [];
		const allHaves: ObjectId[] = [];
		let hasNonDelete = false;

		for (const update of accepted) {
			if (update.newHash !== ZERO_HASH) {
				allWants.push(update.newHash);
				hasNonDelete = true;
			}
			if (update.oldHash && update.oldHash !== ZERO_HASH) {
				allHaves.push(update.oldHash);
			}
		}

		let packData: Uint8Array | null = null;
		if (hasNonDelete) {
			packData = (await buildDeltifiedPack(this.local, allWants, allHaves)) ?? null;
		}

		const result = await pushPack(this.url, commands, packData, pushCaps, this.auth, this.fetchFn);

		const serverResults: PushRefUpdate[] = accepted.map((u) => {
			const refResult = result.refResults.find((r) => r.name === u.name);
			const ok = refResult?.ok ?? result.unpackOk;
			const error =
				refResult?.error ??
				(!ok && result.unpackError ? `unpack failed: ${result.unpackError}` : undefined);
			return { ...u, ok, error };
		});

		return { updates: [...serverResults, ...rejectedResults] };
	}
}

export type { HttpAuth } from "./smart-http.ts";

// ── Shared helpers ───────────────────────────────────────────────────

/**
 * Enumerate objects reachable from wants but not haves, run delta
 * compression, and produce a deltified packfile. Returns null if
 * there are no objects to send.
 */
async function buildDeltifiedPack(
	ctx: GitRepo,
	wants: ObjectId[],
	haves: ObjectId[],
	shallowBoundary?: Set<ObjectId>,
	clientShallowBoundary?: Set<ObjectId>,
): Promise<Uint8Array | undefined> {
	const enumResult = await enumerateObjectsWithContent(
		ctx,
		wants,
		haves,
		shallowBoundary,
		clientShallowBoundary,
	);
	if (enumResult.count === 0) return undefined;

	const objects = await collectEnumeration(enumResult);
	const deltas = findBestDeltas(objects);
	const inputs: DeltaPackInput[] = deltas.map((r) => ({
		hash: r.hash,
		type: r.type,
		content: r.content,
		delta: r.delta,
		deltaBaseHash: r.deltaBase,
	}));

	const { data } = await writePackDeltified(inputs);
	return data;
}
