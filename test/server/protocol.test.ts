import { describe, expect, test } from "bun:test";
import {
	buildRefAdvertisement,
	buildReportStatus,
	buildUploadPackResponse,
	parseReceivePackRequest,
	parseUploadPackRequest,
} from "../../src/server/protocol.ts";
import {
	encodePktLine,
	flushPkt,
	concatPktLines,
	parsePktLineStream,
	pktLineText,
} from "../../src/lib/transport/pkt-line.ts";
import { createServer } from "../../src/server/handler.ts";
import { MemoryStorage } from "../../src/server/memory-storage.ts";
import { createStorageAdapter } from "../../src/server/storage.ts";
import { createCommit, writeBlob, writeTree } from "../../src/repo/writing.ts";

// ── Protocol codec tests ────────────────────────────────────────────

describe("buildRefAdvertisement", () => {
	test("frames pkt-lines with service announcement, flush, refs, capabilities, trailing flush", () => {
		const refs = [
			{ name: "HEAD", hash: "aaa" + "0".repeat(37) },
			{ name: "refs/heads/main", hash: "bbb" + "0".repeat(37) },
		];
		const result = buildRefAdvertisement(refs, "git-upload-pack", ["multi_ack", "side-band-64k"]);
		const lines = parsePktLineStream(result);

		// Service announcement
		expect(pktLineText(lines[0]!)).toBe("# service=git-upload-pack");

		// Flush after service
		expect(lines[1]!.type).toBe("flush");

		// First ref includes NUL + capabilities
		const firstRefRaw = new TextDecoder().decode(
			lines[2]!.type === "data" ? lines[2]!.data : new Uint8Array(),
		);
		expect(firstRefRaw).toContain("\0");
		expect(firstRefRaw).toContain("multi_ack");
		expect(firstRefRaw).toContain("side-band-64k");
		expect(firstRefRaw).toContain("agent=just-git/1.0");
		expect(firstRefRaw).toMatch(/^aaa0{37} HEAD\0/);

		// Second ref has no NUL
		const secondRefRaw = new TextDecoder().decode(
			lines[3]!.type === "data" ? lines[3]!.data : new Uint8Array(),
		);
		expect(secondRefRaw).not.toContain("\0");
		expect(secondRefRaw).toContain("refs/heads/main");

		// Trailing flush
		expect(lines[lines.length - 1]!.type).toBe("flush");
	});

	test("empty repo produces capabilities^{} line with zero-id", () => {
		const result = buildRefAdvertisement([], "git-upload-pack", ["multi_ack"]);
		const lines = parsePktLineStream(result);

		// Skip service announcement + flush
		const capsLine = new TextDecoder().decode(
			lines[2]!.type === "data" ? lines[2]!.data : new Uint8Array(),
		);
		expect(capsLine).toContain("0".repeat(40));
		expect(capsLine).toContain("capabilities^{}");
		expect(capsLine).toContain("\0");
		expect(capsLine).toContain("multi_ack");
	});

	test("includes symref capability when headTarget is provided", () => {
		const refs = [{ name: "HEAD", hash: "a".repeat(40) }];
		const result = buildRefAdvertisement(refs, "git-upload-pack", [], "refs/heads/main");
		const lines = parsePktLineStream(result);

		const firstRefRaw = new TextDecoder().decode(
			lines[2]!.type === "data" ? lines[2]!.data : new Uint8Array(),
		);
		expect(firstRefRaw).toContain("symref=HEAD:refs/heads/main");
	});
});

