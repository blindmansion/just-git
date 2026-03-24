/**
 * Server-side Git protocol helpers.
 *
 * Transport-agnostic ref advertisement, upload-pack response building,
 * and receive-pack request/response parsing. The HTTP-specific service
 * header wrapping is layered on top of the shared ref list builder.
 */

import {
	concatPktLines,
	delimPkt,
	encodePktLine,
	flushPkt,
	parsePktLineStream,
	pktLineText,
} from "../lib/transport/pkt-line.ts";
import type { ShallowUpdate } from "../lib/shallow.ts";

const SIDEBAND_MAX_PAYLOAD = 65520 - 4 - 1; // pkt-line max (65520) minus 4-byte header minus 1-byte band = 65515

// ── Ref advertisement ───────────────────────────────────────────────

export interface AdvertisedRef {
	name: string;
	hash: string;
}

/**
 * Build the pkt-line ref list with capabilities. Transport-agnostic —
 * used directly by SSH/in-process transports and wrapped by
 * `buildRefAdvertisement` for HTTP.
 *
 * Format:
 *   pkt-line("<hash> <refname>\0<capabilities>\n")  // first ref
 *   pkt-line("<hash> <refname>\n")                   // subsequent refs
 *   flush
 */
export function buildRefListPktLines(
	refs: AdvertisedRef[],
	capabilities: string[],
	headTarget?: string,
): Uint8Array {
	const lines: Uint8Array[] = [];

	const caps = [...capabilities];
	if (headTarget) {
		caps.push(`symref=HEAD:${headTarget}`);
	}
	caps.push("agent=just-git/1.0");
	const capStr = caps.join(" ");

	if (refs.length === 0) {
		const zeroHash = "0000000000000000000000000000000000000000";
		lines.push(encodePktLine(`${zeroHash} capabilities^{}\0${capStr}\n`));
	} else {
		for (let i = 0; i < refs.length; i++) {
			const ref = refs[i]!;
			if (i === 0) {
				lines.push(encodePktLine(`${ref.hash} ${ref.name}\0${capStr}\n`));
			} else {
				lines.push(encodePktLine(`${ref.hash} ${ref.name}\n`));
			}
		}
	}

	lines.push(flushPkt());
	return concatPktLines(...lines);
}

/**
 * Build the HTTP response body for `GET /info/refs?service=<service>`.
 * Wraps `buildRefListPktLines` with the HTTP-specific service header.
 *
 * Format:
 *   pkt-line("# service=<service>\n")
 *   flush
 *   <ref list from buildRefListPktLines>
 */
export function buildRefAdvertisement(
	refs: AdvertisedRef[],
	service: string,
	capabilities: string[],
	headTarget?: string,
): Uint8Array {
	const header = concatPktLines(encodePktLine(`# service=${service}\n`), flushPkt());
	const refList = buildRefListPktLines(refs, capabilities, headTarget);

	const result = new Uint8Array(header.byteLength + refList.byteLength);
	result.set(header, 0);
	result.set(refList, header.byteLength);
	return result;
}

// ── Upload-pack request parsing ─────────────────────────────────────

interface UploadPackRequest {
	wants: string[];
	haves: string[];
	capabilities: string[];
	/** Commit hashes the client reports as its current shallow boundary. */
	clientShallows: string[];
	/** Requested depth limit (from `deepen <N>`). */
	depth?: number;
	/** Whether the client sent a `done` line (signals end of negotiation). */
	done: boolean;
}

/**
 * Parse the request body of `POST /git-upload-pack`.
 *
 * Format:
 *   want <hash> <capabilities>\n   (first want)
 *   want <hash>\n                  (subsequent wants)
 *   shallow <hash>\n               (client's existing shallow commits)
 *   deepen <N>\n                   (depth request)
 *   flush
 *   have <hash>\n
 *   ...
 *   done\n
 */
