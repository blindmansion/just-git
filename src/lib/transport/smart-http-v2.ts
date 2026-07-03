// ── Git Smart HTTP Protocol v2 client ────────────────────────────────
// Spec: https://git-scm.com/docs/gitprotocol-v2 and gitprotocol-http
//
// The client mirrors the just-git server's v2 implementation in
// `src/server/protocol.ts`: it *sends* what `parseV2*` parses and *parses*
// what `buildV2*` builds. Push (receive-pack) stays on v1 and is untouched.
//
// OIDs are treated as opaque, space-delimited tokens with no length
// assumptions, so this code is hash-agnostic (SHA-1 / SHA-256 ready). Only
// the `object-format` guard distinguishes hashes, and it fails cleanly on
// anything but sha1 rather than mis-slicing wider OIDs.

import {
	concatPktLines,
	delimPkt,
	demuxV2FetchResponse,
	encodePktLine,
	flushPkt,
	parsePktLinesFromStream,
	parsePktLineStream,
	type PktLine,
	pktLineText,
	type V2Section,
	type V2WantedRef,
} from "./pkt-line.ts";
import { type DiscoverResult, parseRefAdvertisement } from "./smart-http.ts";
import type {
	RemoteRef,
	ShallowFetchOptions,
	FetchFunction,
	ProgressCallback,
} from "./transport.ts";

const decoder = new TextDecoder();

// ── Capability discovery ─────────────────────────────────────────────

/**
 * Parsed v2 capability advertisement. Unlike v1's flat `string[]`, v2
 * capabilities carry structured values (`fetch=shallow filter`,
 * `ls-refs=unborn`, `object-format=sha1`), so they are exposed as a
 * `Map<name, values[]>` alongside the resolved `objectFormat`.
 */
export interface V2Capabilities {
	/** Raw capability lines as advertised (excluding `version 2`). */
	raw: string[];
	/** Capability name → its space-separated values (empty array if none). */
	features: Map<string, string[]>;
	/** The server's `object-format` (defaults to `sha1` when unadvertised). */
	objectFormat: string;
}

/** Result of v2-aware discovery: either an upgraded v2 server or a v1 fallback. */
export type DiscoverV2Result =
	| { version: 2; caps: V2Capabilities }
	| { version: 1; v1: DiscoverResult };

/**
 * Discover capabilities by issuing `GET /info/refs?service=git-upload-pack`
 * with the `Git-Protocol: version=2` header. Detects the version the server
 * agreed to from the first pkt-line (`version 2` ⇒ v2, `# service=…` ⇒ v1)
 * and falls back to v1 parsing transparently.
 */
export async function discoverV2Capabilities(
	url: string,
	fetchFn: FetchFunction = globalThis.fetch,
): Promise<DiscoverV2Result> {
	const cleanUrl = url.replace(/\/+$/, "");
	const res = await fetchFn(`${cleanUrl}/info/refs?service=git-upload-pack`, {
		headers: {
			"User-Agent": "just-git/1.0",
			"Git-Protocol": "version=2",
		},
	});

	if (!res.ok) {
		throw new Error(`HTTP ${res.status} discovering refs at ${cleanUrl}`);
	}

	const body = new Uint8Array(await res.arrayBuffer());

	// Both v1 and v2 advertisements start with a 4-byte hex pkt-line length.
	const first4 = decoder.decode(body.subarray(0, 4));
	if (!/^[0-9a-f]{4}$/.test(first4)) {
		const contentType = res.headers.get("content-type") ?? "";
		throw new Error(`Server does not support smart HTTP (Content-Type: ${contentType})`);
	}

	const pktLines = parsePktLineStream(body);

	// Smart-HTTP servers (e.g. GitHub) may precede the v2 advertisement with the
	// v1-style `# service=git-upload-pack` header + flush. Skip it before
	// checking for the `version 2` marker.
	let idx = 0;
	if (pktLines[idx]?.type === "data" && pktLineText(pktLines[idx]!).startsWith("# service=")) {
		idx++;
		if (pktLines[idx]?.type === "flush") idx++;
	}

	const marker = pktLines[idx];
	if (marker?.type === "data" && pktLineText(marker) === "version 2") {
		return { version: 2, caps: parseV2Capabilities(pktLines.slice(idx)) };
	}

	return { version: 1, v1: parseRefAdvertisement(pktLines, "git-upload-pack") };
}

