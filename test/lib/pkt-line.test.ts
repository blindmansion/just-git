import { describe, expect, test } from "bun:test";
import {
	concatPktLines,
	demuxSideband,
	demuxSidebandStreaming,
	encodePktLine,
	flushPkt,
	parsePktLineStream,
	parsePktLinesFromStream,
	pktLineText,
} from "../../src/lib/transport/pkt-line.ts";

const enc = new TextEncoder();

describe("encodePktLine", () => {
	test("encodes string with correct hex length", () => {
		const result = encodePktLine("hello\n");
		const hex = new TextDecoder().decode(result.subarray(0, 4));
		expect(hex).toBe("000a"); // 4 + 6 = 10 = 0x0a
		expect(new TextDecoder().decode(result.subarray(4))).toBe("hello\n");
	});

	test("encodes Uint8Array payload", () => {
		const payload = enc.encode("abc");
		const result = encodePktLine(payload);
		expect(result.byteLength).toBe(7); // 4 + 3
		const hex = new TextDecoder().decode(result.subarray(0, 4));
		expect(hex).toBe("0007");
	});

	test("matches spec example: # service=git-upload-pack", () => {
		const line = encodePktLine("# service=git-upload-pack\n");
		const hex = new TextDecoder().decode(line.subarray(0, 4));
		expect(hex).toBe("001e"); // 4 + 26 = 30 = 0x1e
	});

	test("rejects oversized payload", () => {
		const huge = new Uint8Array(65520);
		expect(() => encodePktLine(huge)).toThrow("pkt-line too long");
	});

	test("accepts maximum valid payload (65516 bytes)", () => {
		const maxPayload = new Uint8Array(65516);
		const result = encodePktLine(maxPayload);
		expect(result.byteLength).toBe(65520); // 4 + 65516
		const hex = new TextDecoder().decode(result.subarray(0, 4));
		expect(hex).toBe("fff0"); // 65520 = 0xfff0
	});

	test("encodes minimum data packet (empty payload)", () => {
		const result = encodePktLine(new Uint8Array(0));
		expect(result.byteLength).toBe(4);
		const hex = new TextDecoder().decode(result);
		expect(hex).toBe("0004");
	});
});

describe("flushPkt", () => {
	test("returns 0000", () => {
		const f = flushPkt();
		expect(new TextDecoder().decode(f)).toBe("0000");
	});
});

