/**
 * High-level server operations.
 *
 * Transport-agnostic: each operation accepts a `GitRepo` and returns
 * structured results. `applyReceivePack` encapsulates the full push
 * lifecycle (hooks + ref application) for use by any transport adapter.
 */

import { isRejection } from "../hooks.ts";
import { ZERO_HASH } from "../lib/hex.ts";
import { isAncestor } from "../lib/merge.ts";
import { resolveRef } from "../lib/refs.ts";
import { parseTag } from "../lib/objects/tag.ts";
import { findBestDeltas } from "../lib/pack/delta.ts";
import type { DeltaPackInput, PackInput } from "../lib/pack/packfile.ts";
import { readPackStreaming, writePackDeltified, writePackStreaming } from "../lib/pack/packfile.ts";
import { checkRefFormat } from "../lib/refs.ts";
import { computeShallowBoundary } from "../lib/shallow.ts";
import {
	collectEnumeration,
	enumerateObjects,
	enumerateObjectsWithContent,
	type WalkObjectWithContent,
} from "../lib/transport/object-walk.ts";
import type { GitRepo, ObjectId } from "../lib/types.ts";
import type { ShallowUpdate } from "../lib/shallow.ts";
import {
	type AdvertisedRef,
	type PushCommand,
	type V2FetchResponseOptions,
	type V2LsRefsRef,
	buildRefAdvertisement,
	buildRefListPktLines,
	buildShallowOnlyResponse,
	buildUploadPackResponse,
	buildUploadPackResponseStreaming,
	buildV2CapabilityAdvertisement,
	buildV2FetchAcknowledgments,
	buildV2FetchResponse,
	buildV2FetchResponseStreaming,
	buildV2LsRefsResponse,
	parseReceivePackRequest,
	parseUploadPackRequest,
	parseV2FetchArgs,
} from "./protocol.ts";
import type {
	RefUpdateResult,
	RefAdvertisement,
	RefResult,
	RefUpdate,
	RefUpdateRequest,
	Rejection,
	ServerHooks,
} from "./types.ts";
import { RequestLimitError } from "./errors.ts";
import {
	isDeferrableObjectStore,
	type DeferrableObjectStore,
	type PendingObjectBatch,
} from "./storage.ts";

// ── Pack cache ──────────────────────────────────────────────────────

interface PackCacheEntry {
	packData: Uint8Array;
	objectCount: number;
	deltaCount: number;
}

/**
 * Bounded LRU-ish cache for generated packfiles.
 *
 * Keyed on `(repoId, sorted wants)` — only caches full clones
 * (requests with no `have` lines). Incremental fetches always
 * compute fresh packs.
 *
 * Entries are automatically invalidated when refs change: since the
 * cache key includes the exact want hashes, a ref update changes
 * the want set on the next client request, producing a cache miss.
 */
export class PackCache {
	private entries = new Map<string, PackCacheEntry>();
	private currentBytes = 0;
	private maxBytes: number;
	private hits = 0;
	private misses = 0;

	constructor(maxBytes = 256 * 1024 * 1024) {
		this.maxBytes = maxBytes;
	}

	/** Build a cache key. Returns null for requests with haves (not cacheable). */
	static key(repoId: string, wants: string[], haves: string[]): string | null {
		if (haves.length > 0) return null;
		const sorted = wants.slice().sort();
		return `${repoId}\0${sorted.join(",")}`;
	}

	get(key: string): PackCacheEntry | undefined {
		const entry = this.entries.get(key);
		if (entry) {
			this.hits++;
		} else {
			this.misses++;
		}
		return entry;
	}

	set(key: string, entry: PackCacheEntry): void {
		if (this.entries.has(key)) return;

		const size = entry.packData.byteLength;
		if (size > this.maxBytes) return;

		while (this.currentBytes + size > this.maxBytes && this.entries.size > 0) {
			const oldest = this.entries.keys().next().value!;
			this.currentBytes -= this.entries.get(oldest)!.packData.byteLength;
			this.entries.delete(oldest);
		}

		this.entries.set(key, entry);
		this.currentBytes += size;
	}

	clear(): void {
		this.entries.clear();
		this.currentBytes = 0;
	}

	get stats() {
		return {
			entries: this.entries.size,
			bytes: this.currentBytes,
			hits: this.hits,
			misses: this.misses,
		};
	}
}

// ── Capabilities ────────────────────────────────────────────────────

const UPLOAD_PACK_CAPS = [
	"multi_ack_detailed",
	"no-done",
	"side-band-64k",
	"ofs-delta",
	"include-tag",
	"shallow",
];

const RECEIVE_PACK_CAPS = ["report-status", "side-band-64k", "ofs-delta", "delete-refs"];

// ── Ref advertisement ───────────────────────────────────────────────

interface RefsData {
	refs: RefAdvertisement[];
	headTarget?: string;
}

/**
 * Collect the structured ref list from a repo (no wire encoding).
 * The handler can pass this through an advertiseRefs hook to filter,
 * then call `buildRefAdvertisementBytes` to produce the wire format.
 */
