import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	buildV2CapabilityAdvertisement,
	buildV2FetchAcknowledgments,
	buildV2FetchResponse,
	buildV2LsRefsResponse,
	parseV2CommandRequest,
	parseV2FetchArgs,
} from "../../src/server/protocol.ts";
import {
	concatPktLines,
	delimPkt,
	encodePktLine,
	flushPkt,
	parsePktLineStream,
	pktLineText,
	responseEndPkt,
} from "../../src/lib/transport/pkt-line.ts";
import { createServer } from "../../src/server/handler.ts";
import { MemoryStorage } from "../../src/server/memory-storage.ts";
import { createStorageAdapter } from "../../src/server/storage.ts";
import { createCommit, writeBlob, writeTree } from "../../src/repo/writing.ts";
import {
	buildV2CapabilityAdvertisementBytes,
	handleLsRefs,
	handleV2Fetch,
} from "../../src/server/operations.ts";
import { createSeededServer, createServerClient, envAt } from "./util.ts";
import type { SshChannel } from "../../src/server/types.ts";
import type { GitRepo } from "../../src/lib/types.ts";

// ── pkt-line v2 extensions ──────────────────────────────────────────

describe("pkt-line v2 extensions", () => {
	test("delimPkt encodes as 0001", () => {
		const d = delimPkt();
		expect(new TextDecoder().decode(d)).toBe("0001");
	});

	test("responseEndPkt encodes as 0002", () => {
		const r = responseEndPkt();
		expect(new TextDecoder().decode(r)).toBe("0002");
	});

	test("parsePktLineStream recognizes delim and response-end in a stream", () => {
		const stream = concatPktLines(
			encodePktLine("hello\n"),
			delimPkt(),
			encodePktLine("world\n"),
			flushPkt(),
		);
		const lines = parsePktLineStream(stream);
		expect(lines).toHaveLength(4);
		expect(pktLineText(lines[0]!)).toBe("hello");
		expect(lines[1]!.type).toBe("delim");
		expect(pktLineText(lines[2]!)).toBe("world");
		expect(lines[3]!.type).toBe("flush");
	});

	test("pktLineText returns empty string for delim and response-end", () => {
		expect(pktLineText({ type: "delim" })).toBe("");
		expect(pktLineText({ type: "response-end" })).toBe("");
	});

	test("response-end-pkt round-trips through parse", () => {
		const stream = concatPktLines(encodePktLine("data\n"), responseEndPkt());
		const lines = parsePktLineStream(stream);
		expect(lines).toHaveLength(2);
		expect(lines[0]!.type).toBe("data");
		expect(lines[1]!.type).toBe("response-end");
	});
});

// ── V2 capability advertisement ─────────────────────────────────────

describe("buildV2CapabilityAdvertisement", () => {
	test("produces version 2 header, capability lines, and flush", () => {
		const result = buildV2CapabilityAdvertisement(["ls-refs", "fetch=shallow"]);
		const lines = parsePktLineStream(result);

		expect(lines.length).toBeGreaterThanOrEqual(3);
		expect(pktLineText(lines[0]!)).toBe("version 2");
		expect(pktLineText(lines[1]!)).toBe("ls-refs");
		expect(pktLineText(lines[2]!)).toBe("fetch=shallow");
		expect(lines[lines.length - 1]!.type).toBe("flush");
	});

	test("empty capabilities still include version line and flush", () => {
		const result = buildV2CapabilityAdvertisement([]);
		const lines = parsePktLineStream(result);
		expect(lines).toHaveLength(2);
		expect(pktLineText(lines[0]!)).toBe("version 2");
		expect(lines[1]!.type).toBe("flush");
	});

	test("buildV2CapabilityAdvertisementBytes includes standard capabilities", () => {
		const result = buildV2CapabilityAdvertisementBytes();
		const lines = parsePktLineStream(result);
		const texts = lines.filter((l) => l.type === "data").map((l) => pktLineText(l));
		expect(texts).toContain("version 2");
		expect(texts.some((t) => t.startsWith("agent="))).toBe(true);
		expect(texts.some((t) => t.startsWith("ls-refs"))).toBe(true);
		expect(texts.some((t) => t.startsWith("fetch"))).toBe(true);
	});
});

