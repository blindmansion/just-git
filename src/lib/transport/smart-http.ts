// ── Git Smart HTTP Protocol v1 client ────────────────────────────────
// Spec: https://git-scm.com/docs/gitprotocol-http

import {
	concatPktLines,
	demuxSideband,
	encodePktLine,
	flushPkt,
	type PktLine,
	parsePktLineStream,
	pktLineText,
} from "./pkt-line.ts";
import type { FetchFunction } from "../../hooks.ts";
import type { RemoteRef, ShallowFetchOptions } from "./transport.ts";
import { ZERO_HASH } from "../hex.ts";

// ── Auth ─────────────────────────────────────────────────────────────

/** HTTP authentication credentials for Smart HTTP transport. */
export type HttpAuth =
	| { type: "basic"; username: string; password: string }
	| { type: "bearer"; token: string };

function authHeaders(auth?: HttpAuth): Record<string, string> {
	if (!auth) return {};
	if (auth.type === "bearer") {
		return { Authorization: `Bearer ${auth.token}` };
	}
	const encoded = btoa(`${auth.username}:${auth.password}`);
	return { Authorization: `Basic ${encoded}` };
}

// ── Ref discovery ────────────────────────────────────────────────────

interface DiscoverResult {
	refs: RemoteRef[];
	capabilities: string[];
	symrefs: Map<string, string>;
}

export async function discoverRefs(
	url: string,
	service: "git-upload-pack" | "git-receive-pack",
	auth?: HttpAuth,
	fetchFn: FetchFunction = globalThis.fetch,
): Promise<DiscoverResult> {
	const cleanUrl = url.replace(/\/+$/, "");
	const res = await fetchFn(`${cleanUrl}/info/refs?service=${service}`, {
		headers: {
			...authHeaders(auth),
			"User-Agent": "just-git/1.0",
		},
	});

	if (!res.ok) {
		throw new Error(`HTTP ${res.status} discovering refs at ${cleanUrl}`);
	}

	const contentType = res.headers.get("content-type") ?? "";
	const expectedCt = `application/x-${service}-advertisement`;

	const body = new Uint8Array(await res.arrayBuffer());

	// Validate smart server response
	if (!contentType.startsWith(expectedCt)) {
		const first5 = new TextDecoder().decode(body.subarray(0, 5));
		if (!/^[0-9a-f]{4}#/.test(first5)) {
			throw new Error(`Server does not support smart HTTP (Content-Type: ${contentType})`);
		}
	}

	const pktLines = parsePktLineStream(body);
	return parseRefAdvertisement(pktLines, service);
}

function parseRefAdvertisement(pktLines: PktLine[], service: string): DiscoverResult {
	let idx = 0;

	// Skip "# service=..." header line
	const firstLine = pktLines[idx];
	if (firstLine?.type === "data") {
		const text = pktLineText(firstLine);
		if (text === `# service=${service}`) {
			idx++;
		}
	}

	// Skip flush after service line
	if (pktLines[idx]?.type === "flush") {
		idx++;
	}

	const refs: RemoteRef[] = [];
	let capabilities: string[] = [];
	const symrefs = new Map<string, string>();

	for (; idx < pktLines.length; idx++) {
		const line = pktLines[idx];
		if (!line || line.type === "flush") break;
		if (line.type !== "data") continue;

		const raw = line.data;
		const nulIdx = raw.indexOf(0);

		let refPart: string;
		if (nulIdx !== -1) {
			refPart = new TextDecoder().decode(raw.subarray(0, nulIdx));
			const capStr = new TextDecoder().decode(raw.subarray(nulIdx + 1));
			capabilities = capStr.replace(/\n$/, "").split(" ").filter(Boolean);
			for (const cap of capabilities) {
				if (cap.startsWith("symref=")) {
					const val = cap.slice(7);
					const colonIdx = val.indexOf(":");
					if (colonIdx !== -1) {
						symrefs.set(val.slice(0, colonIdx), val.slice(colonIdx + 1));
					}
				}
			}
		} else {
			refPart = new TextDecoder().decode(raw).replace(/\n$/, "");
		}

		const spaceIdx = refPart.indexOf(" ");
		if (spaceIdx === -1) continue;

		const hash = refPart.slice(0, spaceIdx);
		const name = refPart.slice(spaceIdx + 1);

		if (hash === ZERO_HASH && name === "capabilities^{}") continue;

		if (name.endsWith("^{}")) {
			const baseName = name.slice(0, -3);
			const parent = refs.find((r) => r.name === baseName);
			if (parent) {
				parent.peeledHash = hash;
			}
			continue;
		}

		refs.push({ name, hash });
	}

	return { refs, capabilities, symrefs };
}