export function parseUploadPackRequest(body: Uint8Array): UploadPackRequest {
	const pktLines = parsePktLineStream(body);
	const wants: string[] = [];
	const haves: string[] = [];
	const clientShallows: string[] = [];
	let capabilities: string[] = [];
	let depth: number | undefined;
	let done = false;

	for (const line of pktLines) {
		if (line.type === "flush") continue;
		const text = pktLineText(line);

		if (text.startsWith("want ")) {
			const rest = text.slice(5);
			if (wants.length === 0) {
				const spaceIdx = rest.indexOf(" ");
				if (spaceIdx !== -1) {
					wants.push(rest.slice(0, spaceIdx));
					capabilities = rest
						.slice(spaceIdx + 1)
						.split(" ")
						.filter(Boolean);
				} else {
					wants.push(rest);
				}
			} else {
				wants.push(rest);
			}
		} else if (text.startsWith("have ")) {
			haves.push(text.slice(5));
		} else if (text.startsWith("shallow ")) {
			clientShallows.push(text.slice(8));
		} else if (text.startsWith("deepen ")) {
			depth = parseInt(text.slice(7), 10);
			if (Number.isNaN(depth)) depth = undefined;
		} else if (text === "done") {
			done = true;
		}
	}

	return { wants, haves, capabilities, clientShallows, depth, done };
}

// ── Upload-pack response building ───────────────────────────────────

/**
 * Build the response body for `POST /git-upload-pack`.
 *
 * With multi_ack_detailed, emits `ACK <hash> common` for each
 * recognized have, `ACK <last> ready`, then a final plain
 * `ACK <last>` to terminate negotiation before pack data.
 * When no common objects exist, sends `NAK` before the pack.
 * Sideband-64k wraps pack data in band-1 pkt-lines.
 *
 * When `shallowInfo` is provided, shallow/unshallow lines are
 * emitted before the ACK/NAK negotiation (per protocol spec).
 */
export function buildUploadPackResponse(
	packData: Uint8Array,
	useSideband: boolean,
	commonHashes?: string[],
	shallowInfo?: ShallowUpdate,
): Uint8Array {
	const parts: Uint8Array[] = [];

	if (shallowInfo) {
		for (const hash of shallowInfo.shallow) {
			parts.push(encodePktLine(`shallow ${hash}\n`));
		}
		for (const hash of shallowInfo.unshallow) {
			parts.push(encodePktLine(`unshallow ${hash}\n`));
		}
		parts.push(flushPkt());
	}

	if (commonHashes && commonHashes.length > 0) {
		for (const hash of commonHashes) {
			parts.push(encodePktLine(`ACK ${hash} common\n`));
		}
		const lastCommon = commonHashes[commonHashes.length - 1];
		parts.push(encodePktLine(`ACK ${lastCommon} ready\n`));
		parts.push(encodePktLine(`ACK ${lastCommon}\n`));
	} else {
		parts.push(encodePktLine("NAK\n"));
	}

	if (useSideband) {
		let offset = 0;
		while (offset < packData.byteLength) {
			const chunkSize = Math.min(SIDEBAND_MAX_PAYLOAD, packData.byteLength - offset);
			parts.push(encodeSidebandPacket(1, packData.subarray(offset, offset + chunkSize)));
			offset += chunkSize;
		}
		parts.push(flushPkt());
	} else {
		const line = new Uint8Array(packData.byteLength);
		line.set(packData);
		parts.push(line);
	}

	return concatPktLines(...parts);
}

/**
 * Build a response containing only the shallow-update section.
 * Used during the first phase of shallow HTTP negotiation when the
 * client has not yet sent "done".
 */
export function buildShallowOnlyResponse(shallowInfo: ShallowUpdate): Uint8Array {
	const parts: Uint8Array[] = [];
	for (const hash of shallowInfo.shallow) {
		parts.push(encodePktLine(`shallow ${hash}\n`));
	}
	for (const hash of shallowInfo.unshallow) {
		parts.push(encodePktLine(`unshallow ${hash}\n`));
	}
	parts.push(flushPkt());
	return concatPktLines(...parts);
}

/**
 * Streaming variant of `buildUploadPackResponse`. Yields the NAK/ACK
 * preamble first, then wraps each incoming pack chunk in sideband-64k
 * pkt-lines and yields them incrementally.
 */