// ── V2 command request parsing ──────────────────────────────────────

describe("parseV2CommandRequest", () => {
	test("parses ls-refs request", () => {
		const body = concatPktLines(
			encodePktLine("command=ls-refs\n"),
			encodePktLine("agent=git/2.53.0\n"),
			encodePktLine("object-format=sha1\n"),
			delimPkt(),
			encodePktLine("peel\n"),
			encodePktLine("symrefs\n"),
			encodePktLine("ref-prefix refs/heads/\n"),
			flushPkt(),
		);
		const parsed = parseV2CommandRequest(body);
		expect(parsed.command).toBe("ls-refs");
		expect(parsed.capabilities).toEqual(["agent=git/2.53.0", "object-format=sha1"]);
		expect(parsed.args).toEqual(["peel", "symrefs", "ref-prefix refs/heads/"]);
	});

	test("parses fetch request with wants and haves", () => {
		const hash = "a".repeat(40);
		const body = concatPktLines(
			encodePktLine("command=fetch\n"),
			encodePktLine("agent=git/2.53.0\n"),
			delimPkt(),
			encodePktLine("thin-pack\n"),
			encodePktLine(`want ${hash}\n`),
			encodePktLine("done\n"),
			flushPkt(),
		);
		const parsed = parseV2CommandRequest(body);
		expect(parsed.command).toBe("fetch");
		expect(parsed.capabilities).toEqual(["agent=git/2.53.0"]);
		expect(parsed.args).toContain("thin-pack");
		expect(parsed.args).toContain(`want ${hash}`);
		expect(parsed.args).toContain("done");
	});

	test("handles command with no capabilities", () => {
		const body = concatPktLines(
			encodePktLine("command=ls-refs\n"),
			delimPkt(),
			encodePktLine("symrefs\n"),
			flushPkt(),
		);
		const parsed = parseV2CommandRequest(body);
		expect(parsed.command).toBe("ls-refs");
		expect(parsed.capabilities).toEqual([]);
		expect(parsed.args).toEqual(["symrefs"]);
	});

	test("handles command with no args", () => {
		const body = concatPktLines(encodePktLine("command=ls-refs\n"), delimPkt(), flushPkt());
		const parsed = parseV2CommandRequest(body);
		expect(parsed.command).toBe("ls-refs");
		expect(parsed.args).toEqual([]);
	});
});

// ── V2 ls-refs response ─────────────────────────────────────────────

describe("buildV2LsRefsResponse", () => {
	test("formats refs with flush terminator", () => {
		const hash = "a".repeat(40);
		const result = buildV2LsRefsResponse([
			{ hash, name: "HEAD", symrefTarget: "refs/heads/main" },
			{ hash, name: "refs/heads/main" },
		]);
		const lines = parsePktLineStream(result);
		expect(lines).toHaveLength(3);
		expect(pktLineText(lines[0]!)).toBe(`${hash} HEAD symref-target:refs/heads/main`);
		expect(pktLineText(lines[1]!)).toBe(`${hash} refs/heads/main`);
		expect(lines[2]!.type).toBe("flush");
	});

	test("includes peeled hash when provided", () => {
		const hash = "a".repeat(40);
		const peeled = "b".repeat(40);
		const result = buildV2LsRefsResponse([{ hash, name: "refs/tags/v1.0", peeledHash: peeled }]);
		const lines = parsePktLineStream(result);
		expect(pktLineText(lines[0]!)).toContain(`peeled:${peeled}`);
	});

	test("empty refs produces flush-only response", () => {
		const result = buildV2LsRefsResponse([]);
		const lines = parsePktLineStream(result);
		expect(lines).toHaveLength(1);
		expect(lines[0]!.type).toBe("flush");
	});
});

// ── V2 fetch args parsing ───────────────────────────────────────────

