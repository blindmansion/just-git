import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	concatPktLines,
	encodePktLine,
	flushPkt,
	parsePktLineStream,
	pktLineText,
} from "../../src/lib/transport/pkt-line.ts";
import { discoverRefs, fetchPack, pushPack } from "../../src/lib/transport/smart-http.ts";

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
		const req = typeof input === "string" ? new Request(input, init) : new Request(input, init);
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
const ZERO = "0000000000000000000000000000000000000000";

function buildRefAdvert(
	service: string,
	refs: Array<{ hash: string; name: string }>,
	caps: string = "multi_ack_detailed no-done side-band-64k ofs-delta thin-pack include-tag symref=HEAD:refs/heads/main",
) {
	const lines: Uint8Array[] = [];
	lines.push(encodePktLine(`# service=${service}\n`));
	lines.push(flushPkt());
	for (let i = 0; i < refs.length; i++) {
		const r = refs[i]!;
		if (i === 0) {
			lines.push(encodePktLine(`${r.hash} ${r.name}\0${caps}\n`));
		} else {
			lines.push(encodePktLine(`${r.hash} ${r.name}\n`));
		}
	}
	lines.push(flushPkt());
	return concatPktLines(...lines);
}

// ── discoverRefs ─────────────────────────────────────────────────────