function parseV2Capabilities(pktLines: PktLine[]): V2Capabilities {
	const raw: string[] = [];
	for (const line of pktLines) {
		if (line.type !== "data") continue;
		const text = pktLineText(line);
		if (!text || text === "version 2") continue;
		raw.push(text);
	}
	return v2CapabilitiesFromRaw(raw);
}

/**
 * Rebuild a {@link V2Capabilities} from its raw advertised capability lines
 * (the `version 2` marker is ignored if present). Used both by live discovery
 * and to restore a cached `V2CapabilitiesSnapshot` without a network round-trip.
 */
export function v2CapabilitiesFromRaw(raw: string[]): V2Capabilities {
	const lines: string[] = [];
	const features = new Map<string, string[]>();

	for (const text of raw) {
		if (!text || text === "version 2") continue;
		lines.push(text);
		const eq = text.indexOf("=");
		if (eq === -1) {
			features.set(text, []);
		} else {
			features.set(
				text.slice(0, eq),
				text
					.slice(eq + 1)
					.split(" ")
					.filter(Boolean),
			);
		}
	}

	const objectFormatValues = features.get("object-format");
	const objectFormat =
		objectFormatValues && objectFormatValues.length > 0 ? objectFormatValues[0]! : "sha1";

	return { raw: lines, features, objectFormat };
}

/** Whether the server advertised a specific value for the `fetch` capability. */
export function fetchSupports(caps: V2Capabilities, feature: string): boolean {
	return caps.features.get("fetch")?.includes(feature) ?? false;
}

// ── ls-refs ──────────────────────────────────────────────────────────

export interface LsRefsOptions {
	symrefs?: boolean;
	peel?: boolean;
	refPrefixes?: readonly string[];
}

export interface LsRefsResult {
	refs: RemoteRef[];
	/** The ref HEAD points to, derived from its `symref-target` attribute. */
	headTarget?: string;
}

/**
 * Issue a v2 `ls-refs` command (`POST git-upload-pack`). Parses
 * `<oid> <refname> *(SP attribute)` lines into {@link RemoteRef}s, recognising
 * `symref-target:` (for HEAD) and `peeled:` attributes.
 */
export async function lsRefs(
	url: string,
	caps: V2Capabilities,
	fetchFn: FetchFunction = globalThis.fetch,
	options: LsRefsOptions = {},
): Promise<LsRefsResult> {
	const lines: Uint8Array[] = [];
	lines.push(encodePktLine("command=ls-refs\n"));
	lines.push(encodePktLine("agent=just-git/1.0\n"));
	lines.push(encodePktLine(`object-format=${caps.objectFormat}\n`));
	lines.push(delimPkt());
	if (options.symrefs) lines.push(encodePktLine("symrefs\n"));
	if (options.peel) lines.push(encodePktLine("peel\n"));
	for (const prefix of options.refPrefixes ?? []) {
		lines.push(encodePktLine(`ref-prefix ${prefix}\n`));
	}
	lines.push(flushPkt());

	const res = await postV2Command(url, concatPktLines(...lines), fetchFn);
	const body = new Uint8Array(await res.arrayBuffer());
	return parseLsRefsResponse(parsePktLineStream(body));
}