describe("parsePktLineStream", () => {
	test("parses a stream of lines and flushes", () => {
		const stream = concatPktLines(encodePktLine("hello\n"), encodePktLine("world\n"), flushPkt());
		const lines = parsePktLineStream(stream);
		expect(lines).toHaveLength(3);
		expect(pktLineText(lines[0]!)).toBe("hello");
		expect(pktLineText(lines[1]!)).toBe("world");
		expect(lines[2]!.type).toBe("flush");
	});

	test("handles empty stream", () => {
		const lines = parsePktLineStream(new Uint8Array(0));
		expect(lines).toHaveLength(0);
	});

	test("round-trips binary data", () => {
		const binary = new Uint8Array([0x00, 0xff, 0x80, 0x01]);
		const encoded = encodePktLine(binary);
		const parsed = parsePktLineStream(encoded);
		expect(parsed).toHaveLength(1);
		expect(parsed[0]!.type).toBe("data");
		if (parsed[0]!.type === "data") {
			expect(Array.from(parsed[0]!.data)).toEqual(Array.from(binary));
		}
	});

	test("parses multiple flush packets", () => {
		const stream = concatPktLines(flushPkt(), flushPkt());
		const lines = parsePktLineStream(stream);
		expect(lines).toHaveLength(2);
		expect(lines[0]!.type).toBe("flush");
		expect(lines[1]!.type).toBe("flush");
	});

	test("throws on truncated header", () => {
		expect(() => parsePktLineStream(enc.encode("00"))).toThrow("Truncated");
	});

	test("throws on truncated payload", () => {
		expect(() => parsePktLineStream(enc.encode("0010abc"))).toThrow("Truncated");
	});

	test("throws on non-hex length characters", () => {
		expect(() => parsePktLineStream(enc.encode("ZZZZ"))).toThrow("Invalid pkt-line length");
	});

	test("parses delim-pkt (0001) and response-end-pkt (0002)", () => {
		const delim = parsePktLineStream(enc.encode("0001"));
		expect(delim).toHaveLength(1);
		expect(delim[0].type).toBe("delim");

		const respEnd = parsePktLineStream(enc.encode("0002"));
		expect(respEnd).toHaveLength(1);
		expect(respEnd[0].type).toBe("response-end");
	});

	test("throws on length 3 (below minimum)", () => {
		expect(() => parsePktLineStream(enc.encode("0003"))).toThrow("Invalid pkt-line length");
	});

	test("parses minimum data packet (len=4, empty payload)", () => {
		const lines = parsePktLineStream(enc.encode("0004"));
		expect(lines).toHaveLength(1);
		expect(lines[0]!.type).toBe("data");
		if (lines[0]!.type === "data") {
			expect(lines[0]!.data.byteLength).toBe(0);
		}
	});

	test("parses data followed by flush followed by more data", () => {
		const stream = concatPktLines(
			encodePktLine("before\n"),
			flushPkt(),
			encodePktLine("after\n"),
			flushPkt(),
		);
		const lines = parsePktLineStream(stream);
		expect(lines).toHaveLength(4);
		expect(pktLineText(lines[0]!)).toBe("before");
		expect(lines[1]!.type).toBe("flush");
		expect(pktLineText(lines[2]!)).toBe("after");
		expect(lines[3]!.type).toBe("flush");
	});
});

describe("pktLineText", () => {
	test("strips trailing LF", () => {
		const line = parsePktLineStream(encodePktLine("hello\n"))[0]!;
		expect(pktLineText(line)).toBe("hello");
	});

	test("works without trailing LF", () => {
		const line = parsePktLineStream(encodePktLine("hello"))[0]!;
		expect(pktLineText(line)).toBe("hello");
	});

	test("returns empty for flush", () => {
		expect(pktLineText({ type: "flush" })).toBe("");
	});

	test("preserves internal newlines", () => {
		const line = parsePktLineStream(encodePktLine("line1\nline2\n"))[0]!;
		expect(pktLineText(line)).toBe("line1\nline2");
	});

	test("handles empty data packet", () => {
		expect(pktLineText({ type: "data", data: new Uint8Array(0) })).toBe("");
	});
});