export async function* buildUploadPackResponseStreaming(
	packChunks: AsyncIterable<Uint8Array>,
	useSideband: boolean,
	commonHashes?: string[],
	shallowInfo?: ShallowUpdate,
): AsyncGenerator<Uint8Array> {
	if (shallowInfo) {
		const shallowParts: Uint8Array[] = [];
		for (const hash of shallowInfo.shallow) {
			shallowParts.push(encodePktLine(`shallow ${hash}\n`));
		}
		for (const hash of shallowInfo.unshallow) {
			shallowParts.push(encodePktLine(`unshallow ${hash}\n`));
		}
		shallowParts.push(flushPkt());
		yield concatPktLines(...shallowParts);
	}

	const preamble: Uint8Array[] = [];
	if (commonHashes && commonHashes.length > 0) {
		for (const hash of commonHashes) {
			preamble.push(encodePktLine(`ACK ${hash} common\n`));
		}
		const lastCommon = commonHashes[commonHashes.length - 1];
		preamble.push(encodePktLine(`ACK ${lastCommon} ready\n`));
		preamble.push(encodePktLine(`ACK ${lastCommon}\n`));
	} else {
		preamble.push(encodePktLine("NAK\n"));
	}
	yield concatPktLines(...preamble);

	if (useSideband) {
		for await (const chunk of packChunks) {
			let offset = 0;
			while (offset < chunk.byteLength) {
				const chunkSize = Math.min(SIDEBAND_MAX_PAYLOAD, chunk.byteLength - offset);
				yield encodeSidebandPacket(1, chunk.subarray(offset, offset + chunkSize));
				offset += chunkSize;
			}
		}
		yield flushPkt();
	} else {
		for await (const chunk of packChunks) {
			yield chunk;
		}
	}
}

// ── Receive-pack request parsing ────────────────────────────────────

export interface PushCommand {
	oldHash: string;
	newHash: string;
	refName: string;
}

interface ReceivePackRequest {
	commands: PushCommand[];
	packData: Uint8Array;
	capabilities: string[];
	/** Whether the parser found a valid flush packet terminating the command section. */
	sawFlush: boolean;
}

/**
 * Parse the request body of `POST /git-receive-pack`.
 *
 * Format:
 *   <old-hash> <new-hash> <ref-name>\0<capabilities>\n   (first command)
 *   <old-hash> <new-hash> <ref-name>\n                   (subsequent)
 *   flush
 *   <raw packfile data>
 *
 * Note: the pack data after the flush is NOT pkt-line formatted,
 * so we parse pkt-lines manually by tracking the byte offset.
 */
export function parseReceivePackRequest(body: Uint8Array): ReceivePackRequest {
	const decoder = new TextDecoder();
	const commands: PushCommand[] = [];
	let capabilities: string[] = [];
	let offset = 0;
	let sawFlush = false;

	// Parse pkt-line commands until flush
	while (offset < body.byteLength) {
		if (offset + 4 > body.byteLength) break;

		const lenHex = decoder.decode(body.subarray(offset, offset + 4));
		const len = parseInt(lenHex, 16);

		if (Number.isNaN(len)) break;

		if (len === 0) {
			// Flush packet -- everything after is raw pack data
			sawFlush = true;
			offset += 4;
			break;
		}

		if (len < 4 || offset + len > body.byteLength) break;

		const lineData = body.subarray(offset + 4, offset + len);
		offset += len;

		const nulIdx = lineData.indexOf(0);

		let commandPart: string;
		if (nulIdx !== -1) {
			commandPart = decoder.decode(lineData.subarray(0, nulIdx));
			const capStr = decoder.decode(lineData.subarray(nulIdx + 1));
			capabilities = capStr.replace(/\n$/, "").split(" ").filter(Boolean);
		} else {
			const text = decoder.decode(lineData);
			commandPart = text.endsWith("\n") ? text.slice(0, -1) : text;
		}

		const parts = commandPart.split(" ");
		if (parts.length >= 3) {
			commands.push({
				oldHash: parts[0]!,
				newHash: parts[1]!,
				refName: parts[2]!,
			});
		}
	}

	const packData = offset < body.byteLength ? body.subarray(offset) : new Uint8Array(0);

	return { commands, packData, capabilities, sawFlush };
}

