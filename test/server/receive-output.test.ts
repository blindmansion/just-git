import { describe, expect, test } from "bun:test";
import { concatPktLines, parsePktLineStream } from "../../src/lib/transport/pkt-line.ts";
import { ReceivePackOutput } from "../../src/server/receive-output.ts";

const decoder = new TextDecoder();

describe("ReceivePackOutput", () => {
	test("serializes concurrent hook writes with transport backpressure", async () => {
		const chunks: Uint8Array[] = [];
		let releaseFirst!: () => void;
		const firstWrite = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let calls = 0;
		const output = new ReceivePackOutput({
			useSideband: true,
			keepAliveMs: false,
			async write(data) {
				chunks.push(data);
				if (calls++ === 0) await firstWrite;
			},
		});

		const one = output.hookOutput.writeLine("one");
		const two = output.hookOutput.writeLine("two");
		await Promise.resolve();
		expect(chunks).toHaveLength(1);

		releaseFirst();
		await Promise.all([one, two]);
		await output.finish();

		const lines = parsePktLineStream(concatPktLines(...chunks));
		expect(lines.map((line) => line.type)).toEqual(["data", "data", "flush"]);
		const messages = lines
			.filter((line) => line.type === "data")
			.map((line) => decoder.decode(line.data.subarray(1)));
		expect(messages).toEqual(["one\n", "two\n"]);
	});

	test("sends empty band-1 keepalives while sideband hooks are silent", async () => {
		const chunks: Uint8Array[] = [];
		const output = new ReceivePackOutput({
			useSideband: true,
			keepAliveMs: 5,
			async write(data) {
				chunks.push(data);
			},
		});

		output.startKeepAlive();
		await Bun.sleep(18);
		await output.finish();

		const lines = parsePktLineStream(concatPktLines(...chunks));
		expect(
			lines.some(
				(line) => line.type === "data" && line.data[0] === 1 && line.data.byteLength === 1,
			),
		).toBe(true);
		expect(lines.at(-1)!.type).toBe("flush");
	});

	test("falls back to SSH stderr without sideband", async () => {
		const protocol: Uint8Array[] = [];
		const stderr: Uint8Array[] = [];
		const output = new ReceivePackOutput({
			useSideband: false,
			async write(data) {
				protocol.push(data);
			},
			writeStderr(data) {
				stderr.push(data);
			},
		});

		await output.hookOutput.write("working");
		await output.hookOutput.writeLine("...");
		await output.writeProtocol(new TextEncoder().encode("status"));
		await output.finish();

		expect(decoder.decode(concatPktLines(...stderr))).toBe("working...\n");
		expect(decoder.decode(concatPktLines(...protocol))).toBe("status");
	});

	test("silently discards hook output when no safe channel exists", async () => {
		const output = new ReceivePackOutput({
			useSideband: false,
			async write() {},
		});

		await expect(output.hookOutput.writeLine("not on protocol stdout")).resolves.toBeUndefined();
		await output.finish();
	});
});
