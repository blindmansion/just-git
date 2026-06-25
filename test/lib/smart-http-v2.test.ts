import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { concatPktLines, encodePktLine, flushPkt } from "../../src/lib/transport/pkt-line.ts";
import {
	discoverV2Capabilities,
	fetchPackV2,
	lsRefs,
	type V2Capabilities,
} from "../../src/lib/transport/smart-http-v2.ts";
import {
	buildV2CapabilityAdvertisement,
	buildV2FetchResponse,
	buildV2LsRefsResponse,
	parseV2CommandRequest,
} from "../../src/server/protocol.ts";
import { withAuth } from "../../src/transport.ts";

const enc = new TextEncoder();

// ── Mock fetch infrastructure ────────────────────────────────────────

let originalFetch: typeof globalThis.fetch;
let mockFn: ((req: Request) => Promise<Response>) | null = null;

function setMockFetch(fn: (req: Request) => Promise<Response>) {
	mockFn = fn;
}

beforeEach(() => {
	originalFetch = globalThis.fetch;
	globalThis.fetch = (async (input: string | Request, init?: RequestInit) => {
		if (!mockFn) throw new Error("No mock fetch configured");
		const req = new Request(input as string, init);
		return mockFn(req);
	}) as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	mockFn = null;
});

// ── Helpers ──────────────────────────────────────────────────────────

const HASH_A = "95dcfa3633004da0049d3d0fa03f80589cbcaf31";
const HASH_B = "d049f6c27a2244e12041955e262a404c7faba355";

const V2_CAPS = [
	"agent=just-git/1.0",
	"ls-refs=unborn",
	"fetch=shallow",
	"server-option",
	"object-format=sha1",
];

function v2AdvertResponse(caps: string[] = V2_CAPS, withServicePreamble = false): Response {
	const advert = buildV2CapabilityAdvertisement(caps);
	const body = withServicePreamble
		? concatPktLines(encodePktLine("# service=git-upload-pack\n"), flushPkt(), advert)
		: advert;
	return new Response(body, {
		headers: { "Content-Type": "application/x-git-upload-pack-advertisement" },
	});
}

const SAMPLE_CAPS: V2Capabilities = {
	raw: V2_CAPS,
	features: new Map([
		["agent", ["just-git/1.0"]],
		["ls-refs", ["unborn"]],
		["fetch", ["shallow"]],
		["server-option", []],
		["object-format", ["sha1"]],
	]),
	objectFormat: "sha1",
};

/** Caps that additionally advertise `ref-in-want` (`fetch=shallow ref-in-want`). */
const RIW_CAPS: V2Capabilities = {
	...SAMPLE_CAPS,
	features: new Map([...SAMPLE_CAPS.features, ["fetch", ["shallow", "ref-in-want"]]]),
};

/** A minimal but valid empty packfile (header + SHA-1 trailer). */
function emptyPack(): Uint8Array {
	// PACK + version 2 + 0 objects, then a 20-byte trailer (zeros are fine here;
	// these tests don't ingest, they just assert wire framing/parsing).
	const header = new Uint8Array([
		0x50, 0x41, 0x43, 0x4b, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00,
	]);
	const trailer = new Uint8Array(20);
	const out = new Uint8Array(header.byteLength + trailer.byteLength);
	out.set(header, 0);
	out.set(trailer, header.byteLength);
	return out;
}

// ── discoverV2Capabilities ───────────────────────────────────────────