// ── Report-status response building ─────────────────────────────────

interface RefResult {
	name: string;
	ok: boolean;
	error?: string;
}

/**
 * Build the report-status response for `POST /git-receive-pack`.
 *
 * Format (optionally wrapped in sideband):
 *   unpack ok\n  |  unpack <error>\n
 *   ok <ref>\n   |  ng <ref> <error>\n
 *   ...
 *   flush
 */
export function buildReportStatus(
	unpackOk: boolean,
	refResults: RefResult[],
	useSideband: boolean,
): Uint8Array {
	const statusLines: Uint8Array[] = [];

	statusLines.push(encodePktLine(unpackOk ? "unpack ok\n" : "unpack error\n"));

	for (const ref of refResults) {
		if (ref.ok) {
			statusLines.push(encodePktLine(`ok ${ref.name}\n`));
		} else {
			statusLines.push(encodePktLine(`ng ${ref.name} ${ref.error ?? "failed"}\n`));
		}
	}

	statusLines.push(flushPkt());

	const statusData = concatPktLines(...statusLines);

	if (useSideband) {
		// Wrap all status data in band-1
		const parts: Uint8Array[] = [];
		parts.push(encodeSidebandPacket(1, statusData));
		parts.push(flushPkt());
		return concatPktLines(...parts);
	}

	return statusData;
}

// ── Sideband encoding ───────────────────────────────────────────────

/**
 * Encode data into a sideband pkt-line: `[4-byte hex len][band byte][payload]`.
 */
function encodeSidebandPacket(band: number, data: Uint8Array): Uint8Array {
	const payload = new Uint8Array(1 + data.byteLength);
	payload[0] = band;
	payload.set(data, 1);
	return encodePktLine(payload);
}

// ══════════════════════════════════════════════════════════════════════
// Protocol v2
// ══════════════════════════════════════════════════════════════════════

// ── V2 capability advertisement ─────────────────────────────────────

/**
 * Build the v2 capability advertisement response body.
 *
 * Format:
 *   PKT-LINE("version 2\n")
 *   PKT-LINE(capability LF)
 *   ...
 *   flush-pkt
 */
export function buildV2CapabilityAdvertisement(capabilities: string[]): Uint8Array {
	const lines: Uint8Array[] = [];
	lines.push(encodePktLine("version 2\n"));
	for (const cap of capabilities) {
		lines.push(encodePktLine(`${cap}\n`));
	}
	lines.push(flushPkt());
	return concatPktLines(...lines);
}

// ── V2 command request parsing ──────────────────────────────────────

export interface V2CommandRequest {
	command: string;
	capabilities: string[];
	args: string[];
}

/**
 * Parse a v2 command request body.
 *
 * Format:
 *   PKT-LINE("command=" key LF)
 *   *(PKT-LINE(capability LF))
 *   delim-pkt
 *   *(PKT-LINE(command-arg LF))
 *   flush-pkt
 */
export function parseV2CommandRequest(body: Uint8Array): V2CommandRequest {
	const pktLines = parsePktLineStream(body);
	let command = "";
	const capabilities: string[] = [];
	const args: string[] = [];
	let inArgs = false;

	for (const line of pktLines) {
		if (line.type === "flush") break;
		if (line.type === "response-end") break;
		if (line.type === "delim") {
			inArgs = true;
			continue;
		}
		const text = pktLineText(line);
		if (!text) continue;

		if (inArgs) {
			args.push(text);
		} else if (text.startsWith("command=")) {
			command = text.slice(8);
		} else {
			capabilities.push(text);
		}
	}

	return { command, capabilities, args };
}

// ── V2 ls-refs response ─────────────────────────────────────────────

