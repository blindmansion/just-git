import { ZERO_HASH } from "../hex.ts";
import { isAncestor } from "../merge.ts";
import { ingestPackData, objectExists, peelToCommit, readObject } from "../object-db.ts";
import { findBestDeltas } from "../pack/delta.ts";
import type { DeltaPackInput } from "../pack/packfile.ts";
import { writePackDeltified } from "../pack/packfile.ts";
import { listRefs, readHead, resolveRef } from "../refs/refs.ts";
import { computeShallowBoundary, type ShallowUpdate } from "../refs/shallow.ts";
import type { DiscoveryCache, DiscoveryEntry, GitRepo, ObjectId } from "../types.ts";
import { collectEnumeration, enumerateObjectsWithContent } from "./object-walk.ts";
import {
	type DiscoverResult,
	discoverRefs,
	fetchPack,
	type PushCommand,
	pushPack,
} from "./smart-http.ts";
import {
	type V2Capabilities,
	discoverV2Capabilities,
	fetchPackV2,
	fetchSupports,
	lsRefs,
	v2CapabilitiesFromRaw,
} from "./smart-http-v2.ts";

// ── Auth ─────────────────────────────────────────────────────────────

/** HTTP authentication credentials for the Smart HTTP transport. */
export type HttpAuth =
	| { type: "basic"; username: string; password: string }
	| { type: "bearer"; token: string };

/**
 * Callback that provides HTTP authentication for remote operations.
 * Called with the remote URL; return credentials or null for anonymous access.
 */
export type CredentialProvider = (url: string) => HttpAuth | null | Promise<HttpAuth | null>;

/**
 * Pluggable store for credentials *discovered at runtime* — specifically the
 * secrets that `git remote add` / `git clone` strip out of a URL before the
 * sanitized URL is written to `.git/config`. The producing command calls
 * {@link CredentialStore.remember}; a later `fetch` / `push` on the same
 * {@link GitOptions.credentialStore | instance} calls {@link CredentialStore.get}.
 *
 * Keys are URL origins (e.g. `https://github.com`). Supply a custom
 * implementation on {@link GitOptions.credentialStore} to back this with, say,
 * an OS keychain or encrypted-at-rest storage; the default is in-memory and
 * instance-scoped ({@link createMemoryCredentialStore}).
 *
 * Note: the explicit {@link CredentialProvider} capability always takes
 * precedence over the store and never touches the CLI URL path at all, so it
 * remains the safest place to supply credentials.
 */
export interface CredentialStore {
	/** Look up remembered auth for a URL origin. */
	get(origin: string): HttpAuth | undefined | Promise<HttpAuth | undefined>;
	/** Remember auth for a URL origin (stripped from a remote URL). */
	remember(origin: string, auth: HttpAuth): void | Promise<void>;
}

/** Default in-memory, instance-scoped {@link CredentialStore} backed by a `Map`. */
export function createMemoryCredentialStore(): CredentialStore {
	const map = new Map<string, HttpAuth>();
	return {
		get: (origin) => map.get(origin),
		remember: (origin, auth) => {
			map.set(origin, auth);
		},
	};
}

// ── Network policy & progress ────────────────────────────────────────

/**
 * Called with server progress messages (sideband band-2) during
 * network operations (fetch, clone, push). Messages are raw text
 * from the remote — format varies by server.
 */
export type ProgressCallback = (message: string) => void;

/** Custom fetch function signature for HTTP transport. */
export type FetchFunction = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

/**
 * Controls which remote URLs the git instance may access over HTTP.
 * Set to `false` on {@link GitOptions.network} to block all HTTP access.
 */
export interface NetworkPolicy {
	/**
	 * Allowed URL patterns. Can be:
	 * - A hostname: "github.com" (matches any URL whose host equals this)
	 * - A URL prefix: "https://github.com/myorg/" (matches URLs starting with this)
	 */
	allowed?: string[];
	/** Custom fetch function for HTTP transport. Falls back to globalThis.fetch. */
	fetch?: FetchFunction;
}

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

interface NonDeletePushRefUpdate extends PushRefUpdate {
	oldHash: ObjectId;
	newHash: ObjectId;
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
	 * Get the remote refs from the **push** (receive-pack) advertisement.
	 *
	 * A receive-pack ref advertisement already carries the full ref list (v1
	 * advert format), so push consumers that only need remote ref *values* for
	 * the compare-and-swap `oldHash` can read them here instead of via
	 * `advertiseRefs()` — which on v2 costs an extra capability `GET` plus an
	 * upload-pack `ls-refs` that the receive-pack advertisement duplicates. The
	 * result is cached alongside the push capabilities, so the subsequent
	 * `push()` reuses the same advertisement (no second receive-pack `GET`).
	 */
	advertisePushRefs(): Promise<RemoteRef[]>;

