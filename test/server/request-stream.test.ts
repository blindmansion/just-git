import { describe, expect, test } from "bun:test";
import { concatPktLines, encodePktLine, flushPkt } from "../../src/lib/transport/pkt-line.ts";
import { RequestLimitError } from "../../src/server/errors.ts";
import { readReceivePackCommands, StreamPktLineReader } from "../../src/server/request-stream.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const HASH_A = "a".repeat(40);
const HASH_B = "b".repeat(40);
const HASH_C = "c".repeat(40);

function streamFromChunks(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			controller.close();
		},
	});
}

function command(
	oldHash: string,
	newHash: string,
	refName: string,
	capabilities?: readonly string[],
): Uint8Array {
	const suffix = capabilities ? `\0${capabilities.join(" ")}` : "";
	return encodePktLine(`${oldHash} ${newHash} ${refName}${suffix}\n`);
}

async function parse(chunks: Uint8Array[]) {
	const reader = new StreamPktLineReader(streamFromChunks(...chunks));
	try {
		return await readReceivePackCommands(reader);
	} finally {
		reader.release();
	}
}

describe("request stream receive-pack commands", () => {
	test("parses commands across arbitrary chunk boundaries", async () => {
		const body = concatPktLines(
			command(HASH_A, HASH_B, "refs/heads/main"),
			command(HASH_B, HASH_C, "refs/heads/topic"),
			flushPkt(),
		);

		for (let split = 0; split <= body.byteLength; split++) {
			const result = await parse([body.slice(0, split), body.slice(split)]);
			expect(result.commands).toEqual([
				{ oldHash: HASH_A, newHash: HASH_B, refName: "refs/heads/main" },
				{ oldHash: HASH_B, newHash: HASH_C, refName: "refs/heads/topic" },
			]);
			expect(result.sawFlush).toBe(true);
		}

		const byteChunks = Array.from(body, (_, index) => body.slice(index, index + 1));
		expect((await parse(byteChunks)).commands).toHaveLength(2);
	});

	test("reads capabilities only from the first command", async () => {
		const result = await parse([
			concatPktLines(
				command(HASH_A, HASH_B, "refs/heads/main", ["report-status", "side-band-64k"]),
				command(HASH_B, HASH_C, "refs/heads/topic"),
				flushPkt(),
			),
		]);

		expect(result.capabilities).toEqual(["report-status", "side-band-64k"]);
		expect(result.commands[0]?.refName).toBe("refs/heads/main");
		expect(result.commands[1]?.refName).toBe("refs/heads/topic");
	});

	test("stops at the command-section flush packet", async () => {
		const result = await parse([
			concatPktLines(command(HASH_A, HASH_B, "refs/heads/main"), flushPkt()),
		]);

		expect(result.sawFlush).toBe(true);
		expect(result.commands).toHaveLength(1);
	});

	test("rejects malformed packet lengths without consuming them", async () => {
		for (const header of ["000g", "0003", "ffff"]) {
			const bytes = encoder.encode(header);
			const reader = new StreamPktLineReader(streamFromChunks(bytes));
			try {
				expect(await reader.readPktLine()).toBeNull();
				expect(decoder.decode((await Array.fromAsync(reader.streamRemaining()))[0])).toBe(header);
			} finally {
				reader.release();
			}
		}
	});

	test("reports an incomplete command section for truncated packet payloads", async () => {
		const result = await parse([encoder.encode("000aabc")]);

		expect(result).toEqual({ commands: [], capabilities: [], sawFlush: false });
	});

	test("reports a missing flush packet after complete commands", async () => {
		const result = await parse([command(HASH_A, HASH_B, "refs/heads/main")]);

		expect(result.commands).toHaveLength(1);
		expect(result.sawFlush).toBe(false);
	});

	test("preserves bytes buffered after the command section", async () => {
		const pack = encoder.encode("PACK\0raw-pack-bytes");
		const body = concatPktLines(command(HASH_A, HASH_B, "refs/heads/main"), flushPkt(), pack);
		const reader = new StreamPktLineReader(streamFromChunks(body));
		try {
			const result = await readReceivePackCommands(reader);
			const remaining = concatPktLines(...(await Array.fromAsync(reader.streamRemaining())));

			expect(result.sawFlush).toBe(true);
			expect(remaining).toEqual(pack);
		} finally {
			reader.release();
		}
	});

	test("enforces configured command byte and count limits", async () => {
		const first = command(HASH_A, HASH_B, "refs/heads/main");
		const body = concatPktLines(first, command(HASH_B, HASH_C, "refs/heads/topic"), flushPkt());

		const byteReader = new StreamPktLineReader(streamFromChunks(body));
		try {
			await expect(
				readReceivePackCommands(byteReader, { maxCommandBytes: first.byteLength - 1 }),
			).rejects.toBeInstanceOf(RequestLimitError);
		} finally {
			byteReader.release();
		}

		const countReader = new StreamPktLineReader(streamFromChunks(body));
		try {
			await expect(readReceivePackCommands(countReader, { maxCommands: 1 })).rejects.toBeInstanceOf(
				RequestLimitError,
			);
		} finally {
			countReader.release();
		}
	});
});
