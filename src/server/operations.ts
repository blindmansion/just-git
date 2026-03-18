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
import type { DeltaPackInput } from "../lib/pack/packfile.ts";
import { writePackDeltified } from "../lib/pack/packfile.ts";
import {
	collectEnumeration,
	enumerateObjectsWithContent,
	type WalkObjectWithContent,
} from "../lib/transport/object-walk.ts";
import type { GitRepo } from "../lib/types.ts";
import {
	type AdvertisedRef,
	buildRefAdvertisement,
	buildUploadPackResponse,
	parseReceivePackRequest,
	parseUploadPackRequest,
} from "./protocol.ts";
import type { RefAdvertisement, RefUpdate } from "./types.ts";

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

/**
 * Handle a `POST /git-upload-pack` request.
 * Parses wants/haves, enumerates objects, builds a packfile, returns the response.
 */
export async function handleUploadPack(
	repo: GitRepo,
	requestBody: Uint8Array,
): Promise<Uint8Array> {
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

	const enumResult = await enumerateObjectsWithContent(repo, wants, haves);

	if (enumResult.count === 0) {
		return buildUploadPackResponse(new Uint8Array(0), useSideband, commonHashes);
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
						const tagHash = tagRef.hash;
						collected.push({ hash: tagHash, type: "tag", content: obj.content });
						sentHashes.add(tagHash);
					}
				}
			} catch {
				// Tag object missing or unreadable; skip
			}
		}
	}

	const deltas = findBestDeltas(collected);
	const inputs: DeltaPackInput[] = deltas.map((r) => ({
		hash: r.hash,
		type: r.type,
		content: r.content,
		delta: r.delta,
		deltaBaseHash: r.deltaBase,
	}));

	const { data: packData } = await writePackDeltified(inputs);

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
	const { commands, packData, capabilities } = parseReceivePackRequest(requestBody);

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

	return { updates, unpackOk, capabilities };
}
