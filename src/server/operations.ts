/**
 * High-level server operations for Git Smart HTTP.
 *
 * Each operation accepts a `GitRepo` (ObjectStore + RefStore)
 * and returns the appropriate protocol response body.
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
	buildReportStatus,
	buildUploadPackResponse,
	parseReceivePackRequest,
	parseUploadPackRequest,
} from "./protocol.ts";
import type { RefUpdate } from "./types.ts";

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

/**
 * Build the full ref advertisement response body for info/refs.
 */
export async function advertiseRefs(
	repo: GitRepo,
	service: "git-upload-pack" | "git-receive-pack",
): Promise<Uint8Array> {
	const refEntries = await repo.refStore.listRefs("refs");
	const headRef = await repo.refStore.readRef("HEAD");

	const refs: AdvertisedRef[] = [];

	// Resolve HEAD
	let headHash: string | null = null;
	let headTarget: string | undefined;

	if (headRef) {
		if (headRef.type === "symbolic") {
			headTarget = headRef.target;
			// Resolve the symref to get the hash
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

	const caps = service === "git-upload-pack" ? UPLOAD_PACK_CAPS : RECEIVE_PACK_CAPS;

	return buildRefAdvertisement(refs, service, caps, headTarget);
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

/**
 * Handle a `POST /git-receive-pack` request.
 * Parses commands + packfile, ingests objects, validates and applies ref updates.
 */
export async function handleReceivePack(
	repo: GitRepo,
	requestBody: Uint8Array,
	options?: { denyNonFastForwards?: boolean },
): Promise<{ response: Uint8Array; refUpdates: RefUpdate[] }> {
	const { commands, packData, capabilities } = parseReceivePackRequest(requestBody);

	const useSideband = capabilities.includes("side-band-64k");
	const useReportStatus = capabilities.includes("report-status");

	// Ingest the pack data
	let unpackOk = true;
	if (packData.byteLength > 0) {
		try {
			await repo.objectStore.ingestPack(packData);
		} catch {
			unpackOk = false;
			if (useReportStatus) {
				const refResults = commands.map((cmd) => ({
					name: cmd.refName,
					ok: false,
					error: "unpack failed",
				}));
				const response = buildReportStatus(false, refResults, useSideband);
				const refUpdates: RefUpdate[] = commands.map((cmd) => ({
					name: cmd.refName,
					oldHash: cmd.oldHash,
					newHash: cmd.newHash,
					ok: false,
					error: "unpack failed",
				}));
				return { response, refUpdates };
			}
			return { response: new Uint8Array(0), refUpdates: [] };
		}
	}

	const refUpdates: RefUpdate[] = [];

	for (const cmd of commands) {
		try {
			if (cmd.newHash === ZERO_HASH) {
				// Delete ref
				await repo.refStore.deleteRef(cmd.refName);
				refUpdates.push({
					name: cmd.refName,
					oldHash: cmd.oldHash,
					newHash: cmd.newHash,
					ok: true,
				});
				continue;
			}

			if (options?.denyNonFastForwards && cmd.oldHash !== ZERO_HASH) {
				const ff = await isAncestor(repo, cmd.oldHash, cmd.newHash);
				if (!ff) {
					refUpdates.push({
						name: cmd.refName,
						oldHash: cmd.oldHash,
						newHash: cmd.newHash,
						ok: false,
						error: "non-fast-forward",
					});
					continue;
				}
			}

			await repo.refStore.writeRef(cmd.refName, { type: "direct", hash: cmd.newHash });
			refUpdates.push({
				name: cmd.refName,
				oldHash: cmd.oldHash,
				newHash: cmd.newHash,
				ok: true,
			});
		} catch (err) {
			refUpdates.push({
				name: cmd.refName,
				oldHash: cmd.oldHash,
				newHash: cmd.newHash,
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	if (useReportStatus) {
		const refResults = refUpdates.map((u) => ({
			name: u.name,
			ok: u.ok,
			error: u.error,
		}));
		const response = buildReportStatus(unpackOk, refResults, useSideband);
		return { response, refUpdates };
	}

	return { response: new Uint8Array(0), refUpdates };
}