export async function collectRefs(repo: GitRepo): Promise<RefsData> {
	const refEntries = await repo.refStore.listRefs("refs");
	const headRef = await repo.refStore.readRef("HEAD");

	const refs: RefAdvertisement[] = [];

	let headHash: string | null = null;
	let headTarget: string | undefined;

	if (headRef) {
		if (headRef.type === "symbolic") {
			headTarget = headRef.target;
			const targetRef = await repo.refStore.readRef(headRef.target);
			if (targetRef?.type === "direct") {
				headHash = targetRef.hash;
			}
		} else {
			headHash = headRef.hash;
		}
	}

	const sortedEntries = refEntries
		.slice()
		.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

	// Storage backends (MemoryStorage, BunSqliteStorage, etc.) start with no
	// HEAD. Real bare repos always have HEAD pointing at the default branch.
	// Without HEAD + symref, git clients can't determine the default branch
	// and shallow clones silently produce empty repos. Synthesize HEAD from
	// the first branch ref when the store doesn't provide one.
	if (!headHash && sortedEntries.length > 0) {
		const defaultBranch = inferDefaultBranch(sortedEntries);
		if (defaultBranch) {
			headHash = defaultBranch.hash;
			headTarget = defaultBranch.name;
		}
	}

	if (headHash) {
		refs.push({ name: "HEAD", hash: headHash });
	}

	for (const entry of sortedEntries) {
		refs.push({ name: entry.name, hash: entry.hash });

		if (entry.name.startsWith("refs/tags/")) {
			try {
				const obj = await repo.objectStore.read(entry.hash);
				if (obj.type === "tag") {
					const tag = parseTag(obj.content);
					refs.push({ name: `${entry.name}^{}`, hash: tag.object });
				}
			} catch {
				// Object unreadable; skip peeling
			}
		}
	}

	return { refs, headTarget };
}

const DEFAULT_BRANCH_PRIORITY = ["refs/heads/main", "refs/heads/master"];

/**
 * Pick the most likely default branch from a sorted ref list.
 * Prefers `main`, then `master`, then the first `refs/heads/*` entry.
 */
function inferDefaultBranch(
	entries: { name: string; hash: string }[],
): { name: string; hash: string } | null {
	for (const preferred of DEFAULT_BRANCH_PRIORITY) {
		const match = entries.find((e) => e.name === preferred);
		if (match) return match;
	}
	const firstBranch = entries.find((e) => e.name.startsWith("refs/heads/"));
	return firstBranch ?? null;
}

/**
 * Build the HTTP-wrapped ref advertisement (includes `# service=...` header).
 */
export function buildRefAdvertisementBytes(
	refs: RefAdvertisement[],
	service: "git-upload-pack" | "git-receive-pack",
	headTarget?: string,
): Uint8Array {
	const caps = service === "git-upload-pack" ? UPLOAD_PACK_CAPS : RECEIVE_PACK_CAPS;
	return buildRefAdvertisement(refs as AdvertisedRef[], service, caps, headTarget);
}

/**
 * Build the transport-agnostic ref list (no HTTP service header).
 * Used by SSH and in-process transports.
 */
export function buildRefListBytes(
	refs: RefAdvertisement[],
	service: "git-upload-pack" | "git-receive-pack",
	headTarget?: string,
): Uint8Array {
	const caps = service === "git-upload-pack" ? UPLOAD_PACK_CAPS : RECEIVE_PACK_CAPS;
	return buildRefListPktLines(refs as AdvertisedRef[], caps, headTarget);
}

// ── Ref advertisement with hooks ────────────────────────────────────

export interface AdvertiseResult {
	refs: RefAdvertisement[];
	headTarget?: string;
}

/**
 * Collect refs and run the `advertiseRefs` hook. Returns either the
 * (possibly filtered) ref list, or a `Rejection` if the hook denied access.
 *
 * Both HTTP and SSH code paths use this — the caller handles the
 * transport-specific response (HTTP 403 vs SSH exit 128).
 */
export async function advertiseRefsWithHooks<A>(
	repo: GitRepo,
	repoId: string,
	service: "git-upload-pack" | "git-receive-pack",
	hooks: ServerHooks<A> | undefined,
	auth: A,
): Promise<AdvertiseResult | Rejection> {
	const { refs: allRefs, headTarget } = await collectRefs(repo);
	let refs = allRefs;
	if (hooks?.advertiseRefs) {
		const result = await hooks.advertiseRefs({ repo, repoId, refs: allRefs, service, auth });
		if (isRejection(result)) return result;
		if (result) refs = result;
	}
	const visibleHeadTarget =
		headTarget &&
		refs.some((ref) => ref.name === "HEAD") &&
		refs.some((ref) => ref.name === headTarget)
			? headTarget
			: undefined;
	return { refs, headTarget: visibleHeadTarget };
}

// ── Upload-pack (fetch/clone serving) ───────────────────────────────

