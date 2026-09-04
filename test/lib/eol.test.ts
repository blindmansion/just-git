import { describe, expect, test } from "bun:test";
import { crlfToLf, hasCr, hasCrlf, lfToCrlf } from "../../src/lib/eol.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

describe("eol conversions", () => {
	describe("crlfToLf", () => {
		test("strips CR from CRLF pairs", () => {
			expect(dec.decode(crlfToLf(enc.encode("a\r\nb\r\n")))).toBe("a\nb\n");
		});

		test("returns input reference unchanged when no CRLF", () => {
			const input = enc.encode("a\nb\n");
			expect(crlfToLf(input)).toBe(input);
		});

		test("leaves lone CR and lone LF untouched", () => {
			expect(dec.decode(crlfToLf(enc.encode("a\rb\nc\r\nd")))).toBe("a\rb\nc\nd");
		});

		test("handles CRLF at end of content", () => {
			expect(dec.decode(crlfToLf(enc.encode("x\r\n")))).toBe("x\n");
		});
	});

	describe("lfToCrlf", () => {
		test("inserts CR before every LF", () => {
			expect(dec.decode(lfToCrlf(enc.encode("a\nb\n")))).toBe("a\r\nb\r\n");
		});

		test("declines when content already contains a CR", () => {
			const input = enc.encode("a\r\nb\n");
			expect(lfToCrlf(input)).toBe(input);
		});

		test("declines for binary content", () => {
			const input = new Uint8Array([0x41, 0x00, 0x0a]);
			expect(lfToCrlf(input)).toBe(input);
		});

		test("no-op when there is no LF", () => {
			const input = enc.encode("abc");
			expect(lfToCrlf(input)).toBe(input);
		});
	});

	describe("scanners", () => {
		test("hasCrlf detects pairs only", () => {
			expect(hasCrlf(enc.encode("a\r\nb"))).toBe(true);
			expect(hasCrlf(enc.encode("a\rb\n"))).toBe(false);
			expect(hasCrlf(enc.encode("a\r"))).toBe(false);
		});

		test("hasCr detects any CR", () => {
			expect(hasCr(enc.encode("a\rb"))).toBe(true);
			expect(hasCr(enc.encode("a\nb"))).toBe(false);
		});
	});
});