describe("discoverV2Capabilities", () => {
	test("sends Git-Protocol: version=2 header on GET", async () => {
		setMockFetch(async (req) => {
			expect(req.url).toBe("https://github.com/test/repo.git/info/refs?service=git-upload-pack");
			expect(req.headers.get("Git-Protocol")).toBe("version=2");
			return v2AdvertResponse();
		});

		const result = await discoverV2Capabilities("https://github.com/test/repo.git");
		expect(result.version).toBe(2);
	});

	test("parses capability feature list into a Map", async () => {
		setMockFetch(async () => v2AdvertResponse());

		const result = await discoverV2Capabilities("https://example.com/repo.git");
		expect(result.version).toBe(2);
		if (result.version !== 2) throw new Error("expected v2");

		expect(result.caps.features.get("fetch")).toEqual(["shallow"]);
		expect(result.caps.features.get("ls-refs")).toEqual(["unborn"]);
		expect(result.caps.features.get("server-option")).toEqual([]);
		expect(result.caps.objectFormat).toBe("sha1");
		expect(result.caps.raw).toContain("fetch=shallow");
	});

	test("strips trailing slash from URL", async () => {
		setMockFetch(async (req) => {
			expect(req.url).toBe("https://example.com/repo.git/info/refs?service=git-upload-pack");
			return v2AdvertResponse();
		});
		await discoverV2Capabilities("https://example.com/repo.git/");
	});

	test("skips the optional # service preamble (GitHub-style)", async () => {
		setMockFetch(async () => v2AdvertResponse(V2_CAPS, true));

		const result = await discoverV2Capabilities("https://github.com/test/repo.git");
		expect(result.version).toBe(2);
		if (result.version !== 2) throw new Error("expected v2");
		expect(result.caps.features.get("fetch")).toEqual(["shallow"]);
	});

	test("falls back to v1 when server returns a v1 advertisement", async () => {
		const v1Body = concatPktLines(
			encodePktLine("# service=git-upload-pack\n"),
			flushPkt(),
			encodePktLine(`${HASH_A} HEAD\0side-band-64k symref=HEAD:refs/heads/main\n`),
			encodePktLine(`${HASH_A} refs/heads/main\n`),
			flushPkt(),
		);
		setMockFetch(
			async () =>
				new Response(v1Body, {
					headers: { "Content-Type": "application/x-git-upload-pack-advertisement" },
				}),
		);

		const result = await discoverV2Capabilities("https://example.com/repo.git");
		expect(result.version).toBe(1);
		if (result.version !== 1) throw new Error("expected v1");
		expect(result.v1.refs).toHaveLength(2);
		expect(result.v1.symrefs.get("HEAD")).toBe("refs/heads/main");
	});

	test("defaults object-format to sha1 when unadvertised", async () => {
		setMockFetch(async () => v2AdvertResponse(["agent=just-git/1.0", "fetch=shallow", "ls-refs"]));
		const result = await discoverV2Capabilities("https://example.com/repo.git");
		if (result.version !== 2) throw new Error("expected v2");
		expect(result.caps.objectFormat).toBe("sha1");
	});

	test("surfaces a non-sha1 object-format for the transport to reject", async () => {
		setMockFetch(async () => v2AdvertResponse([...V2_CAPS.slice(0, -1), "object-format=sha256"]));
		const result = await discoverV2Capabilities("https://example.com/repo.git");
		if (result.version !== 2) throw new Error("expected v2");
		expect(result.caps.objectFormat).toBe("sha256");
	});

	test("throws on HTTP error", async () => {
		setMockFetch(async () => new Response("nope", { status: 404 }));
		await expect(discoverV2Capabilities("https://example.com/repo.git")).rejects.toThrow(
			"HTTP 404",
		);
	});

	test("throws on a dumb (non-pkt-line) server", async () => {
		setMockFetch(
			async () => new Response("plain text", { headers: { "Content-Type": "text/plain" } }),
		);
		await expect(discoverV2Capabilities("https://example.com/repo.git")).rejects.toThrow(
			"does not support smart HTTP",
		);
	});
});

// ── lsRefs ───────────────────────────────────────────────────────────