	/**
	 * Seed the advertised refs from a recent probe (e.g. a just-completed
	 * `listRemoteRefs`), so a following `advertiseRefs()`/`fetch()` reuses them
	 * instead of issuing its own ref discovery. The caller owns the freshness
	 * decision — it just observed these refs — so this is an explicit, advisory
	 * hint. Only the advertise path benefits (CLI `fetch`/`pull`, programmatic
	 * `fetch` without `refs`); by-name `fetchRefs` resolves server-side and
	 * ignores the seed. On protocol v2 it elides the `ls-refs` round-trip; on v1
	 * the advertisement bundles refs with caps, so the seed is a no-op there.
	 */
	seedRefs(refs: RemoteRef[]): void;

	/**
	 * Fetch objects from the remote that are reachable from `wants`
	 * but not from `haves`. Unpacks received objects into the local store.
	 * Pass `shallow` options for depth-limited fetches.
	 */
	fetch(wants: ObjectId[], haves: ObjectId[], shallow?: ShallowFetchOptions): Promise<FetchResult>;

	/**
	 * Fetch objects for refs requested **by name**, returning the server's
	 * resolved `{ name, hash }` pairs in `remoteRefs` (exactly the requested
	 * refs that exist on the remote — missing ones are omitted).
	 *
	 * On a v2 server advertising `ref-in-want` this is a single `fetch` command
	 * carrying `want-ref` args, skipping the separate `ls-refs` advertisement
	 * (no discover-then-fetch race). Otherwise it transparently degrades to the
	 * `advertiseRefs()` → `fetch(oids)` path.
	 */
	fetchRefs(
		refNames: string[],
		haves: ObjectId[],
		shallow?: ShallowFetchOptions,
	): Promise<FetchResult>;

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
		private local: GitRepo,
		private remote: GitRepo,
	) {}

	async advertiseRefs(): Promise<RemoteRef[]> {
		const refs = await listRefs(this.remote);
		const result: RemoteRef[] = [];
		for (const ref of refs) {
			if (ref.name.startsWith("refs/tags/")) {
				try {
					const raw = await readObject(this.remote, ref.hash);
					if (raw.type === "tag") {
						result.push({
							name: ref.name,
							hash: ref.hash,
							peeledHash: await peelToCommit(this.remote, ref.hash),
						});
						continue;
					}
				} catch {
					// If the tag object is missing or unreadable, fall back to the raw ref.
				}
			}
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

	advertisePushRefs(): Promise<RemoteRef[]> {
		// Local transport has no separate receive-pack advertisement and pays no
		// round-trips, so the upload-pack ref list is the same data.
		return this.advertiseRefs();
	}

	seedRefs(_refs: RemoteRef[]): void {
		// In-process ref reads are free, so there is nothing to short-circuit.
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

	async fetchRefs(
		refNames: string[],
		haves: ObjectId[],
		shallow?: ShallowFetchOptions,
	): Promise<FetchResult> {
		return fetchRefsViaAdvertisement(this, refNames, haves, shallow);
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
				const expectedOld =
					update.oldHash !== null ? { type: "direct" as const, hash: update.oldHash } : null;

				if (isTagRewrite(update) && !update.ok) {
					results.push({
						...update,
						ok: false,
						error: `non-fast-forward update rejected for ${update.name}`,
					});
					continue;
				}

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

				const remoteHooks = this.remote.capabilities?.hooks;
				if (remoteHooks) {
					if (isDelete && update.oldHash) {
						remoteHooks.onRefDelete?.({
							repo: this.remote,
							ref: update.name,
							oldHash: update.oldHash,
						});
					} else if (!isDelete) {
						remoteHooks.onRefUpdate?.({
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
	private cachedPushRefs: RemoteRef[] | null = null;

	/** Resolved upload-pack protocol version, null until first discovery. */
	private protocolVersion: 1 | 2 | null = null;
	/** v2 capabilities, populated only when `protocolVersion === 2`. */
	private cachedV2Caps: V2Capabilities | null = null;

	/** Canonical remote repository URL used as the cache key. */
	private readonly discoveryCacheKey: string | null;
	/** True when the active discovery was restored from the cache, not the wire. */
	private discoveryFromCache = false;
	/** Guards evict-on-error so a stale entry triggers at most one re-discovery. */
	private recoveredFromStaleCache = false;

	/**
	 * @param protocolPreference Whether to *request* protocol v2 on discovery.
	 *   Defaults to v2 (matching modern git ≥2.26) with transparent v1 fallback
	 *   when the server doesn't upgrade. Push (receive-pack) is always v1.
	 * @param discoveryCache Optional cross-operation cache of stable discovery
	 *   (version + caps). When present, a cached v2 entry lets discovery skip the
	 *   capability `GET`; a protocol error on a cached entry evicts it and
	 *   re-discovers once from the wire.
	 */
	constructor(
		private local: GitRepo,
		private url: string,
		private fetchFn?: FetchFunction,
		private onProgress?: ProgressCallback,
		private protocolPreference: 1 | 2 = 2,
		private discoveryCache?: DiscoveryCache,
	) {
		this.discoveryCacheKey = cacheKeyForUrl(url);
	}

	/**
	 * Run upload-pack discovery once, resolving the protocol version. For v2,
	 * this only fetches capabilities; refs come later from ls-refs. For v1 (or
	 * a v2-request that the server declines), refs + caps arrive together.
	 */
	private async ensureDiscovery(): Promise<void> {
		if (this.protocolVersion !== null) return;

		// Cache hit: restore v2 caps and skip the capability GET entirely. A v1
		// advertisement bundles refs with caps, so a caps-only cache cannot skip it.
		const cached = await this.readDiscoveryCache();
		if (cached && this.protocolPreference === 2 && "v2" in cached.uploadPack) {
			this.protocolVersion = 2;
			this.cachedV2Caps = v2CapabilitiesFromRaw(cached.uploadPack.v2.raw);
			// Flag the cache origin *before* validating, so even a poisoned entry
			// (e.g. one claiming an unsupported object-format) self-corrects via
			// evict + re-discover rather than hard-failing.
			this.discoveryFromCache = true;
			this.assertSupportedObjectFormat();
			return;
		}

		if (this.protocolPreference === 2) {
			const result = await discoverV2Capabilities(this.url, this.fetchFn);
			if (result.version === 2) {
				this.protocolVersion = 2;
				this.cachedV2Caps = result.caps;
				this.assertSupportedObjectFormat();
				await this.writeUploadPackDiscovery();
				return;
			}
			this.protocolVersion = 1;
			this.applyV1Discovery(result.v1);
			await this.writeUploadPackDiscovery();
			return;
		}

		this.protocolVersion = 1;
		this.applyV1Discovery(await discoverRefs(this.url, "git-upload-pack", this.fetchFn));
		await this.writeUploadPackDiscovery();
	}

	private async readDiscoveryCache(): Promise<DiscoveryEntry | undefined> {
		if (!this.discoveryCache || this.discoveryCacheKey === null) return undefined;
		return (await this.discoveryCache.get(this.discoveryCacheKey)) ?? undefined;
	}

	/** Persist the just-discovered upload-pack version and capabilities. */
	private async writeUploadPackDiscovery(): Promise<void> {
		if (!this.discoveryCache || this.discoveryCacheKey === null || this.protocolVersion === null) {
			return;
		}
		const uploadPack: DiscoveryEntry["uploadPack"] =
			this.protocolVersion === 2 && this.cachedV2Caps
				? { v2: { raw: this.cachedV2Caps.raw, objectFormat: this.cachedV2Caps.objectFormat } }
				: { v1: this.cachedFetchCaps ?? [], objectFormat: "sha1" };
		await this.discoveryCache.set(this.discoveryCacheKey, {
			protocolVersion: this.protocolVersion,
			uploadPack,
			fetchedAt: Date.now(),
		});
	}

	/** Forget the resolved upload-pack discovery so the next call re-runs it from the wire. */
	private resetDiscovery(): void {
		this.protocolVersion = null;
		this.cachedV2Caps = null;
		this.cachedFetchCaps = null;
		this.cachedFetchRefs = null;
		this.discoveryFromCache = false;
	}

	/**
	 * Run an upload-pack operation, self-correcting a stale cache once: if the
	 * operation fails *and* the discovery it relied on came from the cache, evict
	 * that entry, re-discover from the wire, and retry exactly once. A failure on
	 * fresh-from-wire discovery is a real error and propagates immediately.
	 */
	private async withStaleCacheRecovery<T>(op: () => Promise<T>): Promise<T> {
		try {
			return await op();
		} catch (err) {
			if (!this.discoveryFromCache || this.recoveredFromStaleCache) throw err;
			this.recoveredFromStaleCache = true;
			if (this.discoveryCacheKey !== null) {
				await this.discoveryCache?.evict?.(this.discoveryCacheKey);
			}
			this.resetDiscovery();
			return op();
		}
	}

	private applyV1Discovery(result: DiscoverResult): void {
		this.cachedFetchCaps = result.capabilities;
		this.cachedFetchRefs = result.refs;
		const headSymref = result.symrefs.get("HEAD");
		if (headSymref) this.headTarget = headSymref;
	}

	/**
	 * Reject servers advertising a hash function we cannot consume. The pack
	 * trailer verification (`ingestPack`) is SHA-1 only, so a clear error here
	 * beats mis-parsing wider OIDs further downstream.
	 */
	private assertSupportedObjectFormat(): void {
		const format = this.cachedV2Caps?.objectFormat ?? "sha1";
		if (format !== "sha1") {
			throw new Error(`unsupported object-format '${format}': just-git only supports sha1`);
		}
	}

	/** Populate v2 refs from an ls-refs round-trip (idempotent). */
	private async ensureV2Refs(): Promise<RemoteRef[]> {
		if (this.cachedFetchRefs) return this.cachedFetchRefs;
		const caps = this.cachedV2Caps as V2Capabilities;
		const result = await lsRefs(this.url, caps, this.fetchFn, { symrefs: true, peel: true });
		this.cachedFetchRefs = result.refs;
		if (result.headTarget) this.headTarget = result.headTarget;
		return result.refs;
	}

	seedRefs(refs: RemoteRef[]): void {
		// Reused by the v2 advertise path (ensureV2Refs returns these without an
		// ls-refs POST). On v1 the discovery GET re-populates refs anyway, so this
		// is harmless but ineffective there.
		this.cachedFetchRefs = refs;
	}

	advertiseRefs(): Promise<RemoteRef[]> {
		return this.withStaleCacheRecovery(() => this.advertiseRefsOnce());
	}

	private async advertiseRefsOnce(): Promise<RemoteRef[]> {
		await this.ensureDiscovery();
		if (this.protocolVersion === 2) {
			return this.ensureV2Refs();
		}
		return this.cachedFetchRefs as RemoteRef[];
	}

	private async ensurePushDiscovery() {
		if (!this.cachedPushCaps) {
			const result = await discoverRefs(this.url, "git-receive-pack", this.fetchFn);
			this.cachedPushCaps = result.capabilities;
			// The receive-pack advertisement already lists every ref; keep it so
			// the push path reads remote `oldHash` values from here rather than
			// from a redundant upload-pack advertisement.
			this.cachedPushRefs = result.refs;
		}
		return this.cachedPushCaps as string[];
	}

	async advertisePushRefs(): Promise<RemoteRef[]> {
		await this.ensurePushDiscovery();
		return this.cachedPushRefs as RemoteRef[];
	}

	fetch(wants: ObjectId[], haves: ObjectId[], shallow?: ShallowFetchOptions): Promise<FetchResult> {
		return this.withStaleCacheRecovery(() => this.fetchOnce(wants, haves, shallow));
	}

	private async fetchOnce(
		wants: ObjectId[],
		haves: ObjectId[],
		shallow?: ShallowFetchOptions,
	): Promise<FetchResult> {
		await this.ensureDiscovery();

		if (this.protocolVersion === 2) {
			const refs = await this.ensureV2Refs();
			if (wants.length === 0) {
				return { remoteRefs: refs, objectCount: 0 };
			}

			const result = await fetchPackV2(
				this.url,
				wants,
				haves,
				this.cachedV2Caps as V2Capabilities,
				this.fetchFn,
				shallow,
				this.onProgress,
			);

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

		const caps = this.cachedFetchCaps as string[];
		const refs = this.cachedFetchRefs as RemoteRef[];

		if (wants.length === 0) {
			return { remoteRefs: refs, objectCount: 0 };
		}

		const result = await fetchPack(
			this.url,
			wants,
			haves,
			caps,
			this.fetchFn,
			shallow,
			this.onProgress,
		);

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

	fetchRefs(
		refNames: string[],
		haves: ObjectId[],
		shallow?: ShallowFetchOptions,
	): Promise<FetchResult> {
		return this.withStaleCacheRecovery(() => this.fetchRefsOnce(refNames, haves, shallow));
	}

	private async fetchRefsOnce(
		refNames: string[],
		haves: ObjectId[],
		shallow?: ShallowFetchOptions,
	): Promise<FetchResult> {
		await this.ensureDiscovery();

		// Fast path: v2 + `ref-in-want`. One `fetch` POST resolves the names
		// server-side and returns the packfile — no `ls-refs` round-trip.
		if (
			this.protocolVersion === 2 &&
			fetchSupports(this.cachedV2Caps as V2Capabilities, "ref-in-want")
		) {
			const result = await fetchPackV2(
				this.url,
				[],
				haves,
				this.cachedV2Caps as V2Capabilities,
				this.fetchFn,
				shallow,
				this.onProgress,
				refNames,
			);

			const remoteRefs: RemoteRef[] = result.wantedRefs.map((r) => ({
				name: r.name,
				hash: r.hash,
			}));

			let objectCount = 0;
			if (result.packData.byteLength > 0) {
				objectCount = await ingestPackData(this.local, result.packData);
			}

			const shallowUpdates: ShallowUpdate | undefined =
				result.shallowLines.length > 0 || result.unshallowLines.length > 0
					? { shallow: result.shallowLines, unshallow: result.unshallowLines }
					: undefined;

			return { remoteRefs, objectCount, shallowUpdates };
		}

		// Fallback: server didn't advertise `ref-in-want` (or negotiated v1).
		return fetchRefsViaAdvertisement(this, refNames, haves, shallow);
	}

	async push(updates: PushRefUpdate[]): Promise<PushResult> {
		// Client-side fast-forward check (mirrors LocalTransport behaviour).
		// Each ref is checked independently — real git is non-atomic by default.
		const rejectedNames = new Set<string>();
		const rejectedResults: PushRefUpdate[] = [];
		for (const update of updates) {
			if (isTagRewrite(update) && !update.ok) {
				rejectedNames.add(update.name);
				rejectedResults.push({ ...update, ok: false, error: "non-fast-forward" });
				continue;
			}
			if (isNonDeleteUpdate(update) && !update.ok) {
				const ff = await isAncestor(this.local, update.oldHash, update.newHash);
				if (!ff) {
					const hasRemoteObj = await objectExists(this.local, update.oldHash);
					const error = hasRemoteObj ? "non-fast-forward" : "fetch first";
					rejectedNames.add(update.name);
					rejectedResults.push({ ...update, ok: false, error });
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

		const result = await pushPack(
			this.url,
			commands,
			packData,
			pushCaps,
			this.fetchFn,
			this.onProgress,
		);

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
// ── Shared helpers ───────────────────────────────────────────────────

/**
 * By-name fetch via the generic advertise → fetch(oids) path. Resolves
 * `refNames` against the full advertisement, fetches the matched OIDs, and
 * returns only the matched refs. Used as the fallback when `want-ref` is
 * unavailable (v1, or a v2 server without `ref-in-want`).
 */
async function fetchRefsViaAdvertisement(
	transport: Transport,
	refNames: string[],
	haves: ObjectId[],
	shallow?: ShallowFetchOptions,
): Promise<FetchResult> {
	const allRefs = await transport.advertiseRefs();
	const wanted = new Set(refNames);
	const matched = allRefs.filter((r) => wanted.has(r.name));
	const wants = [...new Set(matched.map((r) => r.hash))];
	if (wants.length === 0) {
		return { remoteRefs: [], objectCount: 0 };
	}
	const result = await transport.fetch(wants, haves, shallow);
	return {
		remoteRefs: matched,
		objectCount: result.objectCount,
		shallowUpdates: result.shallowUpdates,
	};
}

/** Canonicalize a remote repository URL for use as a discovery-cache key. */
function cacheKeyForUrl(url: string): string | null {
	try {
		const parsed = new URL(url);
		parsed.hash = "";
		if (parsed.pathname.length > 1) parsed.pathname = parsed.pathname.replace(/\/+$/, "");
		return parsed.href;
	} catch {
		return null;
	}
}

function isNonDeleteUpdate(update: PushRefUpdate): update is NonDeletePushRefUpdate {
	return !!update.oldHash && update.oldHash !== ZERO_HASH && update.newHash !== ZERO_HASH;
}

function isTagRewrite(update: PushRefUpdate): boolean {
	return update.name.startsWith("refs/tags/") && isNonDeleteUpdate(update);
}

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
