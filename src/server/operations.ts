/**
 * High-level server operations for Git Smart HTTP.
 *
 * Each operation accepts a `GitRepo` (ObjectStore + RefStore)
 * and returns protocol-level results. The handler layer is
 * responsible for hook invocation and ref application.
 */

import { ZERO_HASH } from "../lib/hex.ts";
import { isAncestor } from "../lib/merge.ts";
import { parseTag } from "../lib/objects/tag.ts";
import { findBestDeltas } from "../lib/pack/delta.ts";
import type { DeltaPackInput, PackInput } from "../lib/pack/packfile.ts";
import { writePackDeltified, writePackStreaming } from "../lib/pack/packfile.ts";
import {
	collectEnumeration,
	enumerateObjects,
	enumerateObjectsWithContent,
	type WalkObjectWithContent,
} from "../lib/transport/object-walk.ts";
import type { GitRepo, ObjectId } from "../lib/types.ts";
import {
	type AdvertisedRef,
	buildRefAdvertisement,
	buildUploadPackResponse,
	buildUploadPackResponseStreaming,
	parseReceivePackRequest,
	parseUploadPackRequest,
} from "./protocol.ts";
import type { RefAdvertisement, RefUpdate } from "./types.ts";

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
];

const RECEIVE_PACK_CAPS = ["report-status", "side-band-64k", "ofs-delta", "delete-refs"];

// ── Ref advertisement ───────────────────────────────────────────────

export interface RefsData {
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

	if (headHash) {
		refs.push({ name: "HEAD", hash: headHash });
	}

	for (const entry of refEntries) {
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

/**
 * Build the wire-format ref advertisement from a (possibly filtered) ref list.
 */
export function buildRefAdvertisementBytes(
	refs: RefAdvertisement[],
	service: "git-upload-pack" | "git-receive-pack",
	headTarget?: string,
): Uint8Array {
	const caps = service === "git-upload-pack" ? UPLOAD_PACK_CAPS : RECEIVE_PACK_CAPS;
	return buildRefAdvertisement(refs as AdvertisedRef[], service, caps, headTarget);
}

// ── Upload-pack (fetch/clone serving) ───────────────────────────────

export interface UploadPackOptions {
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
	const t0 = performance.now();
	const { wants, haves, capabilities } = parseUploadPackRequest(requestBody);

	if (wants.length === 0) {
		return buildUploadPackResponse(new Uint8Array(0), false);
	}

	const useMultiAck = capabilities.includes("multi_ack_detailed");
	const useSideband = capabilities.includes("side-band-64k");

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

	// Check pack cache (only for full clones — no haves)
	const cacheKey =
		options?.cache && options.cacheKey ? PackCache.key(options.cacheKey, wants, haves) : null;

	if (cacheKey && options?.cache) {
		const cached = options.cache.get(cacheKey);
		if (cached) {
			console.log(
				`  [upload-pack] cache hit: ${cached.objectCount} objects, ${(cached.packData.byteLength / 1024).toFixed(0)} KB pack | ${(performance.now() - t0).toFixed(0)}ms`,
			);
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
			t0,
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
		t0,
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
	t0: number,
): Promise<ReadableStream<Uint8Array>> {
	const tEnum0 = performance.now();

	// Lightweight enumeration: hash + type only, no content read yet
	const { count, objects: walkObjects } = await enumerateObjects(repo, wants, haves);

	if (count === 0) {
		const empty = buildUploadPackResponse(new Uint8Array(0), useSideband, commonHashes);
		return new ReadableStream({
			start(controller) {
				controller.enqueue(empty);
				controller.close();
			},
		});
	}

	// Collect the walk results (cheap — just hash+type structs)
	const walkList: { hash: ObjectId; type: string }[] = [];
	for await (const obj of walkObjects) walkList.push(obj);
	const tEnum1 = performance.now();

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
	console.log(
		`  [upload-pack] streaming ${totalCount} objects (no deltas) | enumerate ${(tEnum1 - tEnum0).toFixed(0)}ms, setup ${(performance.now() - t0).toFixed(0)}ms`,
	);

	// Build a lazy iterable that reads content on demand
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
	const responseChunks = buildUploadPackResponseStreaming(packChunks, useSideband, commonHashes);

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
	t0: number,
): Promise<Uint8Array> {
	const tEnum0 = performance.now();
	const enumResult = await enumerateObjectsWithContent(repo, wants, haves);

	if (enumResult.count === 0) {
		return buildUploadPackResponse(new Uint8Array(0), useSideband, commonHashes);
	}

	const collected: WalkObjectWithContent[] = await collectEnumeration(enumResult);
	const tEnum1 = performance.now();

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

	const tDelta0 = performance.now();
	const windowOpt = options?.deltaWindow ? { window: options.deltaWindow } : undefined;
	const deltas = findBestDeltas(collected, windowOpt);
	const tDelta1 = performance.now();

	const inputs: DeltaPackInput[] = deltas.map((r) => ({
		hash: r.hash,
		type: r.type,
		content: r.content,
		delta: r.delta,
		deltaBaseHash: r.deltaBase,
	}));

	const tPack0 = performance.now();
	const { data: packData } = await writePackDeltified(inputs);
	const tPack1 = performance.now();

	const totalBytes = collected.reduce((s, o) => s + o.content.byteLength, 0);
	const deltaCount = deltas.filter((d) => d.delta).length;
	console.log(
		`  [upload-pack] ${collected.length} objects (${(totalBytes / 1024).toFixed(0)} KB raw, ${deltaCount} deltas) → ${(packData.byteLength / 1024).toFixed(0)} KB pack | enumerate ${(tEnum1 - tEnum0).toFixed(0)}ms, delta ${(tDelta1 - tDelta0).toFixed(0)}ms, pack ${(tPack1 - tPack0).toFixed(0)}ms, total ${(tPack1 - t0).toFixed(0)}ms`,
	);

	if (cacheKey && options?.cache) {
		options.cache.set(cacheKey, { packData, objectCount: collected.length, deltaCount });
	}

	return buildUploadPackResponse(packData, useSideband, commonHashes);
}

// ── Receive-pack (push handling) ────────────────────────────────────

export interface ReceivePackResult {
	updates: RefUpdate[];
	unpackOk: boolean;
	capabilities: string[];
}

/**
 * Ingest a receive-pack request: parse commands, ingest the packfile,
 * and compute enriched RefUpdate objects. Does NOT apply ref updates —
 * the handler runs hooks first, then applies surviving updates.
 */
export async function ingestReceivePack(
	repo: GitRepo,
	requestBody: Uint8Array,
): Promise<ReceivePackResult> {
	const t0 = performance.now();
	const { commands, packData, capabilities } = parseReceivePackRequest(requestBody);

	let unpackOk = true;
	let objectCount = 0;
	if (packData.byteLength > 0) {
		try {
			const tIngest0 = performance.now();
			objectCount = await repo.objectStore.ingestPack(packData);
			const tIngest1 = performance.now();
			console.log(
				`  [receive-pack] ingested ${objectCount} objects from ${(packData.byteLength / 1024).toFixed(0)} KB pack in ${(tIngest1 - tIngest0).toFixed(0)}ms`,
			);
		} catch (e) {
			console.log(`  [receive-pack] ingest failed: ${e instanceof Error ? e.message : e}`);
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

	const t1 = performance.now();
	console.log(`  [receive-pack] ${commands.length} ref(s), total ${(t1 - t0).toFixed(0)}ms`);

	return { updates, unpackOk, capabilities };
}