describe("parseV2FetchArgs", () => {
	test("parses wants, haves, and done", () => {
		const h1 = "a".repeat(40);
		const h2 = "b".repeat(40);
		const parsed = parseV2FetchArgs([
			`want ${h1}`,
			`have ${h2}`,
			"done",
			"include-tag",
			"ofs-delta",
		]);
		expect(parsed.wants).toEqual([h1]);
		expect(parsed.haves).toEqual([h2]);
		expect(parsed.done).toBe(true);
		expect(parsed.includeTag).toBe(true);
		expect(parsed.ofsDeltas).toBe(true);
	});

	test("parses shallow and deepen", () => {
		const parsed = parseV2FetchArgs([
			`want ${"c".repeat(40)}`,
			`shallow ${"d".repeat(40)}`,
			"deepen 3",
		]);
		expect(parsed.clientShallows).toEqual(["d".repeat(40)]);
		expect(parsed.depth).toBe(3);
		expect(parsed.done).toBe(false);
	});

	test("parses want-ref", () => {
		const parsed = parseV2FetchArgs(["want-ref refs/heads/main", "want-ref refs/tags/v1"]);
		expect(parsed.wantRefs).toEqual(["refs/heads/main", "refs/tags/v1"]);
	});

	test("handles empty args", () => {
		const parsed = parseV2FetchArgs([]);
		expect(parsed.wants).toEqual([]);
		expect(parsed.haves).toEqual([]);
		expect(parsed.done).toBe(false);
		expect(parsed.includeTag).toBe(false);
	});
});

// ── V2 fetch response building ──────────────────────────────────────

describe("buildV2FetchResponse", () => {
	const fakePack = new Uint8Array([0x50, 0x41, 0x43, 0x4b, 0x00, 0x00, 0x00, 0x02]);

	test("produces packfile section with sideband and flush terminator", () => {
		const result = buildV2FetchResponse(fakePack);
		const lines = parsePktLineStream(result);

		expect(pktLineText(lines[0]!)).toBe("packfile");
		// Sideband data packet
		expect(lines[1]!.type).toBe("data");
		const data = lines[1]!.type === "data" ? lines[1]!.data : new Uint8Array();
		expect(data[0]).toBe(1); // band-1
		expect(Array.from(data.subarray(1))).toEqual(Array.from(fakePack));
		expect(lines[lines.length - 1]!.type).toBe("flush");
	});

	test("includes acknowledgments section when commonHashes provided", () => {
		const hash = "a".repeat(40);
		const result = buildV2FetchResponse(fakePack, { commonHashes: [hash] });
		const lines = parsePktLineStream(result);

		expect(pktLineText(lines[0]!)).toBe("acknowledgments");
		expect(pktLineText(lines[1]!)).toBe(`ACK ${hash}`);
		expect(pktLineText(lines[2]!)).toBe("ready");
		expect(lines[3]!.type).toBe("delim");
		expect(pktLineText(lines[4]!)).toBe("packfile");
	});

	test("omits acknowledgments when no commonHashes", () => {
		const result = buildV2FetchResponse(fakePack);
		const lines = parsePktLineStream(result);
		expect(pktLineText(lines[0]!)).toBe("packfile");
	});

	test("includes shallow-info section", () => {
		const sh = "c".repeat(40);
		const result = buildV2FetchResponse(fakePack, {
			shallowInfo: { shallow: [sh], unshallow: [] },
		});
		const lines = parsePktLineStream(result);
		expect(pktLineText(lines[0]!)).toBe("shallow-info");
		expect(pktLineText(lines[1]!)).toBe(`shallow ${sh}`);
		expect(lines[2]!.type).toBe("delim");
		expect(pktLineText(lines[3]!)).toBe("packfile");
	});

	test("includes wanted-refs section", () => {
		const h = "d".repeat(40);
		const result = buildV2FetchResponse(fakePack, {
			wantedRefs: [{ hash: h, name: "refs/heads/main" }],
		});
		const lines = parsePktLineStream(result);
		expect(pktLineText(lines[0]!)).toBe("wanted-refs");
		expect(pktLineText(lines[1]!)).toBe(`${h} refs/heads/main`);
		expect(lines[2]!.type).toBe("delim");
		expect(pktLineText(lines[3]!)).toBe("packfile");
	});
});

// ── V2 fetch acknowledgments-only ───────────────────────────────────

