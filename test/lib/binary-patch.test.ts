import { describe, expect, test } from "bun:test";
import { formatBinaryPatch } from "../../src/lib/diff/binary-patch.ts";
import { inflate } from "../../src/lib/pack/zlib.ts";

const enc = new TextEncoder();

/** The 17-byte blob just-git and git both hash to 83952c4…. */
const BLOB17 = new Uint8Array([
	0x01, 0x02, 0x03, 0x00, 0xc3, 0xbf, 0xc3, 0xbe, 0x50, 0x4e, 0x47, 0x44, 0x41, 0x54, 0x41, 0x00,
	0x01,
]);

/** git's base85 alphabet, for decoding a `GIT binary patch` payload back to bytes. */
const EN85 =
	"0123456789" +
	"ABCDEFGHIJKLMNOPQRSTUVWXYZ" +
	"abcdefghijklmnopqrstuvwxyz" +
	"!#$%&()*+-;<=>?@^_`{|}~";
const DE85 = new Map<string, number>([...EN85].map((c, i) => [c, i]));

/** Decode a single git-base85 line (a length char + encoded body) to raw bytes. */
function decode85Line(line: string): Uint8Array {
	const lenChar = line.charCodeAt(0);
	const len = lenChar >= 97 ? lenChar - 97 + 27 : lenChar - 65 + 1; // 'a'-'z' => 27-52, 'A'-'Z' => 1-26
	const body = line.slice(1);
	const out: number[] = [];
	for (let i = 0; i < body.length; i += 5) {
		let acc = 0;
		for (let j = 0; j < 5; j++) acc = acc * 85 + (DE85.get(body[i + j] as string) as number);
		out.push((acc >>> 24) & 0xff, (acc >>> 16) & 0xff, (acc >>> 8) & 0xff, acc & 0xff);
	}
	return new Uint8Array(out.slice(0, len));
}

/** Extract and inflate the forward (`literal N`) payload of a binary patch body. */
async function inflateForward(patch: string): Promise<Uint8Array> {
	const lines = patch.split("\n");
	const litIdx = lines.findIndex((l) => l.startsWith("literal "));
	const chunks: number[] = [];
	for (let i = litIdx + 1; i < lines.length && lines[i] !== ""; i++) {
		chunks.push(...decode85Line(lines[i] as string));
	}
	return inflate(new Uint8Array(chunks));
}

describe("formatBinaryPatch", () => {
	test("matches git's literal payload byte-for-byte (verified against git 2.53.0)", async () => {
		const patch = await formatBinaryPatch(new Uint8Array(0), BLOB17);
		expect(patch).toBe(
			"GIT binary patch\n" +
				"literal 17\n" +
				"YcmZQ%VrDqJ|M0#5KX(_$5Jv_^053TO3IG5A\n" +
				"\n" +
				"literal 0\n" +
				"HcmV?d00001\n" +
				"\n",
		);
	});

	test("forward block deflates back to the new blob; reverse to the old", async () => {
		const oldBytes = enc.encode("old binary\x00payload");
		const newBytes = enc.encode("a different\x00binary\x00blob here");
		const patch = await formatBinaryPatch(oldBytes, newBytes);

		// `literal <size>` reports the *uncompressed* size of each side.
		expect(patch).toContain(`literal ${newBytes.length}\n`);
		expect(patch).toContain(`literal ${oldBytes.length}\n`);

		// The forward payload must inflate back to the new blob exactly.
		expect(await inflateForward(patch)).toEqual(newBytes);
	});

	test("wraps long payloads at 52 source bytes per line", async () => {
		// A run of random-ish bytes that won't compress to <52 bytes.
		const big = new Uint8Array(400);
		for (let i = 0; i < big.length; i++) big[i] = (i * 37 + 11) & 0xff;
		const patch = await formatBinaryPatch(new Uint8Array(0), big);
		const dataLines = patch
			.split("\n")
			.filter((l) => l.length > 0 && !l.startsWith("literal ") && l !== "GIT binary patch");
		// Every full line encodes 52 bytes ('z' length char) → 1 + ceil(52/4)*5 = 66 chars.
		const fullLines = dataLines.filter((l) => l.startsWith("z"));
		expect(fullLines.length).toBeGreaterThan(0);
		for (const l of fullLines) expect(l.length).toBe(66);
		// Round-trips regardless of wrapping.
		expect(await inflateForward(patch)).toEqual(big);
	});
});