function parseLsRefsResponse(pktLines: PktLine[]): LsRefsResult {
	const refs: RemoteRef[] = [];
	let headTarget: string | undefined;

	for (const line of pktLines) {
		if (line.type !== "data") continue;
		const text = pktLineText(line);
		if (!text) continue;

		const sp = text.indexOf(" ");
		if (sp === -1) continue;

		const hash = text.slice(0, sp);
		const attrs = text.slice(sp + 1).split(" ");
		const name = attrs[0]!;
		const ref: RemoteRef = { name, hash };

		for (let i = 1; i < attrs.length; i++) {
			const attr = attrs[i]!;
			if (attr.startsWith("symref-target:")) {
				const target = attr.slice("symref-target:".length);
				if (name === "HEAD") headTarget = target;
			} else if (attr.startsWith("peeled:")) {
				ref.peeledHash = attr.slice("peeled:".length);
			}
		}

		refs.push(ref);
	}

	return { refs, headTarget };
}

// ── fetch ────────────────────────────────────────────────────────────

export interface FetchPackV2Result {
	packData: Uint8Array;
	acks: string[];
	shallowLines: string[];
	unshallowLines: string[];
	wantedRefs: V2WantedRef[];
}

/**
 * Issue a v2 `fetch` command (`POST git-upload-pack`) and parse the sectioned
 * response.
 *
 * Uses the single-round `done` shortcut: all haves plus `done` are sent in one
 * request, forcing the server to skip multi-round negotiation and produce the
 * packfile immediately (valid per the v2 spec). The response sections are
 * demultiplexed by {@link demuxV2FetchResponse}; only `packfile` is
 * sideband-framed.
 */
export async function fetchPackV2(
	url: string,
	wants: string[],
	haves: string[],
	caps: V2Capabilities,
	fetchFn: FetchFunction = globalThis.fetch,
	shallow?: ShallowFetchOptions,
	onProgress?: ProgressCallback,
	wantRefs: string[] = [],
): Promise<FetchPackV2Result> {
	if (wants.length === 0 && wantRefs.length === 0) {
		throw new Error("fetchPackV2 requires at least one want or want-ref");
	}
	if (wantRefs.length > 0 && !fetchSupports(caps, "ref-in-want")) {
		throw new Error("remote does not support ref-in-want (want-ref) over protocol v2");
	}

	const wantsShallow = shallow?.depth !== undefined || (shallow?.existingShallows?.size ?? 0) > 0;
	if (wantsShallow && !fetchSupports(caps, "shallow")) {
		throw new Error("remote does not support shallow fetch over protocol v2");
	}

	const lines: Uint8Array[] = [];
	lines.push(encodePktLine("command=fetch\n"));
	lines.push(encodePktLine("agent=just-git/1.0\n"));
	lines.push(encodePktLine(`object-format=${caps.objectFormat}\n`));
	lines.push(delimPkt());

	// Standard fetch args (always valid command args, not gated capabilities).
	lines.push(encodePktLine("ofs-delta\n"));
	lines.push(encodePktLine("include-tag\n"));

	for (const want of wants) {
		lines.push(encodePktLine(`want ${want}\n`));
	}

	// Mixed OID + ref wants are legal; `want-ref <refname>` resolves on the
	// server and is echoed back in the `wanted-refs` response section.
	for (const refName of wantRefs) {
		lines.push(encodePktLine(`want-ref ${refName}\n`));
	}

	if (shallow?.existingShallows) {
		for (const hash of shallow.existingShallows) {
			lines.push(encodePktLine(`shallow ${hash}\n`));
		}
	}
	if (shallow?.depth !== undefined) {
		lines.push(encodePktLine(`deepen ${shallow.depth}\n`));
	}

	for (const have of haves) {
		lines.push(encodePktLine(`have ${have}\n`));
	}
	lines.push(encodePktLine("done\n"));
	lines.push(flushPkt());

	const res = await postV2Command(url, concatPktLines(...lines), fetchFn);

	if (res.body) {
		return parseFetchV2ResponseStreaming(res.body, onProgress);
	}

	const body = new Uint8Array(await res.arrayBuffer());
	return parseFetchV2ResponseBatch(body, onProgress);
}