interface UploadPackOptions {
	/** Pack cache instance. When provided, full clones (no haves) are cached. */
	cache?: PackCache;
	/** Repo path used as part of the cache key. Required when cache is set. */
	cacheKey?: string;
	/** Skip delta compression — faster pack generation, larger output. */
	noDelta?: boolean;
	/** Delta window size (default 10). Ignored when noDelta is true. */
	deltaWindow?: number;
}

export interface AuthorizedFetchSet {
	allowedRefHashes: Map<string, string>;
	allowedWantHashes: Set<string>;
}

export interface ReceivePackLimitOptions {
	maxPackBytes?: number;
	maxPackObjects?: number;
}

export function buildAuthorizedFetchSet(adv: AdvertiseResult): AuthorizedFetchSet {
	const allowedRefHashes = new Map<string, string>();
	const allowedWantHashes = new Set<string>();
	for (const ref of adv.refs) {
		allowedRefHashes.set(ref.name, ref.hash);
		allowedWantHashes.add(ref.hash);
	}
	return { allowedRefHashes, allowedWantHashes };
}

/**
 * Handle a `POST /git-upload-pack` request.
 *
 * Returns `Uint8Array` for buffered responses (cache hits, deltified packs)
 * or `ReadableStream<Uint8Array>` for streaming no-delta responses.
 */
export async function handleUploadPack(
	repo: GitRepo,
	requestBody: Uint8Array,
	options?: UploadPackOptions & { authorizedFetchSet?: AuthorizedFetchSet },
): Promise<Uint8Array | ReadableStream<Uint8Array> | Rejection> {
	const { wants, haves, capabilities, clientShallows, depth, done } =
		parseUploadPackRequest(requestBody);

	if (wants.length === 0) {
		return buildUploadPackResponse(new Uint8Array(0), false);
	}

	if (options?.authorizedFetchSet) {
		for (const want of wants) {
			if (!options.authorizedFetchSet.allowedWantHashes.has(want)) {
				return { reject: true, message: `forbidden want ${want}` };
			}
		}
	}

	const useMultiAck = capabilities.includes("multi_ack_detailed");
	const useSideband = capabilities.includes("side-band-64k");

	// Compute shallow boundary when client requests a depth limit
	let shallowInfo: ShallowUpdate | undefined;
	let shallowBoundary: Set<ObjectId> | undefined;
	let clientShallowSet: Set<ObjectId> | undefined;

	// Always track client's shallow state — even requests without
	// "deepen" (e.g. tag auto-follow) need accurate have-walk bounds.
	if (clientShallows.length > 0) {
		clientShallowSet = new Set(clientShallows);
	}

	if (depth !== undefined) {
		const boundary = await computeShallowBoundary(
			repo,
			wants,
			depth,
			clientShallowSet ?? new Set(),
		);
		shallowInfo = boundary;
		// Always set shallowBoundary when depth is requested, even for
		// unshallow (empty set). This signals "deepening mode" to
		// enumerateObjects so it augments wants with shallow parents.
		shallowBoundary = new Set(boundary.shallow);
	}

	// Shallow negotiation phase: when the client sends wants + deepen
	// without "done", it expects only the shallow-update section back.
	// The client will send a second request with "done" for the pack.
	if (shallowInfo && !done) {
		return buildShallowOnlyResponse(shallowInfo);
	}

	let commonHashes: string[] | undefined;
	if (useMultiAck && haves.length > 0) {
		commonHashes = [];
		for (const hash of haves) {
			if (await repo.objectStore.exists(hash)) {
				commonHashes.push(hash);
			}
		}
		if (commonHashes.length === 0) commonHashes = undefined;
	}

	// Shallow fetches are never cached (boundary depends on client state)
	const cacheKey =
		!shallowBoundary && options?.cache && options.cacheKey
			? PackCache.key(options.cacheKey, wants, haves)
			: null;

	if (cacheKey && options?.cache) {
		const cached = options.cache.get(cacheKey);
		if (cached) {
			return buildUploadPackResponse(cached.packData, useSideband, commonHashes);
		}
	}

	const includeTag = capabilities.includes("include-tag");
	const packOpts: PackBuildOptions = {
		repo,
		wants,
		haves,
		includeTag,
		shallowBoundary,
		clientShallowBoundary: clientShallowSet,
		cache: options?.cache,
		cacheKey,
		deltaWindow: options?.deltaWindow,
	};

	if (options?.noDelta) {
		const packChunks = await buildPackStreaming(packOpts);
		if (!packChunks) {
			const { data: emptyPack } = await writePackDeltified([]);
			return buildUploadPackResponse(emptyPack, useSideband, commonHashes, shallowInfo);
		}
		return asyncIterableToStream(
			buildUploadPackResponseStreaming(packChunks, useSideband, commonHashes, shallowInfo),
		);
	}

	const packData = await buildPackBuffered(packOpts);
	return buildUploadPackResponse(packData, useSideband, commonHashes, shallowInfo);
}