describe("discoverRefs", () => {
	test("parses smart server ref advertisement", async () => {
		const body = buildRefAdvert("git-upload-pack", [
			{ hash: HASH_A, name: "HEAD" },
			{ hash: HASH_A, name: "refs/heads/main" },
			{ hash: HASH_B, name: "refs/heads/dev" },
		]);

		setMockFetch(async (req) => {
			expect(req.url).toBe("https://github.com/test/repo.git/info/refs?service=git-upload-pack");
			return new Response(body, {
				headers: {
					"Content-Type": "application/x-git-upload-pack-advertisement",
				},
			});
		});

		const result = await discoverRefs("https://github.com/test/repo.git", "git-upload-pack");

		expect(result.refs).toHaveLength(3);
		expect(result.refs[0]).toEqual({ name: "HEAD", hash: HASH_A });
		expect(result.refs[1]).toEqual({ name: "refs/heads/main", hash: HASH_A });
		expect(result.refs[2]).toEqual({ name: "refs/heads/dev", hash: HASH_B });
		expect(result.capabilities).toContain("side-band-64k");
		expect(result.symrefs.get("HEAD")).toBe("refs/heads/main");
	});

	test("strips trailing slash from URL", async () => {
		setMockFetch(async (req) => {
			expect(req.url).toBe("https://example.com/repo.git/info/refs?service=git-upload-pack");
			return new Response(buildRefAdvert("git-upload-pack", [{ hash: HASH_A, name: "HEAD" }]), {
				headers: {
					"Content-Type": "application/x-git-upload-pack-advertisement",
				},
			});
		});

		await discoverRefs("https://example.com/repo.git/", "git-upload-pack");
	});

	test("sends auth header when provided", async () => {
		setMockFetch(async (req) => {
			const authHeader = req.headers.get("Authorization");
			expect(authHeader).toBe(`Bearer test-token-123`);
			return new Response(buildRefAdvert("git-upload-pack", [{ hash: HASH_A, name: "HEAD" }]), {
				headers: {
					"Content-Type": "application/x-git-upload-pack-advertisement",
				},
			});
		});

		await discoverRefs("https://github.com/repo.git", "git-upload-pack", {
			type: "bearer",
			token: "test-token-123",
		});
	});

	test("handles empty repo (capabilities^{})", async () => {
		const body = concatPktLines(
			encodePktLine("# service=git-upload-pack\n"),
			flushPkt(),
			encodePktLine(`${ZERO} capabilities^{}\0side-band-64k ofs-delta\n`),
			flushPkt(),
		);

		setMockFetch(
			async () =>
				new Response(body, {
					headers: {
						"Content-Type": "application/x-git-upload-pack-advertisement",
					},
				}),
		);

		const result = await discoverRefs("https://github.com/empty.git", "git-upload-pack");
		expect(result.refs).toHaveLength(0);
		expect(result.capabilities).toContain("side-band-64k");
	});

	test("throws on HTTP error", async () => {
		setMockFetch(async () => new Response("Not found", { status: 404 }));

		await expect(discoverRefs("https://github.com/nope.git", "git-upload-pack")).rejects.toThrow(
			"HTTP 404",
		);
	});

	test("throws on dumb server", async () => {
		setMockFetch(
			async () =>
				new Response("plain text refs", {
					headers: { "Content-Type": "text/plain" },
				}),
		);

		await expect(discoverRefs("https://example.com/repo.git", "git-upload-pack")).rejects.toThrow(
			"does not support smart HTTP",
		);
	});

	test("attaches peeled hash to annotated tags", async () => {
		const TAG_HASH = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
		const COMMIT_HASH = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

		const lines: Uint8Array[] = [];
		lines.push(encodePktLine("# service=git-upload-pack\n"));
		lines.push(flushPkt());
		lines.push(encodePktLine(`${HASH_A} HEAD\0side-band-64k symref=HEAD:refs/heads/main\n`));
		lines.push(encodePktLine(`${HASH_A} refs/heads/main\n`));
		lines.push(encodePktLine(`${TAG_HASH} refs/tags/v1.0\n`));
		lines.push(encodePktLine(`${COMMIT_HASH} refs/tags/v1.0^{}\n`));
		lines.push(encodePktLine(`${HASH_B} refs/tags/v2.0\n`));
		lines.push(flushPkt());
		const body = concatPktLines(...lines);

		setMockFetch(
			async () =>
				new Response(body, {
					headers: {
						"Content-Type": "application/x-git-upload-pack-advertisement",
					},
				}),
		);

		const result = await discoverRefs("https://github.com/test/repo.git", "git-upload-pack");

		expect(result.refs).toHaveLength(4);
		const v1Tag = result.refs.find((r) => r.name === "refs/tags/v1.0");
		expect(v1Tag).toBeDefined();
		expect(v1Tag!.hash).toBe(TAG_HASH);
		expect(v1Tag!.peeledHash).toBe(COMMIT_HASH);

		const v2Tag = result.refs.find((r) => r.name === "refs/tags/v2.0");
		expect(v2Tag).toBeDefined();
		expect(v2Tag!.peeledHash).toBeUndefined();
	});

	test("handles receive-pack service for push", async () => {
		const body = buildRefAdvert(
			"git-receive-pack",
			[{ hash: HASH_A, name: "refs/heads/main" }],
			"report-status delete-refs ofs-delta",
		);

		setMockFetch(async (req) => {
			expect(req.url).toContain("service=git-receive-pack");
			return new Response(body, {
				headers: {
					"Content-Type": "application/x-git-receive-pack-advertisement",
				},
			});
		});

		const result = await discoverRefs("https://github.com/repo.git", "git-receive-pack");
		expect(result.refs).toHaveLength(1);
		expect(result.capabilities).toContain("report-status");
	});

	test("parses multiple symrefs", async () => {
		const body = buildRefAdvert(
			"git-upload-pack",
			[
				{ hash: HASH_A, name: "HEAD" },
				{ hash: HASH_A, name: "refs/heads/main" },
			],
			"side-band-64k symref=HEAD:refs/heads/main symref=refs/remotes/origin/HEAD:refs/remotes/origin/main",
		);

		setMockFetch(
			async () =>
				new Response(body, {
					headers: {
						"Content-Type": "application/x-git-upload-pack-advertisement",
					},
				}),
		);

		const result = await discoverRefs("https://github.com/repo.git", "git-upload-pack");
		expect(result.symrefs.size).toBe(2);
		expect(result.symrefs.get("HEAD")).toBe("refs/heads/main");
		expect(result.symrefs.get("refs/remotes/origin/HEAD")).toBe("refs/remotes/origin/main");
	});

	test("sends basic auth header", async () => {
		setMockFetch(async (req) => {
			const authHeader = req.headers.get("Authorization");
			expect(authHeader).toBe(`Basic ${btoa("alice:s3cret")}`);
			return new Response(buildRefAdvert("git-upload-pack", [{ hash: HASH_A, name: "HEAD" }]), {
				headers: {
					"Content-Type": "application/x-git-upload-pack-advertisement",
				},
			});
		});

		await discoverRefs("https://github.com/repo.git", "git-upload-pack", {
			type: "basic",
			username: "alice",
			password: "s3cret",
		});
	});

	test("throws on HTTP 401 (unauthorized)", async () => {
		setMockFetch(async () => new Response("Unauthorized", { status: 401 }));

		await expect(discoverRefs("https://github.com/private.git", "git-upload-pack")).rejects.toThrow(
			"HTTP 401",
		);
	});

	test("throws on HTTP 500 (server error)", async () => {
		setMockFetch(async () => new Response("Internal error", { status: 500 }));

		await expect(discoverRefs("https://github.com/repo.git", "git-upload-pack")).rejects.toThrow(
			"HTTP 500",
		);
	});

	test("parses single-ref repo (HEAD only)", async () => {
		const body = buildRefAdvert("git-upload-pack", [{ hash: HASH_A, name: "HEAD" }]);

		setMockFetch(
			async () =>
				new Response(body, {
					headers: {
						"Content-Type": "application/x-git-upload-pack-advertisement",
					},
				}),
		);

		const result = await discoverRefs("https://github.com/repo.git", "git-upload-pack");
		expect(result.refs).toHaveLength(1);
		expect(result.refs[0]!.name).toBe("HEAD");
		expect(result.capabilities.length).toBeGreaterThan(0);
	});

	test("handles repo with many refs", async () => {
		const refs = [{ hash: HASH_A, name: "HEAD" }];
		for (let i = 0; i < 100; i++) {
			const hash = HASH_A.slice(0, -3) + i.toString().padStart(3, "0");
			refs.push({ hash, name: `refs/heads/branch-${i}` });
		}

		const body = buildRefAdvert("git-upload-pack", refs);
		setMockFetch(
			async () =>
				new Response(body, {
					headers: {
						"Content-Type": "application/x-git-upload-pack-advertisement",
					},
				}),
		);

		const result = await discoverRefs("https://github.com/repo.git", "git-upload-pack");
		expect(result.refs).toHaveLength(101);
	});

	test("handles refs without capabilities (no NUL byte)", async () => {
		const lines: Uint8Array[] = [];
		lines.push(encodePktLine("# service=git-upload-pack\n"));
		lines.push(flushPkt());
		lines.push(encodePktLine(`${HASH_A} HEAD\0side-band-64k\n`));
		lines.push(encodePktLine(`${HASH_B} refs/heads/main\n`));
		lines.push(flushPkt());
		const body = concatPktLines(...lines);

		setMockFetch(
			async () =>
				new Response(body, {
					headers: {
						"Content-Type": "application/x-git-upload-pack-advertisement",
					},
				}),
		);

		const result = await discoverRefs("https://github.com/repo.git", "git-upload-pack");
		expect(result.refs).toHaveLength(2);
		expect(result.refs[1]!.name).toBe("refs/heads/main");
	});

	test("includes User-Agent header", async () => {
		setMockFetch(async (req) => {
			expect(req.headers.get("User-Agent")).toBe("just-git/1.0");
			return new Response(buildRefAdvert("git-upload-pack", [{ hash: HASH_A, name: "HEAD" }]), {
				headers: {
					"Content-Type": "application/x-git-upload-pack-advertisement",
				},
			});
		});

		await discoverRefs("https://github.com/repo.git", "git-upload-pack");
	});

	test("handles multiple peeled tags in sequence", async () => {
		const TAG1 = "1111111111111111111111111111111111111111";
		const TAG2 = "2222222222222222222222222222222222222222";
		const PEEL1 = "3333333333333333333333333333333333333333";
		const PEEL2 = "4444444444444444444444444444444444444444";

		const lines: Uint8Array[] = [];
		lines.push(encodePktLine("# service=git-upload-pack\n"));
		lines.push(flushPkt());
		lines.push(encodePktLine(`${HASH_A} HEAD\0side-band-64k\n`));
		lines.push(encodePktLine(`${TAG1} refs/tags/v1.0\n`));
		lines.push(encodePktLine(`${PEEL1} refs/tags/v1.0^{}\n`));
		lines.push(encodePktLine(`${TAG2} refs/tags/v2.0\n`));
		lines.push(encodePktLine(`${PEEL2} refs/tags/v2.0^{}\n`));
		lines.push(flushPkt());
		const body = concatPktLines(...lines);

		setMockFetch(
			async () =>
				new Response(body, {
					headers: {
						"Content-Type": "application/x-git-upload-pack-advertisement",
					},
				}),
		);

		const result = await discoverRefs("https://github.com/repo.git", "git-upload-pack");

		const v1 = result.refs.find((r) => r.name === "refs/tags/v1.0");
		const v2 = result.refs.find((r) => r.name === "refs/tags/v2.0");
		expect(v1!.peeledHash).toBe(PEEL1);
		expect(v2!.peeledHash).toBe(PEEL2);
	});
});

