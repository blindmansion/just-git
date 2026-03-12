import { describe, expect, test } from "bun:test";
import { WM_CASEFOLD, WM_MATCH, WM_PATHNAME, wildmatch } from "../../src/lib/wildmatch.ts";

function match(pattern: string, text: string, flags = 0): boolean {
	return wildmatch(pattern, text, flags) === WM_MATCH;
}

// ── Basic literal matching ──────────────────────────────────────────

describe("wildmatch literals", () => {
	test("exact match", () => {
		expect(match("foo", "foo")).toBe(true);
	});

	test("exact mismatch", () => {
		expect(match("foo", "bar")).toBe(false);
	});

	test("empty pattern matches empty string", () => {
		expect(match("", "")).toBe(true);
	});

	test("empty pattern does not match non-empty string", () => {
		expect(match("", "foo")).toBe(false);
	});

	test("non-empty pattern does not match empty string", () => {
		expect(match("foo", "")).toBe(false);
	});
});

// ── ? wildcard ──────────────────────────────────────────────────────

describe("wildmatch ?", () => {
	test("? matches single character", () => {
		expect(match("?", "a")).toBe(true);
	});

	test("? does not match empty string", () => {
		expect(match("?", "")).toBe(false);
	});

	test("? does not match / with WM_PATHNAME", () => {
		expect(match("?", "/", WM_PATHNAME)).toBe(false);
	});

	test("? matches / without WM_PATHNAME", () => {
		expect(match("?", "/")).toBe(true);
	});

	test("a?c matches abc", () => {
		expect(match("a?c", "abc")).toBe(true);
	});

	test("a?c does not match ac", () => {
		expect(match("a?c", "ac")).toBe(false);
	});

	test("a?c does not match abbc", () => {
		expect(match("a?c", "abbc")).toBe(false);
	});
});

// ── * wildcard ──────────────────────────────────────────────────────

describe("wildmatch *", () => {
	test("* matches anything", () => {
		expect(match("*", "foo")).toBe(true);
	});

	test("* matches empty string", () => {
		expect(match("*", "")).toBe(true);
	});

	test("* matches string with slashes (no WM_PATHNAME)", () => {
		expect(match("*", "foo/bar")).toBe(true);
	});

	test("* does not match / with WM_PATHNAME", () => {
		expect(match("*", "foo/bar", WM_PATHNAME)).toBe(false);
	});

	test("*.c matches hello.c", () => {
		expect(match("*.c", "hello.c")).toBe(true);
	});

	test("*.c does not match hello.h", () => {
		expect(match("*.c", "hello.h")).toBe(false);
	});

	test("f* matches foo", () => {
		expect(match("f*", "foo")).toBe(true);
	});

	test("f* does not match bar", () => {
		expect(match("f*", "bar")).toBe(false);
	});

	test("*o matches foo", () => {
		expect(match("*o", "foo")).toBe(true);
	});

	test("a*b*c matches abc", () => {
		expect(match("a*b*c", "abc")).toBe(true);
	});

	test("a*b*c matches aXXbYYc", () => {
		expect(match("a*b*c", "aXXbYYc")).toBe(true);
	});

	test("foo/* matches foo/bar with WM_PATHNAME", () => {
		expect(match("foo/*", "foo/bar", WM_PATHNAME)).toBe(true);
	});

	test("foo/* does not match foo/bar/baz with WM_PATHNAME", () => {
		expect(match("foo/*", "foo/bar/baz", WM_PATHNAME)).toBe(false);
	});
});

// ── ** (double-star) ────────────────────────────────────────────────