describe("lsRefs", () => {
	test("sends a well-formed ls-refs command with symrefs + peel", async () => {
		setMockFetch(async (req) => {
			expect(req.url).toBe("https://github.com/test/repo.git/git-upload-pack");
			expect(req.method).toBe("POST");
			expect(req.headers.get("Content-Type")).toBe("application/x-git-upload-pack-request");
			expect(req.headers.get("Git-Protocol")).toBe("version=2");

			const body = new Uint8Array(await req.arrayBuffer());
			const cmd = parseV2CommandRequest(body);
			expect(cmd.command).toBe("ls-refs");
			expect(cmd.capabilities).toContain("object-format=sha1");
			expect(cmd.capabilities).toContain("agent=just-git/1.0");
			expect(cmd.args).toContain("symrefs");
			expect(cmd.args).toContain("peel");

			return new Response(
				buildV2LsRefsResponse([
					{ hash: HASH_A, name: "HEAD", symrefTarget: "refs/heads/main" },
					{ hash: HASH_A, name: "refs/heads/main" },
				]),
				{ headers: { "Content-Type": "application/x-git-upload-pack-result" } },
			);
		});

		const result = await lsRefs("https://github.com/test/repo.git", SAMPLE_CAPS, undefined, {
			symrefs: true,
			peel: true,
		});

		expect(result.refs).toHaveLength(2);
		expect(result.refs[0]).toEqual({ name: "HEAD", hash: HASH_A });
		expect(result.refs[1]).toEqual({ name: "refs/heads/main", hash: HASH_A });
		expect(result.headTarget).toBe("refs/heads/main");
	});

	test("sends ref-prefix args", async () => {
		setMockFetch(async (req) => {
			const body = new Uint8Array(await req.arrayBuffer());
			const cmd = parseV2CommandRequest(body);
			expect(cmd.args).toContain("ref-prefix refs/heads/");
			expect(cmd.args).toContain("ref-prefix refs/tags/");
			return new Response(buildV2LsRefsResponse([{ hash: HASH_A, name: "refs/heads/main" }]), {
				headers: { "Content-Type": "application/x-git-upload-pack-result" },
			});
		});

		await lsRefs("https://github.com/test/repo.git", SAMPLE_CAPS, undefined, {
			refPrefixes: ["refs/heads/", "refs/tags/"],
		});
	});

	test("parses peeled tag attributes", async () => {
		setMockFetch(
			async () =>
				new Response(
					buildV2LsRefsResponse([
						{ hash: HASH_A, name: "refs/tags/v1.0", peeledHash: HASH_B },
						{ hash: HASH_B, name: "refs/tags/v2.0" },
					]),
					{ headers: { "Content-Type": "application/x-git-upload-pack-result" } },
				),
		);

		const result = await lsRefs("https://example.com/repo.git", SAMPLE_CAPS);
		const v1 = result.refs.find((r) => r.name === "refs/tags/v1.0");
		expect(v1?.peeledHash).toBe(HASH_B);
		const v2 = result.refs.find((r) => r.name === "refs/tags/v2.0");
		expect(v2?.peeledHash).toBeUndefined();
	});

	test("handles an empty repository (flush-only response)", async () => {
		setMockFetch(
			async () =>
				new Response(buildV2LsRefsResponse([]), {
					headers: { "Content-Type": "application/x-git-upload-pack-result" },
				}),
		);
		const result = await lsRefs("https://example.com/repo.git", SAMPLE_CAPS);
		expect(result.refs).toHaveLength(0);
		expect(result.headTarget).toBeUndefined();
	});

	test("echoes the server's object-format back", async () => {
		const sha256Caps: V2Capabilities = { ...SAMPLE_CAPS, objectFormat: "sha256" };
		setMockFetch(async (req) => {
			const cmd = parseV2CommandRequest(new Uint8Array(await req.arrayBuffer()));
			expect(cmd.capabilities).toContain("object-format=sha256");
			return new Response(buildV2LsRefsResponse([]), {
				headers: { "Content-Type": "application/x-git-upload-pack-result" },
			});
		});
		await lsRefs("https://example.com/repo.git", sha256Caps);
	});

	test("forwards auth headers", async () => {
		setMockFetch(async (req) => {
			expect(req.headers.get("Authorization")).toBe(`Bearer tok-123`);
			return new Response(buildV2LsRefsResponse([{ hash: HASH_A, name: "refs/heads/main" }]), {
				headers: { "Content-Type": "application/x-git-upload-pack-result" },
			});
		});
		await lsRefs(
			"https://example.com/repo.git",
			SAMPLE_CAPS,
			withAuth({ type: "bearer", token: "tok-123" })(globalThis.fetch),
		);
	});
});

// ── fetchPackV2 ──────────────────────────────────────────────────────