// ── Shared pack-building pipeline ───────────────────────────────────

interface PackBuildOptions {
	repo: GitRepo;
	wants: string[];
	haves: string[];
	includeTag: boolean;
	shallowBoundary?: Set<ObjectId>;
	clientShallowBoundary?: Set<ObjectId>;
	cache?: PackCache;
	cacheKey?: string | null;
	deltaWindow?: number;
}

async function collectIncludedTags(
	repo: GitRepo,
	sentHashes: Set<string>,
): Promise<WalkObjectWithContent[]> {
	const extra: WalkObjectWithContent[] = [];
	const tagRefs = await repo.refStore.listRefs("refs/tags");
	for (const tagRef of tagRefs) {
		if (sentHashes.has(tagRef.hash)) continue;
		try {
			const obj = await repo.objectStore.read(tagRef.hash);
			if (obj.type === "tag") {
				const tag = parseTag(obj.content);
				if (sentHashes.has(tag.object)) {
					extra.push({ hash: tagRef.hash, type: "tag", content: obj.content });
					sentHashes.add(tagRef.hash);
				}
			}
		} catch {
			// skip
		}
	}
	return extra;
}

/**
 * Buffered pack builder: enumerates objects with content, computes deltas,
 * writes a deltified pack, and optionally caches the result.
 */
async function buildPackBuffered(opts: PackBuildOptions): Promise<Uint8Array> {
	const { repo, wants, haves, includeTag, shallowBoundary, clientShallowBoundary } = opts;

	const enumResult = await enumerateObjectsWithContent(
		repo,
		wants,
		haves,
		shallowBoundary,
		clientShallowBoundary,
	);

	if (enumResult.count === 0) {
		const { data } = await writePackDeltified([]);
		return data;
	}

	const collected: WalkObjectWithContent[] = await collectEnumeration(enumResult);
	const sentHashes = new Set(collected.map((o) => o.hash));

	if (includeTag) {
		const extra = await collectIncludedTags(repo, sentHashes);
		collected.push(...extra);
	}

	const windowOpt = opts.deltaWindow ? { window: opts.deltaWindow } : undefined;
	const deltas = findBestDeltas(collected, windowOpt);

	const inputs: DeltaPackInput[] = deltas.map((r) => ({
		hash: r.hash,
		type: r.type,
		content: r.content,
		delta: r.delta,
		deltaBaseHash: r.deltaBase,
	}));

	const { data: packData } = await writePackDeltified(inputs);

	if (opts.cacheKey && opts.cache) {
		const deltaCount = deltas.filter((d) => d.delta).length;
		opts.cache.set(opts.cacheKey, { packData, objectCount: collected.length, deltaCount });
	}

	return packData;
}

/**
 * Streaming pack builder: enumerates objects lazily and streams undeltified
 * pack entries. Returns null when there are no objects to send.
 */
async function buildPackStreaming(
	opts: PackBuildOptions,
): Promise<AsyncIterable<Uint8Array> | null> {
	const { repo, wants, haves, includeTag, shallowBoundary, clientShallowBoundary } = opts;

	const { count, objects: walkObjects } = await enumerateObjects(
		repo,
		wants,
		haves,
		shallowBoundary,
		clientShallowBoundary,
	);

	if (count === 0) return null;

	const walkList: { hash: ObjectId; type: string }[] = [];
	for await (const obj of walkObjects) walkList.push(obj);

	const sentHashes = new Set(walkList.map((o) => o.hash));
	const extraTags = includeTag ? await collectIncludedTags(repo, sentHashes) : [];

	const totalCount = walkList.length + extraTags.length;
	async function* streamObjects(): AsyncGenerator<PackInput> {
		for (const obj of walkList) {
			const raw = await repo.objectStore.read(obj.hash);
			yield { type: raw.type, content: raw.content };
		}
		for (const tag of extraTags) {
			yield { type: tag.type, content: tag.content };
		}
	}

	return writePackStreaming(totalCount, streamObjects());
}