describe("parseUploadPackRequest", () => {
	test("parses wants with capabilities, haves, and done", () => {
		const body = concatPktLines(
			encodePktLine("want aaaa" + "0".repeat(36) + " multi_ack side-band-64k\n"),
			encodePktLine("want bbbb" + "0".repeat(36) + "\n"),
			flushPkt(),
			encodePktLine("have cccc" + "0".repeat(36) + "\n"),
			encodePktLine("have dddd" + "0".repeat(36) + "\n"),
			encodePktLine("done\n"),
		);

		const parsed = parseUploadPackRequest(body);
		expect(parsed.wants).toEqual(["aaaa" + "0".repeat(36), "bbbb" + "0".repeat(36)]);
		expect(parsed.haves).toEqual(["cccc" + "0".repeat(36), "dddd" + "0".repeat(36)]);
		expect(parsed.capabilities).toEqual(["multi_ack", "side-band-64k"]);
	});

	test("parses wants with no haves (fresh clone)", () => {
		const body = concatPktLines(
			encodePktLine("want " + "a".repeat(40) + " ofs-delta\n"),
			flushPkt(),
			encodePktLine("done\n"),
		);

		const parsed = parseUploadPackRequest(body);
		expect(parsed.wants).toEqual(["a".repeat(40)]);
		expect(parsed.haves).toEqual([]);
		expect(parsed.capabilities).toEqual(["ofs-delta"]);
	});

	test("parses want with no capabilities", () => {
		const body = concatPktLines(
			encodePktLine("want " + "f".repeat(40) + "\n"),
			flushPkt(),
			encodePktLine("done\n"),
		);

		const parsed = parseUploadPackRequest(body);
		expect(parsed.wants).toEqual(["f".repeat(40)]);
		expect(parsed.capabilities).toEqual([]);
	});
});

describe("parseReceivePackRequest", () => {
	test("parses commands with capabilities and pack data", () => {
		const oldHash = "a".repeat(40);
		const newHash = "b".repeat(40);
		const packBytes = new Uint8Array([0x50, 0x41, 0x43, 0x4b]); // "PACK"

		const commandLine = `${oldHash} ${newHash} refs/heads/main`;
		const encoder = new TextEncoder();
		const commandBytes = encoder.encode(commandLine);
		const capBytes = encoder.encode(" report-status side-band-64k\n");

		const nul = new Uint8Array([0]);
		const payload = concatPktLines(commandBytes, nul, capBytes);
		const firstLine = encodePktLine(payload);

		const body = concatPktLines(firstLine, flushPkt(), packBytes);
		const parsed = parseReceivePackRequest(body);

		expect(parsed.commands).toHaveLength(1);
		expect(parsed.commands[0]!.oldHash).toBe(oldHash);
		expect(parsed.commands[0]!.newHash).toBe(newHash);
		expect(parsed.commands[0]!.refName).toBe("refs/heads/main");
		expect(parsed.capabilities).toContain("report-status");
		expect(parsed.capabilities).toContain("side-band-64k");
		expect(parsed.packData).toEqual(packBytes);
	});

	test("parses multiple commands", () => {
		const zero = "0".repeat(40);
		const hashA = "a".repeat(40);
		const hashB = "b".repeat(40);

		const line1 = `${zero} ${hashA} refs/heads/new-branch`;
		const line2 = `${hashB} ${zero} refs/heads/old-branch`;

		const encoder = new TextEncoder();
		const nul = new Uint8Array([0]);

		const payload1 = concatPktLines(encoder.encode(line1), nul, encoder.encode(" report-status\n"));
		const body = concatPktLines(encodePktLine(payload1), encodePktLine(line2 + "\n"), flushPkt());

		const parsed = parseReceivePackRequest(body);
		expect(parsed.commands).toHaveLength(2);
		expect(parsed.commands[0]!.refName).toBe("refs/heads/new-branch");
		expect(parsed.commands[1]!.refName).toBe("refs/heads/old-branch");
		expect(parsed.packData.byteLength).toBe(0);
	});
});

describe("buildReportStatus", () => {
	test("produces unpack ok + ok refs without sideband", () => {
		const result = buildReportStatus(
			true,
			[
				{ name: "refs/heads/main", ok: true },
				{ name: "refs/heads/feature", ok: true },
			],
			false,
		);

		const lines = parsePktLineStream(result);
		expect(pktLineText(lines[0]!)).toBe("unpack ok");
		expect(pktLineText(lines[1]!)).toBe("ok refs/heads/main");
		expect(pktLineText(lines[2]!)).toBe("ok refs/heads/feature");
		expect(lines[3]!.type).toBe("flush");
	});

	test("produces unpack error + ng refs", () => {
		const result = buildReportStatus(
			false,
			[{ name: "refs/heads/main", ok: false, error: "hook declined" }],
			false,
		);

		const lines = parsePktLineStream(result);
		expect(pktLineText(lines[0]!)).toBe("unpack error");
		expect(pktLineText(lines[1]!)).toBe("ng refs/heads/main hook declined");
	});

	test("wraps in sideband when requested", () => {
		const result = buildReportStatus(true, [{ name: "refs/heads/main", ok: true }], true);

		const lines = parsePktLineStream(result);
		// Sideband wraps: first line is a data packet with band byte 0x01
		expect(lines[0]!.type).toBe("data");
		const data = lines[0]!.type === "data" ? lines[0]!.data : new Uint8Array();
		expect(data[0]).toBe(1); // band-1
	});
});