describe("wildmatch **", () => {
	test("** matches across directories with WM_PATHNAME", () => {
		expect(match("**", "foo/bar/baz", WM_PATHNAME)).toBe(true);
	});

	test("**/foo matches foo at root", () => {
		expect(match("**/foo", "foo", WM_PATHNAME)).toBe(true);
	});

	test("**/foo matches foo in subdirectory", () => {
		expect(match("**/foo", "a/b/foo", WM_PATHNAME)).toBe(true);
	});

	test("**/foo/bar matches nested path", () => {
		expect(match("**/foo/bar", "x/foo/bar", WM_PATHNAME)).toBe(true);
	});

	test("**/foo/bar does not match wrong nesting", () => {
		expect(match("**/foo/bar", "x/bar/foo", WM_PATHNAME)).toBe(false);
	});

	test("foo/** matches everything inside foo", () => {
		expect(match("foo/**", "foo/bar", WM_PATHNAME)).toBe(true);
	});

	test("foo/** matches deeply nested", () => {
		expect(match("foo/**", "foo/a/b/c", WM_PATHNAME)).toBe(true);
	});

	test("foo/** does not match foo itself", () => {
		expect(match("foo/**", "foo", WM_PATHNAME)).toBe(false);
	});

	test("a/**/b matches a/b (zero directories)", () => {
		expect(match("a/**/b", "a/b", WM_PATHNAME)).toBe(true);
	});

	test("a/**/b matches a/x/b (one directory)", () => {
		expect(match("a/**/b", "a/x/b", WM_PATHNAME)).toBe(true);
	});

	test("a/**/b matches a/x/y/b (two directories)", () => {
		expect(match("a/**/b", "a/x/y/b", WM_PATHNAME)).toBe(true);
	});

	test("a/**/b does not match a/b/x", () => {
		expect(match("a/**/b", "a/b/x", WM_PATHNAME)).toBe(false);
	});

	test("non-boundary ** treated as regular stars", () => {
		// "x**y" — the ** is not at a boundary, treated as two *
		expect(match("x**y", "xAy", WM_PATHNAME)).toBe(true);
		expect(match("x**y", "xy", WM_PATHNAME)).toBe(true);
	});
});

// ── [...] character classes ─────────────────────────────────────────

describe("wildmatch character classes", () => {
	test("[abc] matches a", () => {
		expect(match("[abc]", "a")).toBe(true);
	});

	test("[abc] matches c", () => {
		expect(match("[abc]", "c")).toBe(true);
	});

	test("[abc] does not match d", () => {
		expect(match("[abc]", "d")).toBe(false);
	});

	test("[a-z] matches m", () => {
		expect(match("[a-z]", "m")).toBe(true);
	});

	test("[a-z] does not match M", () => {
		expect(match("[a-z]", "M")).toBe(false);
	});

	test("[a-z] matches M with WM_CASEFOLD", () => {
		expect(match("[a-z]", "M", WM_CASEFOLD)).toBe(true);
	});

	test("[!a-z] does not match m", () => {
		expect(match("[!a-z]", "m")).toBe(false);
	});

	test("[!a-z] matches M", () => {
		expect(match("[!a-z]", "M")).toBe(true);
	});

	test("[^abc] negation with ^", () => {
		expect(match("[^abc]", "d")).toBe(true);
		expect(match("[^abc]", "a")).toBe(false);
	});

	test("[...] does not match / with WM_PATHNAME", () => {
		expect(match("[a-z/]", "/", WM_PATHNAME)).toBe(false);
	});

	test("file.[ch] matches file.c and file.h", () => {
		expect(match("file.[ch]", "file.c")).toBe(true);
		expect(match("file.[ch]", "file.h")).toBe(true);
		expect(match("file.[ch]", "file.o")).toBe(false);
	});

	test("*.[oa] matches .o and .a files", () => {
		expect(match("*.[oa]", "foo.o")).toBe(true);
		expect(match("*.[oa]", "lib.a")).toBe(true);
		expect(match("*.[oa]", "foo.c")).toBe(false);
	});
});

// ── POSIX character classes ─────────────────────────────────────────