function asyncIterableToStream(iterable: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> {
	const iterator = iterable[Symbol.asyncIterator]();
	return new ReadableStream({
		async pull(controller) {
			const { value, done } = await iterator.next();
			if (done) controller.close();
			else controller.enqueue(value);
		},
	});
}

// ── Receive-pack (push handling) ────────────────────────────────────

async function ingestWithTracking(
	store: DeferrableObjectStore,
	batch: PendingObjectBatch,
): Promise<string[]> {
	return await store.commitPack(batch);
}

async function rollbackIngestedObjects(repo: GitRepo, hashes: string[]): Promise<void> {
	if (isDeferrableObjectStore(repo.objectStore)) {
		await repo.objectStore.deleteObjects(hashes);
	}
}

export interface ReceivePackResult {
	updates: RefUpdate[];
	unpackOk: boolean;
	capabilities: string[];
	/** Whether the request body contained a valid pkt-line flush packet. */
	sawFlush: boolean;
	/**
	 * Hashes of objects newly inserted for this repo partition while
	 * ingesting the pack. Used for rollback on all-failed hook paths.
	 * Only populated for deferrable server-backed stores.
	 */
	insertedHashes?: string[];
}

/**
 * Ingest a receive-pack request: parse commands, ingest the packfile,
 * and compute enriched RefUpdate objects. Does NOT apply ref updates —
 * call `applyReceivePack` to run hooks and apply refs.
 *
 * Objects are persisted immediately (needed by `buildRefUpdates` for
 * ancestry checks). `applyReceivePack` can roll back the newly inserted
 * objects if `preReceive` rejects the push or if later processing ends
 * with zero applied ref updates.
 */
export async function ingestReceivePack(
	repo: GitRepo,
	requestBody: Uint8Array,
	limits?: ReceivePackLimitOptions,
): Promise<ReceivePackResult> {
	const { commands, packData, capabilities, sawFlush } = parseReceivePackRequest(requestBody);

	let unpackOk = true;
	let insertedHashes: string[] | undefined;
	if (packData.byteLength > 0) {
		try {
			enforcePackLimits(packData, limits);
			if (isDeferrableObjectStore(repo.objectStore)) {
				const batch = await repo.objectStore.preparePack(packData);
				insertedHashes = await ingestWithTracking(repo.objectStore, batch);
			} else {
				await repo.objectStore.ingestPack(packData);
			}
		} catch (err) {
			if (err instanceof RequestLimitError) throw err;
			unpackOk = false;
		}
	}

	const updates = await buildRefUpdates(repo, commands, unpackOk);
	return { updates, unpackOk, capabilities, sawFlush, insertedHashes };
}

/**
 * Streaming variant of `ingestReceivePack`. Accepts pre-parsed push
 * commands and a raw pack byte stream. Uses `readPackStreaming` for
 * incremental consumption.
 *
 * The HTTP handler continues using `ingestReceivePack` (runtime buffers
 * POST bodies anyway). The SSH handler calls this directly after parsing
 * pkt-line commands.
 */
export async function ingestReceivePackFromStream(
	repo: GitRepo,
	commands: PushCommand[],
	capabilities: string[],
	packStream: AsyncIterable<Uint8Array>,
	sawFlush = true,
	limits?: ReceivePackLimitOptions,
): Promise<ReceivePackResult> {
	let unpackOk = true;
	let insertedHashes: string[] | undefined;
	const needsPack = commands.some((c) => c.newHash !== ZERO_HASH);
	if (needsPack) {
		try {
			const externalBase = async (hash: string) => {
				try {
					return await repo.objectStore.read(hash);
				} catch {
					return null;
				}
			};
			const entries = readPackStreaming(limitPackStream(packStream, limits), externalBase);
			if (isDeferrableObjectStore(repo.objectStore)) {
				const batch = await repo.objectStore.preparePackStream(entries);
				insertedHashes = await ingestWithTracking(repo.objectStore, batch);
			} else {
				await repo.objectStore.ingestPackStream(entries);
			}
		} catch (err) {
			if (err instanceof RequestLimitError) throw err;
			unpackOk = false;
		}
	}

	const updates = await buildRefUpdates(repo, commands, unpackOk);
	return { updates, unpackOk, capabilities, sawFlush, insertedHashes };
}

async function buildRefUpdates(
	repo: GitRepo,
	commands: PushCommand[],
	unpackOk: boolean,
): Promise<RefUpdate[]> {
	const updates: RefUpdate[] = [];
	for (const cmd of commands) {
		const isCreate = cmd.oldHash === ZERO_HASH;
		const isDelete = cmd.newHash === ZERO_HASH;

		if (isCreate) {
			updates.push({
				ref: cmd.refName,
				oldHash: null,
				newHash: cmd.newHash,
				isFF: false,
				isCreate: true,
				isDelete: false,
			});
		} else if (isDelete) {
			updates.push({
				ref: cmd.refName,
				oldHash: cmd.oldHash,
				newHash: cmd.newHash,
				isFF: false,
				isCreate: false,
				isDelete: true,
			});
		} else {
			let isFF = false;
			if (unpackOk) {
				try {
					isFF = await isAncestor(repo, cmd.oldHash, cmd.newHash);
				} catch {
					// Ancestry check failed; leave isFF false
				}
			}
			updates.push({
				ref: cmd.refName,
				oldHash: cmd.oldHash,
				newHash: cmd.newHash,
				isFF,
				isCreate: false,
				isDelete: false,
			});
		}
	}
	return updates;
}

// ── CAS ref application (no hooks) ──────────────────────────────────

/**
 * Apply ref updates with CAS protection only — no hooks.
 *
 * Validates ref format, checks object existence, and performs
 * `compareAndSwapRef` per ref. Used directly by in-process APIs
 * (`server.updateRefs`, `server.commit`) and internally by
 * {@link applyReceivePack} for the transport path.
 */
export async function applyCasRefUpdates(
	repo: GitRepo,
	updates: readonly RefUpdate[],
): Promise<RefUpdateResult> {
	const refResults: RefResult[] = [];
	const applied: RefUpdate[] = [];

	for (const update of updates) {
		if (update.ref === "HEAD") {
			refResults.push({ ref: update.ref, ok: false, error: "HEAD cannot be updated via push" });
			continue;
		}

		if (!update.isDelete && !checkRefFormat(update.ref)) {
			refResults.push({ ref: update.ref, ok: false, error: "invalid refname" });
			continue;
		}

		if (!update.isDelete) {
			const exists = await repo.objectStore.exists(update.newHash);
			if (!exists) {
				refResults.push({ ref: update.ref, ok: false, error: "missing objects" });
				continue;
			}
		}

		try {
			const expectedOld = update.isCreate ? null : update.oldHash;
			const newRef = update.isDelete ? null : { type: "direct" as const, hash: update.newHash };
			const ok = await repo.refStore.compareAndSwapRef(update.ref, expectedOld, newRef);
			if (!ok) {
				refResults.push({ ref: update.ref, ok: false, error: "failed to lock" });
				continue;
			}
			refResults.push({ ref: update.ref, ok: true });
			applied.push(update);
		} catch (err) {
			refResults.push({
				ref: update.ref,
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	return { refResults, applied };
}

// ── Receive-pack lifecycle (transport-agnostic) ─────────────────────

export interface ApplyReceivePackOptions<A = unknown> {
	repo: GitRepo;
	repoId: string;
	ingestResult: ReceivePackResult;
	hooks?: ServerHooks<A>;
	auth: A;
}

/**
 * Run the full receive-pack lifecycle: preReceive hook, per-ref update
 * hook with ref format validation, CAS ref application, optional
 * rollback when no refs are applied, and postReceive hook.
 * Transport-only — used by HTTP and SSH push handlers.
 *
 * Returns per-ref results and the list of successfully applied updates.
 * Does NOT handle unpack failures — the caller should check
 * `ingestResult.unpackOk` and short-circuit before calling this.
 */
export async function applyReceivePack<A = unknown>(
	options: ApplyReceivePackOptions<A>,
): Promise<RefUpdateResult> {
	const { repo, repoId, ingestResult, hooks, auth } = options;
	const { updates } = ingestResult;

	// Pre-receive hook: abort entire push on rejection
	if (hooks?.preReceive) {
		const result = await hooks.preReceive({ repo, repoId, updates, auth });
		if (isRejection(result)) {
			// Roll back ingested objects so rejected pushes leave no side effects
			if (ingestResult.insertedHashes?.length) {
				await rollbackIngestedObjects(repo, ingestResult.insertedHashes);
			}
			const msg = result.message ?? "pre-receive hook declined";
			return {
				refResults: updates.map((u) => ({ ref: u.ref, ok: false, error: msg })),
				applied: [],
			};
		}
	}

	// Per-ref: run update hook, then CAS
	const refResults: RefResult[] = [];
	const applied: RefUpdate[] = [];

	for (const update of updates) {
		if (update.ref === "HEAD") {
			refResults.push({ ref: update.ref, ok: false, error: "HEAD cannot be updated via push" });
			continue;
		}

		if (!update.isDelete && !checkRefFormat(update.ref)) {
			refResults.push({ ref: update.ref, ok: false, error: "invalid refname" });
			continue;
		}

		if (hooks?.update) {
			const result = await hooks.update({ repo, repoId, update, auth });
			if (isRejection(result)) {
				refResults.push({
					ref: update.ref,
					ok: false,
					error: result.message ?? "update hook declined",
				});
				continue;
			}
		}

		if (!update.isDelete) {
			const exists = await repo.objectStore.exists(update.newHash);
			if (!exists) {
				refResults.push({ ref: update.ref, ok: false, error: "missing objects" });
				continue;
			}
		}

		try {
			const expectedOld = update.isCreate ? null : update.oldHash;
			const newRef = update.isDelete ? null : { type: "direct" as const, hash: update.newHash };
			const ok = await repo.refStore.compareAndSwapRef(update.ref, expectedOld, newRef);
			if (!ok) {
				refResults.push({ ref: update.ref, ok: false, error: "failed to lock" });
				continue;
			}
			refResults.push({ ref: update.ref, ok: true });
			applied.push(update);
		} catch (err) {
			refResults.push({
				ref: update.ref,
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	// If the push ingested new objects but every ref later failed validation,
	// hook policy, or CAS, clean those new objects back out of the repo.
	if (applied.length === 0 && ingestResult.insertedHashes?.length) {
		await rollbackIngestedObjects(repo, ingestResult.insertedHashes);
	}

	// Post-receive hook (fire-and-forget, only for successful updates)
	if (hooks?.postReceive && applied.length > 0) {
		try {
			await hooks.postReceive({ repo, repoId, updates: applied, auth });
		} catch {
			// Post-receive errors don't affect the result
		}
	}

	return { refResults, applied };
}

// ── In-process ref updates ──────────────────────────────────────────

/**
 * Resolve `RefUpdateRequest[]` into fully computed `RefUpdate[]`.
 *
 * Reads current ref state when `oldHash` is not provided, and computes
 * `isFF`/`isCreate`/`isDelete` for each entry.
 */
export async function resolveRefUpdates(
	repo: GitRepo,
	requests: RefUpdateRequest[],
): Promise<RefUpdate[]> {
	const updates: RefUpdate[] = [];

	for (const req of requests) {
		const oldHash = req.oldHash !== undefined ? req.oldHash : await resolveRef(repo, req.ref);

		if (oldHash === null) {
			updates.push({
				ref: req.ref,
				oldHash: null,
				newHash: req.newHash ?? ZERO_HASH,
				isFF: false,
				isCreate: true,
				isDelete: false,
			});
		} else if (req.newHash === null) {
			updates.push({
				ref: req.ref,
				oldHash,
				newHash: ZERO_HASH,
				isFF: false,
				isCreate: false,
				isDelete: true,
			});
		} else {
			let isFF = false;
			try {
				isFF = await isAncestor(repo, oldHash, req.newHash);
			} catch {
				// Ancestry check failed; leave isFF false
			}
			updates.push({
				ref: req.ref,
				oldHash,
				newHash: req.newHash,
				isFF,
				isCreate: false,
				isDelete: false,
			});
		}
	}

	return updates;
}

// ══════════════════════════════════════════════════════════════════════
// Protocol v2 operations
// ══════════════════════════════════════════════════════════════════════

const V2_UPLOAD_PACK_CAPS = [
	"agent=just-git/1.0",
	"ls-refs=unborn",
	"fetch=shallow",
	"server-option",
	"object-format=sha1",
];

export function buildV2CapabilityAdvertisementBytes(): Uint8Array {
	return buildV2CapabilityAdvertisement(V2_UPLOAD_PACK_CAPS);
}

// ── V2 ls-refs ──────────────────────────────────────────────────────

/**
 * Handle a v2 `ls-refs` command. Collects refs, applies hook filtering,
 * then builds a v2 ls-refs response respecting the client's requested
 * attributes (symrefs, peel, ref-prefix, unborn).
 */
export async function handleLsRefs<A>(
	repo: GitRepo,
	repoId: string,
	args: string[],
	hooks: ServerHooks<A> | undefined,
	auth: A,
): Promise<Uint8Array | Rejection> {
	const wantSymrefs = args.includes("symrefs");
	const wantPeel = args.includes("peel");
	const wantUnborn = args.includes("unborn");
	const prefixes = args.filter((a) => a.startsWith("ref-prefix ")).map((a) => a.slice(11));

	const adv = await advertiseRefsWithHooks(repo, repoId, "git-upload-pack", hooks, auth);
	if (isRejection(adv)) return adv;

	const { refs: allRefs, headTarget } = adv;
	const result: V2LsRefsRef[] = [];

	for (const ref of allRefs) {
		if (ref.name.endsWith("^{}")) continue;
		if (prefixes.length > 0 && !prefixes.some((p) => ref.name.startsWith(p))) continue;

		const entry: V2LsRefsRef = { hash: ref.hash, name: ref.name };

		if (wantSymrefs && ref.name === "HEAD" && headTarget) {
			entry.symrefTarget = headTarget;
		}

		if (wantPeel && ref.name.startsWith("refs/tags/")) {
			const peeled = allRefs.find((r) => r.name === `${ref.name}^{}`);
			if (peeled) entry.peeledHash = peeled.hash;
		}

		result.push(entry);
	}

	if (wantUnborn && !result.some((r) => r.name === "HEAD") && headTarget) {
		const matchesPrefix = prefixes.length === 0 || prefixes.some((p) => "HEAD".startsWith(p));
		if (matchesPrefix) {
			result.unshift({ hash: "unborn", name: "HEAD", symrefTarget: headTarget });
		}
	}

	return buildV2LsRefsResponse(result);
}

// ── V2 fetch ────────────────────────────────────────────────────────

/**
 * Handle a v2 `fetch` command. Parses fetch args, performs object
 * enumeration and pack building via the shared pipeline, then
 * builds a v2 section-based response.
 */
export async function handleV2Fetch(
	repo: GitRepo,
	args: string[],
	options?: UploadPackOptions & { authorizedFetchSet?: AuthorizedFetchSet },
): Promise<Uint8Array | ReadableStream<Uint8Array> | Rejection> {
	const { wants, haves, done, clientShallows, depth, includeTag, wantRefs } =
		parseV2FetchArgs(args);

	if (wants.length === 0 && wantRefs.length === 0) {
		const { data: emptyPack } = await writePackDeltified([]);
		return buildV2FetchResponse(emptyPack);
	}

	const authz = options?.authorizedFetchSet;

	const resolvedWantRefs: Array<{ hash: string; name: string }> = [];
	const allWants = [...wants];
	for (const refName of wantRefs) {
		if (authz) {
			const hash = authz.allowedRefHashes.get(refName);
			if (!hash) {
				return { reject: true, message: `forbidden want-ref ${refName}` };
			}
			resolvedWantRefs.push({ hash, name: refName });
			if (!allWants.includes(hash)) allWants.push(hash);
		} else {
			const hash = await resolveRef(repo, refName);
			if (hash) {
				resolvedWantRefs.push({ hash, name: refName });
				if (!allWants.includes(hash)) allWants.push(hash);
			}
		}
	}
	if (authz) {
		for (const want of wants) {
			if (!authz.allowedWantHashes.has(want)) {
				return { reject: true, message: `forbidden want ${want}` };
			}
		}
	}

	let shallowInfo: ShallowUpdate | undefined;
	let shallowBoundary: Set<ObjectId> | undefined;
	let clientShallowSet: Set<ObjectId> | undefined;

	if (clientShallows.length > 0) {
		clientShallowSet = new Set(clientShallows);
	}

	if (depth !== undefined) {
		const boundary = await computeShallowBoundary(
			repo,
			allWants,
			depth,
			clientShallowSet ?? new Set(),
		);
		shallowInfo = boundary;
		shallowBoundary = new Set(boundary.shallow);
	}

	let commonHashes: string[] | undefined;
	if (haves.length > 0) {
		commonHashes = [];
		for (const hash of haves) {
			if (await repo.objectStore.exists(hash)) commonHashes.push(hash);
		}
		if (commonHashes.length === 0) commonHashes = undefined;
	}

	// Without "wait-for-done", when the server has common objects it must
	// send "ready" + packfile in a single response. Only send ack-only
	// (without ready) when we have NO common objects and need more haves.
	const hasCommon = commonHashes && commonHashes.length > 0;
	if (!done && !hasCommon) {
		return buildV2FetchAcknowledgments(commonHashes ?? []);
	}

	const cacheKey =
		!shallowBoundary && options?.cache && options.cacheKey
			? PackCache.key(options.cacheKey, allWants, haves)
			: null;

	const v2ResponseOpts: V2FetchResponseOptions = {
		commonHashes,
		shallowInfo,
		wantedRefs: resolvedWantRefs.length > 0 ? resolvedWantRefs : undefined,
	};

	if (cacheKey && options?.cache) {
		const cached = options.cache.get(cacheKey);
		if (cached) return buildV2FetchResponse(cached.packData, v2ResponseOpts);
	}

	const packOpts: PackBuildOptions = {
		repo,
		wants: allWants,
		haves,
		includeTag,
		shallowBoundary,
		clientShallowBoundary: clientShallowSet,
		cache: options?.cache,
		cacheKey,
		deltaWindow: options?.deltaWindow,
	};

	if (options?.noDelta) {
		const packChunks = await buildPackStreaming(packOpts);
		if (!packChunks) {
			const { data: emptyPack } = await writePackDeltified([]);
			return buildV2FetchResponse(emptyPack, v2ResponseOpts);
		}
		return asyncIterableToStream(buildV2FetchResponseStreaming(packChunks, v2ResponseOpts));
	}

	const packData = await buildPackBuffered(packOpts);
	return buildV2FetchResponse(packData, v2ResponseOpts);
}

function enforcePackLimits(packData: Uint8Array, limits?: ReceivePackLimitOptions): void {
	if (!limits) return;
	if (limits.maxPackBytes !== undefined && packData.byteLength > limits.maxPackBytes) {
		throw new RequestLimitError("Pack payload too large");
	}
	if (limits.maxPackObjects !== undefined && packData.byteLength >= 12) {
		const view = new DataView(packData.buffer, packData.byteOffset, packData.byteLength);
		const count = view.getUint32(8);
		if (count > limits.maxPackObjects) {
			throw new RequestLimitError("Pack contains too many objects");
		}
	}
}

async function* limitPackStream(
	packStream: AsyncIterable<Uint8Array>,
	limits?: ReceivePackLimitOptions,
): AsyncGenerator<Uint8Array> {
	if (!limits) {
		for await (const chunk of packStream) yield chunk;
		return;
	}

	let totalBytes = 0;
	const header = new Uint8Array(12);
	let headerLen = 0;

	for await (const chunk of packStream) {
		totalBytes += chunk.byteLength;
		if (limits.maxPackBytes !== undefined && totalBytes > limits.maxPackBytes) {
			throw new RequestLimitError("Pack payload too large");
		}

		if (headerLen < 12) {
			const copyLen = Math.min(12 - headerLen, chunk.byteLength);
			header.set(chunk.subarray(0, copyLen), headerLen);
			headerLen += copyLen;
			if (headerLen === 12 && limits.maxPackObjects !== undefined) {
				const count = new DataView(header.buffer).getUint32(8);
				if (count > limits.maxPackObjects) {
					throw new RequestLimitError("Pack contains too many objects");
				}
			}
		}

		yield chunk;
	}
}