export interface V2LsRefsRef {
	hash: string;
	name: string;
	symrefTarget?: string;
	peeledHash?: string;
}

/**
 * Build the v2 ls-refs response.
 *
 * Format:
 *   PKT-LINE(obj-id SP refname *(SP ref-attribute) LF)
 *   ...
 *   flush-pkt
 */
export function buildV2LsRefsResponse(refs: V2LsRefsRef[]): Uint8Array {
	const lines: Uint8Array[] = [];
	for (const ref of refs) {
		let line = `${ref.hash} ${ref.name}`;
		if (ref.symrefTarget) {
			line += ` symref-target:${ref.symrefTarget}`;
		}
		if (ref.peeledHash) {
			line += ` peeled:${ref.peeledHash}`;
		}
		lines.push(encodePktLine(`${line}\n`));
	}
	lines.push(flushPkt());
	return concatPktLines(...lines);
}

// ── V2 fetch request parsing ────────────────────────────────────────

export interface V2FetchRequest {
	wants: string[];
	haves: string[];
	done: boolean;
	clientShallows: string[];
	depth?: number;
	includeTag: boolean;
	ofsDeltas: boolean;
	wantRefs: string[];
}

/**
 * Parse v2 fetch command args into structured request.
 */
export function parseV2FetchArgs(args: string[]): V2FetchRequest {
	const wants: string[] = [];
	const haves: string[] = [];
	const clientShallows: string[] = [];
	const wantRefs: string[] = [];
	let done = false;
	let depth: number | undefined;
	let includeTag = false;
	let ofsDeltas = false;

	for (const arg of args) {
		if (arg.startsWith("want ")) {
			wants.push(arg.slice(5));
		} else if (arg.startsWith("have ")) {
			haves.push(arg.slice(5));
		} else if (arg.startsWith("shallow ")) {
			clientShallows.push(arg.slice(8));
		} else if (arg.startsWith("deepen ")) {
			depth = parseInt(arg.slice(7), 10);
			if (Number.isNaN(depth)) depth = undefined;
		} else if (arg.startsWith("want-ref ")) {
			wantRefs.push(arg.slice(9));
		} else if (arg === "done") {
			done = true;
		} else if (arg === "include-tag") {
			includeTag = true;
		} else if (arg === "ofs-delta") {
			ofsDeltas = true;
		}
	}

	return { wants, haves, done, clientShallows, depth, includeTag, ofsDeltas, wantRefs };
}

// ── V2 fetch response building ──────────────────────────────────────

export interface V2FetchResponseOptions {
	commonHashes?: string[];
	shallowInfo?: ShallowUpdate;
	wantedRefs?: Array<{ hash: string; name: string }>;
}

/**
 * Build a v2 fetch response with section-based format.
 *
 * Per the spec, when commonHashes are provided the acknowledgments
 * section is included (with "ready") followed by the packfile.
 * When omitted (e.g. fresh clone with no haves), acks are skipped.
 *
 * Sections (separated by delim-pkt):
 *   [acknowledgments section]
 *   [shallow-info section]
 *   [wanted-refs section]
 *   packfile section
 *
 * The packfile section always uses sideband-64k.
 * Terminated by flush-pkt.
 */