describe("demuxSideband", () => {
	function sidebandPkt(band: number, data: string | Uint8Array) {
		const payload = typeof data === "string" ? enc.encode(data) : data;
		const combined = new Uint8Array(1 + payload.byteLength);
		combined[0] = band;
		combined.set(payload, 1);
		return encodePktLine(combined);
	}

	test("separates pack data, progress, and errors", () => {
		const stream = concatPktLines(
			sidebandPkt(1, new Uint8Array([0x50, 0x41, 0x43, 0x4b])), // "PACK"
			sidebandPkt(2, "Counting objects: 5\n"),
			sidebandPkt(1, new Uint8Array([0xde, 0xad])),
			sidebandPkt(3, "fatal: something\n"),
			flushPkt(),
		);

		const lines = parsePktLineStream(stream);
		const result = demuxSideband(lines);

		expect(result.packData.byteLength).toBe(6); // 4 + 2
		expect(result.packData[0]).toBe(0x50); // 'P'
		expect(result.packData[4]).toBe(0xde);
		expect(result.progress).toEqual(["Counting objects: 5\n"]);
		expect(result.errors).toEqual(["fatal: something\n"]);
	});

	test("handles empty sideband stream", () => {
		const result = demuxSideband([{ type: "flush" }]);
		expect(result.packData.byteLength).toBe(0);
		expect(result.progress).toEqual([]);
		expect(result.errors).toEqual([]);
	});

	test("concatenates multiple pack chunks", () => {
		const stream = concatPktLines(
			sidebandPkt(1, new Uint8Array([1, 2, 3])),
			sidebandPkt(1, new Uint8Array([4, 5, 6])),
			flushPkt(),
		);
		const lines = parsePktLineStream(stream);
		const result = demuxSideband(lines);
		expect(Array.from(result.packData)).toEqual([1, 2, 3, 4, 5, 6]);
	});

	test("ignores unknown sideband channels", () => {
		const stream = concatPktLines(
			sidebandPkt(1, new Uint8Array([0xaa, 0xbb])),
			sidebandPkt(4, new Uint8Array([0xff])),
			sidebandPkt(1, new Uint8Array([0xcc])),
			flushPkt(),
		);
		const lines = parsePktLineStream(stream);
		const result = demuxSideband(lines);
		expect(Array.from(result.packData)).toEqual([0xaa, 0xbb, 0xcc]);
		expect(result.progress).toEqual([]);
		expect(result.errors).toEqual([]);
	});

	test("skips data lines with empty payload", () => {
		const result = demuxSideband([{ type: "data", data: new Uint8Array(0) }, { type: "flush" }]);
		expect(result.packData.byteLength).toBe(0);
	});
});

// ── Streaming parser tests ───────────────────────────────────────────

function streamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
	let i = 0;
	return new ReadableStream({
		pull(controller) {
			if (i < chunks.length) {
				controller.enqueue(chunks[i]!);
				i++;
			} else {
				controller.close();
			}
		},
	});
}

async function collectAsync<T>(gen: AsyncIterable<T>): Promise<T[]> {
	const result: T[] = [];
	for await (const item of gen) result.push(item);
	return result;
}