// ── fetchPack ────────────────────────────────────────────────────────

describe("fetchPack", () => {
	function buildFetchResponse(
		ackLines: string[],
		packBytes: Uint8Array,
		useSideband: boolean,
	): Uint8Array {
		const parts: Uint8Array[] = [];

		for (const ack of ackLines) {
			parts.push(encodePktLine(`${ack}\n`));
		}

		if (useSideband) {
			// Wrap pack in sideband channel 1
			const sbData = new Uint8Array(1 + packBytes.byteLength);
			sbData[0] = 1;
			sbData.set(packBytes, 1);
			parts.push(encodePktLine(sbData));

			// Add a progress message
			const progressMsg = enc.encode("Counting objects: 3\n");
			const sbProgress = new Uint8Array(1 + progressMsg.byteLength);
			sbProgress[0] = 2;
			sbProgress.set(progressMsg, 1);
			parts.push(encodePktLine(sbProgress));

			parts.push(flushPkt());
		} else {
			parts.push(encodePktLine(packBytes));
		}

		return concatPktLines(...parts);
	}

	test("sends correct request and parses sideband response", async () => {
		const fakePack = enc.encode("PACK-DATA");

		setMockFetch(async (req) => {
			expect(req.url).toBe("https://github.com/test/repo.git/git-upload-pack");
			expect(req.headers.get("Content-Type")).toBe("application/x-git-upload-pack-request");

			// Verify request body
			const body = new Uint8Array(await req.arrayBuffer());
			const lines = parsePktLineStream(body);
			const firstWant = pktLineText(lines[0]!);
			expect(firstWant).toContain(`want ${HASH_A}`);
			expect(firstWant).toContain("side-band-64k");

			const response = buildFetchResponse(["NAK"], fakePack, true);
			return new Response(response, {
				headers: {
					"Content-Type": "application/x-git-upload-pack-result",
				},
			});
		});

		const result = await fetchPack(
			"https://github.com/test/repo.git",
			[HASH_A],
			[],
			["multi_ack_detailed", "no-done", "side-band-64k", "ofs-delta"],
		);

		expect(result.acks).toEqual(["NAK"]);
		expect(new TextDecoder().decode(result.packData)).toBe("PACK-DATA");
		expect(result.progress).toContain("Counting objects: 3\n");
	});

	test("sends multiple wants and haves", async () => {
		setMockFetch(async (req) => {
			const body = new Uint8Array(await req.arrayBuffer());
			const lines = parsePktLineStream(body);
			const texts = lines.map((l) => (l.type === "data" ? pktLineText(l) : "FLUSH"));

			// Two wants, then flush, then one have, then done
			expect(texts[0]).toContain(`want ${HASH_A}`);
			expect(texts[1]).toBe(`want ${HASH_B}`);
			expect(texts[2]).toBe("FLUSH");
			expect(texts[3]).toBe(`have ${HASH_A}`);
			expect(texts[4]).toBe("done");

			return new Response(buildFetchResponse(["NAK"], enc.encode("P"), true), {
				headers: {
					"Content-Type": "application/x-git-upload-pack-result",
				},
			});
		});

		await fetchPack(
			"https://github.com/test/repo.git",
			[HASH_A, HASH_B],
			[HASH_A],
			["side-band-64k"],
		);
	});

	test("only advertises capabilities server supports", async () => {
		setMockFetch(async (req) => {
			const body = new Uint8Array(await req.arrayBuffer());
			const lines = parsePktLineStream(body);
			const firstWant = pktLineText(lines[0]!);

			// Server only supports side-band-64k and ofs-delta
			expect(firstWant).toContain("side-band-64k");
			expect(firstWant).toContain("ofs-delta");
			expect(firstWant).not.toContain("thin-pack");
			expect(firstWant).not.toContain("no-done");

			return new Response(buildFetchResponse(["NAK"], enc.encode("P"), true), {
				headers: {
					"Content-Type": "application/x-git-upload-pack-result",
				},
			});
		});

		await fetchPack(
			"https://github.com/test/repo.git",
			[HASH_A],
			[],
			["side-band-64k", "ofs-delta"],
		);
	});

	test("handles auth with basic credentials", async () => {
		setMockFetch(async (req) => {
			const authHeader = req.headers.get("Authorization");
			expect(authHeader).toBe(`Basic ${btoa("user:pass")}`);
			return new Response(buildFetchResponse(["NAK"], enc.encode("P"), true), {
				headers: {
					"Content-Type": "application/x-git-upload-pack-result",
				},
			});
		});

		await fetchPack("https://github.com/repo.git", [HASH_A], [], ["side-band-64k"], {
			type: "basic",
			username: "user",
			password: "pass",
		});
	});

	test("throws on empty wants", async () => {
		await expect(fetchPack("https://github.com/repo.git", [], [], [])).rejects.toThrow(
			"at least one want",
		);
	});

	test("throws on HTTP error", async () => {
		setMockFetch(async () => new Response("error", { status: 403 }));
		await expect(fetchPack("https://github.com/repo.git", [HASH_A], [], [])).rejects.toThrow(
			"HTTP 403",
		);
	});

	test("throws on remote error via sideband", async () => {
		const parts: Uint8Array[] = [];
		parts.push(encodePktLine("NAK\n"));
		const errorMsg = enc.encode("fatal: access denied");
		const sbError = new Uint8Array(1 + errorMsg.byteLength);
		sbError[0] = 3;
		sbError.set(errorMsg, 1);
		parts.push(encodePktLine(sbError));
		parts.push(flushPkt());

		setMockFetch(
			async () =>
				new Response(concatPktLines(...parts), {
					headers: {
						"Content-Type": "application/x-git-upload-pack-result",
					},
				}),
		);

		await expect(
			fetchPack("https://github.com/repo.git", [HASH_A], [], ["side-band-64k"]),
		).rejects.toThrow("Remote error");
	});

	test("parses ACK <hash> (simple ACK)", async () => {
		const response = buildFetchResponse([`ACK ${HASH_A}`], enc.encode("PACK"), true);

		setMockFetch(
			async () =>
				new Response(response, {
					headers: { "Content-Type": "application/x-git-upload-pack-result" },
				}),
		);

		const result = await fetchPack(
			"https://github.com/repo.git",
			[HASH_B],
			[HASH_A],
			["side-band-64k"],
		);
		expect(result.acks).toEqual([`ACK ${HASH_A}`]);
	});

	test("parses ACK <hash> continue (multi_ack_detailed)", async () => {
		const response = buildFetchResponse(
			[`ACK ${HASH_A} continue`, `ACK ${HASH_B} ready`, "NAK"],
			enc.encode("PACK"),
			true,
		);

		setMockFetch(
			async () =>
				new Response(response, {
					headers: { "Content-Type": "application/x-git-upload-pack-result" },
				}),
		);

		const result = await fetchPack(
			"https://github.com/repo.git",
			[HASH_B],
			[HASH_A],
			["multi_ack_detailed", "side-band-64k"],
		);
		expect(result.acks).toEqual([`ACK ${HASH_A} continue`, `ACK ${HASH_B} ready`, "NAK"]);
	});

	test("parses ACK <hash> common (multi_ack)", async () => {
		const response = buildFetchResponse([`ACK ${HASH_A} common`], enc.encode("PACK"), true);

		setMockFetch(
			async () =>
				new Response(response, {
					headers: { "Content-Type": "application/x-git-upload-pack-result" },
				}),
		);

		const result = await fetchPack(
			"https://github.com/repo.git",
			[HASH_B],
			[HASH_A],
			["side-band-64k"],
		);
		expect(result.acks).toEqual([`ACK ${HASH_A} common`]);
	});

	test("handles non-sideband response (raw pack)", async () => {
		const fakePack = enc.encode("PACK\x00\x00\x00\x02\x00\x00\x00\x00");

		setMockFetch(async () => {
			const parts: Uint8Array[] = [];
			parts.push(encodePktLine("NAK\n"));
			parts.push(encodePktLine(fakePack));
			return new Response(concatPktLines(...parts), {
				headers: { "Content-Type": "application/x-git-upload-pack-result" },
			});
		});

		const result = await fetchPack("https://github.com/repo.git", [HASH_A], [], ["ofs-delta"]);
		expect(result.acks).toEqual(["NAK"]);
		expect(result.packData.byteLength).toBe(fakePack.byteLength);
		expect(result.progress).toEqual([]);
	});

	test("handles multiple sideband chunks", async () => {
		const chunk1 = new Uint8Array([0x50, 0x41, 0x43, 0x4b]); // "PACK"
		const chunk2 = new Uint8Array([0x00, 0x00, 0x00, 0x02]);
		const chunk3 = new Uint8Array([0x00, 0x00, 0x00, 0x00]);

		const parts: Uint8Array[] = [];
		parts.push(encodePktLine("NAK\n"));

		for (const chunk of [chunk1, chunk2, chunk3]) {
			const sb = new Uint8Array(1 + chunk.byteLength);
			sb[0] = 1;
			sb.set(chunk, 1);
			parts.push(encodePktLine(sb));
		}

		const progressMsg = enc.encode("Resolving deltas: 100%\n");
		const sbProgress = new Uint8Array(1 + progressMsg.byteLength);
		sbProgress[0] = 2;
		sbProgress.set(progressMsg, 1);
		parts.push(encodePktLine(sbProgress));
		parts.push(flushPkt());

		setMockFetch(
			async () =>
				new Response(concatPktLines(...parts), {
					headers: { "Content-Type": "application/x-git-upload-pack-result" },
				}),
		);

		const result = await fetchPack("https://github.com/repo.git", [HASH_A], [], ["side-band-64k"]);
		expect(result.packData.byteLength).toBe(12);
		expect(result.packData[0]).toBe(0x50); // 'P'
		expect(result.progress).toContain("Resolving deltas: 100%\n");
	});

	test("handles response with flush between ACKs and pack", async () => {
		const parts: Uint8Array[] = [];
		parts.push(encodePktLine(`ACK ${HASH_A}\n`));
		parts.push(flushPkt());

		const packData = enc.encode("PACK-AFTER-FLUSH");
		const sb = new Uint8Array(1 + packData.byteLength);
		sb[0] = 1;
		sb.set(packData, 1);
		parts.push(encodePktLine(sb));
		parts.push(flushPkt());

		setMockFetch(
			async () =>
				new Response(concatPktLines(...parts), {
					headers: { "Content-Type": "application/x-git-upload-pack-result" },
				}),
		);

		const result = await fetchPack(
			"https://github.com/repo.git",
			[HASH_B],
			[HASH_A],
			["side-band-64k"],
		);
		expect(result.acks).toEqual([`ACK ${HASH_A}`]);
		expect(new TextDecoder().decode(result.packData)).toBe("PACK-AFTER-FLUSH");
	});

	test("includes agent capability in request", async () => {
		setMockFetch(async (req) => {
			const body = new Uint8Array(await req.arrayBuffer());
			const lines = parsePktLineStream(body);
			const firstWant = pktLineText(lines[0]!);
			expect(firstWant).toContain("agent=just-git/1.0");
			return new Response(buildFetchResponse(["NAK"], enc.encode("P"), true), {
				headers: { "Content-Type": "application/x-git-upload-pack-result" },
			});
		});

		await fetchPack("https://github.com/repo.git", [HASH_A], [], ["side-band-64k"]);
	});

	test("sends haves only (incremental fetch)", async () => {
		setMockFetch(async (req) => {
			const body = new Uint8Array(await req.arrayBuffer());
			const lines = parsePktLineStream(body);
			const texts = lines.map((l) => (l.type === "data" ? pktLineText(l) : "FLUSH"));

			expect(texts[0]).toContain(`want ${HASH_B}`);
			expect(texts[1]).toBe("FLUSH");
			expect(texts[2]).toBe(`have ${HASH_A}`);
			expect(texts[3]).toBe("done");

			return new Response(buildFetchResponse([`ACK ${HASH_A}`], enc.encode("P"), true), {
				headers: { "Content-Type": "application/x-git-upload-pack-result" },
			});
		});

		const result = await fetchPack(
			"https://github.com/repo.git",
			[HASH_B],
			[HASH_A],
			["side-band-64k"],
		);
		expect(result.acks).toEqual([`ACK ${HASH_A}`]);
	});

	test("handles multiple progress messages interleaved with data", async () => {
		const parts: Uint8Array[] = [];
		parts.push(encodePktLine("NAK\n"));

		function sbPkt(band: number, data: Uint8Array): Uint8Array {
			const sb = new Uint8Array(1 + data.byteLength);
			sb[0] = band;
			sb.set(data, 1);
			return encodePktLine(sb);
		}

		parts.push(sbPkt(2, enc.encode("Counting objects: 10\n")));
		parts.push(sbPkt(1, enc.encode("PAC")));
		parts.push(sbPkt(2, enc.encode("Compressing objects: 100%\n")));
		parts.push(sbPkt(1, enc.encode("K-DATA")));
		parts.push(sbPkt(2, enc.encode("Total 10\n")));
		parts.push(flushPkt());

		setMockFetch(
			async () =>
				new Response(concatPktLines(...parts), {
					headers: { "Content-Type": "application/x-git-upload-pack-result" },
				}),
		);

		const result = await fetchPack("https://github.com/repo.git", [HASH_A], [], ["side-band-64k"]);
		expect(new TextDecoder().decode(result.packData)).toBe("PACK-DATA");
		expect(result.progress).toHaveLength(3);
		expect(result.progress[0]).toBe("Counting objects: 10\n");
		expect(result.progress[1]).toBe("Compressing objects: 100%\n");
		expect(result.progress[2]).toBe("Total 10\n");
	});
});