function parseFetchV2ResponseBatch(
	body: Uint8Array,
	onProgress?: ProgressCallback,
): FetchPackV2Result {
	const sections = demuxV2FetchResponse(parsePktLineStream(body));
	if (sections.errors.length > 0) {
		throw new Error(`Remote error: ${sections.errors.join("")}`);
	}
	if (onProgress) {
		for (const msg of sections.progress) onProgress(msg);
	}
	return {
		packData: sections.packData,
		acks: sections.acks,
		shallowLines: sections.shallow,
		unshallowLines: sections.unshallow,
		wantedRefs: sections.wantedRefs,
	};
}

/**
 * Streaming counterpart to {@link parseFetchV2ResponseBatch}: walks the
 * pkt-line stream incrementally so band-2 progress reaches `onProgress` live
 * while band-1 pack chunks accumulate. Section transitions follow the same
 * rules as {@link demuxV2FetchResponse}.
 */
async function parseFetchV2ResponseStreaming(
	body: ReadableStream<Uint8Array>,
	onProgress?: ProgressCallback,
): Promise<FetchPackV2Result> {
	const acks: string[] = [];
	const shallowLines: string[] = [];
	const unshallowLines: string[] = [];
	const wantedRefs: V2WantedRef[] = [];
	const packChunks: Uint8Array[] = [];
	let totalPackBytes = 0;
	let section: V2Section = "none";

	for await (const line of parsePktLinesFromStream(body)) {
		if (line.type === "flush" || line.type === "response-end") break;
		if (line.type === "delim") {
			section = "none";
			continue;
		}
		if (line.type !== "data") continue;

		if (section === "packfile") {
			if (line.data.byteLength === 0) continue;
			const band = line.data[0];
			const payload = line.data.subarray(1);
			if (band === 1) {
				packChunks.push(payload);
				totalPackBytes += payload.byteLength;
			} else if (band === 2) {
				onProgress?.(decoder.decode(payload));
			} else if (band === 3) {
				throw new Error(`Remote error: ${decoder.decode(payload)}`);
			}
			continue;
		}

		const text = pktLineText(line);

		if (section === "none") {
			section = streamSectionForHeader(text);
			continue;
		}
		if (section === "skip") continue;

		switch (section) {
			case "acknowledgments":
				if (text.startsWith("ACK ")) acks.push(text);
				else if (text === "NAK") acks.push("NAK");
				break;
			case "shallow-info":
				if (text.startsWith("shallow ")) shallowLines.push(text.slice(8));
				else if (text.startsWith("unshallow ")) unshallowLines.push(text.slice(10));
				break;
			case "wanted-refs": {
				const sp = text.indexOf(" ");
				if (sp !== -1) wantedRefs.push({ hash: text.slice(0, sp), name: text.slice(sp + 1) });
				break;
			}
		}
	}

	const packData = new Uint8Array(totalPackBytes);
	let offset = 0;
	for (const chunk of packChunks) {
		packData.set(chunk, offset);
		offset += chunk.byteLength;
	}

	return { packData, acks, shallowLines, unshallowLines, wantedRefs };
}

function streamSectionForHeader(text: string): V2Section {
	switch (text) {
		case "acknowledgments":
			return "acknowledgments";
		case "shallow-info":
			return "shallow-info";
		case "wanted-refs":
			return "wanted-refs";
		case "packfile":
			return "packfile";
		default:
			return "skip";
	}
}

// ── Shared request plumbing ──────────────────────────────────────────

/**
 * POST a v2 command body to `git-upload-pack`. The `Git-Protocol: version=2`
 * header is required: without it real git (and the just-git server) treats the
 * POST as a v1 upload-pack request.
 */
async function postV2Command(
	url: string,
	body: Uint8Array,
	fetchFn: FetchFunction,
): Promise<Response> {
	const cleanUrl = url.replace(/\/+$/, "");
	const res = await fetchFn(`${cleanUrl}/git-upload-pack`, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-git-upload-pack-request",
			"User-Agent": "just-git/1.0",
			"Git-Protocol": "version=2",
		},
		body,
	});

	if (!res.ok) {
		throw new Error(`HTTP ${res.status} on git-upload-pack at ${cleanUrl}`);
	}

	return res;
}