describe("parsePktLinesFromStream", () => {
	test("parses lines from a single chunk", async () => {
		const data = concatPktLines(encodePktLine("hello\n"), encodePktLine("world\n"), flushPkt());
		const lines = await collectAsync(parsePktLinesFromStream(streamFromChunks([data])));
		expect(lines).toHaveLength(3);
		expect(pktLineText(lines[0]!)).toBe("hello");
		expect(pktLineText(lines[1]!)).toBe("world");
		expect(lines[2]!.type).toBe("flush");
	});

	test("handles empty stream", async () => {
		const lines = await collectAsync(parsePktLinesFromStream(streamFromChunks([])));
		expect(lines).toHaveLength(0);
	});

	test("parses flush, delim, response-end", async () => {
		const data = concatPktLines(flushPkt());
		const delim = enc.encode("0001");
		const respEnd = enc.encode("0002");
		const stream = streamFromChunks([concatPktLines(data, delim, respEnd)]);
		const lines = await collectAsync(parsePktLinesFromStream(stream));
		expect(lines).toHaveLength(3);
		expect(lines[0]!.type).toBe("flush");
		expect(lines[1]!.type).toBe("delim");
		expect(lines[2]!.type).toBe("response-end");
	});

	test("handles chunk boundary splitting the header", async () => {
		const full = encodePktLine("hello\n");
		// Split at byte 2 — in the middle of the 4-byte hex header
		const chunk1 = full.slice(0, 2);
		const chunk2 = full.slice(2);
		const lines = await collectAsync(parsePktLinesFromStream(streamFromChunks([chunk1, chunk2])));
		expect(lines).toHaveLength(1);
		expect(pktLineText(lines[0]!)).toBe("hello");
	});

	test("handles chunk boundary splitting the payload", async () => {
		const full = encodePktLine("abcdef\n");
		// Split at byte 6 — within the payload (header is 4, payload starts at 5)
		const chunk1 = full.slice(0, 6);
		const chunk2 = full.slice(6);
		const lines = await collectAsync(parsePktLinesFromStream(streamFromChunks([chunk1, chunk2])));
		expect(lines).toHaveLength(1);
		expect(pktLineText(lines[0]!)).toBe("abcdef");
	});

	test("handles every byte as a separate chunk", async () => {
		const full = concatPktLines(encodePktLine("hi\n"), flushPkt());
		const chunks = Array.from(full).map((b) => new Uint8Array([b]));
		const lines = await collectAsync(parsePktLinesFromStream(streamFromChunks(chunks)));
		expect(lines).toHaveLength(2);
		expect(pktLineText(lines[0]!)).toBe("hi");
		expect(lines[1]!.type).toBe("flush");
	});

	test("handles multiple pkt-lines in one chunk", async () => {
		const full = concatPktLines(
			encodePktLine("a\n"),
			encodePktLine("b\n"),
			encodePktLine("c\n"),
			flushPkt(),
		);
		const lines = await collectAsync(parsePktLinesFromStream(streamFromChunks([full])));
		expect(lines).toHaveLength(4);
		expect(pktLineText(lines[0]!)).toBe("a");
		expect(pktLineText(lines[1]!)).toBe("b");
		expect(pktLineText(lines[2]!)).toBe("c");
		expect(lines[3]!.type).toBe("flush");
	});

	test("throws on truncated header at end of stream", async () => {
		const partial = enc.encode("00");
		expect(collectAsync(parsePktLinesFromStream(streamFromChunks([partial])))).rejects.toThrow(
			"Truncated",
		);
	});

	test("throws on truncated payload at end of stream", async () => {
		// Header says 16 bytes total, but we only provide 7
		const partial = enc.encode("0010abc");
		expect(collectAsync(parsePktLinesFromStream(streamFromChunks([partial])))).rejects.toThrow(
			"Truncated",
		);
	});

	test("throws on invalid hex in header", async () => {
		const bad = enc.encode("ZZZZ");
		expect(collectAsync(parsePktLinesFromStream(streamFromChunks([bad])))).rejects.toThrow(
			"Invalid pkt-line length",
		);
	});

	test("round-trips binary data", async () => {
		const binary = new Uint8Array([0x00, 0xff, 0x80, 0x01]);
		const encoded = encodePktLine(binary);
		const lines = await collectAsync(parsePktLinesFromStream(streamFromChunks([encoded])));
		expect(lines).toHaveLength(1);
		expect(lines[0]!.type).toBe("data");
		if (lines[0]!.type === "data") {
			expect(Array.from(lines[0]!.data)).toEqual(Array.from(binary));
		}
	});

	test("matches batch parser output for complex stream", async () => {
		const full = concatPktLines(
			encodePktLine("NAK\n"),
			flushPkt(),
			encodePktLine("data-line\n"),
			encodePktLine(new Uint8Array([1, 2, 3])),
			flushPkt(),
		);

		const batchResult = parsePktLineStream(full);
		const streamResult = await collectAsync(parsePktLinesFromStream(streamFromChunks([full])));

		expect(streamResult).toHaveLength(batchResult.length);
		for (let i = 0; i < batchResult.length; i++) {
			expect(streamResult[i]!.type).toBe(batchResult[i]!.type);
			if (batchResult[i]!.type === "data" && streamResult[i]!.type === "data") {
				const batchData = (batchResult[i] as { type: "data"; data: Uint8Array }).data;
				const streamData = (streamResult[i] as { type: "data"; data: Uint8Array }).data;
				expect(Array.from(streamData)).toEqual(Array.from(batchData));
			}
		}
	});
});

