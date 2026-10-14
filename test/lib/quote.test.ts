import { describe, expect, test } from "bun:test";
import { quoteCPath } from "../../src/lib/quote.ts";

describe("quoteCPath", () => {
	test("returns plain ASCII paths unchanged, spaces included", () => {
		for (const path of ["a", "dir/sub/file.txt", "sp ace", "~!@#$%^&*()"]) {
			expect(quoteCPath(path)).toBe(path);
		}
	});

	test("C-escapes control characters, quotes and backslashes", () => {
		expect(quoteCPath('q"uote')).toBe('"q\\"uote"');
		expect(quoteCPath("back\\slash")).toBe('"back\\\\slash"');
		expect(quoteCPath("a\tb\nc\rd")).toBe('"a\\tb\\nc\\rd"');
		expect(quoteCPath("\x07\x08\x0b\x0c")).toBe('"\\a\\b\\v\\f"');
	});

	test("octal-escapes other control bytes, DEL and non-ASCII UTF-8 bytes", () => {
		expect(quoteCPath("\x01x")).toBe('"\\001x"');
		expect(quoteCPath("\x7f")).toBe('"\\177"');
		expect(quoteCPath("dir/é.txt")).toBe('"dir/\\303\\251.txt"');
		expect(quoteCPath("😀")).toBe('"\\360\\237\\230\\200"');
	});
});
