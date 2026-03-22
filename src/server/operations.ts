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
import { parseTag } from "../lib/objects/tag.ts";
import { findBestDeltas } from "../lib/pack/delta.ts";
import type { DeltaPackInput, PackInput } from "../lib/pack/packfile.ts";
import { writePackDeltified, writePackStreaming } from "../lib/pack/packfile.ts";
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
	buildRefAdvertisement,
	buildRefListPktLines,
	buildShallowOnlyResponse,
	buildUploadPackResponse,
	buildUploadPackResponseStreaming,
	parseReceivePackRequest,
	parseUploadPackRequest,
} from "./protocol.ts";
import type { RefAdvertisement, RefUpdate, ServerHooks } from "./types.ts";

// ── Pack cache ──────────────────────────────────────────────────────

interface PackCacheEntry {
	packData: Uint8Array;
	objectCount: number;
	deltaCount: number;
}

/**
 * Bounded LRU-ish cache for generated packfiles.
 *
 * Keyed on `(repoPath, sorted wants)` — only caches full clones
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
	static key(repoPath: string, wants: string[], haves: string[]): string | null {
		if (haves.length > 0) return null;
		const sorted = wants.slice().sort();
		return `${repoPath}\0${sorted.join(",")}`;
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
	"allow-reachable-sha1-in-want",
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

/**
 * Handle a `POST /git-upload-pack` request.
 *
 * Returns `Uint8Array` for buffered responses (cache hits, deltified packs)
 * or `ReadableStream<Uint8Array>` for streaming no-delta responses.
 */