describe("demuxSidebandStreaming", () => {
	function sidebandPkt(band: number, data: string | Uint8Array) {
		const payload = typeof data === "string" ? enc.encode(data) : data;
		const combined = new Uint8Array(1 + payload.byteLength);
		combined[0] = band;
		combined.set(payload, 1);
		return encodePktLine(combined);
	}

	test("fires onProgress for band-2 messages", async () => {
		const data = concatPktLines(
			sidebandPkt(1, new Uint8Array([0x50, 0x41, 0x43, 0x4b])),
			sidebandPkt(2, "Counting objects: 5\n"),
			sidebandPkt(2, "Compressing: 100%\n"),
			sidebandPkt(1, new Uint8Array([0xde, 0xad])),
			flushPkt(),
		);

		const progress: string[] = [];
		const lines = parsePktLinesFromStream(streamFromChunks([data]));
		const result = await demuxSidebandStreaming(lines, (msg) => progress.push(msg));

		expect(result.packData.byteLength).toBe(6);
		expect(result.packData[0]).toBe(0x50);
		expect(progress).toEqual(["Counting objects: 5\n", "Compressing: 100%\n"]);
	});

	test("throws immediately on band-3 error", async () => {
		const data = concatPktLines(
			sidebandPkt(1, new Uint8Array([0x50])),
			sidebandPkt(3, "fatal: access denied\n"),
			sidebandPkt(1, new Uint8Array([0x41])),
			flushPkt(),
		);

		const lines = parsePktLinesFromStream(streamFromChunks([data]));
		expect(demuxSidebandStreaming(lines)).rejects.toThrow("Remote error: fatal: access denied");
	});

	test("collects preamble lines before sideband data", async () => {
		const data = concatPktLines(
			encodePktLine("NAK\n"),
			encodePktLine("ACK abc123\n"),
			flushPkt(),
			sidebandPkt(1, enc.encode("PACK-DATA")),
			sidebandPkt(2, "progress\n"),
			flushPkt(),
		);

		const progress: string[] = [];
		const lines = parsePktLinesFromStream(streamFromChunks([data]));
		const result = await demuxSidebandStreaming(lines, (msg) => progress.push(msg));

		expect(result.preambleLines).toHaveLength(3);
		expect(pktLineText(result.preambleLines[0]!)).toBe("NAK");
		expect(pktLineText(result.preambleLines[1]!)).toBe("ACK abc123");
		expect(result.preambleLines[2]!.type).toBe("flush");

		expect(new TextDecoder().decode(result.packData)).toBe("PACK-DATA");
		expect(progress).toEqual(["progress\n"]);
	});

	test("works without onProgress callback", async () => {
		const data = concatPktLines(
			sidebandPkt(1, enc.encode("data")),
			sidebandPkt(2, "ignored progress\n"),
			flushPkt(),
		);

		const lines = parsePktLinesFromStream(streamFromChunks([data]));
		const result = await demuxSidebandStreaming(lines);
		expect(new TextDecoder().decode(result.packData)).toBe("data");
		expect(result.preambleLines).toHaveLength(0);
	});

	test("handles empty stream", async () => {
		const lines = parsePktLinesFromStream(streamFromChunks([]));
		const result = await demuxSidebandStreaming(lines);
		expect(result.packData.byteLength).toBe(0);
		expect(result.preambleLines).toHaveLength(0);
	});

	test("assembles pack from chunked stream", async () => {
		const full = concatPktLines(
			sidebandPkt(1, new Uint8Array([1, 2, 3])),
			sidebandPkt(2, "msg\n"),
			sidebandPkt(1, new Uint8Array([4, 5, 6])),
			flushPkt(),
		);

		// Split into byte-at-a-time chunks for maximum boundary stress
		const chunks = Array.from(full).map((b) => new Uint8Array([b]));
		const progress: string[] = [];
		const lines = parsePktLinesFromStream(streamFromChunks(chunks));
		const result = await demuxSidebandStreaming(lines, (msg) => progress.push(msg));

		expect(Array.from(result.packData)).toEqual([1, 2, 3, 4, 5, 6]);
		expect(progress).toEqual(["msg\n"]);
	});
});