// ── pushPack ─────────────────────────────────────────────────────────

describe("pushPack", () => {
	function buildReportStatus(
		unpack: string,
		refs: Array<{ ok: boolean; name: string; error?: string }>,
		useSideband: boolean,
	): Uint8Array {
		const statusParts: Uint8Array[] = [];
		statusParts.push(encodePktLine(`${unpack}\n`));
		for (const r of refs) {
			if (r.ok) {
				statusParts.push(encodePktLine(`ok ${r.name}\n`));
			} else {
				statusParts.push(encodePktLine(`ng ${r.name} ${r.error ?? "failed"}\n`));
			}
		}
		statusParts.push(flushPkt());

		if (!useSideband) {
			return concatPktLines(...statusParts);
		}

		// Wrap in sideband
		const rawStatus = concatPktLines(...statusParts);
		const sbData = new Uint8Array(1 + rawStatus.byteLength);
		sbData[0] = 1;
		sbData.set(rawStatus, 1);
		const wrapped: Uint8Array[] = [encodePktLine(sbData), flushPkt()];
		return concatPktLines(...wrapped);
	}

	test("sends commands and pack, parses report-status", async () => {
		const fakePack = enc.encode("PACK...");

		setMockFetch(async (req) => {
			expect(req.url).toBe("https://github.com/test/repo.git/git-receive-pack");
			expect(req.headers.get("Content-Type")).toBe("application/x-git-receive-pack-request");

			const body = new Uint8Array(await req.arrayBuffer());
			// Verify the body contains the command and pack
			const bodyStr = new TextDecoder().decode(body);
			expect(bodyStr).toContain(HASH_A);
			expect(bodyStr).toContain(HASH_B);
			expect(bodyStr).toContain("refs/heads/main");
			expect(bodyStr).toContain("PACK...");

			return new Response(
				buildReportStatus("unpack ok", [{ ok: true, name: "refs/heads/main" }], false),
				{
					headers: {
						"Content-Type": "application/x-git-receive-pack-result",
					},
				},
			);
		});

		const result = await pushPack(
			"https://github.com/test/repo.git",
			[{ oldHash: HASH_A, newHash: HASH_B, refName: "refs/heads/main" }],
			fakePack,
			["report-status", "delete-refs", "ofs-delta"],
		);

		expect(result.unpackOk).toBe(true);
		expect(result.refResults).toHaveLength(1);
		expect(result.refResults[0]).toEqual({
			name: "refs/heads/main",
			ok: true,
		});
	});

	test("handles push rejection (ng ref)", async () => {
		setMockFetch(
			async () =>
				new Response(
					buildReportStatus(
						"unpack ok",
						[{ ok: false, name: "refs/heads/main", error: "non-fast-forward" }],
						false,
					),
					{
						headers: {
							"Content-Type": "application/x-git-receive-pack-result",
						},
					},
				),
		);

		const result = await pushPack(
			"https://github.com/repo.git",
			[{ oldHash: HASH_A, newHash: HASH_B, refName: "refs/heads/main" }],
			enc.encode("PACK"),
			["report-status"],
		);

		expect(result.unpackOk).toBe(true);
		expect(result.refResults[0]!.ok).toBe(false);
		expect(result.refResults[0]!.error).toBe("non-fast-forward");
	});

	test("handles delete command (no pack)", async () => {
		setMockFetch(async (req) => {
			const body = new Uint8Array(await req.arrayBuffer());
			const bodyStr = new TextDecoder().decode(body);
			expect(bodyStr).toContain(ZERO);
			// Should not contain PACK data for delete-only
			expect(bodyStr).not.toContain("PACK");

			return new Response(
				buildReportStatus("unpack ok", [{ ok: true, name: "refs/heads/feature" }], false),
				{
					headers: {
						"Content-Type": "application/x-git-receive-pack-result",
					},
				},
			);
		});

		const result = await pushPack(
			"https://github.com/repo.git",
			[{ oldHash: HASH_A, newHash: ZERO, refName: "refs/heads/feature" }],
			null,
			["report-status", "delete-refs"],
		);

		expect(result.unpackOk).toBe(true);
		expect(result.refResults[0]!.ok).toBe(true);
	});

	test("includes capabilities on first command only", async () => {
		setMockFetch(async (req) => {
			const body = new Uint8Array(await req.arrayBuffer());

			// Walk pkt-lines manually to find the two command lines before flush
			let offset = 0;
			const decoder = new TextDecoder();
			const cmdDatas: Uint8Array[] = [];
			while (offset + 4 <= body.byteLength) {
				const lenHex = decoder.decode(body.subarray(offset, offset + 4));
				const len = parseInt(lenHex, 16);
				if (len === 0) break; // flush
				cmdDatas.push(body.subarray(offset + 4, offset + len));
				offset += len;
			}

			expect(cmdDatas.length).toBe(2);

			// First command should have NUL + capabilities
			expect(cmdDatas[0]!.indexOf(0)).toBeGreaterThan(-1);

			// Second command should NOT have NUL
			expect(cmdDatas[1]!.indexOf(0)).toBe(-1);

			return new Response(
				buildReportStatus(
					"unpack ok",
					[
						{ ok: true, name: "refs/heads/main" },
						{ ok: true, name: "refs/heads/dev" },
					],
					false,
				),
				{
					headers: {
						"Content-Type": "application/x-git-receive-pack-result",
					},
				},
			);
		});

		await pushPack(
			"https://github.com/repo.git",
			[
				{ oldHash: HASH_A, newHash: HASH_B, refName: "refs/heads/main" },
				{ oldHash: ZERO, newHash: HASH_A, refName: "refs/heads/dev" },
			],
			enc.encode("PACK"),
			["report-status"],
		);
	});

	test("parses unpack error message", async () => {
		setMockFetch(
			async () =>
				new Response(
					buildReportStatus(
						"unpack error: disk full",
						[{ ok: false, name: "refs/heads/main", error: "unpacker error" }],
						false,
					),
					{
						headers: {
							"Content-Type": "application/x-git-receive-pack-result",
						},
					},
				),
		);

		const result = await pushPack(
			"https://github.com/repo.git",
			[{ oldHash: HASH_A, newHash: HASH_B, refName: "refs/heads/main" }],
			enc.encode("PACK"),
			["report-status"],
		);

		expect(result.unpackOk).toBe(false);
		expect(result.unpackError).toBe("error: disk full");
		expect(result.refResults[0]!.ok).toBe(false);
	});

	test("parses sideband-wrapped report-status", async () => {
		setMockFetch(
			async () =>
				new Response(
					buildReportStatus("unpack ok", [{ ok: true, name: "refs/heads/main" }], true),
					{
						headers: {
							"Content-Type": "application/x-git-receive-pack-result",
						},
					},
				),
		);

		const result = await pushPack(
			"https://github.com/repo.git",
			[{ oldHash: HASH_A, newHash: HASH_B, refName: "refs/heads/main" }],
			enc.encode("PACK"),
			["report-status", "side-band-64k"],
		);

		expect(result.unpackOk).toBe(true);
		expect(result.refResults[0]!.ok).toBe(true);
	});

	test("handles mixed ref results (some ok, some ng)", async () => {
		setMockFetch(
			async () =>
				new Response(
					buildReportStatus(
						"unpack ok",
						[
							{ ok: true, name: "refs/heads/main" },
							{
								ok: false,
								name: "refs/heads/protected",
								error: "deny updating a hidden ref",
							},
							{ ok: true, name: "refs/heads/feature" },
						],
						false,
					),
					{
						headers: {
							"Content-Type": "application/x-git-receive-pack-result",
						},
					},
				),
		);

		const result = await pushPack(
			"https://github.com/repo.git",
			[
				{ oldHash: HASH_A, newHash: HASH_B, refName: "refs/heads/main" },
				{ oldHash: HASH_A, newHash: HASH_B, refName: "refs/heads/protected" },
				{ oldHash: ZERO, newHash: HASH_A, refName: "refs/heads/feature" },
			],
			enc.encode("PACK"),
			["report-status"],
		);

		expect(result.unpackOk).toBe(true);
		expect(result.refResults).toHaveLength(3);
		expect(result.refResults[0]!.ok).toBe(true);
		expect(result.refResults[1]!.ok).toBe(false);
		expect(result.refResults[1]!.error).toBe("deny updating a hidden ref");
		expect(result.refResults[2]!.ok).toBe(true);
	});

	test("assumes success when report-status not negotiated", async () => {
		setMockFetch(
			async () =>
				new Response(new Uint8Array(0), {
					headers: {
						"Content-Type": "application/x-git-receive-pack-result",
					},
				}),
		);

		const result = await pushPack(
			"https://github.com/repo.git",
			[{ oldHash: HASH_A, newHash: HASH_B, refName: "refs/heads/main" }],
			enc.encode("PACK"),
			["ofs-delta"],
		);

		expect(result.unpackOk).toBe(true);
		expect(result.refResults).toEqual([]);
		expect(result.progress).toEqual([]);
	});

	test("handles creating a new ref (old hash is ZERO)", async () => {
		setMockFetch(async (req) => {
			const body = new Uint8Array(await req.arrayBuffer());
			const bodyStr = new TextDecoder().decode(body);
			expect(bodyStr).toContain(ZERO);
			expect(bodyStr).toContain(HASH_A);
			expect(bodyStr).toContain("refs/heads/new-branch");

			return new Response(
				buildReportStatus("unpack ok", [{ ok: true, name: "refs/heads/new-branch" }], false),
				{
					headers: {
						"Content-Type": "application/x-git-receive-pack-result",
					},
				},
			);
		});

		const result = await pushPack(
			"https://github.com/repo.git",
			[{ oldHash: ZERO, newHash: HASH_A, refName: "refs/heads/new-branch" }],
			enc.encode("PACK"),
			["report-status"],
		);

		expect(result.unpackOk).toBe(true);
		expect(result.refResults[0]!.ok).toBe(true);
	});

	test("handles ng ref with no error message", async () => {
		const statusParts: Uint8Array[] = [];
		statusParts.push(encodePktLine("unpack ok\n"));
		statusParts.push(encodePktLine("ng refs/heads/main\n"));
		statusParts.push(flushPkt());

		setMockFetch(
			async () =>
				new Response(concatPktLines(...statusParts), {
					headers: {
						"Content-Type": "application/x-git-receive-pack-result",
					},
				}),
		);

		const result = await pushPack(
			"https://github.com/repo.git",
			[{ oldHash: HASH_A, newHash: HASH_B, refName: "refs/heads/main" }],
			enc.encode("PACK"),
			["report-status"],
		);

		expect(result.refResults[0]!.ok).toBe(false);
		expect(result.refResults[0]!.name).toBe("refs/heads/main");
		expect(result.refResults[0]!.error).toBeUndefined();
	});

	test("throws on HTTP error during push", async () => {
		setMockFetch(async () => new Response("Forbidden", { status: 403 }));

		await expect(
			pushPack(
				"https://github.com/repo.git",
				[{ oldHash: HASH_A, newHash: HASH_B, refName: "refs/heads/main" }],
				enc.encode("PACK"),
				["report-status"],
			),
		).rejects.toThrow("HTTP 403");
	});

	test("throws on sideband error during push", async () => {
		const errorMsg = enc.encode("pre-receive hook declined");
		const sbError = new Uint8Array(1 + errorMsg.byteLength);
		sbError[0] = 3;
		sbError.set(errorMsg, 1);

		const parts: Uint8Array[] = [encodePktLine(sbError), flushPkt()];

		setMockFetch(
			async () =>
				new Response(concatPktLines(...parts), {
					headers: {
						"Content-Type": "application/x-git-receive-pack-result",
					},
				}),
		);

		await expect(
			pushPack(
				"https://github.com/repo.git",
				[{ oldHash: HASH_A, newHash: HASH_B, refName: "refs/heads/main" }],
				enc.encode("PACK"),
				["report-status", "side-band-64k"],
			),
		).rejects.toThrow("Remote error");
	});

	test("sends User-Agent header", async () => {
		setMockFetch(async (req) => {
			expect(req.headers.get("User-Agent")).toBe("just-git/1.0");
			return new Response(buildReportStatus("unpack ok", [], false), {
				headers: {
					"Content-Type": "application/x-git-receive-pack-result",
				},
			});
		});

		await pushPack(
			"https://github.com/repo.git",
			[{ oldHash: HASH_A, newHash: HASH_B, refName: "refs/heads/main" }],
			enc.encode("PACK"),
			["report-status"],
		);
	});

	test("throws on empty commands", async () => {
		await expect(pushPack("https://github.com/repo.git", [], null, [])).rejects.toThrow(
			"at least one command",
		);
	});
});