// ── Fetch pack ───────────────────────────────────────────────────────

const WANTED_FETCH_CAPS = [
	"multi_ack_detailed",
	"no-done",
	"side-band-64k",
	"ofs-delta",
	"include-tag",
	"shallow",
];

interface FetchPackResult {
	packData: Uint8Array;
	acks: string[];
	progress: string[];
	shallowLines: string[];
	unshallowLines: string[];
}

export async function fetchPack(
	url: string,
	wants: string[],
	haves: string[],
	serverCaps: string[],
	auth?: HttpAuth,
	fetchFn: FetchFunction = globalThis.fetch,
	shallow?: ShallowFetchOptions,
): Promise<FetchPackResult> {
	if (wants.length === 0) {
		throw new Error("fetchPack requires at least one want");
	}

	const clientCaps = negotiateCapabilities(serverCaps, WANTED_FETCH_CAPS);

	const lines: Uint8Array[] = [];

	lines.push(encodePktLine(`want ${wants[0]} ${clientCaps.join(" ")}\n`));
	for (let i = 1; i < wants.length; i++) {
		lines.push(encodePktLine(`want ${wants[i]}\n`));
	}

	if (shallow?.existingShallows) {
		for (const hash of shallow.existingShallows) {
			lines.push(encodePktLine(`shallow ${hash}\n`));
		}
	}

	if (shallow?.depth !== undefined) {
		lines.push(encodePktLine(`deepen ${shallow.depth}\n`));
	}

	lines.push(flushPkt());

	for (const have of haves) {
		lines.push(encodePktLine(`have ${have}\n`));
	}
	lines.push(encodePktLine("done\n"));

	const requestBody = concatPktLines(...lines);
	const cleanUrl = url.replace(/\/+$/, "");

	const res = await fetchFn(`${cleanUrl}/git-upload-pack`, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-git-upload-pack-request",
			...authHeaders(auth),
			"User-Agent": "just-git/1.0",
		},
		body: requestBody,
	});

	if (!res.ok) {
		throw new Error(`HTTP ${res.status} fetching pack from ${cleanUrl}`);
	}

	const responseBody = new Uint8Array(await res.arrayBuffer());
	return parseFetchResponse(responseBody, clientCaps.includes("side-band-64k"));
}

function parseFetchResponse(body: Uint8Array, useSideband: boolean): FetchPackResult {
	const pktLines = parsePktLineStream(body);
	const acks: string[] = [];
	const shallowLines: string[] = [];
	const unshallowLines: string[] = [];

	let packStartIdx = 0;
	for (let i = 0; i < pktLines.length; i++) {
		const line = pktLines[i];
		if (!line || line.type === "flush") {
			packStartIdx = i + 1;
			continue;
		}
		if (line.type !== "data") continue;

		const text = pktLineText(line);
		if (text.startsWith("shallow ")) {
			shallowLines.push(text.slice(8));
			packStartIdx = i + 1;
		} else if (text.startsWith("unshallow ")) {
			unshallowLines.push(text.slice(10));
			packStartIdx = i + 1;
		} else if (text.startsWith("ACK ") || text === "NAK") {
			acks.push(text);
			packStartIdx = i + 1;
		} else {
			packStartIdx = i;
			break;
		}
	}

	const remaining = pktLines.slice(packStartIdx);

	if (useSideband) {
		const { packData, progress, errors } = demuxSideband(remaining);
		if (errors.length > 0) {
			throw new Error(`Remote error: ${errors.join("")}`);
		}
		return { packData, acks, progress, shallowLines, unshallowLines };
	}

	let totalSize = 0;
	for (const line of remaining) {
		if (line.type === "data") totalSize += line.data.byteLength;
	}
	const packData = new Uint8Array(totalSize);
	let offset = 0;
	for (const line of remaining) {
		if (line.type === "data") {
			packData.set(line.data, offset);
			offset += line.data.byteLength;
		}
	}

	return { packData, acks, progress: [], shallowLines, unshallowLines };
}

// ── Push pack ────────────────────────────────────────────────────────