export async function handleUploadPack(
	repo: GitRepo,
	requestBody: Uint8Array,
	options?: UploadPackOptions,
): Promise<Uint8Array | ReadableStream<Uint8Array>> {
	const { wants, haves, capabilities, clientShallows, depth, done } =
		parseUploadPackRequest(requestBody);

	if (wants.length === 0) {
		return buildUploadPackResponse(new Uint8Array(0), false);
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

	if (options?.noDelta) {
		return handleUploadPackStreaming(
			repo,
			wants,
			haves,
			capabilities,
			useSideband,
			commonHashes,
			shallowInfo,
			shallowBoundary,
			clientShallowSet,
		);
	}

	return handleUploadPackBuffered(
		repo,
		wants,
		haves,
		capabilities,
		useSideband,
		commonHashes,
		options,
		cacheKey,
		shallowInfo,
		shallowBoundary,
		clientShallowSet,
	);
}

/**
 * Streaming upload-pack: enumerates objects, reads content lazily, and
 * streams undeltified pack entries to the client as they're produced.
 */
async function handleUploadPackStreaming(
	repo: GitRepo,
	wants: string[],
	haves: string[],
	capabilities: string[],
	useSideband: boolean,
	commonHashes: string[] | undefined,
	shallowInfo?: ShallowUpdate,
	shallowBoundary?: Set<ObjectId>,
	clientShallowBoundary?: Set<ObjectId>,
): Promise<ReadableStream<Uint8Array>> {
	const { count, objects: walkObjects } = await enumerateObjects(
		repo,
		wants,
		haves,
		shallowBoundary,
		clientShallowBoundary,
	);

	if (count === 0) {
		const { data: emptyPack } = await writePackDeltified([]);
		const empty = buildUploadPackResponse(emptyPack, useSideband, commonHashes, shallowInfo);
		return new ReadableStream({
			start(controller) {
				controller.enqueue(empty);
				controller.close();
			},
		});
	}

	const walkList: { hash: ObjectId; type: string }[] = [];
	for await (const obj of walkObjects) walkList.push(obj);

	// include-tag: find tag objects whose targets are in the pack
	const sentHashes = new Set(walkList.map((o) => o.hash));
	const extraTags: WalkObjectWithContent[] = [];

	if (capabilities.includes("include-tag")) {
		const tagRefs = await repo.refStore.listRefs("refs/tags");
		for (const tagRef of tagRefs) {
			if (sentHashes.has(tagRef.hash)) continue;
			try {
				const obj = await repo.objectStore.read(tagRef.hash);
				if (obj.type === "tag") {
					const tag = parseTag(obj.content);
					if (sentHashes.has(tag.object)) {
						extraTags.push({ hash: tagRef.hash, type: "tag", content: obj.content });
					}
				}
			} catch {
				// Tag object missing or unreadable; skip
			}
		}
	}

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

	const packChunks = writePackStreaming(totalCount, streamObjects());
	const responseChunks = buildUploadPackResponseStreaming(
		packChunks,
		useSideband,
		commonHashes,
		shallowInfo,
	);

	return new ReadableStream({
		async pull(controller) {
			const { value, done } = await responseChunks.next();
			if (done) {
				controller.close();
			} else {
				controller.enqueue(value);
			}
		},
	});
}

/**
 * Buffered upload-pack: collects all objects, computes deltas (unless noDelta),
 * and returns the full response as a Uint8Array.
 */
async function handleUploadPackBuffered(
	repo: GitRepo,
	wants: string[],
	haves: string[],
	capabilities: string[],
	useSideband: boolean,
	commonHashes: string[] | undefined,
	options: UploadPackOptions | undefined,
	cacheKey: string | null,
	shallowInfo?: ShallowUpdate,
	shallowBoundary?: Set<ObjectId>,
	clientShallowBoundary?: Set<ObjectId>,
): Promise<Uint8Array> {
	const enumResult = await enumerateObjectsWithContent(
		repo,
		wants,
		haves,
		shallowBoundary,
		clientShallowBoundary,
	);

	if (enumResult.count === 0) {
		const { data: emptyPack } = await writePackDeltified([]);
		return buildUploadPackResponse(emptyPack, useSideband, commonHashes, shallowInfo);
	}

	const collected: WalkObjectWithContent[] = await collectEnumeration(enumResult);

	const sentHashes = new Set(collected.map((o) => o.hash));

	if (capabilities.includes("include-tag")) {
		const tagRefs = await repo.refStore.listRefs("refs/tags");
		for (const tagRef of tagRefs) {
			if (sentHashes.has(tagRef.hash)) continue;
			try {
				const obj = await repo.objectStore.read(tagRef.hash);
				if (obj.type === "tag") {
					const tag = parseTag(obj.content);
					if (sentHashes.has(tag.object)) {
						collected.push({ hash: tagRef.hash, type: "tag", content: obj.content });
						sentHashes.add(tagRef.hash);
					}
				}
			} catch {
				// Tag object missing or unreadable; skip
			}
		}
	}

	const windowOpt = options?.deltaWindow ? { window: options.deltaWindow } : undefined;
	const deltas = findBestDeltas(collected, windowOpt);

	const inputs: DeltaPackInput[] = deltas.map((r) => ({
		hash: r.hash,
		type: r.type,
		content: r.content,
		delta: r.delta,
		deltaBaseHash: r.deltaBase,
	}));

	const { data: packData } = await writePackDeltified(inputs);

	if (cacheKey && options?.cache) {
		const deltaCount = deltas.filter((d) => d.delta).length;
		options.cache.set(cacheKey, { packData, objectCount: collected.length, deltaCount });
	}

	return buildUploadPackResponse(packData, useSideband, commonHashes, shallowInfo);
}

// ── Receive-pack (push handling) ────────────────────────────────────

export interface ReceivePackResult {
	updates: RefUpdate[];
	unpackOk: boolean;
	capabilities: string[];
	/** Whether the request body contained a valid pkt-line flush packet. */
	sawFlush: boolean;
}

/**
 * Ingest a receive-pack request: parse commands, ingest the packfile,
 * and compute enriched RefUpdate objects. Does NOT apply ref updates —
 * call `applyReceivePack` to run hooks and apply refs.
 */
export async function ingestReceivePack(
	repo: GitRepo,
	requestBody: Uint8Array,
): Promise<ReceivePackResult> {
	const { commands, packData, capabilities, sawFlush } = parseReceivePackRequest(requestBody);

	let unpackOk = true;
	if (packData.byteLength > 0) {
		try {
			await repo.objectStore.ingestPack(packData);
		} catch {
			unpackOk = false;
		}
	}

	const updates: RefUpdate[] = [];
	for (const cmd of commands) {
		const isCreate = cmd.oldHash === ZERO_HASH;
		const isDelete = cmd.newHash === ZERO_HASH;
		let isFF = false;

		if (!isCreate && !isDelete && unpackOk) {
			try {
				isFF = await isAncestor(repo, cmd.oldHash, cmd.newHash);
			} catch {
				// Ancestry check failed; leave isFF false
			}
		}

		updates.push({
			ref: cmd.refName,
			oldHash: isCreate ? null : cmd.oldHash,
			newHash: cmd.newHash,
			isFF,
			isCreate,
			isDelete,
		});
	}

	return { updates, unpackOk, capabilities, sawFlush };
}

// ── Receive-pack lifecycle (transport-agnostic) ─────────────────────

export interface ApplyReceivePackOptions {
	repo: GitRepo;
	repoPath: string;
	ingestResult: ReceivePackResult;
	hooks?: ServerHooks;
	/** Present when the push arrives over HTTP. */
	request?: Request;
}

export interface RefResult {
	ref: string;
	ok: boolean;
	error?: string;
}

export interface ApplyReceivePackResult {
	refResults: RefResult[];
	applied: RefUpdate[];
}

/**
 * Run the full receive-pack lifecycle: preReceive hook, per-ref update
 * hook with ref format validation, CAS ref application, and postReceive
 * hook. Transport-agnostic — works for HTTP, SSH, or in-process pushes.
 *
 * Returns per-ref results and the list of successfully applied updates.
 * Does NOT handle unpack failures — the caller should check
 * `ingestResult.unpackOk` and short-circuit before calling this.
 */
export async function applyReceivePack(
	options: ApplyReceivePackOptions,
): Promise<ApplyReceivePackResult> {
	const { repo, repoPath, ingestResult, hooks, request } = options;
	const { updates } = ingestResult;

	// Pre-receive hook: abort entire push on rejection
	if (hooks?.preReceive) {
		const result = await hooks.preReceive({ repo, repoPath, updates, request });
		if (isRejection(result)) {
			const msg = result.message ?? "pre-receive hook declined";
			return {
				refResults: updates.map((u) => ({ ref: u.ref, ok: false, error: msg })),
				applied: [],
			};
		}
	}

	// Per-ref update hook + ref application
	const refResults: RefResult[] = [];
	const applied: RefUpdate[] = [];

	for (const update of updates) {
		if (!update.isDelete && !checkRefFormat(update.ref)) {
			refResults.push({ ref: update.ref, ok: false, error: "invalid refname" });
			continue;
		}

		if (hooks?.update) {
			const result = await hooks.update({ repo, repoPath, update, request });
			if (isRejection(result)) {
				refResults.push({
					ref: update.ref,
					ok: false,
					error: result.message ?? "update hook declined",
				});
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

	// Post-receive hook (fire-and-forget, only for successful updates)
	if (hooks?.postReceive && applied.length > 0) {
		try {
			await hooks.postReceive({ repo, repoPath, updates: applied, request });
		} catch {
			// Post-receive errors don't affect the result
		}
	}

	return { refResults, applied };
}