describe("buildUploadPackResponse", () => {
	function extractPktLinePrefix(buf: Uint8Array) {
		const lines: ReturnType<typeof parsePktLineStream> = [];
		let offset = 0;
		const decoder = new TextDecoder();
		while (offset + 4 <= buf.byteLength) {
			const lenHex = decoder.decode(buf.subarray(offset, offset + 4));
			const len = parseInt(lenHex, 16);
			if (Number.isNaN(len)) break; // hit raw data (e.g. PACK)
			if (len === 0) {
				lines.push({ type: "flush" as const });
				offset += 4;
				continue;
			}
			if (len < 4 || offset + len > buf.byteLength) break;
			lines.push({ type: "data" as const, data: buf.subarray(offset + 4, offset + len) });
			offset += len;
		}
		return { lines, remainder: buf.subarray(offset) };
	}

	test("emits NAK when no common objects, followed by raw pack data", () => {
		const pack = new Uint8Array([0x50, 0x41, 0x43, 0x4b]);
		const result = buildUploadPackResponse(pack, false);

		const { lines, remainder } = extractPktLinePrefix(result);
		expect(pktLineText(lines[0]!)).toBe("NAK");
		expect(remainder).toEqual(pack);
	});

	test("emits ACK common + ACK ready + ACK final when common hashes exist", () => {
		const hash1 = "a".repeat(40);
		const hash2 = "b".repeat(40);
		const pack = new Uint8Array([0x50, 0x41, 0x43, 0x4b]);
		const result = buildUploadPackResponse(pack, false, [hash1, hash2]);

		const { lines, remainder } = extractPktLinePrefix(result);
		expect(pktLineText(lines[0]!)).toBe(`ACK ${hash1} common`);
		expect(pktLineText(lines[1]!)).toBe(`ACK ${hash2} common`);
		expect(pktLineText(lines[2]!)).toBe(`ACK ${hash2} ready`);
		expect(pktLineText(lines[3]!)).toBe(`ACK ${hash2}`);
		expect(remainder).toEqual(pack);
	});

	test("wraps pack data in sideband band-1 when requested", () => {
		const pack = new Uint8Array([0x50, 0x41, 0x43, 0x4b]);
		const result = buildUploadPackResponse(pack, true);

		const lines = parsePktLineStream(result);
		expect(pktLineText(lines[0]!)).toBe("NAK");
		// Sideband packet with band byte 0x01
		expect(lines[1]!.type).toBe("data");
		const data = lines[1]!.type === "data" ? lines[1]!.data : new Uint8Array();
		expect(data[0]).toBe(1);
		expect(data.slice(1)).toEqual(pack);
		// Trailing flush
		expect(lines[lines.length - 1]!.type).toBe("flush");
	});
});

// ── Handler HTTP conformance tests ──────────────────────────────────

const TEST_IDENTITY = {
	name: "Test",
	email: "test@test.com",
	timestamp: 1000000000,
	timezone: "+0000",
};

