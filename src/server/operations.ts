/**
 * High-level server operations for Git Smart HTTP.
 *
 * Each operation accepts a `ServerRepoContext` (ObjectStore + RefStore)
 * and returns the appropriate protocol response body.
 */

import type { FileSystem } from "../fs.ts";
import { ZERO_HASH } from "../lib/hex.ts";
import { isAncestor } from "../lib/merge.ts";
import { readObject } from "../lib/object-db.ts";
import type { PackInput } from "../lib/pack/packfile.ts";
import { writePack } from "../lib/pack/packfile.ts";
import { enumerateObjectsWithContent } from "../lib/transport/object-walk.ts";
import type { GitContext } from "../lib/types.ts";
import {
	type AdvertisedRef,
	buildRefAdvertisement,
	buildReportStatus,
	buildUploadPackResponse,
	parseReceivePackRequest,
	parseUploadPackRequest,
} from "./protocol.ts";
import type { RefUpdate, ServerRepoContext } from "./types.ts";

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
	repo: ServerRepoContext,
	service: "git-upload-pack" | "git-receive-pack",
): Promise<Uint8Array> {
	const refEntries = await repo.refs.listRefs("refs");
	const headRef = await repo.refs.readRef("HEAD");

	const refs: AdvertisedRef[] = [];

	// Resolve HEAD
	let headHash: string | null = null;
	let headTarget: string | undefined;

	if (headRef) {
		if (headRef.type === "symbolic") {
			headTarget = headRef.target;
			// Resolve the symref to get the hash
			const targetRef = await repo.refs.readRef(headRef.target);
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
	repo: ServerRepoContext,
	requestBody: Uint8Array,
): Promise<Uint8Array> {
	const { wants, haves, capabilities } = parseUploadPackRequest(requestBody);

	if (wants.length === 0) {
		return buildUploadPackResponse(new Uint8Array(0), false);
	}

	const ctx = toGitContext(repo);
	const objects = await enumerateObjectsWithContent(ctx, wants, haves);

	if (objects.length === 0) {
		return buildUploadPackResponse(new Uint8Array(0), capabilities.includes("side-band-64k"));
	}

	const packInputs: PackInput[] = objects.map((obj) => ({
		type: obj.type,
		content: obj.content,
	}));

	const packData = await writePack(packInputs);
	const useSideband = capabilities.includes("side-band-64k");

	return buildUploadPackResponse(packData, useSideband);
}

// ── Receive-pack (push handling) ────────────────────────────────────

/**
 * Handle a `POST /git-receive-pack` request.
 * Parses commands + packfile, ingests objects, validates and applies ref updates.
 */
export async function handleReceivePack(
	repo: ServerRepoContext,
	requestBody: Uint8Array,
): Promise<{ response: Uint8Array; refUpdates: RefUpdate[] }> {
	const { commands, packData, capabilities } = parseReceivePackRequest(requestBody);

	const useSideband = capabilities.includes("side-band-64k");
	const useReportStatus = capabilities.includes("report-status");

	// Ingest the pack data
	let unpackOk = true;
	if (packData.byteLength > 0) {
		try {
			await repo.objects.ingestPack(packData);
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

	const ctx = toGitContext(repo);
	const refUpdates: RefUpdate[] = [];

	for (const cmd of commands) {
		try {
			if (cmd.newHash === ZERO_HASH) {
				// Delete ref
				await repo.refs.deleteRef(cmd.refName);
				refUpdates.push({
					name: cmd.refName,
					oldHash: cmd.oldHash,
					newHash: cmd.newHash,
					ok: true,
				});
				continue;
			}

			// Non-delete: validate fast-forward if old hash is non-zero
			if (cmd.oldHash !== ZERO_HASH) {
				const ff = await isAncestor(ctx, cmd.oldHash, cmd.newHash);
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

			await repo.refs.writeRef(cmd.refName, { type: "direct", hash: cmd.newHash });
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

// ── Internal helpers ────────────────────────────────────────────────

const STUB_FS = new Proxy({} as FileSystem, {
	get(_, prop) {
		return () => {
			throw new Error(`FileSystem.${String(prop)} is not available in server context`);
		};
	},
});

/**
 * Create a minimal GitContext from a ServerRepoContext.
 * The stub FS is never accessed -- all operations route through
 * the objectStore and refStore.
 */
function toGitContext(repo: ServerRepoContext): GitContext {
	return {
		fs: STUB_FS,
		gitDir: "/.git",
		workTree: null,
		objectStore: repo.objects,
		refStore: repo.refs,
	};
}