describe("fetchPackV2", () => {
	test("sends a well-formed fetch command (single-round done)", async () => {
		setMockFetch(async (req) => {
			expect(req.url).toBe("https://github.com/test/repo.git/git-upload-pack");
			expect(req.headers.get("Git-Protocol")).toBe("version=2");

			const body = new Uint8Array(await req.arrayBuffer());
			const cmd = parseV2CommandRequest(body);
			expect(cmd.command).toBe("fetch");
			expect(cmd.capabilities).toContain("object-format=sha1");
			expect(cmd.args).toContain("ofs-delta");
			expect(cmd.args).toContain(`want ${HASH_A}`);
			expect(cmd.args).toContain(`have ${HASH_B}`);
			expect(cmd.args).toContain("done");

			return new Response(buildV2FetchResponse(emptyPack()), {
				headers: { "Content-Type": "application/x-git-upload-pack-result" },
			});
		});

		const result = await fetchPackV2(
			"https://github.com/test/repo.git",
			[HASH_A],
			[HASH_B],
			SAMPLE_CAPS,
		);
		expect(result.packData.byteLength).toBe(32);
		expect(result.packData[0]).toBe(0x50); // 'P'
	});

	test("parses the packfile section (fresh clone, no acks)", async () => {
		const pack = enc.encode("PACKDATA-HERE-1234567890123456789012");
		setMockFetch(
			async () =>
				new Response(buildV2FetchResponse(pack), {
					headers: { "Content-Type": "application/x-git-upload-pack-result" },
				}),
		);

		const result = await fetchPackV2("https://example.com/repo.git", [HASH_A], [], SAMPLE_CAPS);
		expect(new TextDecoder().decode(result.packData)).toBe("PACKDATA-HERE-1234567890123456789012");
		expect(result.acks).toEqual([]);
	});

	test("parses acknowledgments + packfile (incremental fetch)", async () => {
		const pack = enc.encode("INCREMENTAL-PACK-DATA");
		setMockFetch(
			async () =>
				new Response(buildV2FetchResponse(pack, { commonHashes: [HASH_B] }), {
					headers: { "Content-Type": "application/x-git-upload-pack-result" },
				}),
		);

		const result = await fetchPackV2(
			"https://example.com/repo.git",
			[HASH_A],
			[HASH_B],
			SAMPLE_CAPS,
		);
		expect(result.acks).toContain(`ACK ${HASH_B}`);
		expect(new TextDecoder().decode(result.packData)).toBe("INCREMENTAL-PACK-DATA");
	});

	test("parses the shallow-info section", async () => {
		const pack = enc.encode("SHALLOW-PACK");
		setMockFetch(
			async () =>
				new Response(
					buildV2FetchResponse(pack, { shallowInfo: { shallow: [HASH_A], unshallow: [HASH_B] } }),
					{ headers: { "Content-Type": "application/x-git-upload-pack-result" } },
				),
		);

		const result = await fetchPackV2(
			"https://example.com/repo.git",
			[HASH_A],
			[],
			SAMPLE_CAPS,
			undefined,
			{ depth: 1 },
		);
		expect(result.shallowLines).toEqual([HASH_A]);
		expect(result.unshallowLines).toEqual([HASH_B]);
		expect(new TextDecoder().decode(result.packData)).toBe("SHALLOW-PACK");
	});

	test("sends shallow/deepen args when depth is requested", async () => {
		setMockFetch(async (req) => {
			const cmd = parseV2CommandRequest(new Uint8Array(await req.arrayBuffer()));
			expect(cmd.args).toContain("deepen 5");
			expect(cmd.args).toContain(`shallow ${HASH_B}`);
			return new Response(buildV2FetchResponse(emptyPack()), {
				headers: { "Content-Type": "application/x-git-upload-pack-result" },
			});
		});

		await fetchPackV2("https://example.com/repo.git", [HASH_A], [], SAMPLE_CAPS, undefined, {
			depth: 5,
			existingShallows: new Set([HASH_B]),
		});
	});

	test("parses the wanted-refs section", async () => {
		const pack = enc.encode("WANTED-REF-PACK");
		setMockFetch(
			async () =>
				new Response(
					buildV2FetchResponse(pack, {
						wantedRefs: [{ hash: HASH_A, name: "refs/heads/main" }],
					}),
					{ headers: { "Content-Type": "application/x-git-upload-pack-result" } },
				),
		);

		const result = await fetchPackV2("https://example.com/repo.git", [HASH_A], [], SAMPLE_CAPS);
		expect(result.wantedRefs).toEqual([{ hash: HASH_A, name: "refs/heads/main" }]);
	});

	test("reports band-2 progress", async () => {
		// Hand-build a packfile section with a band-2 progress packet.
		const sbProgress = new Uint8Array(1 + enc.encode("Counting objects\n").byteLength);
		sbProgress[0] = 2;
		sbProgress.set(enc.encode("Counting objects\n"), 1);
		const sbData = new Uint8Array(1 + enc.encode("PACKBYTES").byteLength);
		sbData[0] = 1;
		sbData.set(enc.encode("PACKBYTES"), 1);

		const body = concatPktLines(
			encodePktLine("packfile\n"),
			encodePktLine(sbProgress),
			encodePktLine(sbData),
			flushPkt(),
		);
		setMockFetch(
			async () =>
				new Response(body, {
					headers: { "Content-Type": "application/x-git-upload-pack-result" },
				}),
		);

		const progress: string[] = [];
		const result = await fetchPackV2(
			"https://example.com/repo.git",
			[HASH_A],
			[],
			SAMPLE_CAPS,
			undefined,
			undefined,
			(msg) => progress.push(msg),
		);
		expect(new TextDecoder().decode(result.packData)).toBe("PACKBYTES");
		expect(progress).toContain("Counting objects\n");
	});

	test("throws on a band-3 remote error", async () => {
		const sbError = new Uint8Array(1 + enc.encode("access denied").byteLength);
		sbError[0] = 3;
		sbError.set(enc.encode("access denied"), 1);
		const body = concatPktLines(encodePktLine("packfile\n"), encodePktLine(sbError), flushPkt());
		setMockFetch(
			async () =>
				new Response(body, {
					headers: { "Content-Type": "application/x-git-upload-pack-result" },
				}),
		);

		await expect(
			fetchPackV2("https://example.com/repo.git", [HASH_A], [], SAMPLE_CAPS),
		).rejects.toThrow("Remote error");
	});

	test("throws when shallow is requested but unsupported", async () => {
		const noShallow: V2Capabilities = {
			...SAMPLE_CAPS,
			features: new Map([["fetch", []]]),
		};
		await expect(
			fetchPackV2("https://example.com/repo.git", [HASH_A], [], noShallow, undefined, {
				depth: 1,
			}),
		).rejects.toThrow("shallow");
	});

	test("throws on empty wants", async () => {
		await expect(fetchPackV2("https://example.com/repo.git", [], [], SAMPLE_CAPS)).rejects.toThrow(
			"at least one want",
		);
	});

	test("emits want-ref when ref-in-want is advertised (ref-only request)", async () => {
		setMockFetch(async (req) => {
			const cmd = parseV2CommandRequest(new Uint8Array(await req.arrayBuffer()));
			expect(cmd.command).toBe("fetch");
			expect(cmd.args).toContain("want-ref refs/heads/main");
			expect(cmd.args.some((a) => a.startsWith("want "))).toBe(false);
			return new Response(
				buildV2FetchResponse(emptyPack(), {
					wantedRefs: [{ hash: HASH_A, name: "refs/heads/main" }],
				}),
				{ headers: { "Content-Type": "application/x-git-upload-pack-result" } },
			);
		});

		const result = await fetchPackV2(
			"https://example.com/repo.git",
			[],
			[],
			RIW_CAPS,
			undefined,
			undefined,
			undefined,
			["refs/heads/main"],
		);
		expect(result.wantedRefs).toEqual([{ hash: HASH_A, name: "refs/heads/main" }]);
	});

	test("emits mixed want + want-ref in one request", async () => {
		setMockFetch(async (req) => {
			const cmd = parseV2CommandRequest(new Uint8Array(await req.arrayBuffer()));
			expect(cmd.args).toContain(`want ${HASH_A}`);
			expect(cmd.args).toContain("want-ref refs/heads/dev");
			return new Response(
				buildV2FetchResponse(emptyPack(), {
					wantedRefs: [{ hash: HASH_B, name: "refs/heads/dev" }],
				}),
				{ headers: { "Content-Type": "application/x-git-upload-pack-result" } },
			);
		});

		const result = await fetchPackV2(
			"https://example.com/repo.git",
			[HASH_A],
			[],
			RIW_CAPS,
			undefined,
			undefined,
			undefined,
			["refs/heads/dev"],
		);
		expect(result.wantedRefs).toEqual([{ hash: HASH_B, name: "refs/heads/dev" }]);
	});

	test("throws when want-ref is requested but ref-in-want is unadvertised", async () => {
		await expect(
			fetchPackV2(
				"https://example.com/repo.git",
				[],
				[],
				SAMPLE_CAPS,
				undefined,
				undefined,
				undefined,
				["refs/heads/main"],
			),
		).rejects.toThrow("ref-in-want");
	});
});