describe("buildV2FetchAcknowledgments", () => {
	test("produces NAK when no common hashes", () => {
		const result = buildV2FetchAcknowledgments([]);
		const lines = parsePktLineStream(result);
		expect(pktLineText(lines[0]!)).toBe("acknowledgments");
		expect(pktLineText(lines[1]!)).toBe("NAK");
		expect(lines[lines.length - 1]!.type).toBe("flush");
	});

	test("produces ACKs when common hashes exist", () => {
		const h1 = "a".repeat(40);
		const h2 = "b".repeat(40);
		const result = buildV2FetchAcknowledgments([h1, h2]);
		const lines = parsePktLineStream(result);
		expect(pktLineText(lines[0]!)).toBe("acknowledgments");
		expect(pktLineText(lines[1]!)).toBe(`ACK ${h1}`);
		expect(pktLineText(lines[2]!)).toBe(`ACK ${h2}`);
		expect(lines[lines.length - 1]!.type).toBe("flush");
	});

	test("includes ready line when ready=true", () => {
		const h = "a".repeat(40);
		const result = buildV2FetchAcknowledgments([h], true);
		const lines = parsePktLineStream(result);
		const texts = lines.filter((l) => l.type === "data").map((l) => pktLineText(l));
		expect(texts).toContain("ready");
	});

	test("omits ready line when ready is undefined", () => {
		const h = "a".repeat(40);
		const result = buildV2FetchAcknowledgments([h]);
		const lines = parsePktLineStream(result);
		const texts = lines.filter((l) => l.type === "data").map((l) => pktLineText(l));
		expect(texts).not.toContain("ready");
	});
});

// ── HTTP v2 integration ─────────────────────────────────────────────

const TEST_IDENTITY = {
	name: "Test",
	email: "test@test.com",
	timestamp: 1000000000,
	timezone: "+0000",
};

function v2Headers(extra?: Record<string, string>): Record<string, string> {
	return { "Git-Protocol": "version=2", ...extra };
}