export function buildV2FetchResponse(
	packData: Uint8Array,
	options?: V2FetchResponseOptions,
): Uint8Array {
	const parts: Uint8Array[] = [];
	const { commonHashes, shallowInfo, wantedRefs } = options ?? {};

	if (commonHashes && commonHashes.length > 0) {
		parts.push(encodePktLine("acknowledgments\n"));
		for (const hash of commonHashes) {
			parts.push(encodePktLine(`ACK ${hash}\n`));
		}
		parts.push(encodePktLine("ready\n"));
		parts.push(delimPkt());
	}

	// Shallow-info section
	if (shallowInfo && (shallowInfo.shallow.length > 0 || shallowInfo.unshallow.length > 0)) {
		parts.push(encodePktLine("shallow-info\n"));
		for (const hash of shallowInfo.shallow) {
			parts.push(encodePktLine(`shallow ${hash}\n`));
		}
		for (const hash of shallowInfo.unshallow) {
			parts.push(encodePktLine(`unshallow ${hash}\n`));
		}
		parts.push(delimPkt());
	}

	// Wanted-refs section
	if (wantedRefs && wantedRefs.length > 0) {
		parts.push(encodePktLine("wanted-refs\n"));
		for (const ref of wantedRefs) {
			parts.push(encodePktLine(`${ref.hash} ${ref.name}\n`));
		}
		parts.push(delimPkt());
	}

	// Packfile section (always sideband-64k)
	parts.push(encodePktLine("packfile\n"));
	let offset = 0;
	while (offset < packData.byteLength) {
		const chunkSize = Math.min(SIDEBAND_MAX_PAYLOAD, packData.byteLength - offset);
		parts.push(encodeSidebandPacket(1, packData.subarray(offset, offset + chunkSize)));
		offset += chunkSize;
	}
	parts.push(flushPkt());

	return concatPktLines(...parts);
}

/**
 * Build a v2 fetch acknowledgments-only response (no packfile).
 * Sent when the server needs more negotiation rounds.
 *
 * When `ready` is true, includes the `ready` line to tell the client
 * the server has enough common objects and expects `done` next.
 */
export function buildV2FetchAcknowledgments(commonHashes: string[], ready?: boolean): Uint8Array {
	const parts: Uint8Array[] = [];
	parts.push(encodePktLine("acknowledgments\n"));
	if (commonHashes.length > 0) {
		for (const hash of commonHashes) {
			parts.push(encodePktLine(`ACK ${hash}\n`));
		}
	} else {
		parts.push(encodePktLine("NAK\n"));
	}
	if (ready) {
		parts.push(encodePktLine("ready\n"));
	}
	parts.push(flushPkt());
	return concatPktLines(...parts);
}

/**
 * Streaming variant of v2 fetch response. Yields section headers and
 * pack data incrementally.
 */
export async function* buildV2FetchResponseStreaming(
	packChunks: AsyncIterable<Uint8Array>,
	options?: V2FetchResponseOptions,
): AsyncGenerator<Uint8Array> {
	const { commonHashes, shallowInfo, wantedRefs } = options ?? {};

	if (commonHashes && commonHashes.length > 0) {
		const ackParts: Uint8Array[] = [];
		ackParts.push(encodePktLine("acknowledgments\n"));
		for (const hash of commonHashes) {
			ackParts.push(encodePktLine(`ACK ${hash}\n`));
		}
		ackParts.push(encodePktLine("ready\n"));
		ackParts.push(delimPkt());
		yield concatPktLines(...ackParts);
	}

	if (shallowInfo && (shallowInfo.shallow.length > 0 || shallowInfo.unshallow.length > 0)) {
		const shallowParts: Uint8Array[] = [];
		shallowParts.push(encodePktLine("shallow-info\n"));
		for (const hash of shallowInfo.shallow) {
			shallowParts.push(encodePktLine(`shallow ${hash}\n`));
		}
		for (const hash of shallowInfo.unshallow) {
			shallowParts.push(encodePktLine(`unshallow ${hash}\n`));
		}
		shallowParts.push(delimPkt());
		yield concatPktLines(...shallowParts);
	}

	if (wantedRefs && wantedRefs.length > 0) {
		const refParts: Uint8Array[] = [];
		refParts.push(encodePktLine("wanted-refs\n"));
		for (const ref of wantedRefs) {
			refParts.push(encodePktLine(`${ref.hash} ${ref.name}\n`));
		}
		refParts.push(delimPkt());
		yield concatPktLines(...refParts);
	}

	yield encodePktLine("packfile\n");
	for await (const chunk of packChunks) {
		let offset = 0;
		while (offset < chunk.byteLength) {
			const chunkSize = Math.min(SIDEBAND_MAX_PAYLOAD, chunk.byteLength - offset);
			yield encodeSidebandPacket(1, chunk.subarray(offset, offset + chunkSize));
			offset += chunkSize;
		}
	}
	yield flushPkt();
}