const WANTED_PUSH_CAPS = ["report-status", "side-band-64k", "ofs-delta", "delete-refs"];

export interface PushCommand {
	oldHash: string;
	newHash: string;
	refName: string;
}

interface PushPackResult {
	unpackOk: boolean;
	unpackError?: string;
	refResults: Array<{ name: string; ok: boolean; error?: string }>;
	progress: string[];
}

export async function pushPack(
	url: string,
	commands: PushCommand[],
	packData: Uint8Array | null,
	serverCaps: string[],
	auth?: HttpAuth,
	fetchFn: FetchFunction = globalThis.fetch,
): Promise<PushPackResult> {
	if (commands.length === 0) {
		throw new Error("pushPack requires at least one command");
	}

	const clientCaps = negotiateCapabilities(serverCaps, WANTED_PUSH_CAPS);

	const lines: Uint8Array[] = [];

	// First command with capabilities
	const [first, ...rest] = commands;
	if (!first) throw new Error("pushPack requires at least one command");
	lines.push(
		encodePktLine(`${first.oldHash} ${first.newHash} ${first.refName}\0${clientCaps.join(" ")}\n`),
	);
	for (const cmd of rest) {
		lines.push(encodePktLine(`${cmd.oldHash} ${cmd.newHash} ${cmd.refName}\n`));
	}
	lines.push(flushPkt());

	let requestBody: Uint8Array;
	if (packData && packData.byteLength > 0) {
		const pktPart = concatPktLines(...lines);
		requestBody = new Uint8Array(pktPart.byteLength + packData.byteLength);
		requestBody.set(pktPart, 0);
		requestBody.set(packData, pktPart.byteLength);
	} else {
		requestBody = concatPktLines(...lines);
	}

	const cleanUrl = url.replace(/\/+$/, "");

	const res = await fetchFn(`${cleanUrl}/git-receive-pack`, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-git-receive-pack-request",
			...authHeaders(auth),
			"User-Agent": "just-git/1.0",
		},
		body: requestBody,
	});

	if (!res.ok) {
		throw new Error(`HTTP ${res.status} pushing to ${cleanUrl}`);
	}

	const responseBody = new Uint8Array(await res.arrayBuffer());

	if (!clientCaps.includes("report-status")) {
		return { unpackOk: true, refResults: [], progress: [] };
	}

	return parseReportStatus(responseBody, clientCaps.includes("side-band-64k"));
}

function parseReportStatus(body: Uint8Array, useSideband: boolean): PushPackResult {
	let statusLines: PktLine[];
	let progress: string[] = [];

	if (useSideband) {
		const pktLines = parsePktLineStream(body);
		const { packData, progress: prog, errors } = demuxSideband(pktLines);
		if (errors.length > 0) {
			throw new Error(`Remote error: ${errors.join("")}`);
		}
		progress = prog;
		statusLines = parsePktLineStream(packData);
	} else {
		statusLines = parsePktLineStream(body);
	}

	let unpackOk = false;
	let unpackError: string | undefined;
	const refResults: Array<{ name: string; ok: boolean; error?: string }> = [];

	for (const line of statusLines) {
		if (line.type === "flush") break;
		const text = pktLineText(line);

		if (text.startsWith("unpack ")) {
			unpackOk = text === "unpack ok";
			if (!unpackOk) {
				unpackError = text.slice(7);
			}
		} else if (text.startsWith("ok ")) {
			refResults.push({ name: text.slice(3), ok: true });
		} else if (text.startsWith("ng ")) {
			const rest = text.slice(3);
			const spaceIdx = rest.indexOf(" ");
			if (spaceIdx !== -1) {
				refResults.push({
					name: rest.slice(0, spaceIdx),
					ok: false,
					error: rest.slice(spaceIdx + 1),
				});
			} else {
				refResults.push({ name: rest, ok: false });
			}
		}
	}

	return { unpackOk, unpackError, refResults, progress };
}

// ── Capability negotiation ───────────────────────────────────────────

function negotiateCapabilities(serverCaps: string[], wantedCaps: string[]): string[] {
	const serverSet = new Set(serverCaps.map((c) => c.split("=", 1)[0] ?? c));
	const result: string[] = [];
	for (const cap of wantedCaps) {
		if (serverSet.has(cap)) result.push(cap);
	}
	result.push("agent=just-git/1.0");
	return result;
}