describe("HTTP protocol v2", () => {
	let serverFetch: (req: Request) => Promise<Response>;
	let headHash: string;

	beforeAll(async () => {
		const driver = new MemoryStorage();
		const storage = createStorageAdapter(driver);
		const repo = await storage.createRepo("repo");

		const blob = await writeBlob(repo, "# test");
		const tree = await writeTree(repo, [{ name: "README.md", hash: blob }]);
		headHash = await createCommit(repo, {
			tree,
			parents: [],
			author: TEST_IDENTITY,
			committer: TEST_IDENTITY,
			message: "init\n",
		});
		await repo.refStore.writeRef("refs/heads/main", { type: "direct", hash: headHash });

		const server = createServer({ storage: driver });
		serverFetch = server.fetch;
	});

	test("info/refs with v2 header returns capability advertisement", async () => {
		const res = await serverFetch(
			new Request("http://localhost/repo/info/refs?service=git-upload-pack", {
				headers: v2Headers(),
			}),
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("application/x-git-upload-pack-advertisement");

		const body = new Uint8Array(await res.arrayBuffer());
		const lines = parsePktLineStream(body);
		expect(pktLineText(lines[0]!)).toBe("version 2");
		expect(lines[lines.length - 1]!.type).toBe("flush");

		const texts = lines.filter((l) => l.type === "data").map((l) => pktLineText(l));
		expect(texts.some((t) => t.startsWith("ls-refs"))).toBe(true);
		expect(texts.some((t) => t.startsWith("fetch"))).toBe(true);
	});

	test("info/refs without v2 header returns v1 ref advertisement", async () => {
		const res = await serverFetch(
			new Request("http://localhost/repo/info/refs?service=git-upload-pack"),
		);
		expect(res.status).toBe(200);

		const body = new Uint8Array(await res.arrayBuffer());
		const lines = parsePktLineStream(body);
		expect(pktLineText(lines[0]!)).toBe("# service=git-upload-pack");
		expect(lines[1]!.type).toBe("flush");
	});

	test("info/refs v2 for receive-pack falls back to v1", async () => {
		const res = await serverFetch(
			new Request("http://localhost/repo/info/refs?service=git-receive-pack", {
				headers: v2Headers(),
			}),
		);
		expect(res.status).toBe(200);

		const body = new Uint8Array(await res.arrayBuffer());
		const lines = parsePktLineStream(body);
		expect(pktLineText(lines[0]!)).toBe("# service=git-receive-pack");
	});

	test("POST ls-refs command returns refs", async () => {
		const reqBody = concatPktLines(
			encodePktLine("command=ls-refs\n"),
			encodePktLine("agent=test\n"),
			delimPkt(),
			encodePktLine("symrefs\n"),
			encodePktLine("ref-prefix refs/heads/\n"),
			encodePktLine("ref-prefix HEAD\n"),
			flushPkt(),
		);
		const res = await serverFetch(
			new Request("http://localhost/repo/git-upload-pack", {
				method: "POST",
				headers: v2Headers(),
				body: reqBody,
			}),
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("application/x-git-upload-pack-result");

		const body = new Uint8Array(await res.arrayBuffer());
		const lines = parsePktLineStream(body);

		const dataLines = lines.filter((l) => l.type === "data").map((l) => pktLineText(l));
		expect(dataLines.some((l) => l.includes("HEAD"))).toBe(true);
		expect(dataLines.some((l) => l.includes("refs/heads/main"))).toBe(true);
		expect(dataLines.some((l) => l.includes("symref-target:"))).toBe(true);
		expect(lines[lines.length - 1]!.type).toBe("flush");
	});

	test("POST fetch command (fresh clone) returns packfile", async () => {
		const reqBody = concatPktLines(
			encodePktLine("command=fetch\n"),
			encodePktLine("agent=test\n"),
			delimPkt(),
			encodePktLine(`want ${headHash}\n`),
			encodePktLine("done\n"),
			flushPkt(),
		);
		const res = await serverFetch(
			new Request("http://localhost/repo/git-upload-pack", {
				method: "POST",
				headers: v2Headers(),
				body: reqBody,
			}),
		);
		expect(res.status).toBe(200);

		const body = new Uint8Array(await res.arrayBuffer());
		const lines = parsePktLineStream(body);

		const texts = lines.filter((l) => l.type === "data").map((l) => pktLineText(l));
		expect(texts[0]).toBe("packfile");
		expect(lines[lines.length - 1]!.type).toBe("flush");
	});

	test("hidden refs cannot be fetched via want-ref or direct want", async () => {
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

		const secretBlob = await writeBlob(repo, "internal only");
		const secretTree = await writeTree(repo, [{ name: "internal.txt", hash: secretBlob }]);
		const hiddenHash = await createCommit(repo, {
			tree: secretTree,
			parents: [],
			author: TEST_IDENTITY,
			committer: TEST_IDENTITY,
			message: "internal\n",
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

		const lsRefsBody = concatPktLines(
			encodePktLine("command=ls-refs\n"),
			encodePktLine("agent=test\n"),
			delimPkt(),
			encodePktLine("symrefs\n"),
			encodePktLine("ref-prefix refs/heads/\n"),
			encodePktLine("ref-prefix HEAD\n"),
			flushPkt(),
		);
		const lsRefsRes = await server.fetch(
			new Request("http://localhost/repo/git-upload-pack", {
				method: "POST",
				headers: v2Headers(),
				body: lsRefsBody,
			}),
		);
		expect(lsRefsRes.status).toBe(200);

		const lsRefsLines = parsePktLineStream(new Uint8Array(await lsRefsRes.arrayBuffer()));
		const lsRefsTexts = lsRefsLines.filter((l) => l.type === "data").map((l) => pktLineText(l));
		expect(lsRefsTexts.some((line) => line.includes("refs/heads/main"))).toBe(true);
		expect(lsRefsTexts.some((line) => line.includes("refs/heads/internal"))).toBe(false);

		const fetchBody = concatPktLines(
			encodePktLine("command=fetch\n"),
			encodePktLine("agent=test\n"),
			delimPkt(),
			encodePktLine("want-ref refs/heads/internal\n"),
			encodePktLine("done\n"),
			flushPkt(),
		);
		const fetchRes = await server.fetch(
			new Request("http://localhost/repo/git-upload-pack", {
				method: "POST",
				headers: v2Headers(),
				body: fetchBody,
			}),
		);
		expect(fetchRes.status).toBe(403);
		expect(await fetchRes.text()).toContain("forbidden want-ref");

		const directWantBody = concatPktLines(
			encodePktLine("command=fetch\n"),
			encodePktLine("agent=test\n"),
			delimPkt(),
			encodePktLine(`want ${hiddenHash}\n`),
			encodePktLine("done\n"),
			flushPkt(),
		);
		const directWantRes = await server.fetch(
			new Request("http://localhost/repo/git-upload-pack", {
				method: "POST",
				headers: v2Headers(),
				body: directWantBody,
			}),
		);
		expect(directWantRes.status).toBe(403);
		expect(await directWantRes.text()).toContain("forbidden want");
	});

	test("POST unknown v2 command returns 400", async () => {
		const reqBody = concatPktLines(encodePktLine("command=foobar\n"), delimPkt(), flushPkt());
		const res = await serverFetch(
			new Request("http://localhost/repo/git-upload-pack", {
				method: "POST",
				headers: v2Headers(),
				body: reqBody,
			}),
		);
		expect(res.status).toBe(400);
	});

	test("POST without v2 header uses v1 upload-pack", async () => {
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

		const body = new Uint8Array(await res.arrayBuffer());
		const text = new TextDecoder().decode(body);
		expect(text).toContain("NAK");
	});
});

// ── V2 operation handlers ───────────────────────────────────────────

describe("handleLsRefs", () => {
	let repo: GitRepo;
	let commitHash: string;

	beforeAll(async () => {
		const driver = new MemoryStorage();
		const storage = createStorageAdapter(driver);
		repo = await storage.createRepo("test");

		const blob = await writeBlob(repo, "content");
		const tree = await writeTree(repo, [{ name: "file.txt", hash: blob }]);
		commitHash = await createCommit(repo, {
			tree,
			parents: [],
			author: TEST_IDENTITY,
			committer: TEST_IDENTITY,
			message: "test\n",
		});
		await repo.refStore.writeRef("refs/heads/main", { type: "direct", hash: commitHash });
		await repo.refStore.writeRef("refs/tags/v1.0", { type: "direct", hash: commitHash });
	});

	test("returns all refs with symrefs", async () => {
		const result = await handleLsRefs(repo, "test", ["symrefs"], undefined, null);
		expect(result).toBeInstanceOf(Uint8Array);

		const lines = parsePktLineStream(result as Uint8Array);
		const texts = lines.filter((l) => l.type === "data").map((l) => pktLineText(l));

		expect(texts.some((t) => t.includes("HEAD"))).toBe(true);
		expect(texts.some((t) => t.includes("refs/heads/main"))).toBe(true);
		expect(texts.some((t) => t.includes("refs/tags/v1.0"))).toBe(true);
		expect(texts.some((t) => t.includes("symref-target:"))).toBe(true);
	});

	test("filters by ref-prefix", async () => {
		const result = await handleLsRefs(repo, "test", ["ref-prefix refs/tags/"], undefined, null);
		const lines = parsePktLineStream(result as Uint8Array);
		const texts = lines.filter((l) => l.type === "data").map((l) => pktLineText(l));

		expect(texts.every((t) => t.includes("refs/tags/"))).toBe(true);
		expect(texts.some((t) => t.includes("refs/heads/"))).toBe(false);
	});

	test("respects advertiseRefs hook rejection", async () => {
		const result = await handleLsRefs(
			repo,
			"test",
			[],
			{
				advertiseRefs: async () => ({ reject: true, message: "denied" }),
			},
			null,
		);
		expect(result).toHaveProperty("reject", true);
	});
});

describe("handleV2Fetch", () => {
	let repo: GitRepo;
	let commit1Hash: string;
	let commit2Hash: string;

	beforeAll(async () => {
		const driver = new MemoryStorage();
		const storage = createStorageAdapter(driver);
		repo = await storage.createRepo("test");

		const blob1 = await writeBlob(repo, "content1");
		const tree1 = await writeTree(repo, [{ name: "file.txt", hash: blob1 }]);
		commit1Hash = await createCommit(repo, {
			tree: tree1,
			parents: [],
			author: TEST_IDENTITY,
			committer: TEST_IDENTITY,
			message: "first\n",
		});
		await repo.refStore.writeRef("refs/heads/main", { type: "direct", hash: commit1Hash });

		const blob2 = await writeBlob(repo, "content2");
		const tree2 = await writeTree(repo, [
			{ name: "file.txt", hash: blob2 },
			{ name: "new.txt", hash: blob1 },
		]);
		commit2Hash = await createCommit(repo, {
			tree: tree2,
			parents: [commit1Hash],
			author: TEST_IDENTITY,
			committer: TEST_IDENTITY,
			message: "second\n",
		});
		await repo.refStore.writeRef("refs/heads/main", { type: "direct", hash: commit2Hash });
	});

	test("fresh clone fetch (wants with done, no haves) returns packfile", async () => {
		const args = [`want ${commit2Hash}`, "done"];
		const result = await handleV2Fetch(repo, args);
		expect(result).toBeInstanceOf(Uint8Array);

		const lines = parsePktLineStream(result as Uint8Array);
		const texts = lines.filter((l) => l.type === "data").map((l) => pktLineText(l));

		expect(texts[0]).toBe("packfile");
		expect(lines[lines.length - 1]!.type).toBe("flush");

		// Second line should be sideband data containing PACK header
		const sidebandLine = lines[1]!;
		if (sidebandLine.type === "data") {
			expect(sidebandLine.data[0]).toBe(1); // band-1
			expect(sidebandLine.data[1]).toBe(0x50); // 'P'
			expect(sidebandLine.data[2]).toBe(0x41); // 'A'
			expect(sidebandLine.data[3]).toBe(0x43); // 'C'
			expect(sidebandLine.data[4]).toBe(0x4b); // 'K'
		}
	});

	test("incremental fetch with haves returns acks + ready + packfile", async () => {
		const args = [`want ${commit2Hash}`, `have ${commit1Hash}`];
		const result = await handleV2Fetch(repo, args);
		expect(result).toBeInstanceOf(Uint8Array);

		const lines = parsePktLineStream(result as Uint8Array);
		const texts = lines.filter((l) => l.type === "data").map((l) => pktLineText(l));

		expect(texts[0]).toBe("acknowledgments");
		expect(texts[1]).toBe(`ACK ${commit1Hash}`);
		expect(texts[2]).toBe("ready");

		const delimIdx = lines.findIndex((l) => l.type === "delim");
		expect(delimIdx).toBeGreaterThan(0);

		const afterDelim = lines
			.slice(delimIdx + 1)
			.filter((l) => l.type === "data")
			.map((l) => pktLineText(l));
		expect(afterDelim[0]).toBe("packfile");
	});

	test("negotiation without done and without common returns NAK", async () => {
		const args = [`want ${commit2Hash}`, `have ${"f".repeat(40)}`];
		const result = await handleV2Fetch(repo, args);
		expect(result).toBeInstanceOf(Uint8Array);

		const lines = parsePktLineStream(result as Uint8Array);
		const texts = lines.filter((l) => l.type === "data").map((l) => pktLineText(l));

		expect(texts[0]).toBe("acknowledgments");
		expect(texts[1]).toBe("NAK");
		// No packfile — just ack-only
		expect(texts.some((t) => t === "packfile")).toBe(false);
	});
});

// ── End-to-end: just-git client against v2 server ───────────────────

describe("end-to-end v2 with just-git client", () => {
	let srv: ReturnType<typeof Bun.serve>;
	let port: number;

	beforeAll(async () => {
		const result = await createSeededServer(
			{ "README.md": "# V2 Test", "src/app.ts": "export default 42;" },
			"v2repo",
		);
		srv = result.srv;
		port = result.port;
	});

	afterAll(() => {
		srv?.stop();
	});

	test("clone, commit, push, fetch cycle works", async () => {
		const client1 = createServerClient();
		const cloneResult = await client1.exec(`git clone http://localhost:${port}/v2repo /local`, {
			env: envAt(1000002000),
		});
		expect(cloneResult.exitCode).toBe(0);

		const readme = await client1.readFile("/local/README.md");
		expect(readme).toBe("# V2 Test");

		await client1.writeFile("/local/new.txt", "new content");
		await client1.exec("git add .", { cwd: "/local" });
		await client1.exec('git commit -m "add new file"', {
			cwd: "/local",
			env: envAt(1000002100),
		});
		const pushResult = await client1.exec("git push origin main", { cwd: "/local" });
		expect(pushResult.exitCode).toBe(0);

		const client2 = createServerClient();
		const clone2Result = await client2.exec(`git clone http://localhost:${port}/v2repo /local2`, {
			env: envAt(1000002200),
		});
		expect(clone2Result.exitCode).toBe(0);

		const newFile = await client2.readFile("/local2/new.txt");
		expect(newFile).toBe("new content");
	});
});

// ── SSH v2 session ──────────────────────────────────────────────────

describe("SSH v2 session", () => {
	test("v2 upload-pack sends capability advertisement and handles ls-refs", async () => {
		const driver = new MemoryStorage();
		const server = createServer({ storage: driver });
		const repo = await server.createRepo("ssh-test");

		const blob = await writeBlob(repo, "ssh content");
		const tree = await writeTree(repo, [{ name: "file.txt", hash: blob }]);
		const commitHash = await createCommit(repo, {
			tree,
			parents: [],
			author: TEST_IDENTITY,
			committer: TEST_IDENTITY,
			message: "init\n",
		});
		await repo.refStore.writeRef("refs/heads/main", { type: "direct", hash: commitHash });

		const lsRefsCmd = concatPktLines(
			encodePktLine("command=ls-refs\n"),
			delimPkt(),
			encodePktLine("symrefs\n"),
			encodePktLine("ref-prefix refs/heads/\n"),
			encodePktLine("ref-prefix HEAD\n"),
			flushPkt(),
			flushPkt(), // empty request to end session
		);

		const responseChunks: Uint8Array[] = [];
		const channel: SshChannel = {
			readable: new ReadableStream({
				start(controller) {
					controller.enqueue(lsRefsCmd);
					controller.close();
				},
			}),
			writable: new WritableStream({
				write(chunk) {
					responseChunks.push(chunk);
				},
			}),
		};

		// v2 is signaled via --protocol=version=2 in the SSH command
		const exitCode = await server.handleSession(
			"git-upload-pack --protocol=version=2 '/ssh-test'",
			channel,
			{ username: "test-user" },
		);

		expect(exitCode).toBe(0);
		expect(responseChunks.length).toBeGreaterThan(0);

		const fullResponse = concatBytes(...responseChunks);
		const text = new TextDecoder().decode(fullResponse);
		expect(text).toContain("version 2");
		expect(text).toContain("refs/heads/main");
	});

	test("v1 upload-pack still works (no GIT_PROTOCOL)", async () => {
		const driver = new MemoryStorage();
		const server = createServer({ storage: driver });
		const repo = await server.createRepo("v1-test");

		const blob = await writeBlob(repo, "v1 content");
		const tree = await writeTree(repo, [{ name: "file.txt", hash: blob }]);
		const commitHash = await createCommit(repo, {
			tree,
			parents: [],
			author: TEST_IDENTITY,
			committer: TEST_IDENTITY,
			message: "init\n",
		});
		await repo.refStore.writeRef("refs/heads/main", { type: "direct", hash: commitHash });

		const responseChunks: Uint8Array[] = [];
		const channel: SshChannel = {
			readable: new ReadableStream({
				start(c) {
					c.close();
				},
			}),
			writable: new WritableStream({
				write(chunk) {
					responseChunks.push(chunk);
				},
			}),
		};

		const exitCode = await server.handleSession("git-upload-pack '/v1-test'", channel);
		expect(exitCode).toBe(0);

		const fullResponse = concatBytes(...responseChunks);
		const text = new TextDecoder().decode(fullResponse);
		expect(text).toContain("HEAD");
		expect(text).not.toContain("version 2");
	});
});

// ── Helpers ─────────────────────────────────────────────────────────

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
	let len = 0;
	for (const a of arrays) len += a.byteLength;
	const result = new Uint8Array(len);
	let off = 0;
	for (const a of arrays) {
		result.set(a, off);
		off += a.byteLength;
	}
	return result;
}