describe("wildmatch POSIX classes", () => {
	test("[[:digit:]] matches digit", () => {
		expect(match("[[:digit:]]", "5")).toBe(true);
	});

	test("[[:digit:]] does not match letter", () => {
		expect(match("[[:digit:]]", "a")).toBe(false);
	});

	test("[[:alpha:]] matches letter", () => {
		expect(match("[[:alpha:]]", "z")).toBe(true);
	});

	test("[[:alpha:]] does not match digit", () => {
		expect(match("[[:alpha:]]", "9")).toBe(false);
	});

	test("[[:alnum:]] matches both", () => {
		expect(match("[[:alnum:]]", "a")).toBe(true);
		expect(match("[[:alnum:]]", "5")).toBe(true);
		expect(match("[[:alnum:]]", "!")).toBe(false);
	});

	test("[[:upper:]] matches uppercase", () => {
		expect(match("[[:upper:]]", "A")).toBe(true);
		expect(match("[[:upper:]]", "a")).toBe(false);
	});

	test("[[:space:]] matches space", () => {
		expect(match("[[:space:]]", " ")).toBe(true);
		expect(match("[[:space:]]", "a")).toBe(false);
	});
});

// ── Backslash escaping ──────────────────────────────────────────────

describe("wildmatch escaping", () => {
	test("\\* matches literal *", () => {
		expect(match("\\*", "*")).toBe(true);
	});

	test("\\* does not match a", () => {
		expect(match("\\*", "a")).toBe(false);
	});

	test("\\? matches literal ?", () => {
		expect(match("\\?", "?")).toBe(true);
	});

	test("\\? does not match a", () => {
		expect(match("\\?", "a")).toBe(false);
	});

	test("\\[ matches literal [", () => {
		expect(match("\\[", "[")).toBe(true);
	});

	test("\\a matches a (unnecessary escape)", () => {
		expect(match("\\a", "a")).toBe(true);
	});

	test("escaped char inside class", () => {
		expect(match("[\\]]", "]")).toBe(true);
	});
});

// ── Case folding ────────────────────────────────────────────────────

describe("wildmatch WM_CASEFOLD", () => {
	test("case sensitive by default", () => {
		expect(match("foo", "FOO")).toBe(false);
	});

	test("case insensitive with WM_CASEFOLD", () => {
		expect(match("foo", "FOO", WM_CASEFOLD)).toBe(true);
	});

	test("mixed case pattern and text", () => {
		expect(match("FoO", "fOo", WM_CASEFOLD)).toBe(true);
	});

	test("wildcard with case folding", () => {
		expect(match("*.TXT", "readme.txt", WM_CASEFOLD)).toBe(true);
	});
});

// ── Combined pathname + doublestar patterns (gitignore-like) ────────

describe("wildmatch gitignore-like patterns", () => {
	test("*.o matches foo.o at any depth with basename match", () => {
		// With WM_PATHNAME, *.o should NOT match src/foo.o (since * can't cross /)
		expect(match("*.o", "src/foo.o", WM_PATHNAME)).toBe(false);
		// But without, it does
		expect(match("*.o", "src/foo.o")).toBe(true);
	});

	test("doc/frotz matches doc/frotz", () => {
		expect(match("doc/frotz", "doc/frotz", WM_PATHNAME)).toBe(true);
	});

	test("doc/frotz does not match a/doc/frotz", () => {
		expect(match("doc/frotz", "a/doc/frotz", WM_PATHNAME)).toBe(false);
	});

	test("**/doc/frotz matches a/doc/frotz", () => {
		expect(match("**/doc/frotz", "a/doc/frotz", WM_PATHNAME)).toBe(true);
	});

	test("foo/* matches foo/test.json but not foo/bar/hello.c", () => {
		expect(match("foo/*", "foo/test.json", WM_PATHNAME)).toBe(true);
		expect(match("foo/*", "foo/bar/hello.c", WM_PATHNAME)).toBe(false);
	});

	test("abc/** matches abc/x/y/z", () => {
		expect(match("abc/**", "abc/x/y/z", WM_PATHNAME)).toBe(true);
	});
});