describe("handler HTTP conformance", () => {
	let serverFetch: (req: Request) => Promise<Response>;

	const setup = async () => {
		const driver = new MemoryStorage();
		const storage = createStorageAdapter(driver);
		const repo = await storage.createRepo("repo");
		const blob = await writeBlob(repo, "# test");
		const tree = await writeTree(repo, [{ name: "README.md", hash: blob }]);
		const commit = await createCommit(repo, {
			tree,
			parents: [],
			author: TEST_IDENTITY,
			committer: TEST_IDENTITY,
			message: "init\n",
		});
		await repo.refStore.writeRef("refs/heads/main", { type: "direct", hash: commit });
		const server = createServer({ storage: driver });
		serverFetch = server.fetch;
	};

	test("GET /info/refs without service param returns 403", async () => {
		await setup();
		const res = await serverFetch(new Request("http://localhost/repo/info/refs"));
		expect(res.status).toBe(403);
	});

	test("GET /info/refs?service=unknown returns 403", async () => {
		await setup();
		const res = await serverFetch(
			new Request("http://localhost/repo/info/refs?service=git-frobnicate"),
		);
		expect(res.status).toBe(403);
	});

	test("GET /info/refs?service=git-upload-pack returns correct Content-Type", async () => {
		await setup();
		const res = await serverFetch(
			new Request("http://localhost/repo/info/refs?service=git-upload-pack"),
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("application/x-git-upload-pack-advertisement");
	});

	test("GET /info/refs?service=git-receive-pack returns correct Content-Type", async () => {
		await setup();
		const res = await serverFetch(
			new Request("http://localhost/repo/info/refs?service=git-receive-pack"),
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("application/x-git-receive-pack-advertisement");
	});

	test("info/refs response includes Cache-Control: no-cache", async () => {
		await setup();
		const res = await serverFetch(
			new Request("http://localhost/repo/info/refs?service=git-upload-pack"),
		);
		expect(res.headers.get("Cache-Control")).toBe("no-cache");
	});

	test("info/refs response body starts with valid pkt-line matching ^[0-9a-f]{4}#", async () => {
		await setup();
		const res = await serverFetch(
			new Request("http://localhost/repo/info/refs?service=git-upload-pack"),
		);
		const body = await res.arrayBuffer();
		const first5 = new TextDecoder().decode(new Uint8Array(body).subarray(0, 5));
		expect(first5).toMatch(/^[0-9a-f]{4}#/);
	});

	test("POST /git-upload-pack returns correct Content-Type", async () => {
		await setup();
		// Minimal valid upload-pack request with a want for the HEAD commit
		const refsRes = await serverFetch(
			new Request("http://localhost/repo/info/refs?service=git-upload-pack"),
		);
		const refsBody = new Uint8Array(await refsRes.arrayBuffer());
		const lines = parsePktLineStream(refsBody);
		// Find first ref hash (skip service line and flush)
		let headHash = "";
		for (const line of lines) {
			if (line.type === "flush") continue;
			const text = pktLineText(line);
			if (text.startsWith("#")) continue;
			const match = text.match(/^([0-9a-f]{40})/);
			if (match) {
				headHash = match[1]!;
				break;
			}
		}
		expect(headHash).toMatch(/^[0-9a-f]{40}$/);

		const uploadBody = concatPktLines(
			encodePktLine(`want ${headHash} side-band-64k\n`),
			flushPkt(),
			encodePktLine("done\n"),
		);

		const res = await serverFetch(
			new Request("http://localhost/repo/git-upload-pack", {
				method: "POST",
				body: uploadBody,
			}),
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("application/x-git-upload-pack-result");
	});

	test("denied advertiseRefs also blocks direct POST /git-upload-pack", async () => {
		const driver = new MemoryStorage();
		const storage = createStorageAdapter(driver);
		const repo = await storage.createRepo("repo");
		const blob = await writeBlob(repo, "classified");
		const tree = await writeTree(repo, [{ name: "secret.txt", hash: blob }]);
		const secretHash = await createCommit(repo, {
			tree,
			parents: [],
			author: TEST_IDENTITY,
			committer: TEST_IDENTITY,
			message: "secret\n",
		});
		await repo.refStore.writeRef("refs/heads/main", { type: "direct", hash: secretHash });

		const server = createServer({
			storage: driver,
			hooks: {
				advertiseRefs: async ({ service }) =>
					service === "git-upload-pack" ? { reject: true, message: "denied" } : undefined,
			},
		});

		const deniedInfoRefs = await server.fetch(
			new Request("http://localhost/repo/info/refs?service=git-upload-pack"),
		);
		expect(deniedInfoRefs.status).toBe(403);

		const uploadBody = concatPktLines(
			encodePktLine(`want ${secretHash} side-band-64k\n`),
			flushPkt(),
			encodePktLine("done\n"),
		);
		const directUpload = await server.fetch(
			new Request("http://localhost/repo/git-upload-pack", {
				method: "POST",
				body: uploadBody,
			}),
		);

		expect(directUpload.status).toBe(403);
		expect(await directUpload.text()).toContain("denied");
	});

	test("filtered hidden refs cannot be fetched by hash over v1 upload-pack", async () => {
		const driver = new MemoryStorage();
		const storage = createStorageAdapter(driver);
		const repo = await storage.createRepo("repo");

		const publicBlob = await writeBlob(repo, "public");
		const publicTree = await writeTree(repo, [{ name: "README.md", hash: publicBlob }]);
		const publicHash = await createCommit(repo, {
			tree: publicTree,
			parents: [],
			author: TEST_IDENTITY,
			committer: TEST_IDENTITY,
			message: "public\n",
		});
		await repo.refStore.writeRef("refs/heads/main", { type: "direct", hash: publicHash });

		const hiddenBlob = await writeBlob(repo, "secret");
		const hiddenTree = await writeTree(repo, [{ name: "secret.txt", hash: hiddenBlob }]);
		const hiddenHash = await createCommit(repo, {
			tree: hiddenTree,
			parents: [],
			author: TEST_IDENTITY,
			committer: TEST_IDENTITY,
			message: "hidden\n",
		});
		await repo.refStore.writeRef("refs/heads/internal", { type: "direct", hash: hiddenHash });

		const server = createServer({
			storage: driver,
			hooks: {
				advertiseRefs: async ({ refs, service }) =>
					service === "git-upload-pack"
						? refs.filter((ref) => ref.name !== "refs/heads/internal")
						: refs,
			},
		});

		const refsRes = await server.fetch(
			new Request("http://localhost/repo/info/refs?service=git-upload-pack"),
		);
		expect(refsRes.status).toBe(200);
		const refsText = new TextDecoder().decode(new Uint8Array(await refsRes.arrayBuffer()));
		expect(refsText).not.toContain("refs/heads/internal");

		const uploadBody = concatPktLines(
			encodePktLine(`want ${hiddenHash} side-band-64k\n`),
			flushPkt(),
			encodePktLine("done\n"),
		);
		const res = await server.fetch(
			new Request("http://localhost/repo/git-upload-pack", {
				method: "POST",
				body: uploadBody,
			}),
		);

		expect(res.status).toBe(403);
		expect(await res.text()).toContain("forbidden want");
	});

	test("POST /git-receive-pack returns correct Content-Type", async () => {
		await setup();
		// Send a minimal (empty) receive-pack body — just flush
		const body = flushPkt();
		const res = await serverFetch(
			new Request("http://localhost/repo/git-receive-pack", {
				method: "POST",
				body,
			}),
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("application/x-git-receive-pack-result");
	});

	test("unknown path returns 404", async () => {
		await setup();
		const res = await serverFetch(new Request("http://localhost/repo/unknown-endpoint"));
		expect(res.status).toBe(404);
	});

	test("basePath stripping works correctly", async () => {
		const driver = new MemoryStorage();
		const storage = createStorageAdapter(driver);
		const repo = await storage.createRepo("repo");
		const blob = await writeBlob(repo, "# test");
		const tree = await writeTree(repo, [{ name: "README.md", hash: blob }]);
		const commit = await createCommit(repo, {
			tree,
			parents: [],
			author: TEST_IDENTITY,
			committer: TEST_IDENTITY,
			message: "init\n",
		});
		await repo.refStore.writeRef("refs/heads/main", { type: "direct", hash: commit });
		const server = createServer({ storage: driver, basePath: "/git" });

		// Without basePath prefix → 404
		const res404 = await server.fetch(
			new Request("http://localhost/repo/info/refs?service=git-upload-pack"),
		);
		expect(res404.status).toBe(404);

		// With basePath prefix → 200
		const res200 = await server.fetch(
			new Request("http://localhost/git/repo/info/refs?service=git-upload-pack"),
		);
		expect(res200.status).toBe(200);
		expect(res200.headers.get("Content-Type")).toBe("application/x-git-upload-pack-advertisement");
	});
});
